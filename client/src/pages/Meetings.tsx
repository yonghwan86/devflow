import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, NotebookPen, Wand2, Check, X as XIcon, Plus, ChevronDown, ChevronUp, Pencil, Trash2, Info } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Button, Input, Textarea, Badge, Select, Spinner, EmptyState, Avatar, Modal, toast, useConfirm } from "../components/ui";
import { dayKeyToServer, localDayKey, toDayKey, fmtDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "../hooks/useAuth";

// 회의록 → AI 구조화: 업로드 → 추출(제안) → 사람 검토 → 태스크/가이드/체크리스트/일정 반영
const KIND_LABEL: Record<string, string> = { decision: "결정", action: "실행 항목", guide: "가이드", blocker: "블로커", question: "미해결 질문", event: "일정" };
const KIND_STYLE: Record<string, string> = {
  decision: "bg-indigo-100 text-indigo-700", action: "bg-emerald-100 text-emerald-700",
  guide: "bg-amber-100 text-amber-700", blocker: "bg-rose-100 text-rose-700", question: "bg-sky-100 text-sky-700",
  event: "bg-teal-100 text-teal-700",
};
const STATUS_LABEL_EX: Record<string, string> = { suggested: "검토 대기", accepted: "반영됨", edited: "수정 반영", rejected: "거절" };

export default function Meetings() {
  const [, params] = useRoute("/projects/:id/meetings");
  const pid = Number(params?.id);
  const { user: me } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [selected, setSelected] = useState<number | null>(null);
  // C7: 업로드 폼은 모달로 (목록이 폼 아래 깔려 스크롤이 길어지는 문제) + 회의 날짜 입력
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [noteDate, setNoteDate] = useState(localDayKey(new Date()));
  const [source, setSource] = useState("");
  const [noteFilter, setNoteFilter] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editSource, setEditSource] = useState("");
  // 항목별 반영 옵션
  const [targetTask, setTargetTask] = useState<Record<number, number>>({}); // guide/checklist 대상 태스크
  const [applyMode, setApplyMode] = useState<Record<number, "task" | "checklist">>({}); // action 반영 방식
  const [evDate, setEvDate] = useState<Record<number, string>>({});
  const [evTime, setEvTime] = useState<Record<number, string>>({});
  const [evAllDay, setEvAllDay] = useState<Record<number, boolean>>({});
  const [evAtt, setEvAtt] = useState<Record<number, number[]>>({}); // C9: 일정 참석자 (미지정=승인자)

  const listQ = useQuery<{ notes: any[] }>({ queryKey: ["meetings", pid], queryFn: () => get(`/meetings?project_id=${pid}`) });
  const detailQ = useQuery<{ note: any; extractions: any[]; llm_mode: string }>({
    queryKey: ["meeting", selected], queryFn: () => get(`/meetings/${selected}`), enabled: selected != null,
  });
  const tasksQ = useQuery<{ tasks: any[] }>({ queryKey: ["tasks", pid], queryFn: () => get(`/projects/${pid}/tasks`) });
  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["meetings", pid] }); queryClient.invalidateQueries({ queryKey: ["meeting", selected] }); };

  const upload = useMutation({
    mutationFn: () => post<{ note: any }>("/meetings", {
      project_id: pid,
      title: title.trim(),
      source_text: source,
      ...(noteDate ? { note_date: dayKeyToServer(noteDate) } : {}),
    }),
    onSuccess: (d) => {
      setTitle(""); setSource(""); setNoteDate(localDayKey(new Date())); setNewOpen(false);
      setSelected(d.note.id); refresh();
      toast("회의록을 올렸어요. 'AI 구조화'를 눌러 추출하세요.", "success");
    },
    onError: (e: any) => toast(`업로드 실패: ${e.message}`, "error"),
  });
  const process = useMutation({
    mutationFn: () => post(`/meetings/${selected}/process`, {}),
    onSuccess: () => { refresh(); toast("추출 완료 — 항목별로 검토해주세요.", "success"); },
    onError: (e: any) => toast(`추출 실패: ${e.message}`, "error"),
  });
  const saveEdit = useMutation({
    mutationFn: () => patch<{ source_changed: boolean }>(`/meetings/${selected}`, {
      title: editTitle.trim(),
      source_text: editSource,
      note_date: editDate ? dayKeyToServer(editDate) : null,
    }),
    onSuccess: (d) => { setEditMode(false); refresh(); toast(d.source_changed ? "원문이 바뀌었어요 — 다시 추출을 권장해요." : "수정했어요.", "success"); },
    onError: (e: any) => toast(`수정 실패: ${e.message}`, "error"),
  });
  const removeNote = useMutation({
    mutationFn: () => del(`/meetings/${selected}`),
    onSuccess: () => { setSelected(null); queryClient.invalidateQueries({ queryKey: ["meetings", pid] }); toast("회의록을 삭제했어요.", "success"); },
    onError: (e: any) => toast(`삭제 실패: ${e.message}`, "error"),
  });
  const review = useMutation({
    mutationFn: (v: any) => patch(`/meetings/extractions/${v.id}`, v.payload),
    onSuccess: (_d, v) => { refresh(); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); toast(v.payload.status === "accepted" ? "반영했어요." : "거절했어요.", "success"); },
    onError: (e: any) => toast(`처리 실패: ${e.message}`, "error"),
  });

  const notes = listQ.data?.notes ?? [];
  const detail = detailQ.data;
  const projectTasks = tasksQ.data?.tasks ?? [];
  const members = membersQ.data?.members ?? [];

  // C9: 화자 기반 참석자 자동 제안 — 보수적 매칭(full_name 완전 일치 + 유일할 때만, 오탐 push 방지)
  const suggestAttendees = (x: any): number[] => {
    const sp = String(x.speaker ?? "").trim();
    if (!sp) return [];
    const hits = members.filter((m: any) => (m.user.full_name ?? "").trim() === sp);
    return hits.length === 1 ? [hits[0].user.id] : [];
  };
  const attFor = (x: any): number[] => evAtt[x.id] ?? suggestAttendees(x);
  const toggleAtt = (x: any, id: number) => {
    const cur = attFor(x);
    setEvAtt({ ...evAtt, [x.id]: cur.includes(id) ? cur.filter((v) => v !== id) : [...cur, id] });
  };
  const isMock = detail?.llm_mode === "mock";
  const canEditNote = detail && (detail.note.uploaded_by === me?.id || me?.is_admin); // 매니저 여부는 서버가 최종 판단

  const acceptEvent = (x: any) => {
    const date = evDate[x.id];
    if (!date) { toast("일정 날짜를 선택하세요.", "error"); return; }
    const allDay = evAllDay[x.id] ?? true;
    const starts_at = allDay ? dayKeyToServer(date) : new Date(`${date}T${evTime[x.id] || "09:00"}:00`).toISOString();
    // C9: 참석자 선택 시 그 목록이 전부(승인자 포함 여부는 체크 상태) — 미선택이면 기존대로 승인자
    const sel = attFor(x);
    const attendeePayload = sel.length
      ? { attendee_ids: sel.filter((id) => id !== me?.id), include_creator: me?.id != null ? sel.includes(me.id) : true }
      : {};
    review.mutate({ id: x.id, payload: { status: "accepted", starts_at, all_day: allDay, ...attendeePayload } });
  };

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><NotebookPen className="text-brand" size={24} /> 회의록</h1>

      {/* C7: 업로드는 모달 — 목록이 좌측 패널의 주인공 (쌓여도 폼 아래로 안 밀림) */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="새 회의록">
        <div className="flex flex-col gap-3">
          <Input placeholder="회의 제목 (예: 7/2 주간회의)" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            회의 날짜
            <input type="date" className="h-9 rounded-lg border border-slate-200 px-2 text-sm" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
          </label>
          <Textarea rows={8} placeholder={"회의 내용을 붙여넣으세요.\n'이름: 내용' 형식이면 화자도 인식해요."} value={source} onChange={(e) => setSource(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>취소</Button>
            <Button onClick={() => title.trim() && source.trim() && upload.mutate()} disabled={upload.isPending || !title.trim() || !source.trim()}>
              <Plus size={15} /> 업로드
            </Button>
          </div>
        </div>
      </Modal>

      <div className="grid gap-4 lg:grid-cols-[18rem,1fr]">
        {/* 목록 */}
        <div className="flex flex-col gap-2">
          <Button onClick={() => setNewOpen(true)}><Plus size={15} /> 새 회의록</Button>
          <Card className="flex flex-col gap-1 p-3">
            {notes.length > 5 && (
              <Input className="mb-1 h-8 text-xs" placeholder="회의록 검색" value={noteFilter} onChange={(e) => setNoteFilter(e.target.value)} />
            )}
            {listQ.isLoading ? <Spinner /> : notes.length === 0
              ? <div className="py-2 text-center text-xs text-slate-400">아직 회의록이 없어요.</div>
              : notes
                  .filter((n) => !noteFilter.trim() || n.title.toLowerCase().includes(noteFilter.trim().toLowerCase()))
                  .map((n) => (
                <button key={n.id} onClick={() => { setSelected(n.id); setEditMode(false); setShowSource(false); }}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${selected === n.id ? "bg-brand-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-50"}`}>
                  <span className="w-10 flex-shrink-0 font-mono text-[11px] text-slate-400">{fmtDate(n.note_date ?? n.created_at)}</span>
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
              desc="AI가 결정·실행 항목·가이드·블로커·질문·일정을 추출하고, 검토를 거쳐 태스크/가이드/체크리스트/일정으로 반영돼요." />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {editMode ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input className="max-w-xs" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                    <input type="date" className="h-10 rounded-lg border border-slate-200 px-2 text-sm" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                  </div>
                ) : (
                  <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
                    {detail.note.title}
                    <span className="text-sm font-normal text-slate-400">{fmtDate(detail.note.note_date ?? detail.note.created_at)}</span>
                  </h2>
                )}
                <div className="flex items-center gap-1.5">
                  {canEditNote && !editMode && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => { setEditMode(true); setEditTitle(detail.note.title); setEditDate(toDayKey(detail.note.note_date) ?? ""); setEditSource(detail.note.source_text); }}><Pencil size={14} /> 수정</Button>
                      <Button variant="ghost" size="sm" className="text-slate-400 hover:bg-red-50 hover:text-red-500"
                        onClick={async () => { if (await confirm({ title: "회의록 삭제", message: "이 회의록을 삭제할까요? 이미 만든 태스크·가이드·일정은 남아요.", confirmLabel: "삭제", tone: "danger" })) removeNote.mutate(); }}>
                        <Trash2 size={14} /> 삭제
                      </Button>
                    </>
                  )}
                  <Button onClick={() => process.mutate()} disabled={process.isPending}>
                    <Wand2 size={15} /> {process.isPending ? "추출 중…" : detail.extractions.length ? "다시 추출" : "AI 구조화"}
                  </Button>
                </div>
              </div>

              {/* LLM 모드 배지 */}
              {isMock && (
                <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
                  <Info size={14} /> LLM 미연결 — 규칙 기반 추출(정확도 제한).{me?.is_admin && " Admin > LLM 설정에서 키를 등록하면 정확도가 올라가요."}
                </div>
              )}

              {/* 원문 접기/펼치기 (추출 0건이면 기본 펼침) */}
              {editMode ? (
                <Card className="flex flex-col gap-2">
                  <Textarea rows={10} value={editSource} onChange={(e) => setEditSource(e.target.value)} className="text-sm" />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}>취소</Button>
                    <Button size="sm" onClick={() => editTitle.trim() && editSource.trim() && saveEdit.mutate()} disabled={saveEdit.isPending}>저장</Button>
                  </div>
                </Card>
              ) : (
                <Card className="flex flex-col gap-1 p-3">
                  <button onClick={() => setShowSource(!showSource)} className="flex items-center gap-1.5 text-sm font-medium text-slate-600">
                    {showSource || detail.extractions.length === 0 ? <ChevronUp size={15} /> : <ChevronDown size={15} />} 원문
                  </button>
                  {(showSource || detail.extractions.length === 0) && (
                    <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-sm leading-relaxed text-slate-600">{detail.note.source_text}</div>
                  )}
                </Card>
              )}

              {detail.extractions.length === 0 ? (
                detail.note.status === "processed" ? (
                  <Card className="py-8 text-center text-sm text-slate-400">
                    추출된 항목이 없어요 — 원문에 결정·실행·일정 문장이 없거나, {isMock ? "규칙 기반 추출의 한계" : "모델이 추출할 항목을 못 찾았을 수 있어요"}일 수 있어요.
                  </Card>
                ) : (
                  <Card className="py-8 text-center text-sm text-slate-400">"AI 구조화"를 누르면 회의 내용에서 항목을 추출해요.</Card>
                )
              ) : (
                <div className="stagger-children flex flex-col gap-2">
                  {detail.extractions.map((x: any) => (
                    <Card key={x.id} className={`flex flex-col gap-2 transition ${x.status === "rejected" ? "opacity-50" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={KIND_STYLE[x.kind]}>{KIND_LABEL[x.kind]}</Badge>
                        {x.speaker && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Avatar name={x.speaker} size={16} /> {x.speaker}</span>}
                        {x.when_suggested && x.kind === "event" && <span className="text-xs text-teal-600">제안 일시: {x.when_suggested}</span>}
                        <Badge className={`ml-auto ${x.status === "suggested" ? "bg-slate-100 text-slate-500" : x.status === "rejected" ? "bg-slate-200 text-slate-500" : "bg-emerald-100 text-emerald-700"}`}>
                          {STATUS_LABEL_EX[x.status]}
                        </Badge>
                      </div>
                      <div className="text-[15px] text-slate-800">{x.content}</div>
                      {x.source_excerpt && <div className="border-l-2 border-slate-200 pl-2 text-xs text-slate-400">원문: {x.source_excerpt}</div>}
                      {x.status === "suggested" && (
                        <div className="flex flex-col gap-2 border-t border-slate-100 pt-2">
                          {/* guide: 대상 태스크 선택 */}
                          {x.kind === "guide" && (
                            <Select className="h-9 w-full text-xs sm:w-auto" value={targetTask[x.id] ?? ""}
                              onChange={(e) => setTargetTask({ ...targetTask, [x.id]: Number(e.target.value) })}>
                              <option value="">가이드를 붙일 태스크 선택</option>
                              {projectTasks.map((t: any) => <option key={t.id} value={t.id}>{t.item_key} · {t.title}</option>)}
                            </Select>
                          )}
                          {/* action: 태스크 or 체크리스트 */}
                          {x.kind === "action" && (
                            <div className="flex flex-wrap items-center gap-2">
                              <Select className="h-9 w-auto text-xs" value={applyMode[x.id] ?? "task"}
                                onChange={(e) => setApplyMode({ ...applyMode, [x.id]: e.target.value as any })}>
                                <option value="task">새 태스크로</option>
                                <option value="checklist">체크리스트로</option>
                              </Select>
                              {applyMode[x.id] === "checklist" && (
                                <Select className="h-9 w-full text-xs sm:w-auto" value={targetTask[x.id] ?? ""}
                                  onChange={(e) => setTargetTask({ ...targetTask, [x.id]: Number(e.target.value) })}>
                                  <option value="">대상 태스크 선택</option>
                                  {projectTasks.map((t: any) => <option key={t.id} value={t.id}>{t.item_key} · {t.title}</option>)}
                                </Select>
                              )}
                            </div>
                          )}
                          {/* event: 날짜 + 시간 + 종일 + 참석자(화자 자동 제안) */}
                          {x.kind === "event" && (
                            <>
                            <div className="flex flex-wrap items-center gap-2">
                              <input type="date" className="h-9 rounded-lg border border-slate-200 px-2 text-sm" value={evDate[x.id] ?? ""} onChange={(e) => setEvDate({ ...evDate, [x.id]: e.target.value })} />
                              {!(evAllDay[x.id] ?? true) && (
                                <input type="time" className="h-9 rounded-lg border border-slate-200 px-2 text-sm" value={evTime[x.id] ?? "09:00"} onChange={(e) => setEvTime({ ...evTime, [x.id]: e.target.value })} />
                              )}
                              <label className="inline-flex items-center gap-1 text-xs text-slate-500">
                                <input type="checkbox" checked={evAllDay[x.id] ?? true} onChange={(e) => setEvAllDay({ ...evAllDay, [x.id]: e.target.checked })} /> 종일
                              </label>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs text-slate-400">참석자 (비우면 승인자인 나 · 전원=공통 일정)</span>
                              <button type="button" onClick={() => setEvAtt({ ...evAtt, [x.id]: members.map((m: any) => m.user.id) })}
                                className="inline-flex items-center rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 transition hover:border-teal-300 hover:text-teal-600">
                                전원
                              </button>
                              {members.map((m: any) => {
                                const name = m.user.full_name ?? m.user.email;
                                const on = attFor(x).includes(m.user.id);
                                return (
                                  <button key={m.user.id} type="button" onClick={() => toggleAtt(x, m.user.id)}
                                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${on ? "border-teal-300 bg-teal-50 font-semibold text-teal-700" : "border-slate-200 bg-white text-slate-500"}`}>
                                    <Avatar name={name} size={16} /> {name}
                                  </button>
                                );
                              })}
                            </div>
                            </>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            {x.kind === "event" ? (
                              <Button size="sm" onClick={() => acceptEvent(x)} disabled={review.isPending || !evDate[x.id]}>
                                <Check size={14} /> 일정으로 반영
                              </Button>
                            ) : x.kind === "action" ? (
                              <Button size="sm" disabled={review.isPending || (applyMode[x.id] === "checklist" && !targetTask[x.id])}
                                onClick={() => review.mutate({ id: x.id, payload: { status: "accepted", apply_as: applyMode[x.id] ?? "task", ...(applyMode[x.id] === "checklist" ? { task_id: targetTask[x.id] } : {}) } })}>
                                <Check size={14} /> {applyMode[x.id] === "checklist" ? "체크리스트로 반영" : "태스크로 반영"}
                              </Button>
                            ) : x.kind === "guide" ? (
                              <Button size="sm" disabled={review.isPending || !targetTask[x.id]}
                                onClick={() => review.mutate({ id: x.id, payload: { status: "accepted", task_id: targetTask[x.id] } })}>
                                <Check size={14} /> 가이드로 반영
                              </Button>
                            ) : (
                              <Button size="sm" onClick={() => review.mutate({ id: x.id, payload: { status: "accepted" } })} disabled={review.isPending}>
                                <Check size={14} /> 승인 (기록)
                              </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => review.mutate({ id: x.id, payload: { status: "rejected" } })} disabled={review.isPending}>
                              <XIcon size={14} /> 거절
                            </Button>
                          </div>
                        </div>
                      )}
                      {x.linked_task_id && !x.linked_checklist_item_id && <div className="text-xs text-emerald-600">→ 태스크로 생성됨</div>}
                      {x.linked_checklist_item_id && <div className="text-xs text-emerald-600">→ 체크리스트로 추가됨</div>}
                      {x.linked_comment_id && <div className="text-xs text-emerald-600">→ 가이드 댓글로 등록됨</div>}
                      {x.linked_event_id && <div className="text-xs text-emerald-600">→ 일정으로 생성됨</div>}
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
