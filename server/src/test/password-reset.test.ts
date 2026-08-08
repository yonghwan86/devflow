// Y: 비밀번호 재설정 — 열거 방지 · 1회용 · 만료 · 잠금 해제 · 권한 · 메일 실패 경로
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./harness.ts";
import { db } from "../lib/db.ts";
import { passwordResets, users } from "../../../shared/schema.ts";
import { isMailEnabled, sendMail, resetMailTransportForTest } from "../lib/mail.ts";

test("Y: 재설정 요청은 계정 유무를 드러내지 않는다(열거 방지)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const a = request.agent(ctx.app);
  await a.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });

  const exists = await a.post("/api/auth/forgot-password").send({ email: "admin@x.com" });
  const missing = await a.post("/api/auth/forgot-password").send({ email: "nobody@x.com" });

  assert.equal(exists.status, 200);
  assert.equal(missing.status, 200);
  // 상태코드뿐 아니라 본문도 완전히 같아야 한다 — 다르면 그 자체가 열거 단서다.
  assert.deepEqual(exists.body, missing.body);

  // 실제로는 존재하는 계정에만 토큰이 생긴다(응답으로는 구분 불가).
  const rows = await db.select().from(passwordResets);
  assert.equal(rows.length, 1, "존재하는 계정 1건만 토큰 발급");
  assert.equal(rows[0].issued_by, null, "본인 요청은 issued_by=null");
});

test("Y: 관리자 발급 → 재설정 → 새 비밀번호로 로그인, 1회용·만료 보장", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await member.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  const uid = (await member.get("/api/auth/me")).body.user.id;

  // 권한: 일반 유저는 발급 불가
  let r = await member.post(`/api/admin/users/${uid}/reset-link`).send({});
  assert.equal(r.status, 403, "관리자 아님 → 403");

  // 관리자 발급 — 평문 링크는 이때 한 번만
  r = await admin.post(`/api/admin/users/${uid}/reset-link`).send({});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const url = new URL(r.body.reset_url);
  const token = url.searchParams.get("token")!;
  assert.ok(token && token.length > 20, "토큰이 링크에 담김");
  assert.equal(url.pathname, "/reset");

  // 감사 추적: 관리자 발급은 issued_by가 남는다
  const [row] = await db.select().from(passwordResets).where(eq(passwordResets.user_id, uid));
  assert.ok(row.issued_by, "관리자 발급은 issued_by 기록");

  // 짧은 비밀번호 거부
  r = await request(ctx.app).post("/api/auth/reset-password").send({ token, password: "short" });
  assert.equal(r.status, 400);

  // 재설정 성공 → 자동 로그인
  const fresh = request.agent(ctx.app);
  r = await fresh.post("/api/auth/reset-password").send({ token, password: "newpassword1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email, "u@x.com");
  assert.equal((await fresh.get("/api/auth/me")).body.user.id, uid, "재설정 직후 로그인 상태");

  // 새 비밀번호로 로그인되고, 옛 비밀번호는 막힌다
  const relog = request.agent(ctx.app);
  assert.equal((await relog.post("/api/auth/login").send({ email: "u@x.com", password: "newpassword1" })).status, 200);
  assert.equal((await relog.post("/api/auth/login").send({ email: "u@x.com", password: "password123" })).status, 401);

  // 1회용: 같은 토큰 재사용 불가
  r = await request(ctx.app).post("/api/auth/reset-password").send({ token, password: "another12345" });
  assert.equal(r.status, 400, "이미 사용된 토큰 거부");

  // 만료: 새 토큰을 과거로 돌려놓으면 거부
  const issued = (await admin.post(`/api/admin/users/${uid}/reset-link`).send({})).body.reset_url;
  const t2 = new URL(issued).searchParams.get("token")!;
  await db.update(passwordResets).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(passwordResets.user_id, uid));
  r = await request(ctx.app).post("/api/auth/reset-password").send({ token: t2, password: "another12345" });
  assert.equal(r.status, 400, "만료 토큰 거부");
});

