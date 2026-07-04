import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull, gt, or } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { apiTokens, projectMembers, users } from "../../../shared/schema.ts";
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

// Require an authenticated user (session cookie OR api token).
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const uid = req.userId ?? req.session?.userId;
  if (!uid) return next(err.unauthorized());
  req.userId = uid;
  next();
}

// Enforce project membership from the SERVER side (§8/§10.5). Sets req.membership.
export function requireMember(paramName = "projectId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const uid = req.userId ?? req.session?.userId;
    if (!uid) return next(err.unauthorized());
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

// Require one of the given roles within the current project (after requireMember).
export function requireRole(...roles: MemberRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.membership) return next(err.forbidden());
    if (!roles.includes(req.membership.role)) return next(err.forbidden("역할 권한이 부족합니다."));
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
