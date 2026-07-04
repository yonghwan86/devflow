import express, { type Express } from "express";
import session from "express-session";
import type { Store } from "express-session";
import cors from "cors";
import { env } from "./lib/env.ts";
import { securityHeaders } from "./middleware/security.ts";
import { notFound, errorHandler } from "./middleware/errorHandler.ts";
import { apiRouter } from "./routes/index.ts";
import { apiTokenAuth } from "./middleware/auth.ts";

export interface AppOptions {
  sessionStore?: Store;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(cors({ origin: env.isProd ? [env.APP_BASE_URL] : true, credentials: true }));
  // rawBody 보존: GitHub 웹훅 서명 검증(§10.9)에 필요
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

  app.use(
    session({
      name: "devflow.sid",
      store: opts.sessionStore, // undefined -> MemoryStore (tests only)
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        // "auto": Secure only over HTTPS (works on http://localhost; secure behind TLS/tunnel).
        secure: "auto",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    }),
  );

  // Personal API token auth (Authorization: Bearer ...) for MCP/personal use (P1, reused P10).
  app.use(apiTokenAuth);

  app.use("/api", apiRouter());
  app.use("/api", notFound);
  app.use(errorHandler);
  return app;
}
