import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { users, invites, projectMembers, passwordResets } from "../../../shared/schema.ts";
import { ah, publicUser, baseUrl } from "../lib/http.ts";
import { hashPassword, verifyPassword, validatePasswordStrength, DUMMY_BCRYPT_HASH } from "../lib/password.ts";
import { hashInviteToken, encryptField, hashResetToken, makeResetToken } from "../lib/crypto.ts";
import { isMailEnabled } from "../lib/mail.ts";
import {
  applyNewPassword,
  destroyUserSessions,
  invalidateOutstandingResets,
  issueResetToken,
  mailLinkBase,
  resetUrl,
  revokeUserApiTokens,
  sendResetMail,
} from "../lib/passwordReset.ts";
import { err, ApiError } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { requireAuth, currentUser } from "../middleware/auth.ts";
import type { MemberRole } from "../../../shared/schema.ts";

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

// §10 세션 고정 방어: 인증 성공 시 세션 ID를 재발급한 뒤 userId를 기록.
// (재발급 없이 userId만 넣으면 로그인 전 심어둔 세션 ID가 인증 후에도 유효 — session fixation)
function loginSession(req: Request, userId: number): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((e) => {
      if (e) return reject(e);
      req.session.userId = userId;
      resolve();
    }),
  );
}

