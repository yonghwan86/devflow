import crypto from "node:crypto";
import { env } from "./env.ts";

// ── AES-256-GCM for reversible field encryption (username at rest) ──
function key(): Buffer {
  return Buffer.from(env.FIELD_ENCRYPTION_KEY, "hex");
}
export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
export function decryptField(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [ivB, tagB, dataB] = payload.split(".");
  if (!ivB || !tagB || !dataB) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ── HMAC hashing for tokens stored at rest (invite / api tokens) ──
export function hmac(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
export function hashInviteToken(token: string): string {
  return hmac(token, env.INVITE_TOKEN_SECRET);
}
export function hashApiToken(token: string): string {
  return hmac(token, env.API_TOKEN_SECRET);
}
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
// Signed one-time invite token: random.sig  (prevents forging/first-come hijack)
export function makeInviteToken(): { token: string; hash: string } {
  const raw = randomToken(24);
  const sig = hmac(raw, env.INVITE_TOKEN_SECRET).slice(0, 32);
  const token = `${raw}.${sig}`;
  return { token, hash: hashInviteToken(token) };
}
// 비밀번호 재설정 토큰 — 초대와 같은 시크릿을 쓰되 도메인 구분자("pwreset:")로 분리한다.
// 구분자가 없으면 HMAC이 동일해 초대 토큰을 재설정 경로로 흘려 쓰는 실수가 이론상 가능하다.
export function hashResetToken(token: string): string {
  return hmac(`pwreset:${token}`, env.INVITE_TOKEN_SECRET);
}
export function makeResetToken(): { token: string; hash: string } {
  const raw = randomToken(32);
  const sig = hmac(`pwreset:${raw}`, env.INVITE_TOKEN_SECRET).slice(0, 32);
  const token = `${raw}.${sig}`;
  return { token, hash: hashResetToken(token) };
}

export function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
