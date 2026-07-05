// (운영 반영) 기존 가입 회원을 초대 링크 없이 프로젝트에 직접 추가 — POST /projects/:pid/members
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("기존 회원 직접 추가: 성공/미가입 404/중복 409/권한 403", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const carol = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "직접추가" })).body.project.id;

  // 기존 가입 회원 bob
  await bob.post("/api/auth/signup").send({ email: "bob@x.com", password: "password123", full_name: "밥" });

  // ① 직접 추가 성공 → bob이 즉시 프로젝트 접근 가능
  let r = await owner.post(`/api/projects/${pid}/members`).send({ email: "bob@x.com", role: "member" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.member.user.email, "bob@x.com");
  r = await bob.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200, "추가 직후 멤버 접근 가능");

  // ② 미가입 이메일 → 404 (초대 링크 안내)
  r = await owner.post(`/api/projects/${pid}/members`).send({ email: "ghost@x.com" });
  assert.equal(r.status, 404);

  // ③ 이미 멤버 → 409
  r = await owner.post(`/api/projects/${pid}/members`).send({ email: "bob@x.com" });
  assert.equal(r.status, 409);

  // ④ member 권한(bob)이 남(carol)을 추가 시도 → 403
  await carol.post("/api/auth/signup").send({ email: "carol@x.com", password: "password123", full_name: "캐롤" });
  r = await bob.post(`/api/projects/${pid}/members`).send({ email: "carol@x.com" });
  assert.equal(r.status, 403, "owner/manager 전용");
});
