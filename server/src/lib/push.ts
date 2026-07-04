import webpush from "web-push";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { pushSubscriptions, systemSettings } from "../../../shared/schema.ts";
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
}

// Send to all of a user's subscriptions. Prunes expired (404/410) endpoints.
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!configureWebPush()) return 0;
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.user_id, userId));
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
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
