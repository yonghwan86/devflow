// F1 티켓 시스템: member 요청 → 매니저 승인/반려 워크플로우
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";

async function setup(ctx: TestCtx) {
  const owner = request.agent(ctx.app);
  const m1 = request.agent(ctx.app);
  const m2 = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "티켓" })).body.project.id;
  for (const [agent, mail, name] of [[m1, "m1@x.com", "일"], [m2, "m2@x.com", "이"]] as const) {
    const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: mail, role: "member" });
    await agent.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: name });
  }
  const m1id = (await m1.get("/api/auth/me")).body.user.id;
  const m2id = (await m2.get("/api/auth/me")).body.user.id;
  return { owner, m1, m2, pid, m1id, m2id };
}

test("F1: member 티켓 생성 — 서버가 kind/status/requested_by 강제", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, m1, m2, pid, m1id, m2id } = await setup(ctx);

  // ① member가 kind=task, status=done, assignee_ids를 보내도 전부 무시(서버 강제)
  let r = await m1.post(`/api/projects/${pid}/tasks`).send({
    title: "API 키 발급 요청", kind: "task", status: "done", assignee_ids: [m2id], scheduled_date: "2026-07-01",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ticket = r.body.task;
  assert.equal(ticket.kind, "ticket");
  assert.equal(ticket.status, "requested");
  assert.equal(ticket.requested_by, m1id);
  assert.equal(ticket.scheduled_date, null, "member의 scheduled_date는 무시");
  assert.equal((ticket.assignees ?? []).length, 0, "member의 assignee_ids는 무시");
  assert.ok(ticket.item_key, "item_key 원자 시퀀스 정상");

  // ③ 남의 requested 티켓 수정 403 (m2가 m1의 티켓)
  r = await m2.patch(`/api/tasks/${ticket.id}`).send({ title: "가로채기" });
  assert.equal(r.status, 403, "남의 티켓 수정 차단");

  // ④ 본인 requested 티켓 title/priority 수정 성공, status 수정 불가
  r = await m1.patch(`/api/tasks/${ticket.id}`).send({ title: "API 키 발급 요청(수정)", priority: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.title, "API 키 발급 요청(수정)");
  r = await m1.patch(`/api/tasks/${ticket.id}`).send({ status: "todo" });
  assert.ok([403, 409].includes(r.status), "요청자도 status 전이 불가: " + r.status);

  // ⑤ 본인 철회 성공, 남의 것 403
  const other = (await m2.post(`/api/projects/${pid}/tasks`).send({ title: "m2 티켓" })).body.task;
  r = await m1.delete(`/api/tasks/${other.id}`);
  assert.equal(r.status, 403, "남의 티켓 철회 차단");
  r = await m1.delete(`/api/tasks/${ticket.id}`);
  assert.equal(r.status, 200, "본인 requested 티켓 철회 성공");

  // ⑫ 목록에 requested 정상 반환
  r = await owner.get(`/api/projects/${pid}/tasks`);
  const listed = r.body.tasks.find((x: any) => x.id === other.id);
  assert.ok(listed && listed.status === "requested" && listed.kind === "ticket");
});

test("F1: 일반 PATCH로 requested/rejected 전이 불가 (member·manager 공통)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, m1, pid, m1id } = await setup(ctx);

  // ⑥ 담당 member가 일반 태스크를 rejected/requested로 변경 시도 → 400 (zod enum 차단)
  const task = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "일반", assignee_ids: [m1id] })).body.task;
  let r = await m1.patch(`/api/tasks/${task.id}`).send({ status: "rejected" });
  assert.equal(r.status, 400, "rejected 전이 차단: " + JSON.stringify(r.body));
  r = await m1.patch(`/api/tasks/${task.id}`).send({ status: "requested" });
  assert.equal(r.status, 400, "requested 전이 차단");
  r = await owner.patch(`/api/tasks/${task.id}`).send({ status: "requested" });
  assert.equal(r.status, 400, "manager도 불가");

  // ⑦ manager가 requested 티켓을 일반 PATCH로 status 변경 → 409 (승인 API 강제)
  const ticket = (await m1.post(`/api/projects/${pid}/tasks`).send({ title: "티켓" })).body.task;
  r = await owner.patch(`/api/tasks/${ticket.id}`).send({ status: "todo" });
  assert.equal(r.status, 409, "requested는 승인/반려로만: " + JSON.stringify(r.body));
});

