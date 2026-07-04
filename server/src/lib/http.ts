import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { User } from "../../../shared/schema.ts";
import { decryptField } from "./crypto.ts";

// Wrap async handlers so thrown errors reach the error middleware.
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

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
