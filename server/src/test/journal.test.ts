// N3: 내 기록(개인 저널) — 하루 한 장 upsert·append 시각 스탬프·검색,
// 프라이버시(본인 외·관리자 완전 차단), 토큰 스코프 격리(journal:write 전용).
// N7(v1.5/v2): 히트맵·기간 조회·하루 요약·OCR 검색 병합·AI 검색 내 기록 포함.
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { makeTestApp, type TestCtx } from "./harness.ts";
import { db } from "../lib/db.ts";
import { journalAttachments, journalEntries } from "../../../shared/schema.ts";
import { journalDayKey } from "../lib/journalService.ts";

async function setup(ctx: TestCtx) {
  const admin = request.agent(ctx.app); // bootstrap 첫 계정 = 사이트 관리자
  const user = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "a@x.com", password: "password123", full_name: "관리자" });
  await admin.post("/api/auth/login").send({ email: "a@x.com", password: "password123" });
  await user.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  return { admin, user };
}

// PNG 매직넘버만 있는 최소 버퍼 — detectFileType 통과용(썸네일 실패는 non-fatal)
const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("N3: 하루 한 장 upsert + append 스탬프 + 월 목록 + 검색", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { user } = await setup(ctx);

  // 하루 저장(upsert) — 같은 날짜 두 번 저장해도 한 행
  let r = await user.put("/api/journal/2026-01-05").send({ content: "리액트 포털은 document.body에 붙인다 #리액트" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await user.put("/api/journal/2026-01-05").send({ content: "리액트 포털은 document.body에 붙인다 #리액트 #팁" });
  assert.equal(r.status, 200);

  // append — 오늘 페이지에 시각 스탬프와 함께 누적 (두 번 부르면 두 블록)
  r = await user.post("/api/journal/append").send({ text: "첫 캡처", tags: ["아이디어"] });
  assert.equal(r.status, 201);
  const today = r.body.entry.entry_date;
  r = await user.post("/api/journal/append").send({ text: "둘째 캡처" });
  assert.equal(r.status, 201);
  r = await user.get(`/api/journal/${today}`);
  assert.ok(r.body.entry.content.includes("첫 캡처 #아이디어"), "태그 자동 부착: " + r.body.entry.content);
  assert.ok(r.body.entry.content.includes("둘째 캡처"));
  assert.match(r.body.entry.content, /\*\*\d{2}:\d{2}\*\*/, "시각 스탬프");

  // 빈 날짜 조회 = null (lazy — 열람만으로 행을 만들지 않음)
  r = await user.get("/api/journal/2026-01-06");
  assert.equal(r.body.entry, null);

  // 월 목록
  r = await user.get("/api/journal?month=2026-01");
  assert.equal(r.status, 200);
  assert.equal(r.body.days.length, 1);
  assert.equal(r.body.days[0].entry_date, "2026-01-05");

  // 검색 — 본문·태그
  r = await user.get("/api/journal/search?q=" + encodeURIComponent("포털"));
  assert.equal(r.body.results.length, 1);
  assert.equal(r.body.results[0].entry_date, "2026-01-05");
  r = await user.get("/api/journal/search?q=" + encodeURIComponent("#아이디어"));
  assert.equal(r.body.results.length, 1, "태그 검색");

  // 형식 오류
  r = await user.get("/api/journal/not-a-date");
  assert.equal(r.status, 400);
  r = await user.get("/api/journal?month=2026");
  assert.equal(r.status, 400);
});

test("N3: 프라이버시 — 타인·관리자 완전 차단 (본문·검색·첨부)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, user } = await setup(ctx);

  await user.put("/api/journal/2026-02-01").send({ content: "비밀 아이디어 #은밀" });
  const up = await user.post("/api/journal/2026-02-01/attachments").attach("file", fakePng, "shot.png");
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const attId = up.body.attachment.id;

  // 관리자가 같은 날짜를 조회해도 자기(빈) 기록만 — 타인 기록에 닿는 경로 자체가 없음
  let r = await admin.get("/api/journal/2026-02-01");
  assert.equal(r.body.entry, null, "관리자에게도 안 보임");
  assert.equal(r.body.attachments.length, 0);
  r = await admin.get("/api/journal/search?q=" + encodeURIComponent("비밀"));
  assert.equal(r.body.results.length, 0, "검색도 본인 것만");
  r = await admin.get("/api/journal?month=2026-02");
  assert.equal(r.body.days.length, 0);
  // 첨부 직접 접근도 소유자 검사로 404
  r = await admin.get(`/api/journal/attachments/${attId}`);
  assert.equal(r.status, 404, "타인 첨부 차단");
  r = await admin.delete(`/api/journal/attachments/${attId}`);
  assert.equal(r.status, 404, "타인 첨부 삭제 차단");
  // 본인은 조회·삭제 가능
  r = await user.get(`/api/journal/attachments/${attId}`);
  assert.equal(r.status, 200);
  r = await user.delete(`/api/journal/attachments/${attId}`);
  assert.equal(r.status, 200);
});

