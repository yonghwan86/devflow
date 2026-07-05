import cron from "node-cron";
import { env } from "../lib/env.ts";
import { runDailyDigest, runDueReminders, runEventReminders } from "./notifications.ts";
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
  // F5: every minute — 30분 내 시작 이벤트 리마인더 (sendOnce 멱등, 기존 due 패턴)
  cron.schedule("* * * * *", () => void runEventReminders().catch((e) => console.error("[event]", e)), { timezone: tz });
  // 0 0 * * * KST — housekeeping placeholder (flag reset)
  cron.schedule("0 0 * * *", () => {}, { timezone: tz });
  // */5분 — P7 임베딩 잡 큐 처리 (재색인 요청 시엔 즉시 처리, 여긴 잔여분 재시도)
  cron.schedule("*/5 * * * *", () => void processEmbeddingJobs().catch((e) => console.error("[embed]", e)), { timezone: tz });

  // Restart catch-up: 이미 09:00을 지난 시각에 재시작된 경우에만 다이제스트를 보낸다.
  // (09:00 이전 재시작 시 조기 발송하면 멱등 키가 정규 09:00 발송을 막아버림 — Replit dev는 재시작 잦음)
  const hourInTz = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())) % 24;
  if (hourInTz >= 9) void runDailyDigest().catch(() => {});
}