test("Y: 재설정은 계정 잠금을 함께 푼다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await member.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  const uid = (await member.get("/api/auth/me")).body.user.id;

  // 비번을 잊고 5번 틀려 잠긴 상태 — 재설정의 현실적인 출발점
  for (let i = 0; i < 5; i++) await request(ctx.app).post("/api/auth/login").send({ email: "u@x.com", password: "wrongpass" });
  const [locked] = await db.select().from(users).where(eq(users.id, uid));
  assert.ok(locked.locked_until, "5회 실패로 잠김");
  assert.equal((await request(ctx.app).post("/api/auth/login").send({ email: "u@x.com", password: "password123" })).status, 429);

  const url = (await admin.post(`/api/admin/users/${uid}/reset-link`).send({})).body.reset_url;
  const token = new URL(url).searchParams.get("token")!;
  assert.equal((await request(ctx.app).post("/api/auth/reset-password").send({ token, password: "newpassword1" })).status, 200);

  // 잠금이 안 풀리면 새 비번으로도 못 들어간다 — 이 케이스가 회귀의 핵심
  const [after] = await db.select().from(users).where(eq(users.id, uid));
  assert.equal(after.locked_until, null, "잠금 해제");
  assert.equal(after.failed_login_count, 0);
  assert.equal((await request(ctx.app).post("/api/auth/login").send({ email: "u@x.com", password: "newpassword1" })).status, 200);
});

test("Y: 로그인 상태 비밀번호 변경 — 현재 비밀번호 확인 필수", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const a = request.agent(ctx.app);
  await a.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });

  // 비로그인 거부
  assert.equal(
    (await request(ctx.app).post("/api/auth/change-password").send({ current_password: "password123", new_password: "newpassword1" })).status,
    401,
  );
  // 현재 비밀번호 틀리면 거부
  assert.equal((await a.post("/api/auth/change-password").send({ current_password: "wrongpass", new_password: "newpassword1" })).status, 400);
  // 새 비밀번호 길이 검증
  assert.equal((await a.post("/api/auth/change-password").send({ current_password: "password123", new_password: "short" })).status, 400);

  // 성공 → 현재 기기는 로그인 유지, 새 비밀번호로 재로그인 가능
  assert.equal((await a.post("/api/auth/change-password").send({ current_password: "password123", new_password: "newpassword1" })).status, 200);
  assert.equal((await a.get("/api/auth/me")).body.user.email, "admin@x.com", "변경해도 이 기기는 유지");
  const relog = request.agent(ctx.app);
  assert.equal((await relog.post("/api/auth/login").send({ email: "admin@x.com", password: "newpassword1" })).status, 200);
});

test("Y: 비활성 계정에는 발급하지 않는다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await member.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  const uid = (await member.get("/api/auth/me")).body.user.id;
  await db.update(users).set({ is_active: false }).where(eq(users.id, uid));

  assert.equal((await admin.post(`/api/admin/users/${uid}/reset-link`).send({})).status, 400, "비활성 계정 발급 거부");
  // 셀프 요청도 토큰을 만들지 않는다(응답은 여전히 동일 — 열거 방지)
  assert.equal((await request(ctx.app).post("/api/auth/forgot-password").send({ email: "u@x.com" })).status, 200);
  assert.equal((await db.select().from(passwordResets)).length, 0, "비활성 계정엔 토큰 미발급");
});

// ── 멀티에이전트 검증에서 확정된 결함들의 회귀 테스트 ──

test("Y: 재설정 링크 발급은 세션 전용 — Bearer 토큰으로는 못 한다(C5 규약)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await member.post("/api/auth/signup").send({ email: "u@x.com", password: "password123", full_name: "유저" });
  const uid = (await member.get("/api/auth/me")).body.user.id;

  // 관리자 본인이 발급한 제한 스코프 토큰(시리 단축어·MCP용 정상 사용법)
  const tok = (await admin.post("/api/tokens").send({ name: "mcp", scopes: ["task:write"] })).body.token;
  assert.ok(tok, "토큰 발급됨");

  // 이 토큰으로 재설정 링크를 받아낼 수 있으면 = task:write 하나가 전 계정 탈취권이 된다
  const r = await request(ctx.app).post(`/api/admin/users/${uid}/reset-link`).set("Authorization", `Bearer ${tok}`).send({});
  assert.equal(r.status, 403, "Bearer 경로 차단");

  // 같은 관리자라도 세션으로는 정상 발급
  assert.equal((await admin.post(`/api/admin/users/${uid}/reset-link`).send({})).status, 201);
});

