import { useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getActiveProject } from "../lib/activeProject";
import { localDayKey } from "../lib/format";

// 사이드바용 미니 월 달력. 날짜 클릭 → 활성 프로젝트 보드의 해당 날짜(일 뷰)로 이동.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const dayKey = localDayKey; // F3 날짜 규약 통일 (중복 구현 제거)

export function MiniCalendar() {
  const [, navigate] = useLocation();
  const [cursor, setCursor] = useState(new Date());
  const today = new Date();
  const todayKey = dayKey(today);

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  // 마지막 주가 비면(다음 달만 있는 줄) 35칸으로 줄여 컴팩트하게
  const rows = cells[35].getMonth() === cursor.getMonth() ? 6 : 5;
  const visible = cells.slice(0, rows * 7);

  const onPick = (d: Date) => {
    const p = getActiveProject();
    if (!p) { navigate("/projects"); return; }
    navigate(`/projects/${p.id}?view=calendar&date=${dayKey(d)}`);
  };

  return (
    <div className="border-t border-slate-100 px-3 py-3">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          <ChevronLeft size={14} />
        </button>
        <button className="text-xs font-semibold text-slate-600 hover:text-brand" onClick={() => setCursor(new Date())}>
          {cursor.getFullYear()}. {cursor.getMonth() + 1}
        </button>
        <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`py-0.5 text-[10px] font-medium ${i === 0 ? "text-rose-400" : i === 6 ? "text-sky-400" : "text-slate-400"}`}>{w}</div>
        ))}
        {visible.map((d, i) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = k === todayKey;
          return (
            <button key={i} onClick={() => onPick(d)}
              className={`flex h-6 items-center justify-center rounded-md text-[11px] transition hover:bg-brand-50 hover:text-brand
                ${isToday ? "bg-brand font-bold text-white hover:bg-brand-600 hover:text-white" : inMonth ? "text-slate-600" : "text-slate-300"}`}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
