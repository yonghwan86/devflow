import type { Request, Response, NextFunction } from "express";
import { err } from "../lib/errors.ts";

// R0-3: CSRF 방어 — 커스텀 헤더 방식 (의존성 없음; csurf는 deprecated라 금지).
// "세션으로 인증된" mutating 요청에만 X-DevFlow-CSRF: 1 헤더를 요구한다.
// 적용 조건: method ∈ {POST, PATCH, PUT, DELETE} AND Bearer 토큰 없음 AND req.session.userId 존재.
// 이 조건식이 자연스럽게 제외하는 것들(별도 경로 예외 불필요):
//   - /api/webhooks/github (세션 없음 — 절대 깨지면 안 됨)
//   - 로그인/가입/초대수락 (아직 세션 없음)
//   - MCP (R0-2 이후 Bearer 전용 — tokenScopes 보유)
// 반드시 session 미들웨어 뒤, 라우트 앞에 마운트할 것(app.ts).
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  if (req.tokenScopes) return next(); // Bearer 토큰 인증 — CSRF 비대상
  if (!req.session?.userId) return next(); // 세션 미인증 — 로그인·웹훅 등
  if (req.headers["x-devflow-csrf"] === "1") return next();
  next(err.forbidden("CSRF 검증 실패: X-DevFlow-CSRF 헤더가 필요합니다."));
}