test("Y: 메일 링크는 요청 헤더가 아니라 APP_BASE_URL로 만든다(링크 포이즈닝 차단)", async () => {
  const { mailLinkBase, resetUrl } = await import("../lib/passwordReset.ts");
  const { baseUrl } = await import("../lib/http.ts");

  // baseUrl(req)는 설계상 헤더로 폴백한다 — 그래서 메일 링크에 쓰면 안 된다.
  const poisoned = baseUrl({ get: (h: string) => (h === "x-forwarded-host" ? "evil.tld" : undefined), protocol: "http" } as any);
  assert.match(poisoned, /evil\.tld/, "baseUrl은 헤더를 신뢰한다(기존 동작)");

  // 메일 경로는 헤더와 무관해야 한다
  const link = resetUrl(mailLinkBase(), "tok");
  assert.ok(!link.includes("evil.tld"), "메일 링크에 헤더 호스트가 섞이지 않음");
  assert.ok(link.startsWith(process.env.APP_BASE_URL ?? "http://localhost:5000"), "APP_BASE_URL 기준");
});

test("Y: 메일 본문은 링크를 이스케이프한다(정품 도메인 피싱 차단)", async () => {
  const { resetMailBody } = await import("../lib/passwordReset.ts");
  const evil = `https://x"><a href="https://phish.tld">여기</a><b href="`;
  const body = resetMailBody("홍길동", evil);
  assert.ok(!body.html.includes('"><a href="https://phish.tld"'), "href를 닫고 나오는 마크업 주입 불가");
  assert.ok(body.html.includes("&quot;") || body.html.includes("&lt;"), "이스케이프 적용됨");
});

test("Y: 재설정하면 그 사용자의 API 토큰도 폐기된다(세션만 끊으면 Bearer 뒷문이 남는다)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const admin = request.agent(ctx.app);
  const victim = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await victim.post("/api/auth/signup").send({ email: "v@x.com", password: "password123", full_name: "피해자" });
  const uid = (await victim.get("/api/auth/me")).body.user.id;

  // 침입자가 미리 심어둔(=피해자 계정으로 발급된) 무기한 토큰
  const tok = (await victim.post("/api/tokens").send({ name: "backdoor", scopes: ["task:read"] })).body.token;
  assert.equal((await request(ctx.app).get("/api/projects").set("Authorization", `Bearer ${tok}`)).status, 200, "재설정 전에는 동작");

  const url = (await admin.post(`/api/admin/users/${uid}/reset-link`).send({})).body.reset_url;
  const token = new URL(url).searchParams.get("token")!;
  assert.equal((await request(ctx.app).post("/api/auth/reset-password").send({ token, password: "newpassword1" })).status, 200);

  // 비밀번호를 되찾았는데 침입자 토큰이 살아 있으면 복구가 아니다
  assert.equal(
    (await request(ctx.app).get("/api/projects").set("Authorization", `Bearer ${tok}`)).status,
    401,
    "재설정 후 Bearer 토큰 폐기됨",
  );
});

// ── 메일 실패 경로 (전역 규칙: 외부 발송은 실패 경로를 실제로 유발해 확인) ──
test("Y: 메일 미설정이면 조용히 꺼지고, 발송 실패해도 throw하지 않는다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_PORT;
    resetMailTransportForTest();
    return ctx.close();
  });

  // ① 미설정 → 비활성. 로그인 화면이 안내 문구를 바꿀 수 있게 상태가 노출된다.
  resetMailTransportForTest();
  assert.equal(isMailEnabled(), false, "SMTP 미설정 → 비활성");
  assert.equal((await request(ctx.app).get("/api/auth/bootstrap-status")).body.mail_enabled, false);
  assert.equal(await sendMail({ to: "a@b.com", subject: "s", text: "t" }), false, "미설정 발송은 false");

  // ② 설정은 됐지만 서버가 죽어 있는 경우 — 실제로 연결 실패를 유발한다(127.0.0.1:1 = 즉시 거부).
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = "1";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
  resetMailTransportForTest();
  assert.equal(isMailEnabled(), true, "설정되면 활성");
  assert.equal((await request(ctx.app).get("/api/auth/bootstrap-status")).body.mail_enabled, true);
  const sent = await sendMail({ to: "a@b.com", subject: "s", text: "t" });
  assert.equal(sent, false, "발송 실패는 throw가 아니라 false");

  // ③ 발송이 실패해도 요청 자체는 정상 응답 — 실패가 계정 존재 여부를 알려주면 안 된다.
  await request(ctx.app).post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  const r = await request(ctx.app).post("/api/auth/forgot-password").send({ email: "admin@x.com" });
  assert.equal(r.status, 200, "메일이 죽어도 200 — 폴백(관리자 발급)으로 복구");
  assert.equal((await db.select().from(passwordResets)).length, 1, "메일 실패와 무관하게 토큰은 발급됨");
});
