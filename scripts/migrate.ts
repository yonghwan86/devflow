// Idempotent migration runner (re-runnable, §12). Applies migrations/0000_init.sql.
import { migrateProd } from "../server/src/lib/db.ts";
import { env } from "../server/src/lib/env.ts";

async function main() {
  console.log(`[migrate] applying schema to ${env.DATABASE_URL.replace(/:[^:@]+@/, ":****@")}`);
  await migrateProd();
  console.log("[migrate] done (idempotent).");
}
main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
