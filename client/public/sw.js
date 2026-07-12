// DevFlow service worker: minimal offline shell + web push + 앱 아이콘 배지 + 안드로이드 공유 수신.
const CACHE = "devflow-v3";
const SHARE_CACHE = "devflow-share"; // 공유 수신 스테이징 — /share 페이지가 읽고 지움
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});
// 안드로이드 공유 대상(share_target POST /share) — OS가 보내는 multipart를 여기서 받아
// Cache에 스테이징하고 GET /share로 리다이렉트. 앱(/share 페이지)이 로그인 세션으로 실제 저장한다.
// (서버로 직접 POST하면 SameSite=Lax 쿠키가 빠져 401 — 서비스워커 수신이 정석 경로)
async function stageShare(request) {
  try {
    const form = await request.formData();
    const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).join("\n");
    const files = form.getAll("images").filter((f) => f && typeof f === "object" && f.size > 0);
    const cache = await caches.open(SHARE_CACHE);
    const meta = { text, files: [], at: Date.now() };
    for (let i = 0; i < Math.min(files.length, 10); i++) {
      const f = files[i];
      const key = `/__share/file/${i}`;
      await cache.put(key, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }));
      meta.files.push({ key, name: f.name || `shared-${i}.png`, type: f.type || "" });
    }
    await cache.put("/__share/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // 저장공간 부족·파싱 실패 등 — 통째로 유실되는 대신 앱으로 보내 "공유 내용 없음" 안내를 받게 한다
  }
  return Response.redirect("/share", 303);
}
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share") {
    // OS 공유 시트가 보내는 요청만 허용 — 악성 사이트의 숨은 크로스사이트 POST로 조작 콘텐츠가
    // 몰래 스테이징되지 않게 발신 컨텍스트를 검사(Sec-Fetch-Site: none=런처, same-origin=앱 내부).
    const fetchSite = e.request.headers.get("Sec-Fetch-Site");
    if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") {
      e.respondWith(Response.redirect("/share", 303));
      return;
    }
    e.respondWith(stageShare(e.request));
    return;
  }
  if (e.request.method !== "GET") return; // API 등 mutating 요청은 절대 관여하지 않음
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
