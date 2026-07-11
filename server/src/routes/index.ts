import { Router } from "express";
// Routers are mounted incrementally per build phase (P1..P10).
import { authRouter } from "./auth.ts";
import { tokensRouter } from "./tokens.ts";
import { projectsRouter } from "./projects.ts";
import { tasksRouter } from "./tasks.ts";
import { commentsRouter } from "./comments.ts";
import { myWorkRouter } from "./mywork.ts";
import { attachmentsRouter } from "./attachments.ts";
import { pushRouter } from "./push.ts";
import { skillsRouter } from "./skills.ts";
import { dependenciesRouter } from "./dependencies.ts";
import { aiRouter } from "./ai.ts";
import { webhooksRouter } from "./webhooks.ts";
import { snippetsRouter } from "./snippets.ts";
import { mcpRouter } from "./mcp.ts";
import { adminRouter } from "./admin.ts";
import { meetingsRouter } from "./meetings.ts";
import { galleryRouter } from "./gallery.ts";
import { eventsRouter } from "./events.ts";
import { journalRouter } from "./journal.ts";

export function apiRouter(): Router {
  const r = Router();
  r.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  r.use("/auth", authRouter());        // P1
  r.use("/tokens", tokensRouter());    // P1
  r.use("/projects", projectsRouter()); // P1/P2/P3
  r.use("/tasks", tasksRouter());      // P2/P3
  r.use("/comments", commentsRouter()); // P3
  r.use("/my-work", myWorkRouter());   // P2/P3
  r.use("/attachments", attachmentsRouter()); // P4
  r.use("/push", pushRouter());        // P4
  r.use("/skills", skillsRouter());    // P5
  r.use("/dependencies", dependenciesRouter()); // P6
  r.use("/ai", aiRouter());            // P7
  r.use("/webhooks", webhooksRouter()); // P8 (서명 인증)
  r.use("/snippets", snippetsRouter()); // P9
  r.use("/mcp", mcpRouter());          // P10 (Bearer api_token)
  r.use("/admin", adminRouter());      // 관리자 설정 (is_admin 전용)
  r.use("/meetings", meetingsRouter()); // 회의록 파이프라인
  r.use("/gallery", galleryRouter());  // P11 검증 갤러리
  r.use("/events", eventsRouter());    // F5 일정 이벤트
  r.use("/journal", journalRouter());  // N3 내 기록(개인 저널)
  return r;
}
