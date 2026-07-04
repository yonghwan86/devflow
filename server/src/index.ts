import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import pg from "pg";
import { createApp } from "./app.ts";
import { env, assertProdSecrets } from "./lib/env.ts";
import { initProdDb } from "./lib/db.ts";
import { startSchedulers } from "./jobs/scheduler.ts";
import { loadAiSettingsFromDb } from "./lib/adminSettings.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  assertProdSecrets();
  await initProdDb();
  await loadAiSettingsFromDb(); // 관리자 설정(DB) → env 주입 (LLM 키 등)

  // Postgres-backed session store (connect-pg-simple).
  const PgStore = connectPgSimple(session);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const sessionStore = new PgStore({ pool, tableName: "session", createTableIfMissing: false });

  const app = createApp({ sessionStore });

  // Serve built client (mobile-first PWA) in production.
  const clientDir = path.resolve(__dirname, "../../dist/public");
  app.use(express.static(clientDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDir, "index.html"));
  });

  startSchedulers();

  app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`[devflow] listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  });
}
main().catch((e) => {
  console.error("[devflow] fatal:", e);
  process.exit(1);
});
