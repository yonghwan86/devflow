import cron from "node-cron";
import { env } from "../lib/env.ts";
import { runDailyDigest, runDueReminders } from "./notifications.ts";
import { configureWebPush } from "../lib/push.ts";
import { processEmbeddingJobs } from "../lib/embeddings.ts";

let started = false;

export function startSchedulers(): void {
  if (started || env.isTest) return;
  started = true;
  configureWebPush();
  const tz = env.TZ;

  // 0 9 * * * KST — daily digest
  cron.schedule("0 9 * * *", () => void runDailyDigest().catch((e) => console.error("[digest]", e)), { timezone: tz });
  // every minute — due reminders
  cron.schedule("* * * * *", () => void runDueReminders().catch((e) => console.error("[due]", e)), { timezone: tz });
  // 0 0 * * * KST — housekeeping placeholder (flag reset)
  cron.schedule("0 0 * * *", () => {}, { timezone: tz });
  // */5분 — P7 임베딩 잡 큐 처리 (재색인 요청 시엔 즉시 처리, 여긴 잔여분 재시도)
  cron.schedule("*/5 * * * *", () => void processEmbeddingJobs().catch((e) => console.error("[embed]", e)), { timezone: tz });

  // Restart catch-up: idempotency keys ensure no double-send (§9).
  void runDailyDigest().catch(() => {});
}
