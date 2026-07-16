import { and, desc, eq, exists, gte, ilike, lte, notExists, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { journalEntries, journalAttachments } from "../../../shared/schema.ts";
import { env } from "./env.ts";
import { err } from "./errors.ts";
import { isMockLlm, visionExtractText } from "./llm.ts";

// 내 기록(개인 저널) 공용 로직 — REST(routes/journal.ts)와 MCP(journal_append/journal_search)가 공유.
// 모든 함수는 호출자가 넘긴 userId 본인 데이터만 다룬다 — 관리자 우회 경로 없음(설계 불변식).

export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const JOURNAL_MAX_CHARS = 200_000; // 하루 분량 상한 — 폭주·실수 붙여넣기 방지

// KST 기준 날짜 키 — "오늘 페이지"의 하루 경계는 서버 TZ(Asia/Seoul)로 정한다
export function journalDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function getEntry(userId: number, entryDate: string) {
  const [row] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), eq(journalEntries.entry_date, entryDate)))
    .limit(1);
  return row ?? null;
}

// lazy creation: 안 쓴 날은 행이 없고, 첫 저장 때 생성
export async function upsertEntry(userId: number, entryDate: string, content: string) {
  if (content.length > JOURNAL_MAX_CHARS) throw err.badRequest("기록이 너무 깁니다 (하루 20만 자까지).");
  const [row] = await db
    .insert(journalEntries)
    .values({ user_id: userId, entry_date: entryDate, content })
    .onConflictDoUpdate({
      target: [journalEntries.user_id, journalEntries.entry_date],
      set: { content, updated_at: new Date() },
    })
    .returning();
  return row;
}

// 그 날짜에 첨부(이미지)가 하나라도 있는지 — 빈 엔트리를 지워도 되는지 판단용
export async function journalDayHasAttachments(userId: number, entryDate: string): Promise<boolean> {
  const [a] = await db
    .select({ id: journalAttachments.id })
    .from(journalAttachments)
    .where(and(eq(journalAttachments.user_id, userId), eq(journalAttachments.entry_date, entryDate)))
    .limit(1);
  return !!a;
}

// 그 날짜에 첨부가 없을 때만 참인 NOT EXISTS 조건 — DELETE의 WHERE에 넣어 "검사→삭제"를 한 문장으로 원자화(TOCTOU 차단)
function noAttachmentsCond(userId: number, entryDate: string) {
  return notExists(
    db
      .select({ n: sql`1` })
      .from(journalAttachments)
      .where(and(eq(journalAttachments.user_id, userId), eq(journalAttachments.entry_date, entryDate))),
  );
}

// 월목록·히트맵 공용 조건 — "실제 기록이 있는 날"(본문이 공백 아님 OR 그 날 첨부 있음)만.
// 저장 시 삭제(saveEntry)와 별개로 조회에서도 걸러, 수정 배포 전에 이미 쌓인 빈 앵커(유령 점)를 즉시 숨긴다.
export function hasRecordCond() {
  return or(
    sql`btrim(${journalEntries.content}) <> ''`,
    exists(
      db
        .select({ n: sql`1` })
        .from(journalAttachments)
        .where(and(eq(journalAttachments.user_id, journalEntries.user_id), eq(journalAttachments.entry_date, journalEntries.entry_date))),
    ),
  );
}

// 하루 저장 — 텍스트가 비었고 그 날 첨부도 없으면 행을 남기지 않는다(월 목록의 유령 점 방지).
// 첨부가 있으면 이미지-only 날의 목록 노출용 앵커로 빈 행을 유지(upsert). 반환 null = 행 없음.
export async function saveEntry(userId: number, entryDate: string, content: string) {
  if (content.trim()) return upsertEntry(userId, entryDate, content);
  if (await journalDayHasAttachments(userId, entryDate)) return upsertEntry(userId, entryDate, ""); // 앵커 유지
  // 첨부 없음 → 행 삭제. NOT EXISTS(첨부)를 WHERE에 넣어, 검사~삭제 사이 첨부가 들어와도 앵커를 지우지 않는다.
  await db
    .delete(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), eq(journalEntries.entry_date, entryDate), noAttachmentsCond(userId, entryDate)));
  return null;
}

