// 이미 로그인한 사용자가 초대 링크를 열면 비밀번호 재설정 없이 프로젝트에 합류
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("accept-invite-session (logged-in user joins project)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const mallory = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "P" })).body.project.id;

  // Bob은 이미 다른 프로젝트로 가입되어 계정 보유 (공개 가입으로 대체)
  await bob.post("/api/auth/signup").send({ email: "bob@x.com", password: "password123", full_name: "밥" });

  // 오너가 Bob 이메일로 초대 생성
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "bob@x.com", role: "member" });
  const token = inv.body.token;

  // 로그인한 Bob이 초대 수락 → 비밀번호 재설정 없이 합류
  let r = await bob.post("/api/auth/accept-invite-session").send({ token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project_id, pid);
  // 실제 멤버가 됐는지 (프로젝트 태스크 접근 가능)
  r = await bob.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200, "합류 후 멤버 접근 가능");

  // 같은 토큰 재사용 불가 (이미 accepted)
  r = await bob.post("/api/auth/accept-invite-session").send({ token });
  assert.equal(r.status, 400, "재사용 차단");

  // 이메일 불일치 계정은 거부 (계정 탈취 방지)
  await mallory.post("/api/auth/signup").send({ email: "mallory@x.com", password: "password123", full_name: "맬" });
  const inv2 = await owner.post(`/api/projects/${pid}/invites`).send({ email: "someone@x.com", role: "member" });
  r = await mallory.post("/api/auth/accept-invite-session").send({ token: inv2.body.token });
  assert.equal(r.status, 403, "이메일 불일치 초대 거부");

  // 비로그인 상태는 거부
  r = await request(ctx.app).post("/api/auth/accept-invite-session").send({ token: inv2.body.token });
  assert.equal(r.status, 401, "비로그인 거부");
});
