import { useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Paperclip, Camera, Trash2, FileText } from "lucide-react";
import { get, upload, del } from "../lib/api";
import { Button, useConfirm } from "./ui";
import { useAuth } from "../hooks/useAuth";

interface Att { id: number; file_name: string; detected_type: string | null; download_url: string; thumb_url: string | null; uploaded_by: number | null; }

export function Attachments({ taskId, canManage = false }: { taskId: number; canManage?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { user: me } = useAuth();
  const { confirm, dialog } = useConfirm();
  const q = useQuery<{ attachments: Att[] }>({ queryKey: ["attachments", taskId], queryFn: () => get(`/attachments?task_id=${taskId}`) });
  const send = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("task_id", String(taskId)); fd.append("file", file); return upload("/attachments", fd); },
    onSuccess: () => q.refetch(),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/attachments/${id}`), onSuccess: () => q.refetch() });
  // 첨부 삭제는 파일 원본까지 즉시 파기(복구 불가) — 반드시 confirm을 거친다
  const onRemove = async (a: Att) => {
    const ok = await confirm({
      title: "첨부파일 삭제",
      message: `"${a.file_name}" 파일을 삭제할까요? 파일 원본까지 지워져 복구할 수 없어요.`,
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (ok) remove.mutate(a.id);
  };
  const items = q.data?.attachments ?? [];

  return (
    <section>
      {dialog}
      <div className="mb-2 flex items-center gap-2"><Paperclip size={16} className="text-brand" /><h2 className="font-semibold text-slate-700">첨부파일</h2></div>
      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {items.map((a) => (
            <div key={a.id} className="group relative w-28 overflow-hidden rounded-lg border border-slate-200 bg-white">
              {a.thumb_url ? <img src={a.thumb_url} alt={a.file_name} className="h-20 w-full object-cover" />
                : <div className="flex h-20 w-full items-center justify-center bg-slate-50 text-slate-300"><FileText size={28} /></div>}
              <a href={a.download_url} className="block truncate px-1.5 py-1 text-center text-[11px] text-brand" title={a.file_name}>{a.file_name}</a>
              {/* 서버 규칙(업로더 본인 또는 매니저)과 동일하게 버튼 노출 — 403 놀람 방지.
                  모바일(터치)에는 hover가 없어 항상 노출, 데스크톱은 hover 시 노출 */}
              {(canManage || a.uploaded_by === me?.id) && (
                <button onClick={() => onRemove(a)} className="absolute right-1 top-1 rounded-full bg-white/90 p-1.5 text-slate-500 opacity-100 shadow transition hover:text-red-500 md:p-1 md:opacity-0 md:group-hover:opacity-100"><Trash2 size={13} /></button>
              )}
            </div>
          ))}
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*,application/pdf,.txt,.csv" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) send.mutate(f); e.target.value = ""; }} />
      <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={send.isPending}>
        <Camera size={15} /> {send.isPending ? "업로드 중…" : "파일 첨부 (카메라/갤러리)"}
      </Button>
    </section>
  );
}
