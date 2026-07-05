// R0 안정화: 초대 수락 계정 탈취 차단(R0-1) + MCP Bearer 전용(R0-2) + 체크리스트 권한(R0-5)
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("R0-1: accept-invite가 기존 계정을 탈취하지 못한다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const bob = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "P" })).body.project.id;

  // Bob은 이미 가입된 계정
  await bob.post("/api/auth/signup").send({ email: "bob@x.com", password: "password123", full_name: "밥" });

  // 오너가 Bob 이메일로 초대 생성
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "bob@x.com", role: "member" });
  const token = inv.body.token;

  // ① 토큰 취득자가 accept-invite로 기존 계정 비번을 덮어쓰려는 시도 → 409 account_exists
  let r = await request(ctx.app)
    .post("/api/auth/accept-invite")
    .send({ token, password: "hacked12345", full_name: "해커" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "account_exists");

  // password_hash 불변: 원래 비번으로 로그인 성공, 공격 비번은 실패
  r = await request(ctx.app).post("/api/auth/login").send({ email: "bob@x.com", password: "hacked12345" });
  assert.equal(r.status, 401, "공격자가 설정하려던 비번은 무효");
  r = await bob.post("/api/auth/login").send({ email: "bob@x.com", password: "password123" });
  assert.equal(r.status, 200, "기존 비번 유지");

  // ② accepted_at 미소모: 로그인한 Bob이 같은 토큰으로 세션 수락 가능
  r = await bob.post("/api/auth/accept-invite-session").send({ token });
  assert.equal(r.status, 200, "409 이후에도 토큰 재사용 가능(미소모): " + JSON.stringify(r.body));
  assert.equal(r.body.project_id, pid);

  // ③ 신규 사용자 플로우는 기존 그대로 (새 이메일 → 가입 성공)
  const inv2 = await owner.post(`/api/projects/${pid}/invites`).send({ email: "carol@x.com", role: "member" });
  r = await request(ctx.app)
    .post("/api/auth/accept-invite")
    .send({ token: inv2.body.token, password: "password123", full_name: "캐롤" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test("R0-2: MCP는 Bearer 토큰 전용 (세션 접근 401)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  await owner.post("/api/projects").send({ name: "P" });

  // ① 세션만으로 tools/list → 401
  let r = await owner.post("/api/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401, "세션 MCP 접근 차단: " + JSON.stringify(r.body));

  // ② 세션만으로 tools/call → 401
  r = await owner
    .post("/api/mcp")
    .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_my_tasks", arguments: {} } });
  assert.equal(r.status, 401);

  // ③ 유효 토큰 + 스코프 → 성공
  const tok = await owner.post("/api/tokens").send({ name: "mcp", scopes: ["task:read", "project:read"] });
  const bearer = `Bearer ${tok.body.token}`;
  r = await request(ctx.app)
    .post("/api/mcp")
    .set("Authorization", bearer)
    .send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.result?.tools));

  r = await request(ctx.app)
    .post("/api/mcp")
    .set("Authorization", bearer)
    .send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_my_tasks", arguments: {} } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.error, "task:read 스코프 보유 → 성공: " + JSON.stringify(r.body));

  // ④ 스코프 부족 → JSON-RPC 에러
  const weak = await owner.post("/api/tokens").send({ name: "weak", scopes: ["project:read"] });
  r = await request(ctx.app)
    .post("/api/mcp")
    .set("Authorization", `Bearer ${weak.body.token}`)
    .send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_my_tasks", arguments: {} } });
  assert.ok(r.body.error, "스코프 부족은 에러: " + JSON.stringify(r.body));
});

test("R0-5: 체크리스트는 담당자/매니저만 조작", async (t) => {
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

  // m1만 담당자인 태스크
  const task = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "T", assignee_ids: [m1id] })).body.task;

  // 담당 member(m1) 성공
  let r = await m1.post(`/api/tasks/${task.id}/checklist`).send({ content: "담당자 항목" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const itemId = r.body.item.id;

  // 비담당 member(m2)의 추가/수정/삭제 → 403
  r = await m2.post(`/api/tasks/${task.id}/checklist`).send({ content: "남의 태스크" });
  assert.equal(r.status, 403, "비담당 추가 차단");
  r = await m2.patch(`/api/tasks/${task.id}/checklist/${itemId}`).send({ done: true });
  assert.equal(r.status, 403, "비담당 수정 차단");
  r = await m2.delete(`/api/tasks/${task.id}/checklist/${itemId}`);
  assert.equal(r.status, 403, "비담당 삭제 차단");

  // 담당 member(m1): 추가/토글은 성공하지만 삭제는 매니저 전용(G3-3) → 403
  r = await m1.patch(`/api/tasks/${task.id}/checklist/${itemId}`).send({ done: true });
  assert.equal(r.status, 200, "담당자 토글 성공");
  r = await m1.delete(`/api/tasks/${task.id}/checklist/${itemId}`);
  assert.equal(r.status, 403, "담당자도 삭제는 불가(매니저 전용)");

  // manager(owner) 성공: 수정 + 삭제
  r = await owner.patch(`/api/tasks/${task.id}/checklist/${itemId}`).send({ done: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await owner.delete(`/api/tasks/${task.id}/checklist/${itemId}`);
  assert.equal(r.status, 200, "매니저 삭제 성공");
});