// §10.4 rate limit auth endpoints
// skip: 테스트에서만 해제한다 — 리미터 상태가 프로세스 전역이라 한 파일의 테스트들이 서로의 한도를
// 갉아먹어(가입 10회 초과) 무관한 테스트가 인증 실패로 깨진다. 스케줄러의 env.isTest 게이트와 같은 규약.
const skipInTest = () => env.isTest;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." } },
});
// 공개 가입은 더 엄격히 (이메일 열거·봇 가입 속도 제한)
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
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
      await loginSession(req, u.id);
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
      await loginSession(req, u.id);
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
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      // R0-1: 기존 계정이 있으면 어떤 필드도 덮어쓰지 않는다(초대 토큰 유출 = 계정 탈취 차단).
      // invites.accepted_at도 소모하지 않음 — 로그인 후 같은 토큰으로 /accept-invite-session 재사용.
      if (existing) {
        throw new ApiError(409, "account_exists", "이미 가입된 계정입니다. 로그인 후 초대를 수락하세요.");
      }
      const [created] = await db
        .insert(users)
        .values({
          email,
          password_hash: await hashPassword(body.password),
          full_name: body.full_name,
          username: body.username ? encryptField(body.username) : null,
        })
        .returning();
      const userId = created.id;

      // Attach project membership if the invite was project-scoped.
      if (inv.project_id) {
        await db
          .insert(projectMembers)
          .values({
            project_id: inv.project_id,
            user_id: userId,
            role: inv.role as MemberRole,
            operational_role: inv.role === "manager" ? "pm" : "worker",
          })
          .onConflictDoNothing();
      }
      await db.update(invites).set({ accepted_at: new Date() }).where(eq(invites.id, inv.id));

      await loginSession(req, userId);
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      res.status(201).json({ user: publicUser(u) });
    }),
  );

  // 이미 로그인한 사용자가 초대 링크를 열면 → 비밀번호 재설정 없이 해당 프로젝트에 합류.
  // (신규 가입은 /accept-invite, 기존 로그인 사용자는 이 경로)
  r.post(
    "/accept-invite-session",
    ah(async (req, res) => {
      // C5: 세션 전용 — Bearer 토큰 경로를 허용하면 REST 스코프 게이트를 우회해
      // 스코프 없는 토큰으로도 프로젝트 합류(mutating)가 가능해짐. 초대 수락은 브라우저 흐름.
      const uid = req.session?.userId;
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
          .values({
            project_id: inv.project_id,
            user_id: uid,
            role: inv.role as MemberRole,
            operational_role: inv.role === "manager" ? "pm" : "worker",
          })
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
      await loginSession(req, u.id);
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

  // 비밀번호 재설정 요청 — 계정 유무를 절대 드러내지 않는다(§10.4 열거 방지).
  // 응답은 항상 동일하고, 메일 발송은 await하지 않는다(발송 지연이 존재 여부 단서가 되지 않게).
  r.post(
    "/forgot-password",
    signupLimiter,
    ah(async (req, res) => {
      const body = z.object({ email: z.string().email() }).strict().parse(req.body);
      const email = body.email.toLowerCase();
      // 토큰 생성(HMAC 연산)은 계정 유무와 무관하게 항상 수행 — 응답 시간을 균등화한다.
      makeResetToken();
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (u && u.is_active) {
        const token = await issueResetToken(u.id, null);
        // baseUrl(req)를 쓰지 않는다 — 메일 링크의 목적지를 요청 헤더가 정하면 링크 포이즈닝이다.
        sendResetMail(u.email, u.full_name, resetUrl(mailLinkBase(), token));
      }
      res.json({ ok: true });
    }),
  );

  // 재설정 링크 사용 — 새 비밀번호 확정. 성공 시 자동 로그인.
  r.post(
    "/reset-password",
    authLimiter,
    ah(async (req, res) => {
      const body = z.object({ token: z.string().min(10), password: z.string() }).strict().parse(req.body);
      if (!validatePasswordStrength(body.password)) throw err.badRequest("비밀번호는 최소 8자입니다.");
      // 어떤 토큰이 존재하는지 알려주지 않는다 — 만료·사용됨·위조를 한 문구로 통일(초대와 같은 규약).
      const generic = err.badRequest("재설정 링크가 유효하지 않거나 만료되었습니다.");
      const [row] = await db
        .select()
        .from(passwordResets)
        .where(and(eq(passwordResets.token_hash, hashResetToken(body.token)), isNull(passwordResets.used_at)))
        .limit(1);
      if (!row || row.expires_at.getTime() < Date.now()) throw generic;

      // 1회용 보장은 조건부 UPDATE로 원자화한다 — 검사 후 갱신(TOCTOU)이면 동시 요청 둘 다 성공할 수 있다.
      const consumed = await db
        .update(passwordResets)
        .set({ used_at: new Date() })
        .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.used_at)))
        .returning({ id: passwordResets.id });
      if (!consumed.length) throw generic;

      const [u] = await db.select().from(users).where(eq(users.id, row.user_id)).limit(1);
      if (!u || !u.is_active) throw generic;

      await applyNewPassword(u.id, await hashPassword(body.password));
      await invalidateOutstandingResets(u.id);
      await destroyUserSessions(u.id); // 탈취범이 이미 로그인해 있어도 끊긴다
      await revokeUserApiTokens(u.id); // 세션만 끊으면 미리 발급된 Bearer 토큰으로 계속 들어온다
      await loginSession(req, u.id);
      const [fresh] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
      res.json({ user: publicUser(fresh) });
    }),
  );

  // 로그인 상태에서의 비밀번호 변경 — 현재 비밀번호 확인 필수.
  r.post(
    "/change-password",
    requireAuth,
    authLimiter,
    ah(async (req, res) => {
      const body = z
        .object({ current_password: z.string(), new_password: z.string() })
        .strict()
        .parse(req.body);
      if (!validatePasswordStrength(body.new_password)) throw err.badRequest("새 비밀번호는 최소 8자입니다.");
      const [u] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
      if (!u || !u.password_hash) throw err.unauthorized("다시 로그인해 주세요.");
      if (!(await verifyPassword(body.current_password, u.password_hash)))
        throw err.badRequest("현재 비밀번호가 올바르지 않습니다.");

      await applyNewPassword(u.id, await hashPassword(body.new_password));
      await invalidateOutstandingResets(u.id);
      await destroyUserSessions(u.id); // 다른 기기는 로그아웃
      await loginSession(req, u.id); // 이 기기는 세션 재발급으로 유지
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
  // mail_enabled: 메일이 꺼져 있으면 재설정 안내 문구를 "관리자에게 요청"으로 바꾼다.
  // (계정 유무가 아니라 서버 설정 상태라 로그인 전 노출해도 열거 위험이 없다.)
  r.get(
    "/bootstrap-status",
    ah(async (_req, res) => {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      res.json({ needs_bootstrap: count === 0, mail_enabled: isMailEnabled() });
    }),
  );

  return r;
}
