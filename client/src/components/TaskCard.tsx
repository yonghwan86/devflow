import { Link } from "wouter";
import { MessageSquare, Lightbulb, CheckSquare, Flag } from "lucide-react";
import { Card, Badge, AvatarGroup } from "./ui";
import { STATUS_COLOR, STATUS_LABEL, PRIORITY_COLOR, PRIORITY_LABEL, fmtDate } from "../lib/format";

export function TaskCard({ t, pid, draggable, onDragStart, compact }: {
  t: any; pid: number; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; compact?: boolean;
}) {
  const names = (t.assignees ?? []).map((a: any) => a.full_name ?? a.email);
  return (
    <Link href={`/projects/${pid}/tasks/${t.item_key}`}>
      <Card
        draggable={draggable}
        onDragStart={onDragStart}
        className={`cursor-pointer transition hover:border-indigo-200 hover:shadow-md ${draggable ? "active:cursor-grabbing" : ""} ${compact ? "p-3" : ""}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-800">{t.title}</div>
            <div className="mt-0.5 font-mono text-xs text-slate-400">{t.item_key}</div>
          </div>
          <Badge className={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
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
