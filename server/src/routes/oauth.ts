import express, { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { oauthClients, oauthAuthCodes, apiTokens } from "../../../shared/schema.ts";
import { baseUrl } from "../lib/http.ts";
import { hashApiToken } from "../lib/crypto.ts";
import { currentUser } from "../middleware/auth.ts";
import {
  OAUTH_SCOPES,
  AUTH_CODE_TTL_MS,
  ACCESS_TOKEN_TTL_MS,
  hashOauthSecret,
  verifyPkceS256,
  newAuthCode,
  newAccessToken,
  newRefreshToken,
  newClientId,
  newNonce,
  sanitizeScopes,
  isValidRedirectUri,
} from "../lib/oauth.ts";

// MCP OAuth 2.1 인가 서버 — Claude "커스텀 커넥터"가 URL만으로 붙도록 지원(RFC 9728/8414/7591 + PKCE).
// 액세스 토큰은 api_tokens에 저장 → 기존 Bearer 미들웨어가 그대로 인정.

const SCOPE_LABEL: Record<string, string> = {
  "task:read": "태스크 읽기",
  "task:write": "태스크 생성/수정",
  "guide:write": "가이드 작성/수행 표시",
  "project:read": "프로젝트/검색 읽기",
};

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// redirect_uri에 code/error를 붙여 안전하게 리다이렉트 URL 생성
function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f8fa;color:#1e293b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;max-width:420px;width:100%;padding:28px;box-shadow:0 4px 24px rgba(15,23,42,.06)}
h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:14px;margin:0 0 20px}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:18px;font-weight:800}.brand .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#6366f1,#4338ca);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}
ul.scopes{list-style:none;padding:0;margin:0 0 22px}ul.scopes li{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #eef2f7;border-radius:10px;margin-bottom:6px;font-size:14px}
ul.scopes li::before{content:"";width:7px;height:7px;border-radius:50%;background:#6366f1;flex:none}
.who{font-size:13px;color:#64748b;background:#f8fafc;border:1px solid #eef2f7;border-radius:10px;padding:10px 12px;margin-bottom:18px}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:700;padding:11px;border-radius:10px;border:1px solid transparent;cursor:pointer}
button.allow{background:#4f46e5;color:#fff}button.allow:hover{background:#4338ca}button.deny{background:#fff;border-color:#e2e8f0;color:#475569}button.deny:hover{background:#f1f5f9}
.err{color:#e11d48}code{background:#f1f5f9;border-radius:6px;padding:1px 6px;font-size:13px}
</style></head><body><div class="card"><div class="brand"><span class="logo">D</span>DevFlow</div>${bodyHtml}</div></body></html>`;
}

export function oauthRouter(): Router {
  const r = Router();
  // 토큰/등록/동의 폼은 form-urlencoded 또는 JSON — 전역 json 이후 urlencoded도 파싱.
  r.use(express.urlencoded({ extended: false }));

  const meta = (req: Request) => {
    const base = baseUrl(req);
    return { base, resource: `${base}/api/mcp` };
  };

  // ── RFC 9728: Protected Resource Metadata ──
  r.get("/.well-known/oauth-protected-resource", (req, res) => {
    const { base, resource } = meta(req);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      resource,
      authorization_servers: [base],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
  // 일부 클라이언트는 리소스 경로를 붙여 조회(/.well-known/oauth-protected-resource/api/mcp)
  r.get("/.well-known/oauth-protected-resource/*", (req, res) => {
    const { base, resource } = meta(req);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ resource, authorization_servers: [base], scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ["header"] });
  });

  // ── RFC 8414: Authorization Server Metadata ──
  r.get("/.well-known/oauth-authorization-server", (req, res) => {
    const { base } = meta(req);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OAUTH_SCOPES,
    });
  });

  // ── RFC 7591: Dynamic Client Registration ──
  r.post("/oauth/register", async (req, res) => {
    const body = req.body ?? {};
    const uris: unknown = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && isValidRedirectUri(u))) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris는 https 또는 localhost여야 합니다." });
    }
    const clientId = newClientId();
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;
    await db.insert(oauthClients).values({ client_id: clientId, client_name: clientName, redirect_uris: JSON.stringify(uris) });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName ?? undefined,
    });
  });

  // ── Authorization endpoint (사용자 브라우저) ──
  r.get("/oauth/authorize", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";

    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.client_id, clientId)).limit(1);
    const registered: string[] = client ? JSON.parse(client.redirect_uris) : [];
    // client_id / redirect_uri가 신뢰 불가면 리다이렉트 금지 — 에러 페이지 표시(오픈 리다이렉트 방지).
    if (!client || !redirectUri || !registered.includes(redirectUri)) {
      return res.status(400).send(page("연결 오류", `<h1 class="err">연결할 수 없어요</h1><p class="sub">클라이언트 등록 정보(redirect_uri)가 올바르지 않습니다. Claude에서 커넥터를 다시 추가해 보세요.</p>`));
    }
    // 여기부터는 redirect_uri가 검증됨 → 파라미터 오류는 redirect_uri로 error 회신
    if (q.response_type !== "code")
      return res.redirect(redirectWith(redirectUri, { error: "unsupported_response_type", state: q.state }));
    if (!q.code_challenge || q.code_challenge_method !== "S256")
      return res.redirect(redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE S256 필요", state: q.state }));

    // 로그인 세션 없으면 SPA 로그인으로 왕복(로그인 후 이 URL로 복귀)
    if (!req.session?.userId) {
      return res.redirect(`/?oauth_return=${encodeURIComponent(req.originalUrl)}`);
    }
    const user = await currentUser(req);
    if (!user) return res.redirect(`/?oauth_return=${encodeURIComponent(req.originalUrl)}`);

    const scopes = sanitizeScopes(q.scope);
    const nonce = newNonce();
    (req.session as any).oauthReq = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      scope: scopes.join(" "),
      resource: q.resource ?? null,
      state: q.state ?? null,
      nonce,
    };
    const scopeList = scopes.map((s) => `<li>${esc(SCOPE_LABEL[s] ?? s)}</li>`).join("");
    res.send(page("연결 승인",
      `<h1>${esc(client.client_name ?? "외부 앱")} 연결</h1>
       <p class="sub">이 앱이 아래 권한으로 DevFlow에 접근하도록 허용할까요?</p>
       <ul class="scopes">${scopeList}</ul>
       <div class="who">로그인 계정: <b>${esc(user.full_name ?? user.email)}</b> · ${esc(user.email)}</div>
       <form method="post" action="/oauth/authorize/decision" class="row">
         <input type="hidden" name="nonce" value="${esc(nonce)}">
         <button class="deny" name="decision" value="deny">거부</button>
         <button class="allow" name="decision" value="allow">허용</button>
       </form>`));
  });

  // ── 동의 결정 ──
  r.post("/oauth/authorize/decision", async (req, res) => {
    const pending = (req.session as any)?.oauthReq;
    if (!req.session?.userId || !pending || !req.body?.nonce || req.body.nonce !== pending.nonce) {
      return res.status(400).send(page("만료됨", `<h1 class="err">요청이 만료됐어요</h1><p class="sub">Claude에서 다시 연결을 시도해 주세요.</p>`));
    }
    delete (req.session as any).oauthReq;
    if (req.body.decision !== "allow") {
      return res.redirect(redirectWith(pending.redirect_uri, { error: "access_denied", state: pending.state ?? undefined }));
    }
    const code = newAuthCode();
    await db.insert(oauthAuthCodes).values({
      code_hash: hashOauthSecret(code),
      client_id: pending.client_id,
      user_id: req.session.userId,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      scope: pending.scope,
      resource: pending.resource,
      expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });
    res.redirect(redirectWith(pending.redirect_uri, { code, state: pending.state ?? undefined }));
  });

  // ── Token endpoint ──
  r.post("/oauth/token", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const b = req.body ?? {};
    const fail = (code: number, error: string, desc?: string) =>
      res.status(code).json({ error, error_description: desc });

    if (b.grant_type === "authorization_code") {
      const code = String(b.code ?? "");
      const [row] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.code_hash, hashOauthSecret(code))).limit(1);
      if (!row || row.used_at || row.expires_at.getTime() < Date.now()) return fail(400, "invalid_grant", "인증 코드가 유효하지 않거나 만료됐습니다.");
      // 1회용: 즉시 소모
      await db.update(oauthAuthCodes).set({ used_at: new Date() }).where(eq(oauthAuthCodes.id, row.id));
      if (String(b.client_id ?? "") !== row.client_id) return fail(400, "invalid_grant", "client_id 불일치");
      if (String(b.redirect_uri ?? "") !== row.redirect_uri) return fail(400, "invalid_grant", "redirect_uri 불일치");
      if (!verifyPkceS256(String(b.code_verifier ?? ""), row.code_challenge)) return fail(400, "invalid_grant", "PKCE 검증 실패");

      const access = newAccessToken();
      const refresh = newRefreshToken();
      await db.insert(apiTokens).values({
        user_id: row.user_id,
        token_hash: hashApiToken(access),
        name: `oauth:${row.client_id}`,
        scopes: row.scope.split(" ").filter(Boolean),
        expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
        refresh_token_hash: hashOauthSecret(refresh),
        oauth_client_id: row.client_id,
        audience: row.resource ?? `${baseUrl(req)}/api/mcp`,
      });
      return res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refresh,
        scope: row.scope,
      });
    }

    if (b.grant_type === "refresh_token") {
      const rt = String(b.refresh_token ?? "");
      const [tok] = await db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.refresh_token_hash, hashOauthSecret(rt)), isNull(apiTokens.revoked_at)))
        .limit(1);
      if (!tok) return fail(400, "invalid_grant", "리프레시 토큰이 유효하지 않습니다.");
      // 공개 클라이언트 → 리프레시 로테이션(같은 행을 새 액세스/리프레시로 교체)
      const access = newAccessToken();
      const refresh = newRefreshToken();
      await db
        .update(apiTokens)
        .set({
          token_hash: hashApiToken(access),
          refresh_token_hash: hashOauthSecret(refresh),
          expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
          last_used_at: new Date(),
        })
        .where(eq(apiTokens.id, tok.id));
      return res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refresh,
        scope: (tok.scopes ?? []).join(" "),
      });
    }

    return fail(400, "unsupported_grant_type", "authorization_code 또는 refresh_token만 지원합니다.");
  });

  return r;
}
