import { and, eq, ne, inArray, lte, gte, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, guideAssignees, comments, events, eventAttendees, REMIND_NONE } from "../../../shared/schema.ts";
import { sendPushToUser, sendOnce } from "../lib/push.ts";
import { env } from "../lib/env.ts";

function ymd(d: Date): string {
  // date in configured TZ (Asia/Seoul)
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// 0 9 * * * — per-assignee digest: today's tasks + unperformed guides. Idempotent per user/day.
export async function runDailyDigest(now = new Date()): Promise<number> {
  const day = ymd(now);
  // users with a task scheduled today
  const todays = await db
    .select({ user_id: taskAssignees.user_id, task_id: tasks.id })
    .from(taskAssignees)
    .innerJoin(tasks, eq(tasks.id, taskAssignees.task_id))
    .where(
      and(
        ne(tasks.status, "done"),
        sql`(${tasks.scheduled_date} AT TIME ZONE ${env.TZ})::date = (${now.toISOString()}::timestamptz AT TIME ZONE ${env.TZ})::date`,
      ),
    );
  const pendingGuides = await db
    .select({ user_id: guideAssignees.user_id })
    .from(guideAssignees)
    .where(eq(guideAssignees.state, "pending"));

  // F5: 오늘 일정(참석자 기준 — all_day 포함. all_day 기본은 리마인더가 없어 여기서 커버)
  // 멀티데이 일정도 진행 중인 날마다 집계 — 시작일만 보면 2일차부터 "오늘 일정"에서 사라짐
  const todayEvents = await db
    .select({ user_id: eventAttendees.user_id })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.event_id))
    .where(sql`(${events.starts_at} AT TIME ZONE ${env.TZ})::date <= (${now.toISOString()}::timestamptz AT TIME ZONE ${env.TZ})::date
      AND (coalesce(${events.ends_at}, ${events.starts_at}) AT TIME ZONE ${env.TZ})::date >= (${now.toISOString()}::timestamptz AT TIME ZONE ${env.TZ})::date`);

  const counts = new Map<number, { tasks: number; guides: number; events: number }>();
  const bump = (uid: number, k: "tasks" | "guides" | "events") => {
    const c = counts.get(uid) ?? { tasks: 0, guides: 0, events: 0 };
    c[k]++;
    counts.set(uid, c);
  };
  for (const t of todays) bump(t.user_id, "tasks");
  for (const g of pendingGuides) bump(g.user_id, "guides");
  for (const e of todayEvents) bump(e.user_id, "events");

  let notified = 0;
  for (const [userId, c] of counts) {
    const did = await sendOnce(`digest:${day}:user:${userId}`, async () => {
      await sendPushToUser(userId, {
        title: "오늘의 DevFlow",
        body: `오늘 할 일 ${c.tasks}건, 미수행 가이드 ${c.guides}건${c.events > 0 ? `, 오늘 일정 ${c.events}건` : ""}`,
        url: "/",
      });
    }).catch((err) => { console.error("[digest]", err); return false; }); // 한 명 실패가 나머지 발송을 끊지 않게
    if (did) notified++;
  }
  return notified;
}

// F5/N2: 일정 리마인더 — 일정별 remind_minutes(시작 몇 분 전) 기준. sendOnce 멱등 + 따라잡기:
// autoscale로 발송 시각에 서버가 잠들어 있었어도 창(발송시각~종료 경계) 안에 깨어나면 늦게라도 보낸다.
// 기본값: 시간지정 30분 전 / 종일 없음(다이제스트가 커버). 종일 starts_at은 UTC 자정=KST 09:00 규약.
function reminderBody(e: { title: string; starts_at: Date; all_day: boolean }, now: Date): string {
  const day = ymd(e.starts_at);
  const rel = day === ymd(now) ? "오늘" : day === ymd(new Date(now.getTime() + 86400_000)) ? "내일" : day.slice(5).replace("-", "/");
  if (e.all_day) return `${rel} 종일 · ${e.title}`;
  const hm = e.starts_at.toLocaleTimeString("ko-KR", { timeZone: env.TZ, hour: "2-digit", minute: "2-digit" });
  return `${rel} ${hm} ${e.title}`;
}
export async function runEventReminders(now = new Date()): Promise<number> {
  // 후보 창: 과거 15h(종일 일정은 그날 KST 자정까지 발송 가능) ~ 미래 25h(하루 전 리마인드까지)
  const from = new Date(now.getTime() - 15 * 3600_000);
  const to = new Date(now.getTime() + 25 * 3600_000);
  const rows = await db
    .select({
      event_id: events.id, title: events.title, starts_at: events.starts_at,
      all_day: events.all_day, remind_minutes: events.remind_minutes, user_id: eventAttendees.user_id,
    })
    .from(events)
    .innerJoin(eventAttendees, eq(eventAttendees.event_id, events.id))
    .where(and(gte(events.starts_at, from), lte(events.starts_at, to)));
  let sent = 0;
  for (const e of rows) {
    const m = e.remind_minutes ?? (e.all_day ? REMIND_NONE : 30);
    if (m === REMIND_NONE) continue;
    const remindAt = e.starts_at.getTime() - m * 60_000;
    // 발송 창 끝: 시간지정=시작 시각(지난 일정에 "리마인더"는 무의미), 종일=그날 KST 자정(UTC 시작+15h)
    const windowEnd = e.all_day ? e.starts_at.getTime() + 15 * 3600_000 : e.starts_at.getTime();
    if (now.getTime() < remindAt || now.getTime() >= windowEnd) continue;
    // 키에 시각·오프셋 포함 — 발송 후 일정을 연기(starts_at 변경)하거나 리마인드를 바꾸면
    // 새 키로 다시 발송된다 (고정 키면 한 번 울린 일정은 수정해도 영영 침묵)
    const did = await sendOnce(
      `event-reminder:${e.event_id}:${e.starts_at.getTime()}:${m}:user:${e.user_id}`,
      async () => {
        await sendPushToUser(e.user_id, { title: "일정 리마인더", body: reminderBody(e, now), url: "/my-work" });
      },
    ).catch((err) => { console.error("[event-reminder]", err); return false; }); // 한 건 실패가 루프를 끊지 않게
    if (did) sent++;
  }
  return sent;
}

// * * * * * — due-soon reminders (within 60m, not done). Idempotent per task.
export async function runDueReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + 60 * 60_000);
  const due = await db
    .select({ task_id: tasks.id, title: tasks.title, project_id: tasks.project_id, user_id: taskAssignees.user_id, item_key: tasks.item_key })
    .from(tasks)
    .innerJoin(taskAssignees, eq(taskAssignees.task_id, tasks.id))
    .where(and(ne(tasks.status, "done"), lte(tasks.due_date, soon), gte(tasks.due_date, now)));
  let sent = 0;
  for (const d of due) {
    const did = await sendOnce(`due:${d.task_id}:user:${d.user_id}`, async () => {
      await sendPushToUser(d.user_id, { title: "마감 임박", body: `${d.item_key} ${d.title}`, url: `/projects/${d.project_id}/tasks/${d.item_key}` });
    }).catch((err) => { console.error("[due]", err); return false; });
    if (did) sent++;
  }
  return sent;
}
