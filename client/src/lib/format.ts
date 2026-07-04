export const STATUS_LABEL: Record<string, string> = {
  todo: "할 일", in_progress: "진행 중", blocked: "막힘", done: "완료",
};
export const STATUS_COLOR: Record<string, string> = {
  todo: "bg-slate-100 text-slate-600",
  in_progress: "bg-blue-100 text-blue-700",
  blocked: "bg-amber-100 text-amber-700",
  done: "bg-emerald-100 text-emerald-700",
};
export const STATUS_DOT: Record<string, string> = {
  todo: "bg-slate-400", in_progress: "bg-blue-500", blocked: "bg-amber-500", done: "bg-emerald-500",
};
export const PRIORITY_LABEL = ["없음", "낮음", "보통", "높음"];
export const PRIORITY_COLOR = ["text-slate-400", "text-sky-500", "text-amber-500", "text-rose-500"];
export function fmtDate(d?: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}
export function toDayKey(d?: string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}
