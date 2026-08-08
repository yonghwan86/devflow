import cron from "node-cron";
import { env } from "../lib/env.ts";
import { runDailyDigest, runDueReminders, runEventReminders } from "./notifications.ts";
import { configureWebPush } from "../lib/push.ts";
import { processEmbeddingJobs } from "../lib/embeddings.ts";
import { purgeExpiredProjects } from "../lib/projectLifecycle.ts";

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
  // 0 0 * * * KST — housekeeping: 휴지통에서 30일 지난 프로젝트 영구 삭제.
  // 하루 1회면 충분하다(경계에서 몇 시간 늦어도 무해).
  const purgeTrash = () =>
    void purgeExpiredProjects()
      .then((n) => n && console.log(`[trash] 프로젝트 ${n}건 영구 삭제`))
      .catch((e) => console.error("[trash]", e));
  cron.schedule("0 0 * * *", purgeTrash, { timezone: tz });
  // */5분 — P7 임베딩 잡 큐 처리 (재색인 요청 시엔 즉시 처리, 여긴 잔여분 재시도)
  cron.schedule("*/5 * * * *", () => void processEmbeddingJobs().catch((e) => console.error("[embed]", e)), { timezone: tz });

  // Restart catch-up: 이미 09:00을 지난 시각에 재시작된 경우에만 다이제스트를 보낸다.
  // (09:00 이전 재시작 시 조기 발송하면 멱등 키가 정규 09:00 발송을 막아버림 — Replit dev는 재시작 잦음)
  const hourInTz = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())) % 24;
  if (hourInTz >= 9) void runDailyDigest().catch(() => {});

  // 휴지통 비우기도 기동 시 1회 따라잡는다. 다이제스트와 달리 시각 게이트가 없다 —
  // 대상 조건이 "30일 경과"뿐이라 언제 돌려도 결과가 같고(멱등) 조기 실행이라는 개념이 없다.
  // autoscale로 자정마다 서버가 자고 있으면 00:00 tick이 **매일** 유실돼 영영 안 돌기 때문에
  // "다음 자정에 처리된다"는 보장이 성립하지 않는다. 깨어날 때 밀린 것을 처리한다.
  purgeTrash();
}
