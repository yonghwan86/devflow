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

test("P3 재분해 diff: 앵커·유사도 매칭 + 체크리스트 병합 + 사라진 항목 + 병합 검증", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);
  await mgr.post("/api/auth/bootstrap").send({ email: "m@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "diff" })).body.project.id;
  const page = (await mgr.post(`/api/projects/${pid}/pages`).send({
    title: "설계",
    content: "## 로그인 구현\n- 소셜 로그인\n- 2FA\n## 결제 연동\n- 토스",
  })).body.page;

  // 최초 분해·반영 — 앵커가 저장된다
  let r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  assert.equal(r.body.items.length, 2);
  assert.ok(r.body.items.every((it: any) => it.match === null), "최초엔 전부 신규");
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    tasks: [{ title: "로그인 구현", checklist: ["소셜 로그인", "2FA"] }, { title: "결제 연동", checklist: ["토스"] }],
  });
  assert.equal(r.status, 201);
  const loginTask = r.body.tasks.find((x: any) => x.title === "로그인 구현");
  const payTask = r.body.tasks.find((x: any) => x.title === "결제 연동");

  // ① 그대로 재분해 → 전부 앵커 매칭, 병합할 것도 사라진 것도 없음
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  assert.ok(r.body.items.every((it: any) => it.match?.via === "anchor"), JSON.stringify(r.body.items));
  assert.ok(r.body.items.every((it: any) => it.new_checklist.length === 0), "변경 없음");
  assert.equal(r.body.removed.length, 0);

  // ② 앱에서 태스크 제목을 바꿔도 앵커로 매칭 유지
  r = await mgr.patch(`/api/tasks/${loginTask.id}`).send({ title: "로그인 개발(변경됨)" });
  assert.equal(r.status, 200);
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  const linked = r.body.items.find((it: any) => it.title === "로그인 구현");
  assert.equal(linked.match?.task_id, loginTask.id, "제목 변경에도 앵커 매칭 유지");

  // ③ 문서 개정: 로그인 제목 개정(+새 체크 항목), 결제 섹션 삭제, 알림 섹션 신규
  r = await mgr.patch(`/api/projects/${pid}/pages/${page.id}`).send({
    content: "## 로그인/회원가입 구현\n- 소셜 로그인\n- 2FA\n- 휴대폰 인증\n## 알림 구현\n- 웹푸시",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  const renamed = r.body.items.find((it: any) => it.title === "로그인/회원가입 구현");
  assert.equal(renamed?.match?.task_id, loginTask.id, "개정 제목 유사도 매칭: " + JSON.stringify(r.body.items));
  assert.deepEqual(renamed.new_checklist, ["휴대폰 인증"], "새 체크 항목만 병합 제안");
  const fresh = r.body.items.find((it: any) => it.title === "알림 구현");
  assert.equal(fresh.match, null, "신규 항목");
  assert.equal(r.body.removed.length, 1, "결제 연동이 사라짐 목록에");
  assert.equal(r.body.removed[0].id, payTask.id);

  // ④ 병합 반영 — 새 체크 항목 추가 + 앵커 갱신 (중복 항목은 다시 넣지 않음)
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    tasks: [{ title: "알림 구현", checklist: ["웹푸시"] }],
    merges: [{ task_id: loginTask.id, anchor: "로그인/회원가입 구현", add_checklist: ["휴대폰 인증", "소셜 로그인"] }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.merged, 1);
  const detail = (await mgr.get(`/api/projects/${pid}/tasks/by-key/${loginTask.item_key}`)).body;
  const contents = detail.checklist.map((c: any) => c.content);
  assert.ok(contents.includes("휴대폰 인증"), "병합됨: " + JSON.stringify(contents));
  assert.equal(contents.filter((c: string) => c === "소셜 로그인").length, 1, "기존 항목 중복 방지");
  // 앵커 갱신 → 다음 재분해는 정확(anchor) 매칭
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  const again = r.body.items.find((it: any) => it.title === "로그인/회원가입 구현");
  assert.equal(again.match?.via, "anchor", "앵커 갱신 확인");
  assert.equal(again.new_checklist.length, 0);

  // ⑤ 병합 대상 검증 — 이 문서 파생이 아닌 태스크로 병합 시도 → 400
  const stray = (await mgr.post(`/api/projects/${pid}/tasks`).send({ title: "무관 태스크" })).body.task;
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    merges: [{ task_id: stray.id, anchor: "무관", add_checklist: ["x"] }],
  });
  assert.equal(r.status, 400, "타 출처 태스크 병합 거부");

  // ⑤-1 원자성 — 생성+무효 병합 혼합 요청은 선검증에서 400, 태스크가 하나도 생성되지 않아야 함(재시도 중복 방지)
  const before = (await mgr.get(`/api/projects/${pid}/pages/${page.id}/derived-tasks`)).body.tasks.length;
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    tasks: [{ title: "생성되면 안 되는 태스크" }],
    merges: [{ task_id: stray.id, anchor: "무관" }],
  });
  assert.equal(r.status, 400);
  const after = (await mgr.get(`/api/projects/${pid}/pages/${page.id}/derived-tasks`)).body.tasks.length;
  assert.equal(after, before, "선검증 실패 시 쓰기 0건");

  // ⑤-2 앵커 보존 — 모달에서 제목을 고쳐 만들어도(anchor=원본 분해 제목) 재분해가 앵커로 매칭
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}`); // no-op guard
  r = await mgr.patch(`/api/projects/${pid}/pages/${page.id}`).send({
    content: "## 로그인/회원가입 구현\n- 소셜 로그인\n- 2FA\n- 휴대폰 인증\n## 알림 구현\n- 웹푸시\n## 통계 대시보드\n- 지표 정의",
  });
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({
    tasks: [{ title: "대시보드 v1 만들기(제목 수정함)", anchor: "통계 대시보드" }],
  });
  assert.equal(r.status, 201);
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/decompose`);
  const dash = r.body.items.find((it: any) => it.title === "통계 대시보드");
  assert.equal(dash?.match?.via, "anchor", "원본 앵커로 매칭: " + JSON.stringify(dash?.match));

  // ⑥ 빈 반영(생성 0 + 병합 0) → 400
  r = await mgr.post(`/api/projects/${pid}/pages/${page.id}/apply-decomposition`).send({ tasks: [], merges: [] });
  assert.equal(r.status, 400);
});
