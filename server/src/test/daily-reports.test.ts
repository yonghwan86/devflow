import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

function shiftDate(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400_000).toISOString().slice(0, 10);
}

function kstParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

async function setup() {
  const ctx = await makeTestApp();
  const pm = request.agent(ctx.app);
  await pm.post("/api/auth/bootstrap").send({ email: "pm@x.com", password: "password123", full_name: "전체 PM" });
  const project = await pm.post("/api/projects").send({ name: "Daily Report" });
  const pid = project.body.project.id as number;
  await pm.patch(`/api/projects/${pid}/report-settings`).send({ daily_report_enabled: true, report_cutoff_hour: 21 });

  const invitePl = await pm.post(`/api/projects/${pid}/invites`).send({ email: "pl@x.com", role: "member" });
  const pl = request.agent(ctx.app);
  const plAccept = await pl.post("/api/auth/accept-invite").send({ token: invitePl.body.token, password: "password123", full_name: "영역 PL" });
  const plId = plAccept.body.user.id as number;

  const inviteWorker = await pm.post(`/api/projects/${pid}/invites`).send({ email: "worker@x.com", role: "member" });
  const worker = request.agent(ctx.app);
  await worker.post("/api/auth/accept-invite").send({ token: inviteWorker.body.token, password: "password123", full_name: "담당자" });

  const areaA = await pm.post(`/api/projects/${pid}/areas`).send({ name: "결제", lead_user_id: plId });
  const areaB = await pm.post(`/api/projects/${pid}/areas`).send({ name: "검색" });
  return { ctx, pm, pl, worker, pid, plId, areaA: areaA.body.area, areaB: areaB.body.area };
}

test("v2 역할·영역: PL은 자기 영역 공식 태스크만 만들고 담당자는 티켓을 만든다", async () => {
  const { pm, pl, worker, pid, areaA, areaB } = await setup();
  const own = await pl.post(`/api/projects/${pid}/tasks`).send({ title: "결제 구현", area_id: areaA.id });
  assert.equal(own.status, 201);
  assert.equal(own.body.task.kind, "task");
  const other = await pl.post(`/api/projects/${pid}/tasks`).send({ title: "검색 구현", area_id: areaB.id });
  assert.equal(other.status, 403);
  const proposal = await worker.post(`/api/projects/${pid}/tasks`).send({ title: "작업 제안", area_id: areaA.id });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.body.task.kind, "ticket");
  const settings = await pl.patch(`/api/projects/${pid}/report-settings`).send({ report_cutoff_hour: 20 });
  assert.equal(settings.status, 403);
  const pmTask = await pm.post(`/api/projects/${pid}/tasks`).send({ title: "전체 조율", area_id: areaB.id });
  assert.equal(pmTask.status, 201);
});

