import { and, eq, ne, inArray, lte, gte, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, guideAssignees, comments } from "../../../shared/schema.ts";
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

  const counts = new Map<number, { tasks: number; guides: number }>();
  for (const t of todays) {
    const c = counts.get(t.user_id) ?? { tasks: 0, guides: 0 };
    c.tasks++;
    counts.set(t.user_id, c);
  }
  for (const g of pendingGuides) {
    const c = counts.get(g.user_id) ?? { tasks: 0, guides: 0 };
    c.guides++;
    counts.set(g.user_id, c);
  }

  let notified = 0;
  for (const [userId, c] of counts) {
    const did = await sendOnce(`digest:${day}:user:${userId}`, async () => {
      await sendPushToUser(userId, {
        title: "오늘의 DevFlow",
        body: `오늘 할 일 ${c.tasks}건, 미수행 가이드 ${c.guides}건`,
        url: "/",
      });
    });
    if (did) notified++;
  }
  return notified;
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