// 첨부 삭제 후 정리 — 본문이 비었고 첨부도 0개면 앵커용 빈 행을 제거(마지막 이미지 삭제 시 유령 잔존 방지).
// 본문 공백 + 첨부 없음 두 조건을 한 DELETE 문에 넣어 원자화(TOCTOU 차단).
export async function deleteEntryIfOrphan(userId: number, entryDate: string): Promise<void> {
  await db
    .delete(journalEntries)
    .where(and(
      eq(journalEntries.user_id, userId),
      eq(journalEntries.entry_date, entryDate),
      sql`btrim(${journalEntries.content}) = ''`,
      noAttachmentsCond(userId, entryDate),
    ));
}

// 시각 스탬프를 붙여 오늘 기록 끝에 이어쓰기 — 시리 단축어·MCP 캡처 경로의 공용 본체
export async function appendEntry(userId: number, text: string, opts: { tags?: string[]; now?: Date } = {}) {
  const body = text.trim();
  if (!body) throw err.badRequest("기록할 내용이 없습니다.");
  const now = opts.now ?? new Date();
  const day = journalDayKey(now);
  const hm = now.toLocaleTimeString("ko-KR", { timeZone: env.TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const tags = (opts.tags ?? [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
  const block = `**${hm}** ${body}${tags ? ` ${tags}` : ""}`;
  const existing = await getEntry(userId, day);
  const content = existing?.content?.trim() ? `${existing.content.replace(/\s+$/, "")}\n\n${block}` : block;
  return upsertEntry(userId, day, content);
}

// 잔디 히트맵용 — 최근 N주(오늘 포함)의 날짜별 분량. 본문은 안 내려보내고 길이만.
// 클라 격자는 시작 주의 일요일부터 그리므로(요일 정렬), 시작일이 속한 주의 일요일까지 범위를 넓혀
// 그 며칠(최대 6일)에 쓴 기록이 "기록 없음"으로 잘못 보이지 않게 한다.
export async function heatmapDays(userId: number, weeks: number) {
  const w = Math.min(Math.max(Math.trunc(weeks) || 16, 4), 53);
  const startBase = new Date(Date.now() - (w * 7 - 1) * 86400_000);
  const dow = new Date(`${journalDayKey(startBase)}T00:00:00Z`).getUTCDay(); // KST day key의 요일
  const startKey = journalDayKey(new Date(startBase.getTime() - dow * 86400_000));
  return db
    .select({ entry_date: journalEntries.entry_date, chars: sql<number>`length(${journalEntries.content})` })
    .from(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), gte(journalEntries.entry_date, startKey), hasRecordCond()))
    .orderBy(journalEntries.entry_date);
}

// 기간 조회(주간 롤업용) — 전문 포함이라 31일로 제한
export async function getRangeEntries(userId: number, from: string, to: string) {
  if (!DAY_KEY_RE.test(from) || !DAY_KEY_RE.test(to)) throw err.badRequest("from/to는 YYYY-MM-DD 형식입니다.");
  if (from > to) throw err.badRequest("from이 to보다 늦습니다.");
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
  if (span > 31) throw err.badRequest("기간은 31일 이내여야 합니다.");
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), gte(journalEntries.entry_date, from), lte(journalEntries.entry_date, to), sql`btrim(${journalEntries.content}) <> ''`))
    .orderBy(journalEntries.entry_date);
}

