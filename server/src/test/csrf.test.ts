// R0-3: CSRF 방어(커스텀 헤더 X-DevFlow-CSRF) — 세션 인증 mutating 요청만 대상.
// 이 파일은 harness의 testAutoCsrfHeader 없이 createApp({})으로 실제 동작을 검증한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestDb } from "../lib/db.ts";
import { createApp } from "../app.ts";

test("CSRF: 세션 mutating 요청은 X-DevFlow-CSRF 헤더 필수", async (t) => {
  const { close } = await createTestDb();
  t.after(() => close());
  const app = createApp({});
  const agent = request.agent(app);

  // 세션 없는 POST(bootstrap/login)는 CSRF 비대상 — 가입·로그인 플로우 무손상
  let r = await agent.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // ① 세션 POST, 헤더 없음 → 403
  r = await agent.post("/api/projects").send({ name: "P1" });
  assert.equal(r.status, 403, "세션 mutating 요청은 헤더 없이는 거부: " + JSON.stringify(r.body));

  // ② 세션 POST, 헤더 있음 → 통과
  r = await agent.post("/api/projects").set("X-DevFlow-CSRF", "1").send({ name: "P1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pid = r.body.project.id;

  // 세션 PATCH/DELETE도 동일 규칙
  r = await agent.patch(`/api/projects/${pid}`).send({ name: "P1-변경" });
  assert.equal(r.status, 403, "PATCH도 헤더 필수");
  r = await agent.patch(`/api/projects/${pid}`).set("X-DevFlow-CSRF", "1").send({ name: "P1-변경" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // GET은 헤더 불필요
  r = await agent.get(`/api/projects/${pid}/tasks`);
  assert.equal(r.status, 200);

  // ③ Bearer 토큰 요청은 헤더 없어도 통과 (CSRF 비대상)
  const tok = await agent
    .post("/api/tokens")
    .set("X-DevFlow-CSRF", "1")
    .send({ name: "t", scopes: ["task:read", "task:write", "project:read"] });
  assert.equal(tok.status, 201, JSON.stringify(tok.body));
  r = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${tok.body.token}`)
    .send({ name: "P2" });
  assert.equal(r.status, 201, "Bearer는 CSRF 헤더 불필요: " + JSON.stringify(r.body));

  // ④ 웹훅 POST(세션·Bearer 없음)는 CSRF에 걸리지 않고 라우트에 도달(서명 검증 401)
  r = await request(app)
    .post("/api/webhooks/github")
    .set("Content-Type", "application/json")
    .send({ zen: "keep it logically awesome" });
  assert.equal(r.status, 401, "웹훅은 CSRF 미적용(403 아님) — 서명 검증 단계 도달: " + JSON.stringify(r.body));
});