test("N3: 토큰 스코프 격리 — journal:write 전용, 교차 접근 차단", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { user } = await setup(ctx);

  // journal:write 토큰(시리 단축어용) — append는 되고, 저널 밖은 403
  let r = await user.post("/api/tokens").send({ name: "siri", scopes: ["journal:write"] });
  assert.equal(r.status, 201);
  const journalTok = r.body.token;
  r = await request(ctx.app)
    .post("/api/journal/append")
    .set("Authorization", `Bearer ${journalTok}`)
    .send({ text: "시리에서 캡처" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await request(ctx.app).get("/api/my-work").set("Authorization", `Bearer ${journalTok}`);
  assert.equal(r.status, 403, "journal 토큰은 저널 밖 접근 불가");

  // task:write 토큰은 반대로 저널 접근 불가 — 개인 기록이 일반 토큰으로 새지 않게
  r = await user.post("/api/tokens").send({ name: "ci", scopes: ["task:read", "task:write"] });
  const taskTok = r.body.token;
  r = await request(ctx.app)
    .post("/api/journal/append")
    .set("Authorization", `Bearer ${taskTok}`)
    .send({ text: "새어들기" });
  assert.equal(r.status, 403, "task 토큰의 저널 접근 차단");
  r = await request(ctx.app).get("/api/journal/2026-01-01").set("Authorization", `Bearer ${taskTok}`);
  assert.equal(r.status, 403, "읽기도 차단");
  // Express 대소문자 무시 라우팅 우회 차단 — /api/JOURNAL 변형도 라우터 레벨 게이트에 걸림 (N6 검증단 발견)
  r = await request(ctx.app).get("/api/JOURNAL/2026-01-01").set("Authorization", `Bearer ${taskTok}`);
  assert.equal(r.status, 403, "대소문자 변형 우회 차단");
  r = await request(ctx.app).put("/api/Journal/2026-01-01").set("Authorization", `Bearer ${taskTok}`).send({ content: "탈취" });
  assert.equal(r.status, 403, "쓰기 변형도 차단");
});

test("N7: 히트맵·기간 조회(주간 롤업) — 본인 것만, 경계 검증", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, user } = await setup(ctx);

  const today = journalDayKey();
  const daysAgo = (n: number) => journalDayKey(new Date(Date.now() - n * 86400_000));
  await user.put(`/api/journal/${today}`).send({ content: "오늘 기록 — 조금 길게 써본다 ".repeat(10) });
  await user.put(`/api/journal/${daysAgo(3)}`).send({ content: "짧게" });

  // 히트맵: 쓴 날만, chars = 본문 길이
  let r = await user.get("/api/journal/heatmap?weeks=16");
  assert.equal(r.status, 200);
  const keys = r.body.days.map((d: any) => d.entry_date);
  assert.ok(keys.includes(today) && keys.includes(daysAgo(3)), JSON.stringify(keys));
  assert.ok(r.body.days.every((d: any) => d.chars > 0));
  // 프라이버시: 관리자 히트맵에는 남의 기록이 안 잡힘
  r = await admin.get("/api/journal/heatmap?weeks=16");
  assert.equal(r.body.days.length, 0, "관리자에게 타인 히트맵 비노출");

  // 기간 조회: 포함 범위 + 본인 것만
  r = await user.get(`/api/journal/range?from=${daysAgo(6)}&to=${today}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 2);
  r = await admin.get(`/api/journal/range?from=${daysAgo(6)}&to=${today}`);
  assert.equal(r.body.entries.length, 0, "관리자에게 타인 기간 조회 비노출");
  // 경계: from>to, 31일 초과, 형식 오류 전부 400
  r = await user.get(`/api/journal/range?from=${today}&to=${daysAgo(6)}`);
  assert.equal(r.status, 400);
  r = await user.get(`/api/journal/range?from=${daysAgo(40)}&to=${today}`);
  assert.equal(r.status, 400, "31일 초과 거부");
  r = await user.get("/api/journal/range?from=abc&to=def");
  assert.equal(r.status, 400);
});

test("N7: 하루 요약(day-summary) — 완료 태스크+참석 일정, 세션 전용, 본인 것만", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, user } = await setup(ctx);
  const today = journalDayKey();

  // 내 프로젝트에 태스크 만들어 완료 처리(completed_at=지금) + 오늘 개인 일정
  const me = (await user.get("/api/auth/me")).body.user.id;
  const pid = (await user.post("/api/projects").send({ name: "요약검증" })).body.project.id;
  const task = (await user.post(`/api/projects/${pid}/tasks`).send({ title: "요약에 잡힐 일", assignee_ids: [me] })).body.task;
  let r = await user.patch(`/api/tasks/${task.id}`).send({ status: "done" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await user.post("/api/events").send({ title: "요약에 잡힐 회의", starts_at: new Date().toISOString() });
  assert.equal(r.status, 201);

  r = await user.get(`/api/journal/day-summary?date=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tasks.length, 1, "오늘 완료 태스크 1건: " + JSON.stringify(r.body.tasks));
  assert.equal(r.body.tasks[0].item_key, task.item_key);
  assert.equal(r.body.events.length, 1, "오늘 참석 일정 1건");
  assert.ok(r.body.events[0].time, "시간지정 일정은 HH:mm 표시");

  // 프라이버시: 남(관리자)의 요약에는 안 잡힘
  r = await admin.get(`/api/journal/day-summary?date=${today}`);
  assert.equal(r.body.tasks.length + r.body.events.length, 0, "타인 요약 비노출");

  // 세션 전용 — journal:write 토큰(시리)이 태스크·일정 정보까지 읽지 못하게 거부
  const tok = (await user.post("/api/tokens").send({ name: "siri2", scopes: ["journal:write"] })).body.token;
  r = await request(ctx.app).get(`/api/journal/day-summary?date=${today}`).set("Authorization", `Bearer ${tok}`);
  assert.equal(r.status, 403, "토큰 인증 거부");
  r = await user.get("/api/journal/day-summary?date=nope");
  assert.equal(r.status, 400);
});

