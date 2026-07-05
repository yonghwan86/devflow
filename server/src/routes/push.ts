import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { pushSubscriptions } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { env } from "../lib/env.ts";
import { sendPushToUser } from "../lib/push.ts";

export function pushRouter(): Router {
  const r = Router();

  r.get("/vapid-public-key", (_req, res) => res.json({ key: env.VAPID_PUBLIC_KEY || null }));

  r.use(requireAuth);

  r.post(
    "/subscribe",
    ah(async (req, res) => {
      const body = z
        .object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
        .parse(req.body);
      // 같은 브라우저 endpoint가 다른 계정으로 재구독하면 user_id·키를 갱신(공유 기기 계정 전환 시
      // 이전 사용자 알림이 새 사용자 기기로 계속 가는 정보 노출 방지).
      await db
        .insert(pushSubscriptions)
        .values({ user_id: req.userId!, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { user_id: req.userId!, p256dh: body.keys.p256dh, auth: body.keys.auth },
        });
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    "/unsubscribe",
    ah(async (req, res) => {
      const body = z.object({ endpoint: z.string() }).parse(req.body);
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/test",
    ah(async (req, res) => {
      const n = await sendPushToUser(req.userId!, { title: "DevFlow", body: "테스트 알림입니다.", url: "/" });
      res.json({ sent: n });
    }),
  );

  return r;
}
