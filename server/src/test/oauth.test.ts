// MCP OAuth 2.1 — DCR → authorize(동의) → token(PKCE) → MCP 호출 → refresh 로테이션
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

const REDIRECT = "https://claude.example/callback";

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(app: any) {
  const r = await request(app).post("/oauth/register").send({ redirect_uris: [REDIRECT], client_name: "Claude" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.client_id as string;
}

async function loginAgent(app: any) {
  const agent = request.agent(app);
  await agent.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await agent.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  return agent;
}

function authUrl(clientId: string, challenge: string, extra = "") {
  return `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("task:read task:write project:read")}&state=xyz${extra}`;
}

test("MCP OAuth 전체 플로우: 메타데이터·DCR·동의·PKCE·MCP·refresh", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());

  // 메타데이터 (RFC 8414 / 9728)
  let r = await request(ctx.app).get("/.well-known/oauth-authorization-server");
  assert.equal(r.status, 200);
  assert.ok(String(r.body.authorization_endpoint).endsWith("/oauth/authorize"));
  assert.ok(String(r.body.token_endpoint).endsWith("/oauth/token"));
  assert.deepEqual(r.body.code_challenge_methods_supported, ["S256"]);

  r = await request(ctx.app).get("/.well-known/oauth-protected-resource");
  assert.equal(r.status, 200);
  assert.ok(String(r.body.resource).endsWith("/api/mcp"));
  assert.ok(Array.isArray(r.body.authorization_servers) && r.body.authorization_servers.length === 1);

  // 무토큰 MCP → 401 + WWW-Authenticate(resource_metadata)
  r = await request(ctx.app).post("/api/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.match(r.headers["www-authenticate"] ?? "", /resource_metadata=/);

  // 동적 클라이언트 등록 + 로그인
  const clientId = await registerClient(ctx.app);
  const agent = await loginAgent(ctx.app);

  // authorize (세션 有) → 동의 페이지 + nonce
  const { verifier, challenge } = pkce();
  r = await agent.get(authUrl(clientId, challenge));
  assert.equal(r.status, 200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(r.text)?.[1];
  assert.ok(nonce, "동의 페이지 nonce");

  // 동의 → redirect_uri?code=...&state=xyz
  r = await agent.post("/oauth/authorize/decision").type("form").send({ decision: "allow", nonce });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.location);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "xyz");
  const code = loc.searchParams.get("code")!;
  assert.ok(code);

  // 토큰 교환(PKCE)
  r = await request(ctx.app).post("/oauth/token").type("form")
    .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const access = r.body.access_token, refresh = r.body.refresh_token;
  assert.ok(access && refresh);
  assert.equal(r.body.token_type, "Bearer");

  // 액세스 토큰으로 MCP tools/list (JSON — Accept에 SSE 없음)
  r = await request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${access}`)
    .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.result.tools) && r.body.result.tools.length >= 6);

  // claude.ai 호환: Accept에 text/event-stream이면 SSE로 응답 + 요청 protocolVersion echo
  r = await request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${access}`)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"] ?? "", /text\/event-stream/);
  assert.match(r.text, /event: message/);
  assert.match(r.text, /"protocolVersion":"2025-06-18"/);

  // list_projects로 프로젝트 발견 → create_task (Claude가 이름→id 매핑에 사용)
  const proj = (await agent.post("/api/projects").send({ name: "MCP프로젝트" })).body.project;
  const mcpCall = (id: number, toolName: string, args: any) =>
    request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${access}`)
      .send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: args } });

  r = await mcpCall(4, "list_projects", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const listed = JSON.parse(r.body.result.content[0].text).projects;
  assert.ok(listed.some((p: any) => p.id === proj.id && p.name === "MCP프로젝트"), "list_projects에 생성 프로젝트 포함");

  r = await mcpCall(5, "create_task", { project_id: proj.id, title: "MCP로 만든 태스크" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(JSON.parse(r.body.result.content[0].text).task?.item_key, "MCP create_task 성공");

  // 코드 재사용 차단
  r = await request(ctx.app).post("/oauth/token").type("form")
    .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_grant");

  // refresh 로테이션 → 새 액세스 동작, 옛 refresh 무효
  r = await request(ctx.app).post("/oauth/token").type("form")
    .send({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const access2 = r.body.access_token;
  assert.ok(access2 && access2 !== access);
  r = await request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${access2}`)
    .send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(r.status, 200);
  r = await request(ctx.app).post("/oauth/token").type("form")
    .send({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
  assert.equal(r.status, 400, "로테이션된 옛 리프레시 토큰은 무효");
});

test("MCP OAuth 보안: PKCE 불일치·미등록 redirect_uri·무세션 왕복", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const clientId = await registerClient(ctx.app);
  const agent = await loginAgent(ctx.app);

  // 미등록 redirect_uri → 에러 페이지(리다이렉트 금지)
  let r = await agent.get(`/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=x&code_challenge_method=S256`);
  assert.equal(r.status, 400);

  // 정상 authorize → code 획득
  const { verifier, challenge } = pkce();
  r = await agent.get(authUrl(clientId, challenge));
  const nonce = /name="nonce" value="([^"]+)"/.exec(r.text)?.[1];
  r = await agent.post("/oauth/authorize/decision").type("form").send({ decision: "allow", nonce });
  const code = new URL(r.headers.location).searchParams.get("code")!;

  // 잘못된 code_verifier → invalid_grant
  r = await request(ctx.app).post("/oauth/token").type("form")
    .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: "wrong-verifier" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_grant");

  // 무세션 authorize → SPA 로그인으로 왕복(302 → /?oauth_return=...)
  const noSession = pkce();
  r = await request(ctx.app).get(authUrl(clientId, noSession.challenge));
  assert.equal(r.status, 302);
  assert.match(r.headers.location ?? "", /^\/\?oauth_return=/);

  // 거부(deny) → error=access_denied
  const d = pkce();
  r = await agent.get(authUrl(clientId, d.challenge));
  const nonce2 = /name="nonce" value="([^"]+)"/.exec(r.text)?.[1];
  r = await agent.post("/oauth/authorize/decision").type("form").send({ decision: "deny", nonce: nonce2 });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.location).searchParams.get("error"), "access_denied");
});
