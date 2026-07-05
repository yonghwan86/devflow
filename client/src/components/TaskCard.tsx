import { Link } from "wouter";
import { MessageSquare, Lightbulb, CheckSquare, Flag, Ticket } from "lucide-react";
import { Card, Badge, AvatarGroup } from "./ui";
import { STATUS_COLOR, STATUS_LABEL, PRIORITY_COLOR, PRIORITY_LABEL, fmtDate } from "../lib/format";

export function TaskCard({ t, pid, draggable, onDragStart, compact, requesterName }: {
  t: any; pid: number; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; compact?: boolean;
  requesterName?: string | null; // F1: kind=ticket일 때 "요청: {이름}" 표시
}) {
  const names = (t.assignees ?? []).map((a: any) => a.full_name ?? a.email);
  return (
    <Link href={`/projects/${pid}/tasks/${t.item_key}`}>
      <Card
        draggable={draggable}
        onDragStart={onDragStart}
        className={`cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover ${draggable ? "active:cursor-grabbing" : ""} ${compact ? "p-3" : ""}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1 truncate font-medium text-slate-800">
              {t.kind === "ticket" && <Ticket size={13} className="flex-shrink-0 text-violet-500" />}
              <span className="truncate">{t.title}</span>
            </div>
            <div className="mt-0.5 font-mono text-xs text-slate-400">
              {t.item_key}
              {t.kind === "ticket" && requesterName && <span className="ml-1.5 font-sans text-violet-500">요청: {requesterName}</span>}
            </div>
          </div>
          <Badge className={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {t.project_name && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">{t.project_name}</span>}
          {t.priority > 0 && <span className={`inline-flex items-center gap-0.5 ${PRIORITY_COLOR[t.priority]}`}><Flag size={11} /> {PRIORITY_LABEL[t.priority]}</span>}
          {t.due_date && <span className="text-amber-600">마감 {fmtDate(t.due_date)}</span>}
          {t.checklist?.total > 0 && <span className="inline-flex items-center gap-0.5"><CheckSquare size={11} /> {t.checklist.done}/{t.checklist.total}</span>}
          {t.guides?.total > 0 && <span className="inline-flex items-center gap-0.5 text-amber-600"><Lightbulb size={11} /> {t.guides.applied}/{t.guides.total}</span>}
          <span className="ml-auto">{names.length > 0 && <AvatarGroup names={names} size={20} />}</span>
        </div>
      </Card>
    </Link>
  );
}
