// 역할 계층: owner > manager > member — 소유자 보호, 매니저 권한 상속, 소유권 양도
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

async function signup(app: any, email: string, name: string) {
  const a = request.agent(app);
  await a.post("/api/auth/signup").send({ email, password: "password123", full_name: name });
  await a.post("/api/auth/login").send({ email, password: "password123" });
  return a;
}

test("역할 계층: 생성자=소유자, owner 보호, owner 직접지정 거부, member 권한 없음, 매니저 상속", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });

  // 생성자 my_role=owner
  const proj = (await owner.post("/api/projects").send({ name: "역할" })).body.project;
  assert.equal(proj.my_role, "owner", "생성자=소유자");
  const pid = proj.id;
  const ownerM = (await owner.get(`/api/projects/${pid}/members`)).body.members.find((m: any) => m.user.email === "o@x.com");
  assert.equal(ownerM.role, "owner");

  const bob = await signup(ctx.app, "bob@x.com", "밥");
  const carol = await signup(ctx.app, "carol@x.com", "캐롤");
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  const carolId = (await carol.get("/api/auth/me")).body.user.id;
  const bobM = (await owner.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" })).body.member;
  await owner.post(`/api/projects/${pid}/members`).send({ user_id: carolId, role: "member" });

  // 멤버 추가로 owner 직접 지정 → 400 (owner는 양도 전용, ASSIGNABLE_ROLES enum)
  let r = await owner.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "owner" });
  assert.equal(r.status, 400, "멤버 추가로 owner 직접 지정 불가");

  // owner가 매니저 권한 상속: 멤버→매니저 승격
  r = await owner.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "manager" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.member.role, "manager");

  // owner가 requireRole("manager") 라우트(프로젝트 설정 PATCH) 통과 → 상속 확인
  r = await owner.patch(`/api/projects/${pid}`).send({ name: "역할-수정" });
  assert.equal(r.status, 200, "owner가 매니저 전용 라우트 상속 통과");

  // member(carol)는 역할변경/제거 불가 → 403
  r = await carol.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "member" });
  assert.equal(r.status, 403);
  r = await carol.delete(`/api/projects/${pid}/members/${bobM.id}`);
  assert.equal(r.status, 403);

  // 소유자 행은 강등 불가 → 400
  r = await owner.patch(`/api/projects/${pid}/members/${ownerM.id}`).send({ role: "manager" });
  assert.equal(r.status, 400, "소유자 강등 차단");
  // 소유자 행은 제거 불가 → 400
  r = await owner.delete(`/api/projects/${pid}/members/${ownerM.id}`);
  assert.equal(r.status, 400, "소유자 제거 차단");

  // 매니저(bob)가 소유자 행을 강등/제거 시도해도 차단 → 400
  r = await bob.patch(`/api/projects/${pid}/members/${ownerM.id}`).send({ role: "member" });
  assert.equal(r.status, 400, "매니저도 소유자 강등 불가");
  r = await bob.delete(`/api/projects/${pid}/members/${ownerM.id}`);
  assert.equal(r.status, 400, "매니저도 소유자 제거 불가");
});

test("소유권 양도: owner만 가능, 대상은 멤버여야, 양도 후 역할 교체", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o2@x.com", password: "password123", full_name: "오너2" });
  await owner.post("/api/auth/login").send({ email: "o2@x.com", password: "password123" });
  const ownerId = (await owner.get("/api/auth/me")).body.user.id;

  const proj = (await owner.post("/api/projects").send({ name: "양도" })).body.project;
  const pid = proj.id;
  const bob = await signup(ctx.app, "bob3@x.com", "밥");
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  await owner.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" });

  // 비멤버에게 양도 → 404
  const stranger = await signup(ctx.app, "stranger@x.com", "낯선이");
  const strangerId = (await stranger.get("/api/auth/me")).body.user.id;
  let r = await owner.post(`/api/projects/${pid}/transfer-owner`).send({ user_id: strangerId });
  assert.equal(r.status, 404, "비멤버 양도 불가");

  // 자기 자신에게 양도 → 400
  r = await owner.post(`/api/projects/${pid}/transfer-owner`).send({ user_id: ownerId });
  assert.equal(r.status, 400, "자기 자신 양도 불가");

  // member(bob)는 양도 불가 → 403 (requireRole owner)
  r = await bob.post(`/api/projects/${pid}/transfer-owner`).send({ user_id: ownerId });
  assert.equal(r.status, 403, "소유자만 양도 가능");

  // owner가 bob에게 양도 → 200
  r = await owner.post(`/api/projects/${pid}/transfer-owner`).send({ user_id: bobId });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // 역할 교체 확인: bob=owner, 구 owner=manager
  const members = (await bob.get(`/api/projects/${pid}/members`)).body.members;
  assert.equal(members.find((m: any) => m.user.id === bobId).role, "owner", "새 소유자");
  assert.equal(members.find((m: any) => m.user.id === ownerId).role, "manager", "구 소유자는 매니저로");

  // 새 소유자 my_role=owner, 구 소유자는 양도 권한 상실 → 403
  assert.equal((await bob.get(`/api/projects/${pid}`)).body.project.my_role, "owner");
  r = await owner.post(`/api/projects/${pid}/transfer-owner`).send({ user_id: ownerId });
  assert.equal(r.status, 403, "양도 후 구 소유자는 권한 없음");
});
