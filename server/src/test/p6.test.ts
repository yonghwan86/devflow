// P6: task_dependencies — 추가/사이클 방지/권한
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("P6 dependencies", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const member = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const proj = await owner.post("/api/projects").send({ name: "P6" });
  const pid = proj.body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await member.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });

  const a = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "설계" })).body.task;
  const b = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "구현" })).body.task;
  const c = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "배포" })).body.task;

  // 구현 ← 설계, 배포 ← 구현
  let r = await owner.post("/api/dependencies").send({ task_id: b.id, depends_on_task_id: a.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await owner.post("/api/dependencies").send({ task_id: c.id, depends_on_task_id: b.id });
  assert.equal(r.status, 201);

  // 사이클 금지: 설계 ← 배포는 순환
  r = await owner.post("/api/dependencies").send({ task_id: a.id, depends_on_task_id: c.id });
  assert.equal(r.status, 400, "cycle must be rejected: " + JSON.stringify(r.body));

  // 자기 참조 금지
  r = await owner.post("/api/dependencies").send({ task_id: a.id, depends_on_task_id: a.id });
  assert.equal(r.status, 400);

  // member는 관리 불가 (권한 거부 케이스)
  r = await member.post("/api/dependencies").send({ task_id: b.id, depends_on_task_id: c.id });
  assert.equal(r.status, 403);

  // 목록 (멤버 가능) + 태스크 상세에 선행 태스크 포함
  r = await member.get(`/api/dependencies?project_id=${pid}`);
  assert.equal(r.body.dependencies.length, 2);
  r = await owner.get(`/api/projects/${pid}/tasks/by-key/${b.item_key}`);
  assert.equal(r.body.dependencies.length, 1);
  assert.equal(r.body.dependencies[0].item_key, a.item_key);

  // 제거
  r = await owner.delete(`/api/dependencies/${b.id}/${a.id}`);
  assert.equal(r.status, 200);
  r = await owner.get(`/api/dependencies?project_id=${pid}`);
  assert.equal(r.body.dependencies.length, 1);

  // 비멤버 프로젝트 접근 차단
  const stranger = request.agent(ctx.app);
  const p2 = await owner.post("/api/projects").send({ name: "다른곳" });
  const inv2 = await owner.post(`/api/projects/${p2.body.project.id}/invites`).send({ email: "s@x.com", role: "member" });
  await stranger.post("/api/auth/accept-invite").send({ token: inv2.body.token, password: "password123", full_name: "외부" });
  await stranger.post("/api/auth/login").send({ email: "s@x.com", password: "password123" });
  r = await stranger.get(`/api/dependencies?project_id=${pid}`);
  assert.equal(r.status, 404);
});
