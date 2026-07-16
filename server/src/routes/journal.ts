import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { journalEntries, journalAttachments, tasks, taskAssignees, events, eventAttendees } from "../../../shared/schema.ts";
import { env } from "../lib/env.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { detectFileType, MAX_UPLOAD_BYTES } from "../lib/fileType.ts";
import { getStorage } from "../lib/storage.ts";
import { randomToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import { DAY_KEY_RE, appendEntry, deleteEntryIfOrphan, getEntry, getRangeEntries, heatmapDays, journalDayKey, ocrAttachment, saveEntry, searchEntries } from "../lib/journalService.ts";

// N3: 내 기록(개인 저널) — 완전 개인 공간.
// 불변식: 모든 쿼리가 user_id = 본인 필터를 지난다. 관리자(is_admin)에게도 우회 경로가 없다.
// 토큰 인증은 journal:write 스코프 전용(auth.ts 게이트) — 다른 스코프 토큰이 개인 기록에 접근 불가.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });
const MAX_ATTACHMENTS_PER_DAY = 20;

// 이미지 업로드는 건당 비전 OCR(유료 LLM) 1회를 유발 → 사용자별 rate limit으로 비용·부하 남용 차단
// (붙여넣기 여러 장은 정상, 스크립트 대량 업로드·업로드↔삭제 반복 우회는 차단). ai.ts의 aiLimiter와 동일 정책.
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req as any).userId ?? req.ip),
  message: { error: { code: "rate_limited", message: "이미지 업로드가 너무 잦습니다. 잠시 후 다시 시도하세요." } },
});

const attView = (a: typeof journalAttachments.$inferSelect) => ({
  id: a.id,
  entry_date: a.entry_date,
  file_name: a.file_name,
  size_bytes: a.size_bytes,
  created_at: a.created_at,
  ocr_text: a.ocr_text, // v1.5: 비전 추출 텍스트 (키 미등록·처리 전이면 null)
  download_url: `/api/journal/attachments/${a.id}`,
  thumb_url: a.thumb_key ? `/api/journal/attachments/${a.id}?thumb=1` : null,
});

