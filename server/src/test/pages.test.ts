// F4 문서 페이지: 트리 CRUD, 권한, 사이클 방지, 태스크 파생
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";

async function setup(ctx: TestCtx) {
  const owner = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  const outsider = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "문서" })).body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await outsider.post("/api/auth/signup").send({ email: "out@x.com", password: "password123", full_name: "외부" });
  return { owner, member, outsider, pid };
}

test("F4: 페이지 CRUD + 권한 + 사이클 방지", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, member, outsider, pid } = await setup(ctx);

  // ① 멤버 CRUD 성공 (생성/수정은 멤버 전원)
  let r = await member.post(`/api/projects/${pid}/pages`).send({ title: "루트", content: "# 개요\n**중요** 내용" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const root = r.body.page;
  r = await member.post(`/api/projects/${pid}/pages`).send({ title: "하위", parent_id: root.id });
  assert.equal(r.status, 201);
  const child = r.body.page;

  // GET 상세: content_html 서버 렌더(sanitize) 포함
  r = await member.get(`/api/projects/${pid}/pages/${root.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.page.content_html.includes("<strong>중요</strong>"), r.body.page.content_html);

  // PATCH: content 수정 — 응답에 content_html 미포함 (자동저장 렌더 낭비 방지)
  r = await member.patch(`/api/projects/${pid}/pages/${root.id}`).send({ content: "수정된 내용" });
  assert.equal(r.status, 200);
  assert.equal(r.body.page.content_html, undefined, "PATCH 응답에는 content_html 없음");

  // ③ PATCH whitelist 위반 400
  r = await member.patch(`/api/projects/${pid}/pages/${root.id}`).send({ created_by: 999 });
  assert.equal(r.status, 400, "whitelist 위반 차단");

  // ④ 사이클 방지: 자기 자신 / 자기 하위를 parent로 지정 400
  r = await member.patch(`/api/projects/${pid}/pages/${root.id}`).send({ parent_id: root.id });
  assert.equal(r.status, 400, "자기 자신 parent 금지");
  r = await member.patch(`/api/projects/${pid}/pages/${root.id}`).send({ parent_id: child.id });
  assert.equal(r.status, 400, "하위를 parent로 지정 금지(사이클)");

  // ② 비멤버 조회/생성 403
  r = await outsider.get(`/api/projects/${pid}/pages`);
  assert.equal(r.status, 403);
  r = await outsider.post(`/api/projects/${pid}/pages`).send({ title: "침입" });
  assert.equal(r.status, 403);

  // ⑤ 타 프로젝트 pageId 접근 차단
  const pid2 = (await owner.post("/api/projects").send({ name: "다른" })).body.project.id;
  r = await owner.get(`/api/projects/${pid2}/pages/${root.id}`);
  assert.equal(r.status, 404, "크로스 프로젝트 pageId 차단");

  // ⑥ 삭제 권한: 작성자 아닌 member 403, 작성자/manager 성공
  const ownerPage = (await owner.post(`/api/projects/${pid}/pages`).send({ title: "오너 문서" })).body.page;
  r = await member.delete(`/api/projects/${pid}/pages/${ownerPage.id}`);
  assert.equal(r.status, 403, "남의 문서 member 삭제 차단");
  r = await member.delete(`/api/projects/${pid}/pages/${child.id}`);
  assert.equal(r.status, 200, "작성자 본인 삭제 성공");
  r = await owner.delete(`/api/projects/${pid}/pages/${ownerPage.id}`);
  assert.equal(r.status, 200, "manager 삭제 성공");
});

test("F4: 태스크 파생 — role별 kind 강제 + 삭제 시 생존", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, member, pid } = await setup(ctx);

  const page = (await owner.post(`/api/projects/${pid}/pages`).send({ title: "스펙", content: "로그인 화면을 만든다" })).body.page;
  const sub = (await owner.post(`/api/projects/${pid}/pages`).send({ title: "하위", parent_id: page.id })).body.page;

  // ⑧ manager 파생 → kind=task/todo
  let r = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "로그인 화면", source_page_id: page.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.task.kind, "task");
  assert.equal(r.body.task.source_page_id, page.id);

  // ⑨ member 파생 → kind=ticket/requested (F1 규칙 자동 적용)
  r = await member.post(`/api/projects/${pid}/tasks`).send({ title: "회원가입 검토", source_page_id: page.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.task.kind, "ticket");
  assert.equal(r.body.task.status, "requested");
  assert.equal(r.body.task.source_page_id, page.id);

  // ⑩ 타 프로젝트 페이지를 source로 지정 400
  const pid2 = (await owner.post("/api/projects").send({ name: "다른" })).body.project.id;
  r = await owner.post(`/api/projects/${pid2}/tasks`).send({ title: "잘못", source_page_id: page.id });
  assert.equal(r.status, 400, "크로스 프로젝트 source_page_id 차단");

  // ⑪ derived-tasks 목록 정확 (task + ticket 2건)
  r = await owner.get(`/api/projects/${pid}/pages/${page.id}/derived-tasks`);
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks.length, 2);

  // ⑦ 페이지 삭제 → 파생 task 생존 + source_page_id null + 하위 parent null
  r = await owner.delete(`/api/projects/${pid}/pages/${page.id}`);
  assert.equal(r.status, 200);
  const list = await owner.get(`/api/projects/${pid}/tasks`);
  const derived = list.body.tasks.find((x: any) => x.title === "로그인 화면");
  assert.ok(derived, "파생 태스크 생존");
  assert.equal(derived.source_page_id, null, "source_page_id set null");
  const pagesLeft = await owner.get(`/api/projects/${pid}/pages`);
  const subLeft = pagesLeft.body.pages.find((p: any) => p.id === sub.id);
  assert.ok(subLeft, "하위 페이지 생존");
  assert.equal(subLeft.parent_id, null, "하위는 루트로 승격");
});
