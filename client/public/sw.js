// DevFlow service worker: minimal offline shell + web push + 앱 아이콘 배지.
const CACHE = "devflow-v2";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api")) return; // never cache API
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});
// Web push — 알림 표시 + 앱 아이콘 배지(설치된 PWA에서 동작: Android Chrome·iOS 16.4+)
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || "DevFlow";
  e.waitUntil(
    (async () => {
      if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
        try {
          if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
          else await self.navigator.clearAppBadge();
        } catch {}
      }
      await self.registration.showNotification(title, {
        body: data.body || "",
        data: { url: data.url || "/" },
        icon: "/icon-192.png",
        badge: "/icon-192.png", // Android 상태바용 모노크롬 아이콘 슬롯
      });
    })(),
  );
});
// 클릭 → 이미 열린 창이 있으면 포커스+이동, 없으면 새 창
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c) { try { await c.navigate(url); } catch {} }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
