import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { apiTokens } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { hashApiToken, randomToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";

// Personal access tokens (§7/§8). Hash-only storage, one-time reveal. Reused by MCP (P10).
export const TOKEN_SCOPES = [
  "task:read",
  "task:write",
  "comment:write",
  "guide:write",
  "project:read",
  "skill:read",
] as const;

export function tokensRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  // C5 보안: 토큰으로 토큰을 발급·폐기하면 제한 스코프 토큰이 전체 스코프 토큰을 재발급하는
  // 자기 권한 상승이 가능 — 토큰 관리는 웹 로그인(세션) 전용.
  r.use((req, _res, next) => {
    if (req.tokenScopes) return next(err.forbidden("토큰 관리는 웹 로그인(세션)에서만 가능합니다."));
    next();
  });

  r.get(
    "/",
    ah(async (req, res) => {
      const rows = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          scopes: apiTokens.scopes,
          expires_at: apiTokens.expires_at,
          last_used_at: apiTokens.last_used_at,
          revoked_at: apiTokens.revoked_at,
          created_at: apiTokens.created_at,
        })
        .from(apiTokens)
        .where(eq(apiTokens.user_id, req.userId!));
      res.json({ tokens: rows }); // never returns token_hash or plaintext
    }),
  );

  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          name: z.string().min(1),
          // C5: 빈 스코프 토큰은 REST 게이트에서 전부 403이 되어 무용 — 발급 시점에 차단
          scopes: z.array(z.enum(TOKEN_SCOPES)).min(1, "스코프를 1개 이상 선택하세요."),
          expires_at: z.coerce.date().optional(),
        })
        .parse(req.body);
      const raw = `df_${randomToken(24)}`; // plaintext returned ONCE
      const [tok] = await db
        .insert(apiTokens)
        .values({
          user_id: req.userId!,
          token_hash: hashApiToken(raw),
          name: body.name,
          scopes: body.scopes,
          expires_at: body.expires_at ?? null,
        })
        .returning({ id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes });
      res.status(201).json({ token: raw, meta: tok }); // meta has no secret
    }),
  );

  r.delete(
    "/:id",
    ah(async (req, res) => {
      const id = Number(req.params.id);
      const [existing] = await db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.user_id, req.userId!)))
        .limit(1);
      if (!existing) throw err.notFound("토큰을 찾을 수 없습니다.");
      await db
        .update(apiTokens)
        .set({ revoked_at: new Date() })
        .where(and(eq(apiTokens.id, id), eq(apiTokens.user_id, req.userId!), isNull(apiTokens.revoked_at)));
      res.json({ ok: true });
    }),
  );

  return r;
}
