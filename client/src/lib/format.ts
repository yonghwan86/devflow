export const STATUS_LABEL: Record<string, string> = {
  requested: "요청됨", rejected: "반려됨",
  todo: "할 일", in_progress: "진행 중", blocked: "막힘", done: "완료",
};
export const STATUS_COLOR: Record<string, string> = {
  requested: "bg-violet-100 text-violet-700", // F1: 티켓 요청 (amber 계열과 구분)
  rejected: "bg-rose-100 text-rose-700",
  todo: "bg-slate-100 text-slate-600",
  in_progress: "bg-blue-100 text-blue-700",
  blocked: "bg-amber-100 text-amber-700",
  done: "bg-emerald-100 text-emerald-700",
};
export const STATUS_DOT: Record<string, string> = {
  requested: "bg-violet-500", rejected: "bg-rose-500",
  todo: "bg-slate-400", in_progress: "bg-blue-500", blocked: "bg-amber-500", done: "bg-emerald-500",
};
export const PRIORITY_LABEL = ["없음", "낮음", "보통", "높음"];
export const PRIORITY_COLOR = ["text-slate-400", "text-sky-500", "text-amber-500", "text-rose-500"];
export function fmtDate(d?: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

/* ── 날짜 규약 (F3 — 전 코드베이스 통일) ──────────────────────────────
 * 1) "오늘"/사용자 로컬 날짜 → localDayKey(new Date())  — 로컬 y-m-d.
 * 2) 서버 저장 날짜(scheduled_date/due_date) → toDayKey(s):
 *    저장 규약이 "로컬 날짜의 UTC 자정"이므로 ISO 문자열 앞 10자를 Date 왕복 없이
 *    그대로 사용한다. (Date 왕복은 음수 오프셋 타임존에서 하루 밀림)
 * 3) day key → 서버 전송: `${key}T00:00:00.000Z` (dayKeyToServer) — 기존 쓰기 규약 유지.
 * 시간 지정 이벤트(F5)만 예외: 실제 timestamptz이므로 localDayKey(new Date(starts_at))로 배치.
 * ──────────────────────────────────────────────────────────────── */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function toDayKey(d?: string | null): string | null {
  if (!d) return null;
  return String(d).slice(0, 10);
}
export const dayKeyToServer = (key: string) => `${key}T00:00:00.000Z`;
