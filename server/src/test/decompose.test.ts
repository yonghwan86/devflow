// G6: 문서 분해 — 구조 기반 정확성 + 반영(태스크+체크리스트) + 권한 + 한도
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";
import { structDecompose } from "../lib/pageDecompose.ts";

test("structDecompose: heading+불릿 / 참고 섹션 제외 / heading 없는 불릿", () => {
  // ① heading + 불릿
  const doc1 = `# 프로젝트 개편\n## 로그인 개선\n- 소셜 로그인 추가\n- 2FA 지원\n## 결제 연동\n- 토스 연동\n\n## 참고\n- 이건 무시`;
  const r1 = structDecompose(doc1);
  assert.equal(r1.tasks.length, 2, JSON.stringify(r1.tasks.map((t) => t.title)));
  assert.equal(r1.tasks[0].title, "로그인 개선");
  assert.deepEqual(r1.tasks[0].checklist, ["소셜 로그인 추가", "2FA 지원"]);
  // ② "참고" 섹션 제외
  assert.ok(!r1.tasks.some((t) => t.title === "참고"), "참고 섹션 제외");

  // ③ heading 없는 불릿 문서
  const doc2 = `- 서버 세팅\n  - Docker 구성\n  - env 설정\n- DB 마이그레이션`;
  const r2 = structDecompose(doc2);
  assert.equal(r2.tasks.length, 2);
  assert.equal(r2.tasks[0].title, "서버 세팅");
  assert.deepEqual(r2.tasks[0].checklist, ["Docker 구성", "env 설정"]);
});

test("G6 분해 API: 반영/권한/한도/derived_titles", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await mgr.post("/api/auth/bootstrap").send({ email: "m@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "문서" })).body.project.id;
  const inv = await mgr.post(`/api/projects/${pid}/invites`).send({ email: "u@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await member.post("/api/auth/login").send({ email: "u@x.com", password: "password123" });

  const page = (await mgr.post(`/api/projects/${pid}/pages`).send({
    title: "설계",
    content: "## 로그인 개선\n- 소셜 로그인\n- 2FA\n## 결제 연동\n- 토스",
  })).body.page;

  // ④ member decompose/apply 403
  let r = await member.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  assert.equal(r.status, 403);
  r = await member.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({ tasks: [{ title: "x", checklist: [] }] });
  assert.equal(r.status, 403);

  // decompose 제안
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tasks.length, 2);
  assert.equal(r.body.llm_mode, "mock");
  assert.deepEqual(r.body.derived_titles, []);

  // ⑤ apply — 태스크+체크리스트 생성, source_page_id 연결, derived-tasks에 등장
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    tasks: [{ title: "로그인 개선", checklist: ["소셜 로그인", "2FA"] }, { title: "결제 연동", checklist: ["토스"] }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.tasks.length, 2);
  const firstKey = r.body.tasks[0].item_key;
  const detail = (await mgr.get(`/api/projects/${pid}/tasks/by-key/${firstKey}`)).body;
  assert.equal(detail.checklist.length, 2, "체크리스트 생성됨");
  assert.equal(detail.task.source_page_id, page.id, "source_page_id 연결");
  const derived = (await mgr.get(`/api/projects/${pid}/pages/${page.id}/derived-tasks`)).body.tasks;
  assert.equal(derived.length, 2, "파생 태스크 목록에 등장");

  // ⑧ 재분해 시 derived_titles에 기존 파생 제목 포함
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  assert.ok(r.body.derived_titles.includes("로그인 개선"), "기존 파생 제목 표시");

  // ⑦ 빈 title → 400
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({ tasks: [{ title: "", checklist: [] }] });
  assert.equal(r.status, 400, "빈 title 거부");

  // ⑥ 한도 초과(31개 태스크) → 400
  const many = Array.from({ length: 31 }, (_, i) => ({ title: `T${i}`, checklist: [] }));
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({ tasks: many });
  assert.equal(r.status, 400, "31개 태스크 거부");
});
