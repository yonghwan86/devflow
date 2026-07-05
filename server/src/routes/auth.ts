import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { users, invites, projectMembers } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { hashPassword, verifyPassword, validatePasswordStrength, DUMMY_BCRYPT_HASH } from "../lib/password.ts";
import { hashInviteToken, encryptField } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import { requireAuth, currentUser } from "../middleware/auth.ts";
import type { MemberRole } from "../../../shared/schema.ts";

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

// §10.4 rate limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." } },
});
// 공개 가입은 더 엄격히 (이메일 열거·봇 가입 속도 제한)
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." } },
});

export function authRouter(): Router {
  const r = Router();

  // Bootstrap the very first user (owner) only when no users exist.
  r.post(
    "/bootstrap",
    authLimiter,
    ah(async (req, res) => {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      if (count > 0) throw err.forbidden("이미 초기화되었습니다. 초대 링크로 가입하세요.");
      const body = z
        .object({
          email: z.string().email(),
          password: z.string(),
          full_name: z.string().min(1),
          username: z.string().min(1).optional(),
        })
        .parse(req.body);
      if (!validatePasswordStrength(body.password)) throw err.badRequest("비밀번호는 최소 8자입니다.");
      const [u] = await db
        .insert(users)
        .values({
          email: body.email.toLowerCase(),
          password_hash: await hashPassword(body.password),
          full_name: body.full_name,
          username: body.username ? encryptField(body.username) : null,
          is_admin: true, // 최초 계정 = 사이트 관리자 (LLM 키 등 관리자 설정 권한)
        })
        .returning();
      req.session.userId = u.id;
      res.status(201).json({ user: publicUser(u) });
    }),
  );

  // P11 개정(§10.2): 가입은 공개 — 단, 프로젝트 접근은 여전히 초대로만.
  // 공개 가입 회원은 검증 갤러리 열람·리뷰만 가능(프로젝트 데이터 접근 불가, 서버측 멤버십 필터).
  r.post(
    "/signup",
    signupLimiter,
    ah(async (req, res) => {
      const body = z
        .object({
          email: z.string().email(),
          password: z.string(),
          full_name: z.string().min(1).max(100),
        })
        .strict()
        .parse(req.body);
      if (!validatePasswordStrength(body.password)) throw err.badRequest("비밀번호는 최소 8자입니다.");
      const email = body.email.toLowerCase();
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      // 열거 방지: 이미 있는 이메일도 동일한 일반 오류
      if (existing) throw err.badRequest("가입할 수 없는 이메일입니다.");
      const [u] = await db
        .insert(users)
        .values({ email, password_hash: await hashPassword(body.password), full_name: body.full_name })
        .returning();
      req.session.userId = u.id;
      res.status(201).json({ user: publicUser(u) });
    }),
  );

  // Accept invite: signup / set password via signed one-time token only (§10.2).
  r.post(
    "/accept-invite",
    authLimiter,
    ah(async (req, res) => {
      const body = z
        .object({
          token: z.string().min(10),
          password: z.string(),
          full_name: z.string().min(1),
          username: z.string().min(1).optional(),
        })
        .parse(req.body);
      if (!validatePasswordStrength(body.password)) throw err.badRequest("비밀번호는 최소 8자입니다.");

      const tokenHash = hashInviteToken(body.token);
      const [inv] = await db
        .select()
        .from(invites)
        .where(and(eq(invites.token_hash, tokenHash), isNull(invites.accepted_at)))
        .limit(1);
      // Generic error to avoid leaking which tokens exist.
      if (!inv || inv.expires_at.getTime() < Date.now())
        throw err.badRequest("초대 링크가 유효하지 않거나 만료되었습니다.");

      const email = inv.email.toLowerCase();
      // Create-or-set-password for the invited email.
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      let userId: number;
      if (existing) {
        await db
          .update(users)
          .set({
            password_hash: await hashPassword(body.password),
            full_name: body.full_name,
            username: body.username ? encryptField(body.username) : existing.username,
            is_active: true,
            updated_at: new Date(),
          })
          .where(eq(users.id, existing.id));
        userId = existing.id;
      } else {
        const [u] = await db
          .insert(users)
          .values({
            email,
            password_hash: await hashPassword(body.password),
            full_name: body.full_name,
            username: body.username ? encryptField(body.username) : null,
          })
          .returning();
        userId = u.id;
      }

      // Attach project membership if the invite was project-scoped.
      if (inv.project_id) {
        await db
          .insert(projectMembers)
          .values({ project_id: inv.project_id, user_id: userId, role: inv.role as MemberRole })
          .onConflictDoNothing();
      }
      await db.update(invites).set({ accepted_at: new Date() }).where(eq(invites.id, inv.id));

      req.session.userId = userId;
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      res.status(201).json({ user: publicUser(u) });
    }),
  );

  // 이미 로그인한 사용자가 초대 링크를 열면 → 비밀번호 재설정 없이 해당 프로젝트에 합류.
  // (신규 가입은 /accept-invite, 기존 로그인 사용자는 이 경로)
  r.post(
    "/accept-invite-session",
    ah(async (req, res) => {
      const uid = req.session?.userId ?? req.userId;
      if (!uid) throw err.unauthorized();
      const body = z.object({ token: z.string().min(10) }).strict().parse(req.body);
      const tokenHash = hashInviteToken(body.token);
      const [inv] = await db
        .select()
        .from(invites)
        .where(and(eq(invites.token_hash, tokenHash), isNull(invites.accepted_at)))
        .limit(1);
      if (!inv || inv.expires_at.getTime() < Date.now())
        throw err.badRequest("초대 링크가 유효하지 않거나 만료되었습니다.");

      const [me] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
      if (!me) throw err.unauthorized();
      // 초대는 이메일 귀속 — 계정 탈취 방지 위해 로그인 계정 이메일과 일치해야 함(§10.2)
      if (me.email.toLowerCase() !== inv.email.toLowerCase())
        throw err.forbidden(`이 초대는 ${inv.email} 계정용입니다. 현재 로그인한 계정과 달라요.`);

      if (inv.project_id) {
        await db
          .insert(projectMembers)
          .values({ project_id: inv.project_id, user_id: uid, role: inv.role as MemberRole })
          .onConflictDoNothing();
      }
      await db.update(invites).set({ accepted_at: new Date() }).where(eq(invites.id, inv.id));
      res.json({ ok: true, project_id: inv.project_id });
    }),
  );

  // Login with account lockout + generic errors (§10.4 no enumeration).
  r.post(
    "/login",
    authLimiter,
    ah(async (req, res) => {
      const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
      const generic = err.unauthorized("이메일 또는 비밀번호가 올바르지 않습니다.");
      const [u] = await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1);
      if (!u || !u.password_hash || !u.is_active) {
        // Equalize timing to block enumeration via response latency (§10.4).
        await verifyPassword(body.password, DUMMY_BCRYPT_HASH);
        throw generic;
      }
      if (u.locked_until && u.locked_until.getTime() > Date.now())
        throw err.tooMany("로그인 시도가 많아 계정이 잠겼습니다. 잠시 후 다시 시도하세요.");

      const ok = await verifyPassword(body.password, u.password_hash);
      if (!ok) {
        const fails = (u.failed_login_count ?? 0) + 1;
        const locked = fails >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
        await db
          .update(users)
          .set({ failed_login_count: locked ? 0 : fails, locked_until: locked })
          .where(eq(users.id, u.id));
        throw generic;
      }
      await db.update(users).set({ failed_login_count: 0, locked_until: null }).where(eq(users.id, u.id));
      req.session.userId = u.id;
      res.json({ user: publicUser(u) });
    }),
  );

  r.post(
    "/logout",
    ah(async (req, res) => {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      res.json({ ok: true });
    }),
  );

  r.get(
    "/me",
    ah(async (req, res) => {
      const u = await currentUser(req);
      res.json({ user: u ? publicUser(u) : null });
    }),
  );

  // 최초 설정(부트스트랩)이 아직 안 됐는지 — 유저가 하나도 없을 때만 true.
  // 로그인 화면에서 "최초 설정" 탭을 이 값이 true일 때만 노출.
  r.get(
    "/bootstrap-status",
    ah(async (_req, res) => {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      res.json({ needs_bootstrap: count === 0 });
    }),
  );

  return r;
}