test("일일보고: on-demand 집계, PL 확인, PM 대리 가능·확정본 불변", async () => {
  const { pm, pl, worker, pid, areaA, areaB } = await setup();
  const done = await pm.post(`/api/projects/${pid}/tasks`).send({ title: "결제 완료", area_id: areaA.id });
  await pm.patch(`/api/tasks/${done.body.task.id}`).send({ status: "done" });
  await pm.post(`/api/projects/${pid}/tasks`).send({ title: "검색 막힘", area_id: areaB.id });

  const now = kstParts();
  const reportDate = shiftDate(now.date, now.hour < 21 ? 1 : 2);
  const prepared = await pl.post(`/api/projects/${pid}/daily-reports/prepare`).send({ report_date: reportDate });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.body.report.status, "draft");
  assert.ok(prepared.body.report.snapshot.completed.some((task: any) => task.title === "결제 완료"));
  const reportId = prepared.body.report.id as number;

  const denied = await worker.get(`/api/projects/${pid}/daily-reports/${reportId}`);
  assert.equal(denied.status, 403);
  const otherArea = await pl.patch(`/api/projects/${pid}/daily-reports/${reportId}/areas/${areaB.id}`).send({ note: "침범" });
  assert.equal(otherArea.status, 403);
  const note = await pl.patch(`/api/projects/${pid}/daily-reports/${reportId}/areas/${areaA.id}`).send({ judgment: "normal", note: "PG 심사 외 순항" });
  assert.equal(note.status, 200);
  const confirmArea = await pl.post(`/api/projects/${pid}/daily-reports/${reportId}/areas/${areaA.id}/confirm`).send({});
  assert.equal(confirmArea.status, 200);

  // 검색 영역 PL이 없어도 PM은 대신 확인하거나 확인 없이 확정할 수 있다.
  const delegated = await pm.post(`/api/projects/${pid}/daily-reports/${reportId}/areas/${areaB.id}/confirm`).send({});
  assert.equal(delegated.status, 200);
  const summary = await pm.patch(`/api/projects/${pid}/daily-reports/${reportId}/summary`).send({ overall_status: "warning", headline: "검색 일정은 주의이며 결제가 순항 중입니다." });
  assert.equal(summary.status, 200);
  const confirmed = await pm.post(`/api/projects/${pid}/daily-reports/${reportId}/confirm`).send({});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.report.status, "confirmed");
  const immutable = await pm.patch(`/api/projects/${pid}/daily-reports/${reportId}/summary`).send({ headline: "몰래 수정" });
  assert.equal(immutable.status, 409);

  const correction = await pm.post(`/api/projects/${pid}/daily-reports/${reportId}/corrections`).send({ correction_reason: "완료 건 제목 사실 오류" });
  assert.equal(correction.status, 201);
  assert.equal(correction.body.report.version, 2);
  assert.equal(correction.body.report.status, "draft");
});

test("회의 메모: 확정 후 작성하고 한 번만 미래 태스크로 반영한다", async () => {
  const { ctx, pm, pl, pid, areaA } = await setup();
  const now = kstParts();
  const reportDate = shiftDate(now.date, now.hour < 21 ? 1 : 2);
  const prepared = await pm.post(`/api/projects/${pid}/daily-reports/prepare`).send({ report_date: reportDate });
  const reportId = prepared.body.report.id as number;
  await pm.post(`/api/projects/${pid}/daily-reports/${reportId}/confirm`).send({});

  const token = (await pm.post("/api/tokens").send({ name: "daily-report-mcp", scopes: ["project:read", "task:write"] })).body.token;
  const mcp = (id: number, name: string, args: any) => request(ctx.app).post("/api/mcp")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const readViaMcp = await mcp(1, "get_daily_report", { project_id: pid, report_id: reportId });
  assert.equal(readViaMcp.body.result.isError, false, JSON.stringify(readViaMcp.body));
  const mcpReport = JSON.parse(readViaMcp.body.result.content[0].text);
  assert.equal(mcpReport.report.id, reportId);
  const memoViaMcp = await mcp(2, "add_daily_report_meeting_memo", { project_id: pid, report_id: reportId, area_id: null, body: "PM MCP 회의 기록", action_type: "note", action_payload: {} });
  assert.equal(memoViaMcp.body.result.isError, false, JSON.stringify(memoViaMcp.body));

  const memo = await pl.post(`/api/projects/${pid}/daily-reports/${reportId}/memos`).send({
    area_id: areaA.id,
    body: "PG 재시도 정책 태스크 추가",
    action_type: "task_create",
    action_payload: { title: "PG 재시도 정책 반영", area_id: areaA.id, priority: 2 },
  });
  assert.equal(memo.status, 201);
  const applied = await pl.post(`/api/projects/${pid}/daily-reports/${reportId}/memos/${memo.body.memo.id}/apply`).send({});
  assert.equal(applied.status, 200);
  assert.ok(applied.body.memo.target_task_id);
  const twice = await pl.post(`/api/projects/${pid}/daily-reports/${reportId}/memos/${memo.body.memo.id}/apply`).send({});
  assert.equal(twice.status, 409);
  const tasks = await pm.get(`/api/projects/${pid}/tasks`);
  assert.equal(tasks.body.tasks.filter((task: any) => task.title === "PG 재시도 정책 반영").length, 1);
});
