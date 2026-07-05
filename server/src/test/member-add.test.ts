// G1-5: 기존 가입 회원을 user_id로 직접 추가 + addable-users 후보 목록
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("직접 추가: addable-users 후보 + user_id 추가/미가입 404/중복 409/권한 403/비활성 제외", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const carol = request.agent(ctx.app);

  await mgr.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "직접추가" })).body.project.id;

  await bob.post("/api/auth/signup").send({ email: "bob@x.com", password: "password123", full_name: "밥" });
  await bob.post("/api/auth/login").send({ email: "bob@x.com", password: "password123" });
  await carol.post("/api/auth/signup").send({ email: "carol@x.com", password: "password123", full_name: "캐롤" });

  const bobId = (await bob.get("/api/auth/me")).body.user.id;

  // ① addable-users: 아직 멤버 아닌 활성 사용자(bob, carol) 포함, 이미 멤버(매니저 본인) 제외
  let r = await mgr.get(`/api/projects/${pid}/addable-users`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const emails = r.body.users.map((u: any) => u.email);
  assert.ok(emails.includes("bob@x.com") && emails.includes("carol@x.com"), JSON.stringify(emails));
  assert.ok(!emails.includes("o@x.com"), "이미 멤버는 후보에서 제외");

  // ② user_id로 추가 성공 → bob 즉시 접근 가능
  r = await mgr.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.member.user.email, "bob@x.com");
  r = await bob.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200, "추가 직후 멤버 접근 가능");

  // 추가 후 addable-users에서 bob 제외
  r = await mgr.get(`/api/projects/${pid}/addable-users`);
  assert.ok(!r.body.users.some((u: any) => u.id === bobId), "추가된 사용자는 후보에서 사라짐");

  // ③ 존재하지 않는 user_id → 404
  r = await mgr.post(`/api/projects/${pid}/members`).send({ user_id: 999999 });
  assert.equal(r.status, 404);

  // ④ 이미 멤버 → 409
  r = await mgr.post(`/api/projects/${pid}/members`).send({ user_id: bobId });
  assert.equal(r.status, 409);

  // ⑤ member 권한(bob)이 addable-users·추가 시도 → 403
  const carolId = (await carol.get("/api/auth/me")).body.user.id;
  r = await bob.get(`/api/projects/${pid}/addable-users`);
  assert.equal(r.status, 403, "매니저 전용");
  r = await bob.post(`/api/projects/${pid}/members`).send({ user_id: carolId });
  assert.equal(r.status, 403, "매니저 전용");
});
