import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { TaskCard } from "./TaskCard";
import { STATUS_DOT, STATUS_LABEL } from "../lib/format";
import { useCollapsedSet } from "../hooks/useCollapsedSet";

// F2: 공용 칸반 — ProjectBoard와 MyWork가 함께 사용(중복 구현 금지).
// 링크는 pidFor(task)로 생성해 My Work의 크로스 프로젝트 링크를 지원한다.
export interface KanbanColumn {
  id: string;
  label?: string;
  droppable?: boolean; // false: 드롭 대상 제외 (requested/rejected 등)
}

export function KanbanBoard({ tasks, columns, canDrag, onDrop, onReorder, pidFor, requesterName, cardExtra, emptyText }: {
  tasks: any[];
  columns: KanbanColumn[];
  canDrag: (t: any) => boolean;
  onDrop: (taskId: number, colId: string) => void;
  // P2: 같은 컬럼 안 순서 변경 — 카드 위에 드롭=그 카드 위로 끼워넣기, 컬럼 빈 곳=맨 아래.
  // 미지정이면(멤버·MyWork) 기존 동작(상태 이동만) 그대로.
  onReorder?: (taskId: number, beforeTaskId: number | null, colId: string) => void;
  pidFor: (t: any) => number;
  requesterName?: (t: any) => string | null;
  cardExtra?: (t: any) => ReactNode; // requested 카드 아래 트리아지 액션 등
  emptyText?: string;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [overCard, setOverCard] = useState<number | null>(null); // 끼워넣기 대상 카드 표시
  // 컬럼 접기 — 모바일에선 컬럼이 세로로 쌓여 '진행 중'까지 한참 스크롤해야 하는 문제의 해법.
  // 보드·MyWork 공용 키: "완료는 늘 접어둠" 선호가 두 화면에서 같이 유지된다.
  const { collapsed, toggle } = useCollapsedSet("devflow.kanban.collapsed");
  const cols = columns.length;
  return (
    <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${cols >= 6 ? "lg:grid-cols-6" : cols === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
      {columns.map((c) => {
        const group = tasks.filter((t) => t.status === c.id);
        const droppable = c.droppable !== false;
        // 드래그로 접힌 컬럼 위에 오면 임시로 펼침 — 드롭 위치를 눈으로 확인할 수 있게
        const isCollapsed = collapsed.has(c.id) && over !== c.id;
        return (
          <div key={c.id}
            onDragOver={(e) => { if (droppable) { e.preventDefault(); setOver(c.id); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              if (!droppable) return;
              setOver(null);
              setOverCard(null);
              const id = Number(e.dataTransfer.getData("text/task"));
              if (!id) return;
              if (tasks.find((t) => t.id === id)?.status === c.id) {
                // 같은 컬럼 빈 곳 드롭 = 맨 아래로 (재정렬 미지원이면 기존처럼 no-op)
                onReorder?.(id, null, c.id);
                return;
              }
              onDrop(id, c.id);
            }}
            className={`flex flex-col gap-2 rounded-xl p-2 transition ${over === c.id ? "bg-indigo-50 ring-2 ring-indigo-200" : "bg-slate-100/60"}`}>
            <button type="button" onClick={() => toggle(c.id)} aria-expanded={!isCollapsed}
              title={isCollapsed ? "펼치기" : "접기"}
              className="flex items-center gap-2 rounded-lg px-1 py-1 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-200/60">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.id] ?? "bg-slate-400"}`} /> {c.label ?? STATUS_LABEL[c.id]}
              <span className="text-slate-400">{group.length}</span>
              <ChevronRight size={14} className={`ml-auto text-slate-400 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
            </button>
            {!isCollapsed && group.map((t) => (
              <div key={t.id}
                className={`flex flex-col gap-1.5 rounded-xl transition ${onReorder && overCard === t.id ? "ring-2 ring-brand-300" : ""}`}
                onDragOver={onReorder && droppable ? (e) => { e.preventDefault(); e.stopPropagation(); setOver(c.id); setOverCard(t.id); } : undefined}
                onDragLeave={onReorder ? () => setOverCard((v) => (v === t.id ? null : v)) : undefined}
                onDrop={onReorder && droppable ? (e) => {
                  e.stopPropagation();
                  setOver(null);
                  setOverCard(null);
                  const id = Number(e.dataTransfer.getData("text/task"));
                  if (!id || id === t.id) return;
                  const src = tasks.find((x) => x.id === id);
                  if (!src) return;
                  if (src.status !== c.id) { onDrop(id, c.id); return; } // 다른 컬럼에서 오면 상태 이동 (기존 동작)
                  onReorder(id, t.id, c.id); // 같은 컬럼 = 이 카드 위로 끼워넣기
                } : undefined}>
                <TaskCard t={t} pid={pidFor(t)} compact draggable={canDrag(t)}
                  requesterName={requesterName?.(t) ?? null}
                  onDragStart={(e) => e.dataTransfer.setData("text/task", String(t.id))} />
                {cardExtra?.(t)}
              </div>
            ))}
            {!isCollapsed && group.length === 0 && <div className="px-1 py-4 text-center text-xs text-slate-300">{emptyText ?? "비어 있음"}</div>}
          </div>
        );
      })}
    </div>
  );
}
