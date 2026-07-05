// F2 My Work 칸반: board_tasks 범위 + summary 집계
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("F2: board_tasks — 담당 태스크 + 내 요청 티켓 포함, 남의 티켓 제외 + summary", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const m1 = request.agent(ctx.app);
  const m2 = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "P" })).body.project.id;
  for (const [agent, mail, name] of [[m1, "m1@x.com", "일"], [m2, "m2@x.com", "이"]] as const) {
    const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: mail, role: "member" });
    await agent.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: name });
  }
  const m1id = (await m1.get("/api/auth/me")).body.user.id;

  // ① m1 담당 미완료 태스크 (지연: due_date 어제)
  const yesterday = new Date(Date.now() - 86400_000).toISOString();
  const t1 = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "담당 지연", assignee_ids: [m1id], due_date: yesterday })).body.task;
  // 오늘 마감 담당 태스크
  const today = new Date().toISOString();
  const t2 = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "오늘 마감", assignee_ids: [m1id], due_date: today })).body.task;
  // ② m1이 요청한 티켓 (담당자 아님에도 board에 포함돼야 함)
  const tk = (await m1.post(`/api/projects/${pid}/tasks`).send({ title: "내 요청 티켓" })).body.task;
  // ③ 남(m2)이 요청한 티켓 — m1 board에 나오면 안 됨
  await m2.post(`/api/projects/${pid}/tasks`).send({ title: "남의 티켓" });
  // 최근 완료: m1이 done 처리
  const t3 = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "끝낸 일", assignee_ids: [m1id] })).body.task;
  await m1.patch(`/api/tasks/${t3.id}`).send({ status: "done" });

  const r = await m1.get("/api/my-work");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const board = r.body.board_tasks as any[];
  const ids = new Set(board.map((x) => x.id));
  assert.ok(ids.has(t1.id), "담당 미완료 포함");
  assert.ok(ids.has(t2.id), "오늘 마감 포함");
  assert.ok(ids.has(tk.id), "내가 요청한 requested 티켓 포함(담당자 아님에도)");
  assert.ok(ids.has(t3.id), "최근 7일 완료 포함");
  assert.ok(!board.some((x) => x.title === "남의 티켓"), "남이 요청한 티켓 제외");
  const mine = board.find((x) => x.id === tk.id);
  assert.equal(mine.kind, "ticket");
  assert.equal(mine.project_name, "P", "project_name 포함");

  // summary 집계
  const s = r.body.summary;
  assert.equal(s.status_counts.requested, 1);
  assert.equal(s.status_counts.todo, 2, JSON.stringify(s.status_counts));
  assert.equal(s.status_counts.done, 1);
  assert.equal(s.today_due, 1, "오늘 마감 1건");
  assert.equal(s.overdue, 1, "지연 1건(어제 마감 미완료)");
  assert.equal(s.completed_this_week.length, 7, "월~일 7칸");
  assert.equal(s.completed_this_week.reduce((a: number, b: number) => a + b, 0) >= 1, true, "이번 주 완료 반영");

  // 기존 응답 필드 유지 (하위호환)
  assert.ok(Array.isArray(r.body.today) && Array.isArray(r.body.team_today) && Array.isArray(r.body.pending_guides));
});
