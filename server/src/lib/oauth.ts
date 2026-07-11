import crypto from "node:crypto";
import { randomToken, hmac } from "./crypto.ts";
import { env } from "./env.ts";

// MCP OAuth 2.1 — Claude 네이티브 커넥터가 붙을 수 있게 devflow가 인가 서버 역할을 한다.
// 액세스 토큰은 api_tokens 재사용(Bearer 미들웨어가 그대로 인정), 스코프는 MCP 툴 스코프와 동일.
export const OAUTH_SCOPES = ["task:read", "task:write", "guide:write", "project:read", "journal:write"] as const;

export const AUTH_CODE_TTL_MS = 60_000; // 인증코드 1분(단명)
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 3600_000; // 액세스 30일 + 리프레시 로테이션

// 코드·리프레시 토큰은 해시로만 저장(유출 대비). 액세스 토큰은 hashApiToken 사용(auth 미들웨어와 동일).
export function hashOauthSecret(value: string): string {
  return hmac(value, env.API_TOKEN_SECRET);
}

// PKCE S256: base64url(sha256(code_verifier)) === code_challenge (타이밍 안전 비교)
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const newAuthCode = () => randomToken(24);
export const newAccessToken = () => `dfa_${randomToken(24)}`;
export const newRefreshToken = () => `dfr_${randomToken(24)}`;
export const newClientId = () => `mcp_${randomToken(12)}`;
export const newNonce = () => randomToken(16);

// 요청 scope를 허용 스코프로 필터. 비었으면 전체 MCP 스코프 부여.
export function sanitizeScopes(requested?: string | null): string[] {
  const allowed = new Set<string>(OAUTH_SCOPES);
  const req = (requested ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const granted = req.filter((s) => allowed.has(s));
  return granted.length ? granted : [...OAUTH_SCOPES];
}

// OAuth 2.1: redirect_uri는 https 또는 localhost(http)만, 프래그먼트 금지.
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}
