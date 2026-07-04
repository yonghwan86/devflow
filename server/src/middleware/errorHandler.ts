import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/errors.ts";
import { ZodError } from "zod";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: "경로를 찾을 수 없습니다." } });
}

export function errorHandler(e: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (e instanceof ApiError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message } });
  }
  if (e instanceof ZodError) {
    return res
      .status(400)
      .json({ error: { code: "validation", message: "입력값이 올바르지 않습니다.", issues: e.issues } });
  }
  console.error("[unhandled]", e);
  return res.status(500).json({ error: { code: "internal", message: "서버 오류가 발생했습니다." } });
}
