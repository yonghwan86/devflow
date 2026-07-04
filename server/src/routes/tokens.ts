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
          scopes: z.array(z.enum(TOKEN_SCOPES)).default([]),
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