test("N7: 이미지 OCR 텍스트 검색 병합 — [이미지] 스니펫, 본인 것만", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, user } = await setup(ctx);

  const up = await user.post("/api/journal/2026-03-02/attachments").attach("file", fakePng, "capture.png");
  assert.equal(up.status, 201);
  // mock LLM에선 OCR이 돌지 않으므로(키 없음) 추출 결과를 직접 주입해 검색 병합만 검증
  await db.update(journalAttachments).set({ ocr_text: "리액트 서스펜스는 데이터 로딩 폴백" }).where(eq(journalAttachments.id, up.body.attachment.id));

  let r = await user.get("/api/journal/search?q=" + encodeURIComponent("서스펜스"));
  assert.equal(r.body.results.length, 1, JSON.stringify(r.body.results));
  assert.equal(r.body.results[0].entry_date, "2026-03-02");
  assert.ok(r.body.results[0].snippet.startsWith("[이미지"), "이미지 출처 표시: " + r.body.results[0].snippet);

  // 본문 매치가 있는 날은 중복으로 안 뜸
  await user.put("/api/journal/2026-03-02").send({ content: "서스펜스 본문 메모" });
  r = await user.get("/api/journal/search?q=" + encodeURIComponent("서스펜스"));
  assert.equal(r.body.results.length, 1, "같은 날 본문+이미지 매치는 1건으로");
  assert.ok(!r.body.results[0].snippet.startsWith("[이미지"), "본문 매치 우선");

  // 프라이버시: 타인(관리자) 검색에 안 잡힘
  r = await admin.get("/api/journal/search?q=" + encodeURIComponent("서스펜스"));
  assert.equal(r.body.results.length, 0);
});