// v1.5: 이미지 첨부 OCR — LLM 비전으로 텍스트 추출해 검색 대상으로. 업로드 응답을 막지 않는 백그라운드 작업.
// LLM 키 미등록(mock)이면 조용히 건너뜀 — 키 등록 이후 올린 이미지부터 적용된다.
const OCR_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export async function ocrAttachment(attachmentId: number, buffer: Buffer, mime: string): Promise<void> {
  if (isMockLlm() || !OCR_MIMES.has(mime)) return;
  try {
    // 폰 사진 원본(수 MB)은 비전 API 한도(Anthropic 5MB/이미지)를 넘을 수 있어 전송 전 축소.
    // 1568px는 비전 모델 권장 상한 — 텍스트 판독에 충분하면서 토큰 비용도 줄인다.
    // flatten: 투명 PNG(수식·로고·다크모드 내보내기)를 JPEG로 바꿀 때 알파가 검정으로 깔려 글자가
    // 안 보이던 것을 흰 배경으로 정규화(알파 없는 이미지엔 무효과).
    let img = buffer;
    let sendMime = mime;
    try {
      const sharp = (await import("sharp")).default;
      img = await sharp(buffer).flatten({ background: "#ffffff" }).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      sendMime = "image/jpeg";
    } catch {
      // 축소 실패 폴백은 원본 전송 — 단, 프로바이더 한도(≈5MB)를 넘는 원본은 어차피 거부되니 조용히 스킵
      if (buffer.length > 4_500_000) return;
    }
    const raw = await visionExtractText(
      { base64: img.toString("base64"), mime: sendMime },
      "이 이미지에 보이는 모든 텍스트를 원문 그대로 추출해줘. 텍스트가 없으면 이미지 내용을 한두 문장으로 요약해줘. 부가 설명 없이 내용만 답해.",
    );
    const text = raw.trim().slice(0, 8000);
    if (text) await db.update(journalAttachments).set({ ocr_text: text }).where(eq(journalAttachments.id, attachmentId));
  } catch (e) {
    console.error("[journal-ocr]", e); // OCR 실패는 첨부 자체에 영향 없음
  }
}

const mkSnippet = (content: string, q: string) => {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  const from = Math.max(0, idx - 80);
  const to = Math.min(content.length, (idx < 0 ? 0 : idx + q.length) + 120);
  return `${from > 0 ? "…" : ""}${content.slice(from, to)}${to < content.length ? "…" : ""}`;
};

// ILIKE 부분일치 검색 — 본인 기록만(본문 + 이미지 OCR 텍스트), 최신 날짜순, 매치 주변 스니펫 반환
export async function searchEntries(userId: number, query: string, limit = 10) {
  const q = query.trim();
  if (!q) return [];
  const lim = Math.min(Math.max(limit, 1), 30);
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`); // LIKE 와일드카드가 검색어에 있으면 문자 그대로
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), ilike(journalEntries.content, `%${escaped}%`)))
    .orderBy(desc(journalEntries.entry_date))
    .limit(lim);
  const results = rows.map((r) => ({ entry_date: r.entry_date, snippet: mkSnippet(r.content, q), updated_at: r.updated_at }));
  // 이미지 OCR 텍스트도 검색 — 본문 매치가 없는 날만 추가 (같은 날 중복 방지)
  const attRows = await db
    .select({ entry_date: journalAttachments.entry_date, file_name: journalAttachments.file_name, ocr_text: journalAttachments.ocr_text, created_at: journalAttachments.created_at })
    .from(journalAttachments)
    .where(and(eq(journalAttachments.user_id, userId), ilike(journalAttachments.ocr_text, `%${escaped}%`)))
    .orderBy(desc(journalAttachments.entry_date))
    .limit(lim);
  const seen = new Set(results.map((r) => r.entry_date));
  for (const a of attRows) {
    if (seen.has(a.entry_date)) continue;
    seen.add(a.entry_date);
    results.push({ entry_date: a.entry_date, snippet: `[이미지 ${a.file_name}] ${mkSnippet(a.ocr_text ?? "", q)}`, updated_at: a.created_at });
  }
  results.sort((x, y) => (x.entry_date < y.entry_date ? 1 : -1));
  return results.slice(0, lim);
}