export function journalRouter(): Router {
  const r = Router();
  // 스코프 격리의 최종 방어선 — auth.ts의 URL prefix 게이트는 경로 표기 변형에 취약할 수 있어,
  // 실제로 이 라우터에 도달한 요청에서 다시 강제한다 (라우터 매칭 기준이라 우회 불가).
  r.use((req, _res, next) => {
    if (req.tokenScopes && !req.tokenScopes.includes("journal:write"))
      return next(err.forbidden("토큰 스코프 부족: 내 기록에는 journal:write 스코프가 필요합니다."));
    next();
  });
  r.use(requireAuth);

  // 월별 목록 — 날짜 리스트·쓴 날 점 표시용. preview는 첫 줄 일부만.
  r.get(
    "/",
    ah(async (req, res) => {
      const month = String(req.query.month ?? "");
      if (!/^\d{4}-\d{2}$/.test(month)) throw err.badRequest("month(YYYY-MM)가 필요합니다.");
      const rows = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.user_id, req.userId!), like(journalEntries.entry_date, `${month}-%`)))
        .orderBy(desc(journalEntries.entry_date));
      // 이미지-only 날 표시용 — 그 달 날짜별 첨부 개수(preview가 비면 클라가 "이미지 N장"으로 안내)
      const attCounts = await db
        .select({ entry_date: journalAttachments.entry_date, n: sql<number>`count(*)::int` })
        .from(journalAttachments)
        .where(and(eq(journalAttachments.user_id, req.userId!), like(journalAttachments.entry_date, `${month}-%`)))
        .groupBy(journalAttachments.entry_date);
      const attMap = new Map(attCounts.map((a) => [a.entry_date, a.n]));
      res.json({
        today: journalDayKey(),
        days: rows.map((e) => ({
          entry_date: e.entry_date,
          updated_at: e.updated_at,
          preview: e.content.slice(0, 120),
          image_count: attMap.get(e.entry_date) ?? 0,
        })),
      });
    }),
  );

  // 검색 — 본인 기록 전체에서 부분일치 (태그 필터도 이 경로: q="#아이디어")
  r.get(
    "/search",
    ah(async (req, res) => {
      const q = String(req.query.q ?? "");
      if (!q.trim()) throw err.badRequest("q가 필요합니다.");
      res.json({ results: await searchEntries(req.userId!, q, Number(req.query.limit ?? 10)) });
    }),
  );

  // 잔디 히트맵 — 최근 N주 날짜별 분량(길이만). "/:date"보다 먼저 등록해야 한다.
  r.get(
    "/heatmap",
    ah(async (req, res) => {
      res.json({ today: journalDayKey(), days: await heatmapDays(req.userId!, Number(req.query.weeks ?? 16)) });
    }),
  );

  // 기간 전문 조회 — 주간 롤업용 (31일 제한은 서비스에서 검증)
  r.get(
    "/range",
    ah(async (req, res) => {
      const rows = await getRangeEntries(req.userId!, String(req.query.from ?? ""), String(req.query.to ?? ""));
      res.json({ entries: rows.map((e) => ({ entry_date: e.entry_date, content: e.content, updated_at: e.updated_at })) });
    }),
  );

  // 하루 요약 — 이 날 완료한 내 태스크 + 참석 일정 (자동 요약 프리필용).
  // 세션 전용: journal:write 토큰(시리 단축어)이 저널 밖 태스크·일정 정보까지 읽지 못하게 토큰 인증은 거부.
  r.get(
    "/day-summary",
    ah(async (req, res) => {
      if (req.tokenScopes) throw err.forbidden("이 기능은 앱 로그인에서만 사용할 수 있습니다.");
      const date = String(req.query.date ?? "");
      if (!DAY_KEY_RE.test(date)) throw err.badRequest("date(YYYY-MM-DD)가 필요합니다.");
      const doneTasks = await db
        .select({ item_key: tasks.item_key, title: tasks.title })
        .from(taskAssignees)
        .innerJoin(tasks, eq(tasks.id, taskAssignees.task_id))
        .where(and(
          eq(taskAssignees.user_id, req.userId!),
          eq(tasks.status, "done"),
          sql`(${tasks.completed_at} AT TIME ZONE ${env.TZ})::date = ${date}::date`,
        ))
        .orderBy(tasks.item_key);
      const dayEvents = await db
        .select({ title: events.title, starts_at: events.starts_at, all_day: events.all_day })
        .from(eventAttendees)
        .innerJoin(events, eq(events.id, eventAttendees.event_id))
        .where(and(
          eq(eventAttendees.user_id, req.userId!),
          sql`(${events.starts_at} AT TIME ZONE ${env.TZ})::date <= ${date}::date
            AND (coalesce(${events.ends_at}, ${events.starts_at}) AT TIME ZONE ${env.TZ})::date >= ${date}::date`,
        ))
        .orderBy(events.starts_at);
      res.json({
        tasks: doneTasks,
        events: dayEvents.map((e) => ({
          title: e.title,
          time: e.all_day ? null : new Date(e.starts_at).toLocaleTimeString("ko-KR", { timeZone: env.TZ, hour: "2-digit", minute: "2-digit", hour12: false }),
        })),
      });
    }),
  );

  // 이어쓰기 — 시리 단축어("시리야 기록")·간이 캡처용. 오늘(KST) 페이지에 시각 스탬프와 함께 추가.
  r.post(
    "/append",
    ah(async (req, res) => {
      const body = z
        .object({ text: z.string().min(1).max(20_000), tags: z.array(z.string().max(50)).max(10).optional() })
        .parse(req.body ?? {});
      const entry = await appendEntry(req.userId!, body.text, { tags: body.tags });
      res.status(201).json({ entry: { entry_date: entry.entry_date, content: entry.content } });
    }),
  );

  // 하루 조회 — 없는 날은 entry: null (lazy creation: 열람만으로 행을 만들지 않음)
  r.get(
    "/:date",
    ah(async (req, res) => {
      const date = String(req.params.date);
      if (!DAY_KEY_RE.test(date)) throw err.badRequest("날짜는 YYYY-MM-DD 형식입니다.");
      const entry = await getEntry(req.userId!, date);
      const atts = await db
        .select()
        .from(journalAttachments)
        .where(and(eq(journalAttachments.user_id, req.userId!), eq(journalAttachments.entry_date, date)))
        .orderBy(journalAttachments.id);
      res.json({ entry, attachments: atts.map(attView) });
    }),
  );

  // 하루 저장(upsert) — 빈 내용 저장은 "그날 기록 비우기"로 허용
  r.put(
    "/:date",
    ah(async (req, res) => {
      const date = String(req.params.date);
      if (!DAY_KEY_RE.test(date)) throw err.badRequest("날짜는 YYYY-MM-DD 형식입니다.");
      const body = z.object({ content: z.string() }).parse(req.body ?? {});
      const entry = await saveEntry(req.userId!, date, body.content);
      res.json({ entry });
    }),
  );

  // 이미지 첨부 — 원본 보존(맥락용). 매직넘버로 이미지만 허용, 썸네일 생성.
  r.post(
    "/:date/attachments",
    uploadLimiter,
    upload.single("file"),
    ah(async (req, res) => {
      const date = String(req.params.date);
      if (!DAY_KEY_RE.test(date)) throw err.badRequest("날짜는 YYYY-MM-DD 형식입니다.");
      if (!req.file) throw err.badRequest("파일이 없습니다.");
      const detected = detectFileType(req.file.buffer);
      if (!detected || detected.category !== "image") throw err.badRequest("이미지 파일만 첨부할 수 있어요.");
      const count = await db
        .select({ id: journalAttachments.id })
        .from(journalAttachments)
        .where(and(eq(journalAttachments.user_id, req.userId!), eq(journalAttachments.entry_date, date)));
      if (count.length >= MAX_ATTACHMENTS_PER_DAY) throw err.badRequest(`하루 첨부는 ${MAX_ATTACHMENTS_PER_DAY}개까지예요.`);
      // 텍스트 없이 이미지만 올린 날도 월 목록에 나타나게 — 빈 앵커 행을 보장한다.
      // onConflictDoNothing: 이미 행이 있으면(본문 포함) 손대지 않는다(경합 시 본문을 ""로 덮던 TOCTOU 차단).
      await db.insert(journalEntries).values({ user_id: req.userId!, entry_date: date, content: "" }).onConflictDoNothing();

      const storage = getStorage();
      const base = `journal/u${req.userId!}/${randomToken(16)}`;
      const storageKey = `${base}.${detected.ext}`;
      await storage.put(storageKey, req.file.buffer, detected.mime);
      let thumbKey: string | null = null;
      try {
        const thumb = await sharp(req.file.buffer).resize(320, 320, { fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
        thumbKey = `${base}.thumb.jpg`;
        await storage.put(thumbKey, thumb, "image/jpeg");
      } catch { /* non-fatal */ }

      const [a] = await db
        .insert(journalAttachments)
        .values({
          user_id: req.userId!,
          entry_date: date,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
          detected_type: detected.mime,
          size_bytes: req.file.size,
          storage_key: storageKey,
          thumb_key: thumbKey,
        })
        .returning();
      void ocrAttachment(a.id, req.file.buffer, detected.mime); // v1.5: 텍스트 추출은 백그라운드 — 응답을 막지 않음
      res.status(201).json({ attachment: attView(a) });
    }),
  );

  // 첨부 조회 — 본인 것만. 이미지 전용이라(매직넘버 강제) inline 표시 안전.
  r.get(
    "/attachments/:id",
    ah(async (req, res) => {
      const [a] = await db
        .select()
        .from(journalAttachments)
        .where(and(eq(journalAttachments.id, Number(req.params.id)), eq(journalAttachments.user_id, req.userId!)))
        .limit(1);
      if (!a) throw err.notFound();
      const wantThumb = req.query.thumb === "1" && a.thumb_key;
      const key = wantThumb ? a.thumb_key! : a.storage_key;
      const storage = getStorage();
      const url = await storage.presignGet(key, a.file_name);
      if (url) return res.redirect(url);
      const buf = await storage.get(key);
      res.setHeader("Content-Type", wantThumb ? "image/jpeg" : a.detected_type ?? "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(a.file_name)}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(buf);
    }),
  );

  r.delete(
    "/attachments/:id",
    ah(async (req, res) => {
      const [a] = await db
        .select()
        .from(journalAttachments)
        .where(and(eq(journalAttachments.id, Number(req.params.id)), eq(journalAttachments.user_id, req.userId!)))
        .limit(1);
      if (!a) throw err.notFound();
      const storage = getStorage();
      await storage.delete(a.storage_key).catch(() => {});
      if (a.thumb_key) await storage.delete(a.thumb_key).catch(() => {});
      await db.delete(journalAttachments).where(eq(journalAttachments.id, a.id));
      await deleteEntryIfOrphan(req.userId!, a.entry_date); // 마지막 이미지였고 본문이 비었으면 앵커용 빈 행도 정리
      res.json({ ok: true });
    }),
  );

  return r;
}
