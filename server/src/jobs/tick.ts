import { env } from "../lib/env.ts";
import { runDailyDigest, runDueReminders, runEventReminders } from "./notifications.ts";

// autoscale 보완: 배포가 autoscale이라 트래픽이 없으면 인스턴스가 잠들고, 잠든 동안 cron이
// 안 돌아 리마인더가 통째로 증발한다. 요청 유입(외부 크론 핑 포함)을 실행 기회로 삼아
// 밀린 알림 잡을 처리한다 — 1분 스로틀, fire-and-forget이라 응답 지연 없음.
// 발송은 전부 sendOnce(DB 선점 멱등)라 cron·다중 인스턴스와 겹쳐 돌아도 중복 없음.
let lastTick = 0;
let running = false;

export function opportunisticTick(now = new Date()): void {
  if (env.isTest) return;
  if (running || now.getTime() - lastTick < 60_000) return;
  lastTick = now.getTime();
  running = true;
  void (async () => {
    try {
      await runDueReminders(now);
      await runEventReminders(now);
      // 다이제스트는 9시(KST) 이후 미발송분 따라잡기 — 사용자·일 단위 멱등이라 반복 호출 무해
      const hour =
        Number(new Intl.DateTimeFormat("en-US", { timeZone: env.TZ, hour: "2-digit", hour12: false }).format(now)) % 24;
      if (hour >= 9) await runDailyDigest(now);
    } catch (e) {
      console.error("[tick]", e);
    } finally {
      running = false;
    }
  })();
}
