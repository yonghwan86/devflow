import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { get } from "../lib/api";
import { Button } from "./ui";
import { localDayKey } from "../lib/format";
import { EventModal } from "./EventModal";
import { useAuth } from "../hooks/useAuth";

// F5: 이벤트 → 캘린더 배치용 day key (시간 지정 = 로컬 날, 종일 = 저장된 UTC 자정의 앞 10자)
export function eventDayKey(ev: any): string {
  return ev.all_day ? String(ev.starts_at).slice(0, 10) : localDayKey(new Date(ev.starts_at));
}
export function eventTimeLabel(ev: any): string {
  if (ev.all_day) return "종일";
  return new Date(ev.starts_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}
// C3: 멀티데이 일정 — 시작일뿐 아니라 진행 중인 날에도 잡히도록 기간 포함 판정
export function eventCoversDay(ev: any, dayKey: string): boolean {
  const start = eventDayKey(ev);
  const end = ev.ends_at ? (ev.all_day ? String(ev.ends_at).slice(0, 10) : localDayKey(new Date(ev.ends_at))) : start;
  return dayKey >= start && dayKey <= end;
}

// My Work 상단 — 오늘 내 일정(개인 + 참석 프로젝트 일정) 시간순. 칩 클릭 → 보기·수정·삭제 (C3).
export function EventStrip() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const { user: me } = useAuth();
  const todayKey = localDayKey(new Date());
  // TZ 경계 유실 방지: 요청 범위를 앞뒤 1일 패딩 후 day key로 필터 (F5 규약)
  const pad = (days: number) => localDayKey(new Date(Date.now() + days * 86400_000));
  const q = useQuery<{ events: any[] }>({
    queryKey: ["events", "today", todayKey],
    queryFn: () => get(`/events?from=${pad(-1)}&to=${pad(1)}`),
  });
  // C9: "내 오늘"에는 나와 관련된 일정만 — 개인 / 내가 참석 / 공지성(참석자 미지정) 일정.
  // 남만 참석하는 일정(대리 등록 등)은 프로젝트 캘린더에서 보이므로 여기선 제외.
  const mine = (e: any) =>
    e.project_id == null || (e.attendees ?? []).some((a: any) => a.id === me?.id) || (e.attendees ?? []).length <= 1;
  const todays = (q.data?.events ?? [])
    .filter((e) => eventCoversDay(e, todayKey) && mine(e)) // 멀티데이 진행 중 일정 포함
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/40 px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
        <CalendarClock size={14} /> 오늘 일정
      </span>
      {todays.length === 0 ? (
        <span className="text-xs text-slate-400">없음</span>
      ) : (
        todays.map((e) => (
          <button key={e.id} onClick={() => setEditing(e)}
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs text-slate-700 shadow-sm ring-1 ring-emerald-100 transition hover:ring-emerald-300"
            title={`${e.description ?? e.title} — 클릭해 보기·수정`}>
            <span className="font-mono font-semibold text-emerald-600">{eventTimeLabel(e)}</span>
            <span className="max-w-[12rem] truncate">{e.title}</span>
            <span className="text-slate-400">{e.project_name ?? "개인"}</span>
          </button>
        ))
      )}
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setModalOpen(true)}><Plus size={14} /> 일정</Button>
      <EventModal open={modalOpen || !!editing} onClose={() => { setModalOpen(false); setEditing(null); }} event={editing} />
    </div>
  );
}
