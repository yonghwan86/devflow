import type { Request, Response, NextFunction } from "express";

// Baseline security headers. Live-preview CSP hardening comes in P9.
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
}
