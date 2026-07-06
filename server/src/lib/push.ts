import webpush from "web-push";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { pushSubscriptions, systemSettings, projectMembers, tasks, taskAssignees, roleAtLeast } from "../../../shared/schema.ts";
import { env } from "./env.ts";

let configured = false;
export function configureWebPush(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  badge?: number; // 앱 아이콘 배지 수 — 미지정 시 수신자의 미완료 배정 태스크 수 자동 첨부
}

// 수신자의 미완료 배정 태스크 수 (앱 아이콘 배지용)
async function openTaskCount(userId: number): Promise<number> {
  const ids = (
    await db.select({ id: taskAssignees.task_id }).from(taskAssignees).where(eq(taskAssignees.user_id, userId))
  ).map((a) => a.id);
  if (!ids.length) return 0;
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, ids), ne(tasks.status, "done"), ne(tasks.status, "rejected")));
  return rows.length;
}

// Send to all of a user's subscriptions. Prunes expired (404/410) endpoints.
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!configureWebPush()) return 0;
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.user_id, userId));
  if (!subs.length) return 0;
  const body = JSON.stringify({ ...payload, badge: payload.badge ?? (await openTaskCount(userId)) });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      }
    }
  }
  return sent;
}

// F1-4: 프로젝트의 owner/manager 전원에게 발송 (티켓 요청 알림 등).
// 사용자 액션 1회당 1발송이므로 sendOnce(멱등 키) 불필요 — cron성 알림이 아님.
export async function notifyProjectManagers(projectId: number, payload: PushPayload): Promise<number> {
  const rows = await db
    .select({ user_id: projectMembers.user_id, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.project_id, projectId));
  const managers = rows.filter((r) => roleAtLeast(r.role, "manager")); // owner+manager
  let sent = 0;
  for (const r of managers) sent += await sendPushToUser(r.user_id, payload);
  return sent;
}

// §9 idempotency: record-after-send key so restarts/retries never double-send.
export async function alreadySent(key: string): Promise<boolean> {
  const [hit] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return !!hit;
}
export async function markSent(key: string): Promise<void> {
  await db.insert(systemSettings).values({ key, value: new Date().toISOString() }).onConflictDoNothing();
}
// Run a send exactly once for a given idempotency key.
export async function sendOnce(key: string, fn: () => Promise<void>): Promise<boolean> {
  if (await alreadySent(key)) return false;
  await fn();
  await markSent(key);
  return true;
}