test("N7: AI 검색에 내 기록 포함 — 본인 것만, 프로젝트 지정 시 제외", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, user } = await setup(ctx);

  await user.put("/api/journal/2026-04-01").send({ content: "제이쿼리금지원칙 — 신규 코드는 리액트로만" });

  // 전체 검색: journal 소스 포함 (임베딩은 mock — 저널 병합만 확인)
  let r = await user.post("/api/ai/search").send({ q: "제이쿼리금지원칙" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const jhits = r.body.results.filter((h: any) => h.source_type === "journal");
  assert.equal(jhits.length, 1, JSON.stringify(r.body.results));
  assert.equal(jhits[0].entry_date, "2026-04-01");
  assert.equal(jhits[0].score, null, "저널은 유사도 점수 없음");

  // ask 출처에도 포함
  r = await user.post("/api/ai/ask").send({ q: "제이쿼리금지원칙" });
  assert.ok(r.body.sources.some((s: any) => s.source_type === "journal"), JSON.stringify(r.body.sources));

  // 프라이버시: 타인(관리자) 검색에는 안 섞임
  r = await admin.post("/api/ai/search").send({ q: "제이쿼리금지원칙" });
  assert.equal(r.body.results.filter((h: any) => h.source_type === "journal").length, 0, "타인 저널 비노출");

  // 프로젝트를 특정하면 저널 제외 (저널은 프로젝트 소속이 아님)
  const pid = (await user.post("/api/projects").send({ name: "AI검증" })).body.project.id;
  r = await user.post("/api/ai/search").send({ q: "제이쿼리금지원칙", project_id: pid });
  assert.equal(r.body.results.filter((h: any) => h.source_type === "journal").length, 0, "프로젝트 지정 시 저널 제외");

  // ★ 토큰 인증(세션 아님)은 저널 병합 금지 — task:read 토큰이 AI 검색으로 개인 저널을 빼가지 못하게
  const tok = (await user.post("/api/tokens").send({ name: "ci-ai", scopes: ["task:read"] })).body.token;
  r = await request(ctx.app).post("/api/ai/search").set("Authorization", `Bearer ${tok}`).send({ q: "제이쿼리금지원칙" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results.filter((h: any) => h.source_type === "journal").length, 0, "토큰 인증엔 저널 병합 금지");
  r = await request(ctx.app).post("/api/ai/ask").set("Authorization", `Bearer ${tok}`).send({ q: "제이쿼리금지원칙" });
  assert.equal(r.body.sources.filter((h: any) => h.source_type === "journal").length, 0, "ask도 토큰엔 저널 미포함");
});

test("U: 빈 기록은 남기지 않는다 — 단 이미지-only 날은 앵커로 유지·표시", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { user } = await setup(ctx);

  // 1) 텍스트 썼다가 비우면 행 자체가 사라진다(월 목록 유령 점 방지)
  let r = await user.put("/api/journal/2026-05-10").send({ content: "임시 메모" });
  assert.equal(r.status, 200);
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 1, "쓴 날은 목록에 있다");
  r = await user.put("/api/journal/2026-05-10").send({ content: "   " }); // 공백만 = 비움
  assert.equal(r.status, 200);
  assert.equal(r.body.entry, null, "빈 저장은 행을 지우고 null 반환");
  r = await user.get("/api/journal/2026-05-10");
  assert.equal(r.body.entry, null, "행이 실제로 삭제됨");
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 0, "빈 날은 월 목록에서 사라진다(유령 점 없음)");

  // 없던 날에 빈 저장 = 행 생성도 안 함(유령 생성 방지)
  r = await user.put("/api/journal/2026-05-09").send({ content: "" });
  assert.equal(r.body.entry, null);
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 0);

  // 2) 이미지만 올린 날 — 빈 행 앵커로 목록에 남고 image_count로 표시
  const up = await user.post("/api/journal/2026-05-11/attachments").attach("file", fakePng, "shot.png");
  assert.equal(up.status, 201, JSON.stringify(up.body));
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 1, "이미지-only 날은 목록에 있다");
  assert.equal(r.body.days[0].entry_date, "2026-05-11");
  assert.equal(r.body.days[0].preview, "", "텍스트 없음");
  assert.equal(r.body.days[0].image_count, 1, "이미지 개수 표시");

  // 3) 첨부 있는 날은 빈 저장에도 앵커 행 유지(이미지가 목록에서 사라지지 않게)
  r = await user.put("/api/journal/2026-05-11").send({ content: "" });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.entry, null, "첨부 있으면 빈 행 유지(null 아님)");
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 1, "이미지-only 날 여전히 목록에");

  // 4) 마지막 이미지를 지우면 앵커 빈 행도 정리 → 날이 목록에서 사라진다
  r = await user.delete(`/api/journal/attachments/${up.body.attachment.id}`);
  assert.equal(r.status, 200);
  r = await user.get("/api/journal/2026-05-11");
  assert.equal(r.body.entry, null, "고아 빈 행이 정리됨");
  r = await user.get("/api/journal?month=2026-05");
  assert.equal(r.body.days.length, 0, "이미지 지운 날은 목록에서 사라진다");

  // 5) 텍스트+이미지 날에서 이미지만 지우면 본문이 있으니 행 유지
  await user.put("/api/journal/2026-05-12").send({ content: "본문 있음" });
  const up2 = await user.post("/api/journal/2026-05-12/attachments").attach("file", fakePng, "s2.png");
  assert.equal(up2.status, 201);
  r = await user.delete(`/api/journal/attachments/${up2.body.attachment.id}`);
  assert.equal(r.status, 200);
  r = await user.get("/api/journal/2026-05-12");
  assert.equal(r.body.entry?.content, "본문 있음", "본문 있으면 이미지 삭제해도 행 유지");

  // 6) 본문 있는 날에 이미지 업로드해도 본문 보존 — 앵커 생성이 본문을 ""로 덮지 않는다(onConflictDoNothing)
  await user.put("/api/journal/2026-05-13").send({ content: "지켜야 할 본문" });
  const up3 = await user.post("/api/journal/2026-05-13/attachments").attach("file", fakePng, "s3.png");
  assert.equal(up3.status, 201);
  r = await user.get("/api/journal/2026-05-13");
  assert.equal(r.body.entry?.content, "지켜야 할 본문", "이미지 업로드가 본문을 덮지 않음");
});

