import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "./db.ts";
import { journalEntries } from "../../../shared/schema.ts";
import { env } from "./env.ts";
import { err } from "./errors.ts";

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

// ILIKE 부분일치 검색 — 본인 기록만, 최신 날짜순, 매치 주변 스니펫 반환
export async function searchEntries(userId: number, query: string, limit = 10) {
  const q = query.trim();
  if (!q) return [];
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`); // LIKE 와일드카드가 검색어에 있으면 문자 그대로
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.user_id, userId), ilike(journalEntries.content, `%${escaped}%`)))
    .orderBy(desc(journalEntries.entry_date))
    .limit(Math.min(Math.max(limit, 1), 30));
  return rows.map((r) => {
    const idx = r.content.toLowerCase().indexOf(q.toLowerCase());
    const from = Math.max(0, idx - 80);
    const to = Math.min(r.content.length, (idx < 0 ? 0 : idx + q.length) + 120);
    const snippet = `${from > 0 ? "…" : ""}${r.content.slice(from, to)}${to < r.content.length ? "…" : ""}`;
    return { entry_date: r.entry_date, snippet, updated_at: r.updated_at };
  });
}
