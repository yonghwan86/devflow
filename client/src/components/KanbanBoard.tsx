import { useState } from "react";
import type { ReactNode } from "react";
import { TaskCard } from "./TaskCard";
import { STATUS_DOT, STATUS_LABEL } from "../lib/format";

// F2: 공용 칸반 — ProjectBoard와 MyWork가 함께 사용(중복 구현 금지).
// 링크는 pidFor(task)로 생성해 My Work의 크로스 프로젝트 링크를 지원한다.
export interface KanbanColumn {
  id: string;
  label?: string;
  droppable?: boolean; // false: 드롭 대상 제외 (requested/rejected 등)
}

export function KanbanBoard({ tasks, columns, canDrag, onDrop, pidFor, requesterName, cardExtra, emptyText }: {
  tasks: any[];
  columns: KanbanColumn[];
  canDrag: (t: any) => boolean;
  onDrop: (taskId: number, colId: string) => void;
  pidFor: (t: any) => number;
  requesterName?: (t: any) => string | null;
  cardExtra?: (t: any) => ReactNode; // requested 카드 아래 트리아지 액션 등
  emptyText?: string;
}) {
  const [over, setOver] = useState<string | null>(null);
  const cols = columns.length;
  return (
    <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${cols >= 6 ? "lg:grid-cols-6" : cols === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
      {columns.map((c) => {
        const group = tasks.filter((t) => t.status === c.id);
        const droppable = c.droppable !== false;
        return (
          <div key={c.id}
            onDragOver={(e) => { if (droppable) { e.preventDefault(); setOver(c.id); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              if (!droppable) return;
              setOver(null);
              const id = Number(e.dataTransfer.getData("text/task"));
              if (id) onDrop(id, c.id);
            }}
            className={`flex flex-col gap-2 rounded-xl p-2 transition ${over === c.id ? "bg-indigo-50 ring-2 ring-indigo-200" : "bg-slate-100/60"}`}>
            <div className="flex items-center gap-2 px-1 py-1 text-sm font-semibold text-slate-600">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.id] ?? "bg-slate-400"}`} /> {c.label ?? STATUS_LABEL[c.id]}
              <span className="text-slate-400">{group.length}</span>
            </div>
            {group.map((t) => (
              <div key={t.id} className="flex flex-col gap-1.5">
                <TaskCard t={t} pid={pidFor(t)} compact draggable={canDrag(t)}
                  requesterName={requesterName?.(t) ?? null}
                  onDragStart={(e) => e.dataTransfer.setData("text/task", String(t.id))} />
                {cardExtra?.(t)}
              </div>
            ))}
            {group.length === 0 && <div className="px-1 py-4 text-center text-xs text-slate-300">{emptyText ?? "비어 있음"}</div>}
          </div>
        );
      })}
    </div>
  );
}