test("W: 조회 필터 — 배포 전 남은 빈 앵커는 월목록·히트맵·주간롤업에서 제외", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { user } = await setup(ctx);
  const me = (await user.get("/api/auth/me")).body.user.id;

  // 수정 배포 전에 남아있던 빈 앵커를 직접 insert로 재현(saveEntry 우회 — 과거 유령 데이터)
  await db.insert(journalEntries).values({ user_id: me, entry_date: "2026-06-01", content: "" });
  await db.insert(journalEntries).values({ user_id: me, entry_date: "2026-06-02", content: "   " }); // 공백만
  await db.insert(journalEntries).values({ user_id: me, entry_date: "2026-06-03", content: "진짜 내용" });

  // 월목록: 내용 있는 날만 (빈·공백 앵커 제외 — 조회 필터가 과거 유령을 숨김)
  let r = await user.get("/api/journal?month=2026-06");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.days.map((d: any) => d.entry_date), ["2026-06-03"], "빈 앵커 제외: " + JSON.stringify(r.body.days));

  // 이미지-only 날은 유지(첨부 있음) + image_count
  const up = await user.post("/api/journal/2026-06-04/attachments").attach("file", fakePng, "x.png");
  assert.equal(up.status, 201);
  r = await user.get("/api/journal?month=2026-06");
  assert.deepEqual(r.body.days.map((d: any) => d.entry_date).sort(), ["2026-06-03", "2026-06-04"], "이미지-only 날 유지");
  assert.equal(r.body.days.find((d: any) => d.entry_date === "2026-06-04").image_count, 1);

  // 주간 롤업(range): 텍스트 있는 날만 (이미지-only·빈 앵커 제외)
  r = await user.get("/api/journal/range?from=2026-06-01&to=2026-06-04");
  assert.deepEqual(r.body.entries.map((e: any) => e.entry_date), ["2026-06-03"], "롤업은 텍스트 있는 날만");

  // 히트맵(상대 날짜): 빈 앵커 제외, 내용 있는 날 포함
  const daysAgo = (n: number) => journalDayKey(new Date(Date.now() - n * 86400_000));
  await db.insert(journalEntries).values({ user_id: me, entry_date: daysAgo(1), content: "" });        // 빈 앵커
  await db.insert(journalEntries).values({ user_id: me, entry_date: daysAgo(2), content: "히트맵 내용" }); // 내용
  r = await user.get("/api/journal/heatmap?weeks=16");
  const hd = r.body.days.map((d: any) => d.entry_date);
  assert.ok(hd.includes(daysAgo(2)), "히트맵에 내용 있는 날 포함");
  assert.ok(!hd.includes(daysAgo(1)), "히트맵에서 빈 앵커 제외: " + JSON.stringify(hd));
});
