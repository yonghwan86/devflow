import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, X, Calendar, Flag, CheckSquare, GitBranch, MessageCircle, Sparkles, ExternalLink, Workflow, Settings, Paperclip, MessagesSquare, Ticket, Trash2, FileText, Pencil } from "lucide-react";
import { get, patch, post, del } from "../lib/api";
import { Card, Badge, Button, Input, Textarea, Avatar, NameChip, ProgressBar, Select, EmptyState, toast, cx, SkeletonList, useConfirm } from "../components/ui";
import { HScroll } from "../components/HScroll";
import { STATUS_COLOR, STATUS_LABEL, STATUS_DOT, PRIORITY_LABEL, PRIORITY_COLOR, dayKeyToServer, fmtDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { UpdatesPanel } from "../components/UpdatesPanel";
import { Attachments } from "../components/Attachments";
import { TicketTriageActions } from "../components/TicketTriageActions";
import { ProjectNav } from "../components/ProjectNav";
import { useAuth } from "../hooks/useAuth";

const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
// F3 날짜 규약: 서버 저장값은 "로컬 날짜의 UTC 자정" — Date 왕복 없이 앞 10자 사용
const toDateInput = (d?: string | null) => (d ? String(d).slice(0, 10) : "");

type Tab = "checklist" | "activity" | "files" | "settings";

export default function TaskDetail() {
  const [, params] = useRoute("/projects/:id/tasks/:key");
  const [, navigate] = useLocation();
  const { user: me } = useAuth();
  const { confirm, dialog } = useConfirm();
  const pid = Number(params?.id);
  const key = params?.key;
  const [tab, setTab] = useState<Tab>("checklist");
  const [newItem, setNewItem] = useState("");
  const [editTicket, setEditTicket] = useState(false); // F1: 요청자 티켓 수정 폼
  const [tTitle, setTTitle] = useState("");
  const [tDesc, setTDesc] = useState("");
  const [tPriority, setTPriority] = useState(0);
  const [editDesc, setEditDesc] = useState(false); // G3-1: 설명 편집
  const [descDraft, setDescDraft] = useState("");
  const [editTitle, setEditTitle] = useState(false); // 제목 인라인 수정 (매니저 — 서버 PATCH는 원래 허용)
  const [titleDraft, setTitleDraft] = useState("");
  const [editItem, setEditItem] = useState<{ id: number; text: string } | null>(null); // 체크리스트 문구 수정
  const [openItem, setOpenItem] = useState<number | null>(null); // 피드백 스레드가 열린 체크리스트 항목
  const [fb, setFb] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null); // P7: AI 가이드 초안 (사람 검토 후 등록)

  const q = useQuery<any>({ queryKey: ["task", pid, key], queryFn: () => get(`/projects/${pid}/tasks/by-key/${key}`) });
  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["task", pid, key] });

  const tid = q.data?.task.id;
  const commentsQ = useQuery<{ comments: any[] }>({
    queryKey: ["comments", tid],
    queryFn: () => get(`/comments?task_id=${tid}`),
    enabled: !!tid,
  });
  const mut = (body: any) => patch(`/tasks/${tid}`, body);
  const onErr = (e: any) => toast(`변경 실패: ${e.message}`);
  const setField = useMutation({ mutationFn: (body: any) => mut(body), onSuccess: refresh, onError: onErr });
  const saveDesc = useMutation({
    mutationFn: () => patch(`/tasks/${tid}`, { description: descDraft.trim() || null }),
    onSuccess: () => { setEditDesc(false); refresh(); },
    onError: onErr,
  });
  const saveTitle = useMutation({
    mutationFn: () => patch(`/tasks/${tid}`, { title: titleDraft.trim() }),
    onSuccess: () => { setEditTitle(false); refresh(); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); },
    onError: onErr,
  });
  const saveItemText = useMutation({
    mutationFn: (v: { id: number; text: string }) => patch(`/tasks/${tid}/checklist/${v.id}`, { content: v.text.trim() }),
    // 저장한 그 항목의 편집기만 닫는다 — 응답 도착 전에 다른 항목을 열었으면 그 초안을 건드리지 않음
    onSuccess: (_d, v) => { setEditItem((cur) => (cur !== null && cur.id === v.id ? null : cur)); refresh(); },
    onError: onErr,
  });
  const addAssignee = useMutation({ mutationFn: (user_id: number) => post(`/tasks/${tid}/assignees`, { user_id }), onSuccess: refresh, onError: onErr });
  const rmAssignee = useMutation({ mutationFn: (user_id: number) => del(`/tasks/${tid}/assignees/${user_id}`), onSuccess: refresh, onError: onErr });
  const addItem = useMutation({ mutationFn: () => post(`/tasks/${tid}/checklist`, { content: newItem }), onSuccess: () => { setNewItem(""); refresh(); }, onError: onErr });
  const toggleItem = useMutation({ mutationFn: (v: { id: number; done: boolean }) => patch(`/tasks/${tid}/checklist/${v.id}`, { done: v.done }), onSuccess: refresh });
  const delItem = useMutation({ mutationFn: (id: number) => del(`/tasks/${tid}/checklist/${id}`), onSuccess: refresh, onError: onErr });
  const delTask = useMutation({
    mutationFn: () => del(`/tasks/${tid}`),
    onSuccess: () => { toast("태스크를 삭제했어요."); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); navigate(`/projects/${pid}`, { replace: true }); },
    onError: (e: any) => toast(`삭제 실패: ${e.message}`),
  });
  const addFeedback = useMutation({
    mutationFn: () => post("/comments", { task_id: tid, body: fb.trim(), checklist_item_id: openItem }),
    onSuccess: () => { setFb(""); queryClient.invalidateQueries({ queryKey: ["comments", tid] }); },
    onError: (e: any) => toast(`피드백 등록 실패: ${e.message}`),
  });
  // P6: 선행 태스크
  const projTasksQ = useQuery<{ tasks: any[] }>({ queryKey: ["tasks", pid], queryFn: () => get(`/projects/${pid}/tasks`) });
  const addDep = useMutation({
    mutationFn: (depId: number) => post("/dependencies", { task_id: tid, depends_on_task_id: depId }),
    onSuccess: refresh,
    onError: (e: any) => toast(`선행 태스크 추가 실패: ${e.message}`),
  });
  const rmDep = useMutation({
    mutationFn: (depId: number) => del(`/dependencies/${tid}/${depId}`),
    onSuccess: refresh,
    onError: (e: any) => toast(`선행 태스크 제거 실패: ${e.message}`),
  });
  // P7: AI 가이드 제안 (자동 등록 금지 — 초안을 사람이 검토·수정 후 등록)
  const suggest = useMutation({
    mutationFn: () => post<{ suggestion: string }>("/ai/suggest-guide", { task_id: tid }),
    onSuccess: (d) => setSuggestion(d.suggestion),
    onError: (e: any) => toast(`제안 실패: ${e.message}`),
  });
  const postSuggestion = useMutation({
    mutationFn: () => post("/comments", { task_id: tid, body: suggestion ?? "", is_guide: true }),
    onSuccess: () => { setSuggestion(null); queryClient.invalidateQueries({ queryKey: ["comments", tid] }); refresh(); },
    onError: (e: any) => toast(`가이드 등록 실패: ${e.message}`),
  });

  if (q.isLoading) return <div className="mx-auto max-w-3xl pt-6"><SkeletonList count={3} lines={3} /></div>;
  if (q.isError) return <div className="text-red-500">태스크를 찾을 수 없습니다.</div>;
  const { task, creator, assignees, checklist, subtasks, checklist_progress, my_role, dependencies = [], github_links = [], source_page_in_trash = false } = q.data;
  const canManage = ["owner", "manager"].includes(my_role);
  const members = membersQ.data?.members ?? [];
  const assigneeIds = new Set(assignees.map((a: any) => a.id));
  const addable = members.filter((m: any) => !assigneeIds.has(m.user.id));
  const iAmAssignee = me != null && assigneeIds.has(me.id);
  const canEditChecklist = canManage || iAmAssignee;
  const allComments = commentsQ.data?.comments ?? [];
  // F1: 티켓 트리아지 상태
  const isRequested = task.status === "requested";
  const isRejected = task.status === "rejected";
  const isMyRequest = task.kind === "ticket" && task.requested_by === me?.id;
  const withdraw = async () => {
    if (!(await confirm({ title: "요청 철회", message: "이 티켓 요청을 철회할까요?", confirmLabel: "철회", tone: "danger" }))) return;
    try {
      await del(`/tasks/${task.id}`);
      toast("요청을 철회했어요.");
      navigate(`/projects/${pid}`, { replace: true });
    } catch (e: any) { toast(`철회 실패: ${e.message}`); }
  };
  const saveTicketEdit = async () => {
    try {
      await patch(`/tasks/${task.id}`, { title: tTitle.trim(), description: tDesc.trim() || null, priority: tPriority });
      setEditTicket(false); refresh();
    } catch (e: any) { toast(`수정 실패: ${e.message}`); }
  };
  const startEditDesc = () => { setDescDraft(task.description ?? ""); setEditDesc(true); };
  const askDeleteTask = async () => {
    if (await confirm({ title: "태스크 삭제", message: "이 태스크와 체크리스트·댓글이 함께 삭제됩니다. 삭제할까요?", confirmLabel: "삭제", tone: "danger" }))
      delTask.mutate();
  };

  const tabs: { id: Tab; label: string; icon: any; count?: number }[] = [
    { id: "checklist", label: "체크리스트", icon: CheckSquare, count: checklist_progress.total > 0 ? checklist_progress.total : undefined },
    { id: "activity", label: "활동", icon: MessagesSquare, count: allComments.filter((x: any) => !x.checklist_item_id).length || undefined },
    { id: "files", label: "파일", icon: Paperclip },
    { id: "settings", label: "설정", icon: Settings },
  ];

  return (
    <div className="flex flex-col gap-4 pb-10">
      {dialog}
      {/* C12: 태스크 상세는 하위 화면 — 탭 하이라이트 없이 이동만 ("보드" = 이전으로) */}
      <ProjectNav pid={pid} />

      {/* 헤더: 항상 보이는 핵심 정보 */}
      <div>
        <div className="flex items-center gap-2 font-mono text-xs text-slate-400">
          {task.item_key}
          {task.kind === "ticket" && (
            <Badge className="bg-violet-100 font-sans text-violet-700"><Ticket size={11} className="mr-0.5 inline" /> 티켓</Badge>
          )}
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          {editTitle ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && titleDraft.trim()) saveTitle.mutate();
                  if (e.key === "Escape") setEditTitle(false);
                }}
                className="text-lg font-bold" placeholder="태스크 제목" />
              <Button size="sm" onClick={() => saveTitle.mutate()} disabled={!titleDraft.trim() || saveTitle.isPending}>저장</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditTitle(false)}>취소</Button>
            </div>
          ) : (
            <div className="flex min-w-0 items-start gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{task.title}</h1>
              {canManage && (
                <button onClick={() => { setTitleDraft(task.title); setEditTitle(true); }}
                  className="mt-2 flex-shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-slate-100 hover:text-brand" aria-label="제목 수정">
                  <Pencil size={14} />
                </button>
              )}
            </div>
          )}
          {canManage && !editTitle && (
            <Button variant="ghost" size="sm" onClick={askDeleteTask} disabled={delTask.isPending}
              className="flex-shrink-0 text-slate-400 hover:bg-red-50 hover:text-red-500">
              <Trash2 size={15} /> 삭제
            </Button>
          )}
        </div>
        {/* C9: 만든 사람(=지시·요청자) + 생성일 — "이 일 누구한테 물어보지?"의 답 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
          만든 사람 {creator ? <NameChip name={creator.full_name ?? creator.email} id={creator.id} /> : <span className="text-slate-300">알 수 없음</span>}
          <span>· {fmtDate(task.created_at)} 등록</span>
        </div>
      </div>

      {/* G3-1: 설명 — 탭 밖, 제목 바로 아래 상시 노출 (매니저 편집) */}
      {editDesc ? (
        <Card className="flex flex-col gap-2">
          <Textarea rows={5} value={descDraft} onChange={(e) => setDescDraft(e.target.value)} placeholder="태스크 설명 (마크다운 지원)" className="text-sm" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditDesc(false)}>취소</Button>
            <Button size="sm" onClick={() => saveDesc.mutate()} disabled={saveDesc.isPending}>저장</Button>
          </div>
        </Card>
      ) : task.description ? (
        <Card>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{task.description}</div>
            {canManage && (
              <button onClick={startEditDesc} className="flex-shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand" aria-label="설명 편집">
                <Pencil size={14} />
              </button>
            )}
          </div>
        </Card>
      ) : canManage ? (
        <Button variant="outline" size="sm" onClick={startEditDesc} className="self-start"><Plus size={14} /> 설명 추가</Button>
      ) : null}

      {/* F4: 출처 문서 링크 — 제목·설명 아래. 휴지통에 있으면 404 막다른 링크 대신 안내 칩 */}
      {task.source_page_id && (
        source_page_in_trash ? (
          <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-400"
            title="출처 문서가 휴지통에 있어요 — 매니저가 문서 화면의 휴지통에서 복원할 수 있어요">
            <FileText size={13} /> 출처 문서가 휴지통에 있어요
          </span>
        ) : (
          <Link href={`/projects/${pid}/pages?page=${task.source_page_id}`}
            className="inline-flex items-center gap-1.5 self-start rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-brand-50 hover:text-brand">
            <FileText size={13} /> 출처 문서 보기
          </Link>
        )
      )}

      {/* F1: 트리아지 배너 */}
      {isRequested && (
        <Card className="flex flex-col gap-3 border-violet-200 bg-violet-50/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-violet-700">
              {canManage ? "검토가 필요한 티켓이에요 — 승인하면 보드에 올라갑니다." : "검토 대기 중 — 매니저 승인 후 진행돼요."}
            </div>
            {canManage ? (
              <TicketTriageActions taskId={task.id} members={members} dueDate={task.due_date} onDone={refresh} />
            ) : isMyRequest ? (
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => { setEditTicket(!editTicket); setTTitle(task.title); setTDesc(task.description ?? ""); setTPriority(task.priority); }}>수정</Button>
                <Button variant="ghost" size="sm" onClick={withdraw}>철회</Button>
              </div>
            ) : null}
          </div>
          {editTicket && isMyRequest && (
            <div className="flex flex-col gap-2">
              <Input value={tTitle} onChange={(e) => setTTitle(e.target.value)} placeholder="제목" />
              <Textarea rows={3} value={tDesc} onChange={(e) => setTDesc(e.target.value)} placeholder="설명" />
              <div className="flex items-center gap-2">
                <Select className="h-9 w-auto text-sm" value={tPriority} onChange={(e) => setTPriority(Number(e.target.value))}>
                  {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
                </Select>
                <Button size="sm" onClick={saveTicketEdit} disabled={!tTitle.trim()}>저장</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditTicket(false)}>취소</Button>
              </div>
            </div>
          )}
        </Card>
      )}
      {isRejected && (
        <Card className="border-rose-200 bg-rose-50/40 text-sm text-rose-700">
          반려된 티켓이에요. 반려 사유는 활동 탭 댓글에서 확인하세요. 필요하면 새 티켓으로 다시 요청할 수 있어요.
        </Card>
      )}

      {/* status pills — requested/rejected 상태에선 전이 불가라 숨김.
          서버 규칙(담당자 본인 또는 매니저만 상태 변경)과 동일하게 비담당 멤버는 비활성 — 403 토스트만 뜨던 문제 방지 */}
      {!isRequested && !isRejected && (
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => {
          const canSetStatus = canManage || iAmAssignee;
          return (
          <button key={s} onClick={() => canSetStatus && task.status !== s && setField.mutate({ status: s })}
            disabled={!canSetStatus}
            title={canSetStatus ? undefined : "담당자 또는 매니저만 상태를 변경할 수 있어요"}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150",
              task.status === s ? STATUS_COLOR[s] + " shadow-sm ring-2 ring-brand/25" : "border border-slate-200 bg-white text-slate-500",
              canSetStatus ? task.status !== s && "hover:border-slate-300 hover:bg-slate-50" : "cursor-not-allowed opacity-60",
            )}>
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
          </button>
          );
        })}
        {checklist_progress.total > 0 && (
          <span className="ml-auto hidden items-center gap-2 text-xs text-slate-400 sm:inline-flex">
            체크리스트 {checklist_progress.done}/{checklist_progress.total}
            <ProgressBar value={checklist_progress.done} total={checklist_progress.total} className="w-24" />
          </span>
        )}
      </div>
      )}

      {/* 탭 내비게이션 — 모바일에서 잘리면 희미한 ‹ ›로 옆에 더 있음을 표시 */}
      <div className="sticky top-[53px] z-10 -mx-4 border-b border-slate-200/80 bg-[#f7f8fa]/95 px-4 backdrop-blur md:static md:mx-0 md:px-0">
        <HScroll size="sm" className="flex gap-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cx(
                  "relative flex flex-shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm transition-colors duration-150",
                  on ? "font-semibold text-brand" : "text-slate-500 hover:text-slate-700",
                )}>
                <Icon size={15} />
                {t.label}
                {t.count != null && <span className={cx("rounded-full px-1.5 py-0.5 text-[10px] font-semibold", on ? "bg-brand-50 text-brand" : "bg-slate-100 text-slate-500")}>{t.count}</span>}
                {on && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
              </button>
            );
          })}
        </HScroll>
      </div>

      {/* ───── 체크리스트 탭 (항목별 피드백 + 서브태스크) ───── */}
      {tab === "checklist" && (
        <div className="animate-fade-in flex flex-col gap-5">
          <section>
            {checklist_progress.total === 0 ? (
              <EmptyState
                icon={<CheckSquare size={22} />}
                title="아직 체크리스트가 없어요"
                desc={canEditChecklist ? "완료 조건을 항목으로 나눠 진행 상황을 추적해 보세요." : "매니저나 담당자가 체크리스트를 추가하면 여기에 표시돼요."}
              />
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <CheckSquare size={16} className="text-brand" />
                  <h2 className="font-semibold text-slate-700">체크리스트</h2>
                  <span className="text-sm text-slate-400">{checklist_progress.done}/{checklist_progress.total}</span>
                </div>
                <ProgressBar value={checklist_progress.done} total={checklist_progress.total} className="mb-2" />
              </>
            )}
            <div className="flex flex-col gap-1">
              {checklist.map((c: any) => {
                const itemComments = allComments.filter((x: any) => x.checklist_item_id === c.id);
                const open = openItem === c.id;
                return (
                  <div key={c.id} className={`rounded-lg px-1 py-1.5 transition-colors ${open ? "bg-slate-50/70" : ""}`}>
                    <div className="flex items-center gap-2.5">
                      <input type="checkbox" checked={c.done} disabled={!canEditChecklist} onChange={(e) => toggleItem.mutate({ id: c.id, done: e.target.checked })}
                        className={cx("h-5 w-5 rounded accent-indigo-600 transition-transform", c.done && "animate-check-pop")} />
                      {editItem !== null && editItem.id === c.id ? (
                        // 문구 수정 — Enter 저장, Esc/바깥 클릭 취소. 삭제(피드백까지 날아감) 없이 오타를 고치는 길
                        <Input autoFocus value={editItem.text}
                          onChange={(e) => setEditItem({ id: c.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            const cur = { id: c.id, text: (e.target as HTMLInputElement).value };
                            if (e.key === "Enter" && !e.nativeEvent.isComposing && cur.text.trim()) saveItemText.mutate(cur);
                            if (e.key === "Escape") setEditItem(null);
                          }}
                          onBlur={() => setEditItem(null)}
                          className="h-8 min-h-0 min-w-0 flex-1 text-sm" />
                      ) : (
                        <span className={`min-w-0 flex-1 text-sm transition-colors ${c.done ? "text-slate-400 line-through" : "text-slate-700"}`}>{c.content}</span>
                      )}
                      {canEditChecklist && editItem?.id !== c.id && (
                        <button onClick={() => setEditItem({ id: c.id, text: c.content })}
                          className="flex-shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-slate-100 hover:text-brand" aria-label="문구 수정">
                          <Pencil size={13} />
                        </button>
                      )}
                      <button onClick={() => { setOpenItem(open ? null : c.id); setFb(""); }}
                        className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition hover:bg-slate-100 ${itemComments.length ? "font-medium text-brand" : "text-slate-400"}`}>
                        <MessageCircle size={13} /> {itemComments.length > 0 ? itemComments.length : "피드백"}
                      </button>
                      {canManage && (
                        <button
                          onClick={async () => {
                            // 항목에 달린 피드백 댓글까지 함께 지워지므로(cascade) 원클릭 삭제 금지
                            const ok = await confirm({
                              title: "체크리스트 항목 삭제",
                              message: `"${c.content}" 항목을 삭제할까요?${itemComments.length ? ` 이 항목의 피드백 ${itemComments.length}개도 함께 삭제돼요.` : ""}`,
                              confirmLabel: "삭제",
                              tone: "danger",
                            });
                            if (ok) delItem.mutate(c.id);
                          }}
                          className="flex-shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-500" aria-label="항목 삭제">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="animate-fade-in ml-7 mt-2 flex flex-col gap-2 border-l-2 border-brand-100 pl-3 pb-1">
                        {itemComments.map((x: any) => (
                          <div key={x.id} className="rounded-lg bg-white p-2 shadow-sm ring-1 ring-slate-100">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                              <Avatar name={x.author.full_name ?? x.author.email} id={x.author.id} size={18} />
                              {x.author.full_name ?? x.author.email}
                            </div>
                            <div className="mt-1 text-sm leading-relaxed text-slate-700 [&_a]:text-brand [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1" dangerouslySetInnerHTML={{ __html: x.body_html }} />
                          </div>
                        ))}
                        {itemComments.length === 0 && <div className="text-xs text-slate-400">아직 피드백이 없어요. 첫 리뷰를 남겨보세요.</div>}
                        <div className="flex gap-2">
                          <Input placeholder="이 항목에 피드백 남기기 (마크다운 지원)" value={fb} onChange={(e) => setFb(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && fb.trim() && !addFeedback.isPending) addFeedback.mutate(); }} className="h-9 min-h-0 text-sm" />
                          <Button size="sm" onClick={() => addFeedback.mutate()} disabled={addFeedback.isPending || !fb.trim()}>등록</Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {canEditChecklist && (
              <div className="mt-2 flex gap-2">
                <Input placeholder="항목 추가" value={newItem} onChange={(e) => setNewItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && newItem && !addItem.isPending) addItem.mutate(); }} />
                <Button variant="outline" onClick={() => newItem && addItem.mutate()}><Plus size={16} /></Button>
              </div>
            )}
          </section>

          {/* 서브태스크 (체크리스트 탭 하단으로 이동 — 수행 성격) */}
          {subtasks.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2"><GitBranch size={16} className="text-brand" /><h2 className="font-semibold text-slate-700">서브태스크</h2></div>
              <div className="flex flex-col gap-1">
                {subtasks.map((s: any) => (
                  <Card key={s.id} className="flex items-center justify-between py-2.5">
                    <span className={`text-sm ${s.status === "done" ? "text-slate-400 line-through" : "text-slate-700"}`}>{s.title}</span>
                    <Badge className={STATUS_COLOR[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ───── 활동 탭 (AI 가이드 제안 + 업데이트/댓글) ───── */}
      {tab === "activity" && (
        <div className="animate-fade-in flex flex-col gap-5">
          {canManage && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2"><Sparkles size={16} className="text-brand" /><h2 className="font-semibold text-slate-700">AI 가이드 제안</h2></div>
                <Button variant="outline" size="sm" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
                  <Sparkles size={14} /> {suggest.isPending ? "생성 중…" : "초안 생성"}
                </Button>
              </div>
              {suggestion != null && (
                <Card className="flex flex-col gap-2 border-brand-100 bg-brand-50/30">
                  <Textarea rows={7} value={suggestion} onChange={(e) => setSuggestion(e.target.value)} className="text-sm" />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">검토·수정 후 등록하세요. 등록하면 담당자별 수행 추적이 시작돼요.</span>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setSuggestion(null)}>버리기</Button>
                      <Button size="sm" onClick={() => postSuggestion.mutate()} disabled={postSuggestion.isPending || !suggestion.trim()}>가이드로 등록</Button>
                    </div>
                  </div>
                </Card>
              )}
            </section>
          )}
          <UpdatesPanel taskId={task.id} canManage={canManage} onChange={refresh} />
        </div>
      )}

      {/* ───── 파일 탭 ───── */}
      {tab === "files" && (
        <div className="animate-fade-in">
          <Attachments taskId={task.id} canManage={canManage} />
        </div>
      )}

      {/* ───── 설정 탭 (우선순위/일정/담당자/선행 태스크/GitHub) ───── */}
      {tab === "settings" && (
        <div className="animate-fade-in flex flex-col gap-4">
          <Card className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Flag size={13} /> 우선순위</div>
              {canManage ? (
                <Select value={task.priority} onChange={(e) => setField.mutate({ priority: Number(e.target.value) })} className="h-9 text-sm">
                  {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
                </Select>
              ) : <span className={PRIORITY_COLOR[task.priority]}>{PRIORITY_LABEL[task.priority]}</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Calendar size={13} /> 오늘 예정일 / 마감</div>
              {canManage ? (
                <div className="flex gap-2">
                  <input type="date" className="h-9 flex-1 rounded-lg border border-slate-200 px-2 text-sm shadow-sm transition hover:border-slate-300 focus:border-brand-400 focus:outline-none" value={toDateInput(task.scheduled_date)}
                    onChange={(e) => setField.mutate({ scheduled_date: e.target.value ? dayKeyToServer(e.target.value) : null })} />
                  <input type="date" className="h-9 flex-1 rounded-lg border border-slate-200 px-2 text-sm shadow-sm transition hover:border-slate-300 focus:border-brand-400 focus:outline-none" value={toDateInput(task.due_date)}
                    onChange={(e) => setField.mutate({ due_date: e.target.value ? dayKeyToServer(e.target.value) : null })} />
                </div>
              ) : <span className="text-sm text-slate-600">{toDateInput(task.scheduled_date) || "-"} / {toDateInput(task.due_date) || "-"}</span>}
            </div>

            {/* assignees */}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <div className="text-xs font-medium text-slate-500">담당자</div>
              <div className="flex flex-wrap items-center gap-2">
                {assignees.map((a: any) => (
                  <span key={a.id} className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pl-1 pr-2 transition hover:bg-slate-200/70">
                    <Avatar name={a.full_name ?? a.email} id={a.id} size={22} />
                    <span className="text-xs text-slate-700">{a.full_name ?? a.email}</span>
                    {canManage && <button onClick={() => rmAssignee.mutate(a.id)} className="text-slate-400 transition hover:text-red-500"><X size={13} /></button>}
                  </span>
                ))}
                {assignees.length === 0 && <span className="text-sm text-slate-400">담당자 없음</span>}
                {canManage && addable.length > 0 && (
                  <Select className="h-8 w-auto text-xs" value="" onChange={(e) => e.target.value && addAssignee.mutate(Number(e.target.value))}>
                    <option value="">+ 담당자 추가</option>
                    {addable.map((m: any) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}
                  </Select>
                )}
              </div>
            </div>
          </Card>

          {/* P6: 선행 태스크 */}
          {(dependencies.length > 0 || canManage) && (
            <Card className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Workflow size={13} /> 선행 태스크</div>
              <div className="flex flex-wrap items-center gap-2">
                {dependencies.map((d: any) => (
                  <span key={d.id} className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800 ring-1 ring-amber-100">
                    <Link href={`/projects/${pid}/tasks/${d.item_key}`} className="font-mono hover:underline">{d.item_key}</Link>
                    <span className={d.status === "done" ? "text-emerald-600" : ""}>{d.title}{d.status === "done" ? " ✓" : ""}</span>
                    {canManage && <button onClick={() => rmDep.mutate(d.id)} className="text-amber-400 transition hover:text-red-500"><X size={12} /></button>}
                  </span>
                ))}
                {dependencies.length === 0 && <span className="text-sm text-slate-400">없음</span>}
                {canManage && (
                  <Select className="h-8 w-auto text-xs" value="" onChange={(e) => e.target.value && addDep.mutate(Number(e.target.value))}>
                    <option value="">+ 선행 태스크 추가</option>
                    {(projTasksQ.data?.tasks ?? [])
                      .filter((x: any) => x.id !== task.id && !dependencies.some((d: any) => d.id === x.id))
                      .map((x: any) => <option key={x.id} value={x.id}>{x.item_key} · {x.title}</option>)}
                  </Select>
                )}
              </div>
            </Card>
          )}

          {/* P8: GitHub 연동 링크 */}
          {github_links.length > 0 && (
            <Card className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><GitBranch size={13} /> GitHub</div>
              <div className="flex flex-col gap-1.5">
                {github_links.map((l: any) => (
                  <div key={l.id} className="flex items-center gap-2 text-sm">
                    <Badge className={l.kind === "pr" ? "bg-violet-100 text-violet-700" : l.kind === "commit" ? "bg-slate-100 text-slate-600" : "bg-sky-100 text-sky-700"}>
                      {l.kind === "pr" ? `PR #${l.external_id}` : l.kind === "commit" ? l.external_id.slice(0, 7) : l.kind}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-slate-700">{l.title ?? l.external_id}</span>
                    {l.state && <Badge className={l.state === "merged" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}>{l.state}</Badge>}
                    {l.url && <a href={l.url} target="_blank" rel="noreferrer" className="text-slate-400 transition hover:text-brand"><ExternalLink size={14} /></a>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
