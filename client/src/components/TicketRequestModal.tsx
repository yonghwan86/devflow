import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Ticket } from "lucide-react";
import { post } from "../lib/api";
import { Modal, Button, Input, Textarea, Select, Field, toast } from "./ui";
import { PRIORITY_LABEL } from "../lib/format";
import { queryClient } from "../lib/queryClient";

// F1: member 티켓 요청 모달 — 서버가 role에 따라 kind/status를 강제하므로
// member는 ticket(requested), manager는 일반 task(todo)로 생성된다.
export function TicketRequestModal({ pid, open, onClose }: { pid: number; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [dueDate, setDueDate] = useState("");

  const create = useMutation({
    mutationFn: () =>
      post(`/projects/${pid}/tasks`, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        due_date: dueDate ? `${dueDate}T00:00:00.000Z` : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", pid] });
      toast("요청을 등록했어요. 매니저 검토 후 진행됩니다.");
      setTitle(""); setDescription(""); setPriority(0); setDueDate("");
      onClose();
    },
    onError: (e: any) => toast(`요청 실패: ${e.message}`),
  });

  return (
    <Modal open={open} onClose={onClose} title="티켓 요청">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm text-violet-700">
          <Ticket size={15} /> 필요한 작업을 요청하면 매니저가 검토 후 승인/반려해요.
        </div>
        <Field label="제목">
          <Input placeholder="무엇이 필요한가요?" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="설명 (선택)">
          <Textarea rows={4} placeholder="배경과 상세 내용 (마크다운 지원)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="우선순위">
            <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </Select>
          </Field>
          <Field label="희망 마감일 (선택)">
            <input type="date" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button onClick={() => title.trim() && create.mutate()} disabled={create.isPending || !title.trim()}>
            {create.isPending ? "등록 중…" : "요청 등록"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
