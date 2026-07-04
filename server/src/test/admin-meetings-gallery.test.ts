// 관리자 설정(LLM 키) · 회의록 파이프라인 · P11 검증 갤러리
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("admin settings + meetings pipeline + gallery", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app); // bootstrap 계정 = 사이트 관리자
  const member = request.agent(ctx.app);
  const visitor = request.agent(ctx.app); // 공개 가입 회원 (프로젝트 무소속)

  await admin.post("/api/auth/bootstrap").send({ email: "a@x.com", password: "password123", full_name: "관리자" });
  await admin.post("/api/auth/login").send({ email: "a@x.com", password: "password123" });
  const pid = (await admin.post("/api/projects").send({ name: "본진" })).body.project.id;
  const inv = await admin.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "팀원" });
  await member.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });

  /* ---------- 관리자 설정 ---------- */
  // bootstrap 계정은 is_admin
  let r = await admin.get("/api/auth/me");
  assert.equal(r.body.user.is_admin, true, "bootstrap=admin");
  // 관리자: 설정 조회/저장, 키는 마스킹만
  r = await admin.patch("/api/admin/settings").send({ llm_provider: "openai", llm_api_key: "sk-test-abcdef123456", llm_model: "gpt-4o-mini" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.llm_provider, "openai");
  assert.equal(r.body.settings.llm_api_key_set, true);
  assert.ok(!JSON.stringify(r.body).includes("sk-test-abcdef123456"), "★ 키 원문 노출 금지");
  assert.ok(r.body.settings.llm_api_key_masked.includes("****"));
  // 일반 회원은 접근 불가
  r = await member.get("/api/admin/settings");
  assert.equal(r.status, 403, "member는 관리자 설정 접근 금지");
  r = await member.patch("/api/admin/settings").send({ llm_provider: "mock" });
  assert.equal(r.status, 403);
  // 되돌리기 (이후 테스트는 mock 경로)
  r = await admin.patch("/api/admin/settings").send({ llm_provider: "mock", llm_api_key: "" });
  assert.equal(r.body.settings.llm_provider, "mock");
  r = await admin.post("/api/admin/settings/test").send({});
  assert.equal(r.body.ok, true, "mock 연결 테스트");

  /* ---------- 회의록 파이프라인 ---------- */
  const source = [
    "용환: 배포는 금요일로 하기로 결정했습니다.",
    "유빈: 로그인 버그 수정을 제가 진행해야 합니다.",
    "용환: 캐시는 반드시 무효화 후 배포하세요. 주의가 필요합니다.",
    "유빈: 스테이징 DB 접속이 안 되는 문제가 있어요.",
    "용환: 다음 스프린트 범위는 어떻게 하죠?",
  ].join("\n");
  r = await member.post("/api/meetings").send({ project_id: pid, title: "주간회의", source_text: source });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const noteId = r.body.note.id;
  r = await member.post(`/api/meetings/${noteId}/process`).send({});
  assert.equal(r.status, 200);
  const kinds = r.body.extractions.map((x: any) => x.kind).sort();
  assert.ok(kinds.includes("decision") && kinds.includes("action") && kinds.includes("guide") && kinds.includes("blocker") && kinds.includes("question"),
    "5종 추출: " + JSON.stringify(kinds));
  assert.ok(r.body.extractions.every((x: any) => x.status === "suggested"), "자동 등록 금지 — 전부 suggested");
  const action = r.body.extractions.find((x: any) => x.kind === "action");
  assert.equal(action.speaker, "유빈", "화자 귀속");

  // action 승인 → 태스크 생성
  r = await member.patch(`/api/meetings/extractions/${action.id}`).send({ status: "accepted" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.extraction.linked_task_id, "태스크 연결");
  r = await admin.get(`/api/projects/${pid}/tasks`);
  assert.ok(r.body.tasks.some((x: any) => x.title.includes("로그인 버그")), "회의록→태스크 생성");

  // guide 승인은 task_id 필요 + manager만
  const ext = await member.get(`/api/meetings/${noteId}`);
  const guide = ext.body.extractions.find((x: any) => x.kind === "guide");
  const taskId = r.body.tasks[0].id;
  r = await member.patch(`/api/meetings/extractions/${guide.id}`).send({ status: "accepted", task_id: taskId });
  assert.equal(r.status, 403, "member는 가이드 승격 불가");
  r = await admin.patch(`/api/meetings/extractions/${guide.id}`).send({ status: "accepted", task_id: taskId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.extraction.linked_comment_id, "가이드 댓글 연결");

  // 비멤버 접근 차단
  await visitor.post("/api/auth/signup").send({ email: "v@x.com", password: "password123", full_name: "방문자" });
  r = await visitor.get(`/api/meetings?project_id=${pid}`);
  assert.equal(r.status, 404, "비멤버 회의록 차단");

  /* ---------- P11 갤러리 ---------- */
  // 제출 (관리자가 프로젝트 결과물 제출)
  r = await admin.post("/api/gallery").send({ project_id: pid, title: "DevFlow 데모", summary: "팀 업무관리 도구", demo_url: "https://demo.example.com" });
  assert.equal(r.status, 201);
  const subId = r.body.submission.id;
  // 본인 리뷰 금지
  r = await admin.post(`/api/gallery/${subId}/feedback`).send({ rating: 5, body: "좋아요" });
  assert.equal(r.status, 403, "본인 제출물 리뷰 금지");
  // 공개 가입 회원이 열람+리뷰 가능 (프로젝트 데이터는 접근 불가여도)
  r = await visitor.get("/api/gallery");
  assert.equal(r.status, 200);
  assert.equal(r.body.submissions.length, 1);
  r = await visitor.post(`/api/gallery/${subId}/feedback`).send({ rating: 5, body: "UX가 깔끔해요", category: "ux" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // 중복 리뷰 금지
  r = await visitor.post(`/api/gallery/${subId}/feedback`).send({ rating: 4, body: "again" });
  assert.equal(r.status, 400, "1인 1리뷰");
  // 게이트: min_reviews 3 — member까지 2명이어도 아직 open
  await member.post(`/api/gallery/${subId}/feedback`).send({ rating: 5, body: "동작 잘 됨", category: "perf" });
  r = await visitor.get(`/api/gallery/${subId}`);
  assert.equal(r.body.submission.status, "open");
  assert.equal(r.body.submission.review_count, 2);
  // 세 번째 리뷰어 → validated 승격
  const third = request.agent(ctx.app);
  await third.post("/api/auth/signup").send({ email: "t@x.com", password: "password123", full_name: "셋째" });
  await third.post(`/api/gallery/${subId}/feedback`).send({ rating: 4, body: "시장성 있음", category: "market" });
  r = await visitor.get(`/api/gallery/${subId}`);
  assert.equal(r.body.submission.status, "validated", "게이트 충족 시 자동 승격: " + JSON.stringify(r.body.submission));

  // 공개 가입 회원이 프로젝트 데이터에 접근 불가 재확인 (§10.5)
  r = await visitor.get(`/api/projects/${pid}/tasks`);
  assert.ok([403, 404].includes(r.status), "공개 회원 프로젝트 차단");
});
