import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, NotebookPen, Wand2, Check, X as XIcon, Plus } from "lucide-react";
import { get, post, patch } from "../lib/api";
import { Card, Button, Input, Textarea, Badge, Select, Spinner, EmptyState, Avatar, toast } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// 회의록 → AI 구조화: 업로드 → 추출(제안) → 사람 검토 → 태스크/가이드 반영
const KIND_LABEL: Record<string, string> = { decision: "결정", action: "실행 항목", guide: "가이드", blocker: "블로커", question: "미해결 질문" };
const KIND_STYLE: Record<string, string> = {
  decision: "bg-indigo-100 text-indigo-700", action: "bg-emerald-100 text-emerald-700",
  guide: "bg-amber-100 text-amber-700", blocker: "bg-rose-100 text-rose-700", question: "bg-sky-100 text-sky-700",
};
const STATUS_LABEL_EX: Record<string, string> = { suggested: "검토 대기", accepted: "반영됨", edited: "수정 반영", rejected: "거절" };

export default function Meetings() {
  const [, params] = useRoute("/projects/:id/meetings");
  const pid = Number(params?.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [guideTask, setGuideTask] = useState<Record<number, number>>({}); // extraction id → task id

  const listQ = useQuery<{ notes: any[] }>({ queryKey: ["meetings", pid], queryFn: () => get(`/meetings?project_id=${pid}`) });
  const detailQ = useQuery<{ note: any; extractions: any[] }>({
    queryKey: ["meeting", selected], queryFn: () => get(`/meetings/${selected}`), enabled: selected != null,
  });
  const tasksQ = useQuery<{ tasks: any[] }>({ queryKey: ["tasks", pid], queryFn: () => get(`/projects/${pid}/tasks`) });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["meetings", pid] }); queryClient.invalidateQueries({ queryKey: ["meeting", selected] }); };

  const upload = useMutation({
    mutationFn: () => post<{ note: any }>("/meetings", { project_id: pid, title: title.trim(), source_text: source }),
    onSuccess: (d) => { setTitle(""); setSource(""); setSelected(d.note.id); refresh(); toast("회의록을 올렸어요. 'AI 구조화'를 눌러 추출하세요.", "success"); },
    onError: (e: any) => toast(`업로드 실패: ${e.message}`, "error"),
  });
  const process = useMutation({
    mutationFn: () => post(`/meetings/${selected}/process`, {}),
    onSuccess: () => { refresh(); toast("추출 완료 — 항목별로 검토해주세요.", "success"); },
    onError: (e: any) => toast(`추출 실패: ${e.message}`, "error"),
  });
  const review = useMutation({
    mutationFn: (v: { id: number; status: "accepted" | "rejected"; task_id?: number }) =>
      patch(`/meetings/extractions/${v.id}`, { status: v.status, ...(v.task_id ? { task_id: v.task_id } : {}) }),
    onSuccess: (_d, v) => { refresh(); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); toast(v.status === "accepted" ? "반영했어요." : "거절했어요.", "success"); },
    onError: (e: any) => toast(`처리 실패: ${e.message}`, "error"),
  });

  const notes = listQ.data?.notes ?? [];
  const detail = detailQ.data;
  const projectTasks = tasksQ.data?.tasks ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><NotebookPen className="text-brand" size={24} /> 회의록</h1>

      <div className="grid gap-4 lg:grid-cols-[18rem,1fr]">
        {/* 목록 + 업로드 */}
        <div className="flex flex-col gap-3">
          <Card className="flex flex-col gap-2">
            <div className="text-sm font-semibold text-slate-700">새 회의록</div>
            <Input placeholder="회의 제목 (예: 7/2 주간회의)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea rows={6} placeholder={"회의 내용을 붙여넣으세요.\n'이름: 내용' 형식이면 화자도 인식해요."} value={source} onChange={(e) => setSource(e.target.value)} />
            <Button onClick={() => title.trim() && source.trim() && upload.mutate()} disabled={upload.isPending || !title.trim() || !source.trim()}>
              <Plus size={15} /> 업로드
            </Button>
          </Card>
          <Card className="flex flex-col gap-1 p-3">
            {listQ.isLoading ? <Spinner /> : notes.length === 0
              ? <div className="py-2 text-center text-xs text-slate-400">아직 회의록이 없어요.</div>
              : notes.map((n) => (
                <button key={n.id} onClick={() => setSelected(n.id)}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${selected === n.id ? "bg-brand-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-50"}`}>
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  <Badge className={n.status === "reviewed" ? "bg-emerald-100 text-emerald-700" : n.status === "processed" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}>
                    {n.status === "reviewed" ? "검토 완료" : n.status === "processed" ? "검토 중" : "업로드됨"}
                  </Badge>
                </button>
              ))}
          </Card>
        </div>

        {/* 상세 + 추출 검토 */}
        <div className="flex min-w-0 flex-col gap-3">
          {!detail ? (
            <EmptyState icon={<NotebookPen size={22} />} title="회의록을 선택하거나 업로드하세요"
              desc="AI가 결정·실행 항목·가이드·블로커·질문을 추출하고, 검토를 거쳐 태스크/가이드로 반영돼요." />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold text-slate-900">{detail.note.title}</h2>
                <Button onClick={() => process.mutate()} disabled={process.isPending}>
                  <Wand2 size={15} /> {process.isPending ? "추출 중…" : detail.extractions.length ? "다시 추출" : "AI 구조화"}
                </Button>
              </div>

              {detail.extractions.length === 0 ? (
                <Card className="py-8 text-center text-sm text-slate-400">"AI 구조화"를 누르면 회의 내용에서 항목을 추출해요.</Card>
              ) : (
                <div className="stagger-children flex flex-col gap-2">
                  {detail.extractions.map((x: any) => (
                    <Card key={x.id} className={`flex flex-col gap-2 transition ${x.status === "rejected" ? "opacity-50" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={KIND_STYLE[x.kind]}>{KIND_LABEL[x.kind]}</Badge>
                        {x.speaker && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Avatar name={x.speaker} size={16} /> {x.speaker}</span>}
                        <Badge className={`ml-auto ${x.status === "suggested" ? "bg-slate-100 text-slate-500" : x.status === "rejected" ? "bg-slate-200 text-slate-500" : "bg-emerald-100 text-emerald-700"}`}>
                          {STATUS_LABEL_EX[x.status]}
                        </Badge>
                      </div>
                      <div className="text-[15px] text-slate-800">{x.content}</div>
                      {x.source_excerpt && <div className="border-l-2 border-slate-200 pl-2 text-xs text-slate-400">원문: {x.source_excerpt}</div>}
                      {x.status === "suggested" && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                          {x.kind === "guide" && (
                            <Select className="h-9 w-auto text-xs" value={guideTask[x.id] ?? ""}
                              onChange={(e) => setGuideTask({ ...guideTask, [x.id]: Number(e.target.value) })}>
                              <option value="">가이드를 붙일 태스크 선택</option>
                              {projectTasks.map((t: any) => <option key={t.id} value={t.id}>{t.item_key} · {t.title}</option>)}
                            </Select>
                          )}
                          <Button size="sm" onClick={() => review.mutate({ id: x.id, status: "accepted", task_id: x.kind === "guide" ? guideTask[x.id] : undefined })}
                            disabled={review.isPending || (x.kind === "guide" && !guideTask[x.id])}>
                            <Check size={14} /> {x.kind === "action" ? "태스크로 반영" : x.kind === "guide" ? "가이드로 반영" : "승인"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => review.mutate({ id: x.id, status: "rejected" })} disabled={review.isPending}>
                            <XIcon size={14} /> 거절
                          </Button>
                        </div>
                      )}
                      {x.linked_task_id && <div className="text-xs text-emerald-600">→ 태스크로 생성됨</div>}
                      {x.linked_comment_id && <div className="text-xs text-emerald-600">→ 가이드 댓글로 등록됨</div>}
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
