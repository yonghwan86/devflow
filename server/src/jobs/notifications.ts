import { and, eq, ne, inArray, lte, gte, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, guideAssignees, comments, events, eventAttendees } from "../../../shared/schema.ts";
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

  // F5: 오늘 일정(참석자 기준 — all_day 포함. all_day는 30분 리마인더 대상이 아니라 여기서 커버)
  const todayEvents = await db
    .select({ user_id: eventAttendees.user_id })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.event_id))
    .where(sql`(${events.starts_at} AT TIME ZONE ${env.TZ})::date = (${now.toISOString()}::timestamptz AT TIME ZONE ${env.TZ})::date`);

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
    });
    if (did) notified++;
  }
  return notified;
}

// F5: * * * * * — 30분 내 시작하는(all_day 제외) 이벤트의 참석자 리마인더. sendOnce 멱등.
export async function runEventReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + 30 * 60_000);
  const upcoming = await db
    .select({ event_id: events.id, title: events.title, starts_at: events.starts_at, user_id: eventAttendees.user_id })
    .from(events)
    .innerJoin(eventAttendees, eq(eventAttendees.event_id, events.id))
    .where(and(eq(events.all_day, false), gte(events.starts_at, now), lte(events.starts_at, soon)));
  let sent = 0;
  for (const e of upcoming) {
    const did = await sendOnce(`event-reminder:${e.event_id}:user:${e.user_id}`, async () => {
      const hm = new Date(e.starts_at).toLocaleTimeString("ko-KR", { timeZone: env.TZ, hour: "2-digit", minute: "2-digit" });
      await sendPushToUser(e.user_id, { title: "곧 시작하는 일정", body: `${hm} ${e.title}`, url: "/my-work" });
    });
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
    });
    if (did) sent++;
  }
  return sent;
}
