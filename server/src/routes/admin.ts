import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { users } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth, currentUser } from "../middleware/auth.ts";
import { getAiSettingsMasked, saveAiSettings } from "../lib/adminSettings.ts";
import { getLlm, isMockLlm } from "../lib/llm.ts";
import { err } from "../lib/errors.ts";

// 사이트 관리자 전용 (users.is_admin). LLM 키/프로바이더는 비용·유출 리스크가 있어
// 아무나 수정 금지 — 최초 설정(bootstrap) 계정이 관리자.
async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const u = await currentUser(req);
  if (!u?.is_admin) return next(err.forbidden("관리자만 접근할 수 있습니다."));
  next();
}

export function adminRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.use(requireAdmin);

  // 현재 설정 (키는 마스킹 — 원문 절대 반환 금지 §10.8/§10.12)
  r.get(
    "/settings",
    ah(async (_req, res) => {
      res.json({ settings: await getAiSettingsMasked() });
    }),
  );

  // 설정 저장 — PATCH 화이트리스트(§10.3). llm_api_key: 빈 문자열 → 삭제(mock 폴백)
  r.patch(
    "/settings",
    ah(async (req, res) => {
      const body = z
        .object({
          llm_provider: z.enum(["mock", "openai", "anthropic"]).optional(),
          llm_api_key: z.string().max(500).nullable().optional(),
          llm_model: z.string().max(100).optional(),
          // C4 보안: base_url은 SSRF/키 유출 통로가 될 수 있음 — https(또는 로컬 개발용 localhost)만 허용
          llm_base_url: z.string().max(300)
            .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(v),
              "llm_base_url은 https:// URL(개발용은 http://localhost)만 허용됩니다.")
            .optional(),
          embedding_model: z.string().max(100).optional(),
        })
        .strict()
        .parse(req.body);
      await saveAiSettings(
        { ...body, llm_api_key: body.llm_api_key === "" ? null : body.llm_api_key },
        req.userId!,
      );
      res.json({ settings: await getAiSettingsMasked() });
    }),
  );

  // G2-3: 사용자 관리 — 목록 + 관리자 지정/해제. 민감 필드(password_hash/username) 절대 미포함.
  r.get(
    "/users",
    ah(async (_req, res) => {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          full_name: users.full_name,
          is_admin: users.is_admin,
          is_active: users.is_active,
          created_at: users.created_at,
        })
        .from(users)
        .orderBy(users.id);
      res.json({ users: rows });
    }),
  );

  r.patch(
    "/users/:id",
    ah(async (req, res) => {
      const body = z.object({ is_admin: z.boolean() }).strict().parse(req.body);
      const targetId = Number(req.params.id);
      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) throw err.notFound("사용자를 찾을 수 없습니다.");
      // 마지막 관리자 가드 — 관리자 해제로 관리자가 0명이 되는 것 차단(본인 해제 포함)
      if (target.is_admin && !body.is_admin) {
        const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(eq(users.is_admin, true));
        if (count <= 1) throw err.badRequest("관리자는 1명 이상 필요합니다.");
      }
      const [u] = await db.update(users).set({ is_admin: body.is_admin, updated_at: new Date() }).where(eq(users.id, targetId)).returning();
      res.json({ user: { id: u.id, email: u.email, full_name: u.full_name, is_admin: u.is_admin } });
    }),
  );

  // 연결 테스트: 실제 1회 호출로 키·모델 검증 (mock이면 항상 성공)
  r.post(
    "/settings/test",
    ah(async (_req, res) => {
      if (isMockLlm()) return res.json({ ok: true, provider: "mock", note: "mock 모드 — 키 없이 동작" });
      try {
        await getLlm().complete([
          { role: "system", content: '반드시 JSON {"ok": true} 로만 응답하세요.' },
          { role: "user", content: "ping" },
        ]);
        res.json({ ok: true });
      } catch (e: any) {
        res.json({ ok: false, error: String(e?.message ?? e) });
      }
    }),
  );

  return r;
}