test("F1: 승인 — 담당자 배정 + 가이드 pending 백필", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, m1, m2, pid, m2id } = await setup(ctx);

  const ticket = (await m1.post(`/api/projects/${pid}/tasks`).send({ title: "승인 대상" })).body.task;

  // 승인 전 가이드 댓글 생성(담당자 없어서 guide_assignees 0) — 승인 시 배정된 m2에 백필돼야 함
  const g = await owner.post("/api/comments").send({ task_id: ticket.id, body: "가이드: 컨벤션 참고", is_guide: true });
  assert.equal(g.status, 201);

  // member는 승인 불가
  let r = await m1.post(`/api/tasks/${ticket.id}/approve`).send({});
  assert.equal(r.status, 403, "member 승인 차단");

  // ⑧ 승인 성공 + 담당자 저장
  r = await owner.post(`/api/tasks/${ticket.id}/approve`).send({ assignee_ids: [m2id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.status, "todo");
  assert.ok(r.body.assignees.some((a: any) => a.id === m2id), "담당자 저장");

  // 가이드 백필: m2의 pending guide가 생겼는지 (m2의 my-work 미수행 가이드 집계로 확인)
  const mw = await m2.get("/api/my-work");
  assert.equal(mw.status, 200);
  const pendingGuides = JSON.stringify(mw.body);
  assert.ok(pendingGuides.includes("컨벤션") || (mw.body.pending_guides ?? mw.body.guides ?? []).length >= 0);
  // 더 직접적으로: 태스크 상세의 guides 집계 total=1
  const detail = await owner.get(`/api/tasks/${ticket.id}`);
  assert.equal(detail.body.guides.total, 1, "승인-배정된 담당자에 가이드 백필: " + JSON.stringify(detail.body.guides));

  // 승인 후 재승인 → 409
  r = await owner.post(`/api/tasks/${ticket.id}/approve`).send({});
  assert.equal(r.status, 409, "이미 처리된 티켓 재승인 차단");
});

test("F1: 반려 — 사유 필수, 댓글 이력, completed_at null, 롤업 제외", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, m1, pid, m1id } = await setup(ctx);

  const ticket = (await m1.post(`/api/projects/${pid}/tasks`).send({ title: "반려 대상" })).body.task;

  // ⑩ reason 없으면 400
  let r = await owner.post(`/api/tasks/${ticket.id}/reject`).send({});
  assert.equal(r.status, 400, "사유 필수");
  r = await owner.post(`/api/tasks/${ticket.id}/reject`).send({ reason: "   " });
  assert.equal(r.status, 400, "공백 사유 거부");

  // ⑨ 반려 성공 + completed_at null + 사유 댓글
  r = await owner.post(`/api/tasks/${ticket.id}/reject`).send({ reason: "중복 요청입니다" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.status, "rejected");
  assert.equal(r.body.task.completed_at, null, "rejected는 done이 아님 — completed_at 미설정");
  const cm = await owner.get(`/api/comments?task_id=${ticket.id}`);
  assert.ok(cm.body.comments.some((c: any) => c.body.includes("중복 요청입니다")), "반려 사유 댓글 생성");

  // ⑪ 롤업: rejected 하위는 모수 제외 — 나머지 하위 done이면 부모 done
  const parent = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "부모" })).body.task;
  const c1 = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "하위1", parent_task_id: parent.id, assignee_ids: [m1id] })).body.task;
  // 하위2 = member 티켓(부모에 붙임: manager가 승인 후 반려하는 대신, 티켓을 부모 하위로 만들기 위해 manager가 직접 requested 흉내 불가
  // → member 티켓은 parent 지정 입력이 없으므로: 하위2를 一般 태스크로 만들고 티켓 반려 시나리오는 위에서 검증됨.
  // 여기서는 rejected 하위를 만들기 위해 member 티켓 생성 → manager가 부모 지정(PATCH) → 반려.
  const t2 = (await m1.post(`/api/projects/${pid}/tasks`).send({ title: "하위2(티켓)" })).body.task;
  r = await owner.patch(`/api/tasks/${t2.id}`).send({ parent_task_id: parent.id });
  assert.equal(r.status, 200, "requested 티켓의 status 외 필드는 manager 수정 가능: " + JSON.stringify(r.body));
  r = await owner.post(`/api/tasks/${t2.id}/reject`).send({ reason: "범위 밖" });
  assert.equal(r.status, 200);
  // 하위1 완료 → rejected 하위(하위2)는 모수 제외 → 부모 자동 done
  r = await m1.patch(`/api/tasks/${c1.id}`).send({ status: "done" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await owner.get(`/api/tasks/${parent.id}`);
  assert.equal(p.body.task.status, "done", "rejected 하위가 부모 롤업을 막지 않음");

  // ⑫ 상세에 rejected 정상 반환
  const d = await owner.get(`/api/tasks/${ticket.id}`);
  assert.equal(d.body.task.status, "rejected");
});
