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
// VAPID 미설정·구독 없음은 영구 조건이라 0 반환(sendOnce 키 소비 유지 — 재시도 무의미).
// 반면 전 구독이 일시 장애(5xx·네트워크)로 실패하면 throw — sendOnce가 키를 회수해 다음 tick에서 재시도.
// 일부 성공은 성공(재시도하면 성공한 기기에 중복 발송되므로).
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!configureWebPush()) return 0;
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.user_id, userId));
  if (!subs.length) return 0;
  const body = JSON.stringify({ ...payload, badge: payload.badge ?? (await openTaskCount(userId)) });
  let sent = 0;
  let transientErr: unknown = null;
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
      } else {
        transientErr = e;
      }
    }
  }
  if (sent === 0 && transientErr) throw transientErr;
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

// §9 idempotency: 키를 먼저 선점(insert)한 쪽만 발송 — autoscale에서 인스턴스 여러 개가
// 동시에 깨어나 같은 잡을 돌려도 onConflictDoNothing이 한 쪽만 통과시킨다.
// (확인→발송→기록 순서는 그 사이 찰나에 둘 다 발송하는 틈이 있었음)
export async function sendOnce(key: string, fn: () => Promise<void>): Promise<boolean> {
  const claimed = await db
    .insert(systemSettings)
    .values({ key, value: new Date().toISOString() })
    .onConflictDoNothing()
    .returning({ key: systemSettings.key });
  if (!claimed.length) return false;
  try {
    await fn();
    return true;
  } catch (e) {
    // 발송 실패 시 키 회수 — 다음 tick/cron에서 재시도 가능하게
    try {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    } catch { /* 회수 실패는 무시 — 최악이 미발송 1회 */ }
    throw e;
  }
}
