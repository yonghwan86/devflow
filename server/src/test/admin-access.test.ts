// G2: 관리자 전체 가시성 + 원클릭 참여 + 사용자 관리(마지막 관리자 가드)
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("G2 관리자 접근/사용자 관리", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app); // bootstrap = is_admin
  const user = request.agent(ctx.app);

  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await admin.post("/api/auth/login").send({ email: "admin@x.com", password: "password123" });
  await user.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  await user.post("/api/auth/login").send({ email: "u@x.com", password: "password123" });
  const userId = (await user.get("/api/auth/me")).body.user.id;

  // 유저가 자기 프로젝트 생성 (admin은 멤버 아님)
  const proj = (await user.post("/api/projects").send({ name: "유저프로젝트" })).body.project;
  const pid = proj.id;

  // ① 일반 유저 /projects/all 403
  let r = await user.get("/api/projects/all");
  assert.equal(r.status, 403);

  // ② admin 전체 목록에 미참여 프로젝트 포함(my_role null) + member_count
  r = await admin.get("/api/projects/all");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const found = r.body.projects.find((p: any) => p.id === pid);
  assert.ok(found, "전체 목록에 유저 프로젝트 포함");
  assert.equal(found.my_role, null, "미참여 → my_role null");
  assert.equal(found.member_count, 1);

  // ④ 일반 유저 join-as-admin 403
  r = await user.post(`/api/projects/${pid}/join-as-admin`);
  assert.equal(r.status, 403);

  // ③ admin join-as-admin 후 그 프로젝트 태스크 접근 가능
  r = await admin.post(`/api/projects/${pid}/join-as-admin`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await admin.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200, "참여 후 멤버 접근 가능");
  // 멱등: 다시 호출해도 성공
  r = await admin.post(`/api/projects/${pid}/join-as-admin`);
  assert.equal(r.status, 201, "멱등 재참여");
  // all 목록에서 이제 my_role=manager
  r = await admin.get("/api/projects/all");
  assert.equal(r.body.projects.find((p: any) => p.id === pid).my_role, "manager");

  // ⑤ admin users 목록에 민감 필드 없음
  r = await admin.get("/api/admin/users");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const urow = r.body.users.find((u: any) => u.email === "u@x.com");
  assert.ok(urow && urow.password_hash === undefined && urow.username === undefined, "민감 필드 미포함");

  // 일반 유저 admin API 403
  r = await user.get("/api/admin/users");
  assert.equal(r.status, 403);

  // ⑥ 관리자 지정/해제 동작
  r = await admin.patch(`/api/admin/users/${userId}`).send({ is_admin: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.is_admin, true);
  r = await admin.patch(`/api/admin/users/${userId}`).send({ is_admin: false });
  assert.equal(r.body.user.is_admin, false);

  // ⑦ 마지막 관리자 해제 → 400 (지금 관리자는 admin 1명뿐)
  const adminId = (await admin.get("/api/auth/me")).body.user.id;
  r = await admin.patch(`/api/admin/users/${adminId}`).send({ is_admin: false });
  assert.equal(r.status, 400, "마지막 관리자 해제 차단");
});
