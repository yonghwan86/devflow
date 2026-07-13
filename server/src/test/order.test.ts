// 정렬 규약 회귀 테스트 —
// 태스크 목록: sort_order desc(드래그 우선) → created_at asc(등록순) → id asc(일괄 생성 tie-break)
// 멤버 목록: 가입순(joined_at, id) 고정 — ORDER BY 없이는 PG가 UPDATE 후 순서를 뒤바꿀 수 있다
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("태스크 목록: 등록순(먼저 등록이 위) + 드래그 sort_order 우선", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);

  await mgr.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "정렬" })).body.project.id;

  await mgr.post(`/api/projects/${pid}/tasks`).send({ title: "첫째" });
  await mgr.post(`/api/projects/${pid}/tasks`).send({ title: "둘째" });
  const c = (await mgr.post(`/api/projects/${pid}/tasks`).send({ title: "셋째" })).body.task;

  // ① 등록순: 먼저 만든 태스크가 위 — 같은 초에 생성돼도 id tie-break로 순서 보장 (문서 분해 일괄 생성 대비)
  let r = await mgr.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map((x: any) => x.title), ["첫째", "둘째", "셋째"], "등록순");

  // ② 드래그(sort_order)가 등록순보다 우선 — 셋째를 맨 위로
  r = await mgr.patch(`/api/tasks/${c.id}`).send({ sort_order: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await mgr.get(`/api/projects/${pid}/tasks`);
  assert.deepEqual(r.body.tasks.map((x: any) => x.title), ["셋째", "첫째", "둘째"], "sort_order 우선");
});

test("멤버 목록: 가입순 고정 — 역할 변경(UPDATE) 후에도 순서 불변", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);
  const bob = request.agent(ctx.app);
  const carol = request.agent(ctx.app);

  await mgr.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "멤버정렬" })).body.project.id;

  await bob.post("/api/auth/signup").send({ email: "bob@x.com", password: "password123", full_name: "밥" });
  await carol.post("/api/auth/signup").send({ email: "carol@x.com", password: "password123", full_name: "캐롤" });
  await bob.post("/api/auth/login").send({ email: "bob@x.com", password: "password123" });
  await carol.post("/api/auth/login").send({ email: "carol@x.com", password: "password123" });
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  const carolId = (await carol.get("/api/auth/me")).body.user.id;
  await mgr.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" });
  await mgr.post(`/api/projects/${pid}/members`).send({ user_id: carolId, role: "member" });

  const order = ["o@x.com", "bob@x.com", "carol@x.com"];
  let r = await mgr.get(`/api/projects/${pid}/members`);
  assert.deepEqual(r.body.members.map((m: any) => m.user.email), order, "가입순");

  // 중간 멤버를 UPDATE(역할 변경)해도 순서 불변 — ORDER BY가 없으면 PG 힙 이동으로 뒤바뀔 수 있는 지점
  const bobM = r.body.members.find((m: any) => m.user.email === "bob@x.com");
  r = await mgr.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "manager" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await mgr.get(`/api/projects/${pid}/members`);
  assert.deepEqual(r.body.members.map((m: any) => m.user.email), order, "UPDATE 후에도 가입순 유지");
});
