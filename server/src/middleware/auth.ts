import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull, gt, or } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { apiTokens, projectMembers, users, ROLE_RANK } from "../../../shared/schema.ts";
import { hashApiToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import type { MemberRole } from "../../../shared/schema.ts";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}
declare global {
  // eslint-disable-next-line no-var
  namespace Express {
    interface Request {
      userId?: number;
      tokenScopes?: string[];
      membership?: { project_id: number; role: MemberRole };
    }
  }
}

// Bearer personal-token auth (api_tokens). Sets req.userId + scopes if valid.
export async function apiTokenAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return next();
  const raw = h.slice(7).trim();
  if (!raw) return next();
  try {
    const hash = hashApiToken(raw);
    const now = new Date();
    const [tok] = await db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.token_hash, hash),
          isNull(apiTokens.revoked_at),
          or(isNull(apiTokens.expires_at), gt(apiTokens.expires_at, now)),
        ),
      )
      .limit(1);
    if (tok) {
      req.userId = tok.user_id;
      req.tokenScopes = tok.scopes ?? [];
      await db.update(apiTokens).set({ last_used_at: now }).where(eq(apiTokens.id, tok.id));
    }
  } catch {
    /* ignore, fall through to session */
  }
  next();
}

// C4 보안: Bearer 토큰 스코프를 REST에도 강제 — 기존엔 MCP에서만 검사해 제한 스코프 토큰이 REST 전체 접근 가능했음.
// 리소스별 세밀 매핑 대신 보수적 메서드 게이트: 읽기(GET/HEAD)는 read 계열, 쓰기는 write 계열 스코프 필요.
// 세션 사용자는 tokenScopes가 없어 무제한(기존과 동일). MCP(/api/mcp)는 자체 needScope로 도구별 검사.
// 쓰기 스코프는 읽기를 함의(read-modify-write 흐름 보장 — write-only 토큰이 조회 불가하면 무용)
const REST_READ_SCOPES = ["task:read", "project:read", "skill:read", "task:write", "guide:write", "comment:write"];
const REST_WRITE_SCOPES = ["task:write", "guide:write", "comment:write"];
function restScopeError(req: Request): Error | null {
  if (!req.tokenScopes) return null;
  // N3: 내 기록(개인 저널)은 전용 스코프로 격리 — task:write 등 다른 쓰기 토큰이 개인 기록을
  // 읽고 쓰지 못하게, 반대로 journal:write 토큰(시리 단축어용)은 저널 밖 접근 불가.
  // toLowerCase: Express는 대소문자 무시 라우팅이라 /api/JOURNAL도 저널 라우터에 닿음 — 게이트도 동일 기준.
  // (차단의 최종 방어선은 journal.ts 라우터 안 미들웨어 — 여기는 journal:write 토큰의 통과 허용이 주 역할)
  if ((req.originalUrl ?? "").toLowerCase().startsWith("/api/journal")) {
    return req.tokenScopes.includes("journal:write")
      ? null
      : err.forbidden("토큰 스코프 부족: 내 기록에는 journal:write 스코프가 필요합니다.");
  }
  // 의미상 조회인 POST만 read 계열로 취급 — 화이트리스트 (reindex·suggest-guide는 쓰기·비용 유발이라 제외)
  const isReadPost =
    req.method === "POST" &&
    ["/api/ai/search", "/api/ai/ask"].some((p) => (req.originalUrl ?? "").startsWith(p));
  const need = req.method === "GET" || req.method === "HEAD" || isReadPost ? REST_READ_SCOPES : REST_WRITE_SCOPES;
  if (!need.some((s) => req.tokenScopes!.includes(s)))
    return err.forbidden(`토큰 스코프 부족: ${req.method} 요청에는 ${need.join(" | ")} 중 하나가 필요합니다.`);
  return null;
}

// Require an authenticated user (session cookie OR api token).
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const uid = req.userId ?? req.session?.userId;
  if (!uid) return next(err.unauthorized());
  const scopeErr = restScopeError(req);
  if (scopeErr) return next(scopeErr);
  req.userId = uid;
  next();
}

// Enforce project membership from the SERVER side (§8/§10.5). Sets req.membership.
export function requireMember(paramName = "projectId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const uid = req.userId ?? req.session?.userId;
    if (!uid) return next(err.unauthorized());
    const scopeErr = restScopeError(req); // requireAuth 없이 단독 사용되는 라우트도 게이트 적용
    if (scopeErr) return next(scopeErr);
    const projectId = Number(req.params[paramName] ?? req.body?.project_id ?? req.query.project_id);
    if (!Number.isInteger(projectId)) return next(err.badRequest("projectId가 필요합니다."));
    const [m] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
      .limit(1);
    if (!m) return next(err.forbidden("프로젝트 멤버가 아닙니다."));
    req.userId = uid;
    req.membership = { project_id: projectId, role: m.role };
    next();
  };
}

// 계층 기반 권한: 주어진 역할들 중 "가장 낮은 랭크 이상"이면 통과.
// 예) requireRole("manager") → manager 또는 owner 통과(owner가 매니저 권한 상속), member 거부.
//     requireRole("owner")   → owner만 통과.
export function requireRole(...roles: MemberRole[]) {
  const minRank = Math.min(...roles.map((r) => ROLE_RANK[r]));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.membership) return next(err.forbidden());
    if (ROLE_RANK[req.membership.role] < minRank) return next(err.forbidden("역할 권한이 부족합니다."));
    next();
  };
}

// Optional scope check for token-based access.
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Session users (no token) are unrestricted; token users must hold the scope.
    if (req.tokenScopes && !req.tokenScopes.includes(scope)) {
      return next(err.forbidden(`토큰 스코프 부족: ${scope}`));
    }
    next();
  };
}

export async function currentUser(req: Request) {
  const uid = req.userId ?? req.session?.userId;
  if (!uid) return null;
  const [u] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  return u ?? null;
}
