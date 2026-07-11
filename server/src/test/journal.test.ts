// N3: 내 기록(개인 저널) — 하루 한 장 upsert·append 시각 스탬프·검색,
// 프라이버시(본인 외·관리자 완전 차단), 토큰 스코프 격리(journal:write 전용).
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";

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
