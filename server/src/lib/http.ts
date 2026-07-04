import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { User } from "../../../shared/schema.ts";
import { decryptField } from "./crypto.ts";
import { env } from "./env.ts";

// Wrap async handlers so thrown errors reach the error middleware.
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// 공개 링크(초대 등)의 베이스 URL.
// 우선순위: APP_BASE_URL이 로컬 기본값이 아니면 그걸 사용(운영자가 명시 설정) →
// 아니면 실제 접속한 호스트/프로토콜에서 유도(trust proxy로 https·도메인 정확) → 최후에 요청 host.
// 배포 도메인을 별도 설정 안 해도 "지금 접속한 주소"로 초대 링크가 생성된다.
export function baseUrl(req: Request): string {
  const configured = env.APP_BASE_URL;
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured.replace(/\/+$/, "");
  const host = req.get("x-forwarded-host") || req.get("host");
  if (host) {
    const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
    return `${proto}://${host}`;
  }
  return configured.replace(/\/+$/, "");
}

// Never leak password_hash / raw encrypted fields to clients.
export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    username: decryptField(u.username),
    avatar_url: u.avatar_url,
    is_active: u.is_active,
    is_admin: u.is_admin,
  };
}
