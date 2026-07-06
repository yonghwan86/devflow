import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { post } from "../lib/api";
import { Button, Select, Textarea, toast } from "./ui";
import { localDayKey, dayKeyToServer } from "../lib/format";

// F1: requested 티켓에 대한 매니저 트리아지 액션 (승인=담당자 선택+착수일, 반려=사유 필수).
// 서버가 최종 권한을 판단하므로 UI는 매니저에게만 노출하면 된다.
export function TicketTriageActions({ taskId, members, onDone }: {
  taskId: number;
  members: { user: { id: number; full_name?: string | null; email: string } }[];
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [assignee, setAssignee] = useState<number | "">("");
  const [schedDate, setSchedDate] = useState(localDayKey(new Date())); // 기본 오늘 — 비우면 날짜 없이 승인
  const [reason, setReason] = useState("");

  const approve = useMutation({
    mutationFn: () =>
      post(`/tasks/${taskId}/approve`, {
        ...(assignee === "" ? {} : { assignee_ids: [Number(assignee)] }),
        // 착수일을 함께 지정 — 무날짜 승인 태스크가 캘린더·타임라인에서 증발하는 문제 방지
        ...(schedDate ? { scheduled_date: dayKeyToServer(schedDate) } : {}),
      }),
    onSuccess: () => { toast("티켓을 승인했어요."); setMode("idle"); onDone(); },
    onError: (e: any) => toast(`승인 실패: ${e.message}`),
  });
  const reject = useMutation({
    mutationFn: () => post(`/tasks/${taskId}/reject`, { reason: reason.trim() }),
    onSuccess: () => { toast("티켓을 반려했어요."); setMode("idle"); setReason(""); onDone(); },
    onError: (e: any) => toast(`반려 실패: ${e.message}`),
  });

  if (mode === "approve") {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-white p-2 ring-1 ring-violet-200" onClick={(e) => e.stopPropagation()}>
        <Select className="h-9 text-sm" value={assignee} onChange={(e) => setAssignee(e.target.value === "" ? "" : Number(e.target.value))}>
          <option value="">담당자 없이 승인</option>
          {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          착수일
          <input type="date" className="h-8 flex-1 rounded-lg border border-slate-200 px-2 text-sm" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
        </label>
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setMode("idle")}>취소</Button>
          <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}><Check size={14} /> 승인</Button>
        </div>
      </div>
    );
  }
  if (mode === "reject") {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-white p-2 ring-1 ring-rose-200" onClick={(e) => e.stopPropagation()}>
        <Textarea rows={2} placeholder="반려 사유 (필수) — 요청자에게 댓글로 남아요" value={reason} onChange={(e) => setReason(e.target.value)} className="text-sm" />
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => { setMode("idle"); setReason(""); }}>취소</Button>
          <Button size="sm" onClick={() => reason.trim() && reject.mutate()} disabled={reject.isPending || !reason.trim()}>
            <X size={14} /> 반려
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" onClick={() => setMode("approve")}><Check size={14} /> 승인</Button>
      <Button variant="outline" size="sm" onClick={() => setMode("reject")}><X size={14} /> 반려</Button>
    </div>
  );
}
