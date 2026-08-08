import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { apiTokens, passwordResets, users } from "../../../shared/schema.ts";
import { makeResetToken } from "./crypto.ts";
import { sendMail } from "./mail.ts";
import { env } from "./env.ts";

// 초대(기본 72시간)보다 짧다 — 재설정 링크 유출은 곧 계정 탈취라 노출 창을 좁힌다.
export const RESET_TTL_MINUTES = 120;

export function resetUrl(base: string, token: string): string {
  return `${base.replace(/\/$/, "")}/reset?token=${token}`;
}

// **메일로 나가는 링크는 절대 요청 헤더에서 유도하지 않는다.**
// baseUrl(req)는 APP_BASE_URL이 로컬 기본값이면 X-Forwarded-Host로 폴백하는데(http.ts:16-25),
// 그 값이 제3자에게 발송되는 메일에 박히면 미인증 공격자가 링크 목적지를 정하게 된다(링크 포이즈닝).
// 관리자 발급 링크는 요청자 본인 화면에만 돌아가므로 baseUrl(req)를 그대로 써도 자해에 그친다.
export function mailLinkBase(): string {
  return env.APP_BASE_URL.replace(/\/+$/, "");
}

// 메일 본문에 넣는 값은 이스케이프한다 — 링크가 정품 도메인·정상 DKIM으로 나가므로
// 본문이 조작되면 그대로 신뢰받는 피싱이 된다(심층 방어: mailLinkBase와 중복이어도 유지).
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 1회용 토큰 발급. issuedBy=null이면 본인 요청, 값이 있으면 관리자 발급(감사 추적).
export async function issueResetToken(userId: number, issuedBy: number | null): Promise<string> {
  const { token, hash } = makeResetToken();
  await db.insert(passwordResets).values({
    user_id: userId,
    token_hash: hash,
    expires_at: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    issued_by: issuedBy,
  });
  return token;
}

export function resetMailBody(name: string | null, url: string): { subject: string; text: string; html: string } {
  const who = name ? `${name}님, ` : "";
  const subject = "[DevFlow] 비밀번호 재설정 링크";
  const text = `${who}DevFlow 비밀번호 재설정 요청이 접수되었습니다.

아래 링크에서 새 비밀번호를 설정하세요 (${RESET_TTL_MINUTES / 60}시간 뒤 만료, 1회만 사용 가능):
${url}

본인이 요청하지 않았다면 이 메일을 무시하세요. 링크를 쓰지 않으면 비밀번호는 그대로입니다.`;
  const u = esc(url);
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:480px;line-height:1.6;color:#1f2328">
  <p>${esc(who)}DevFlow 비밀번호 재설정 요청이 접수되었습니다.</p>
  <p style="margin:22px 0"><a href="${u}" style="background:#4f46e5;color:#fff;padding:11px 20px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">새 비밀번호 설정하기</a></p>
  <p style="font-size:13px;color:#59636e">${RESET_TTL_MINUTES / 60}시간 뒤 만료되고 <b>1회만</b> 사용할 수 있습니다.<br>
  본인이 요청하지 않았다면 이 메일을 무시하세요 — 링크를 쓰지 않으면 비밀번호는 그대로입니다.</p>
  <p style="font-size:12px;color:#8b949e;word-break:break-all">버튼이 열리지 않으면: ${u}</p>
</div>`;
  return { subject, text, html };
}

// 발송은 호출부에서 await하지 않는다 — 메일 서버 지연이 응답 시간에 드러나면
// "이 이메일은 가입돼 있구나"를 알려주는 단서가 된다(계정 열거).
export function sendResetMail(to: string, name: string | null, url: string): void {
  const body = resetMailBody(name, url);
  void sendMail({ to, ...body }).catch(() => {});
}

// 재설정·비밀번호 변경 시 이 사용자의 **다른 모든 세션**을 끊는다.
// 이미 로그인해 있는 탈취범을 몰아내는 유일한 수단이라 재설정의 핵심 단계다.
// connect-pg-simple의 session 테이블을 직접 지운다(테스트는 MemoryStore라 대상이 없음 — 실패해도 무시).
export async function destroyUserSessions(userId: number): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM session WHERE sess->>'userId' = ${String(userId)}`);
  } catch {
    /* 세션 테이블 없음(테스트 MemoryStore) — 재설정 자체를 막지 않는다 */
  }
}

// 재설정은 "계정을 잃었다"는 복구 경로다 — 세션만 끊으면 침입자가 미리 발급해 둔
// 개인 API 토큰(Bearer)으로 계속 들어온다. api_tokens는 expires_at이 null이면 무기한이라 영구 뒷문이 된다.
// 로그인 상태의 단순 변경(change-password)에는 적용하지 않는다 — 정상 사용 중인 MCP 연동이 조용히 끊긴다.
export async function revokeUserApiTokens(userId: number): Promise<number> {
  const rows = await db
    .update(apiTokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(apiTokens.user_id, userId), isNull(apiTokens.revoked_at)))
    .returning({ id: apiTokens.id });
  return rows.length;
}

// 미사용 토큰 일괄 무효화 — 새 비밀번호가 정해지면 남은 링크는 전부 죽어야 한다.
export async function invalidateOutstandingResets(userId: number): Promise<void> {
  await db
    .update(passwordResets)
    .set({ used_at: new Date() })
    .where(and(eq(passwordResets.user_id, userId), isNull(passwordResets.used_at)));
}

// 비밀번호 확정 + 잠금 해제. 비번을 잊고 여러 번 틀려 **잠긴 상태가 대부분**이라
// 잠금을 같이 풀지 않으면 새 비밀번호로도 못 들어간다.
export async function applyNewPassword(userId: number, passwordHash: string): Promise<void> {
  await db
    .update(users)
    .set({ password_hash: passwordHash, failed_login_count: 0, locked_until: null, updated_at: new Date() })
    .where(eq(users.id, userId));
}
