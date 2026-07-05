import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, Plus, X, Calendar, Flag, CheckSquare, GitBranch, MessageCircle, Sparkles, ExternalLink, Workflow, LayoutList, Paperclip, MessagesSquare, Ticket } from "lucide-react";
import { get, patch, post, del } from "../lib/api";
import { Card, Badge, Button, Input, Textarea, Avatar, ProgressBar, Select, toast, cx, SkeletonList } from "../components/ui";
import { STATUS_COLOR, STATUS_LABEL, STATUS_DOT, PRIORITY_LABEL, PRIORITY_COLOR, dayKeyToServer } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { UpdatesPanel } from "../components/UpdatesPanel";
import { Attachments } from "../components/Attachments";
import { TicketTriageActions } from "../components/TicketTriageActions";
import { useAuth } from "../hooks/useAuth";

const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
// F3 날짜 규약: 서버 저장값은 "로컬 날짜의 UTC 자정" — Date 왕복 없이 앞 10자 사용
const toDateInput = (d?: string | null) => (d ? String(d).slice(0, 10) : "");

type Tab = "overview" | "checklist" | "activity" | "files";

export default function TaskDetail() {
  const [, params] = useRoute("/projects/:id/tasks/:key");
  const [, navigate] = useLocation();
  const { user: me } = useAuth();
  const pid = Number(params?.id);
  const key = params?.key;
  const [tab, setTab] = useState<Tab>("overview");
  const [newItem, setNewItem] = useState("");
  const [editTicket, setEditTicket] = useState(false); // F1: 요청자 티켓 수정 폼
  const [tTitle, setTTitle] = useState("");
  const [tDesc, setTDesc] = useState("");
  const [tPriority, setTPriority] = useState(0);
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
  const addAssignee = useMutation({ mutationFn: (user_id: number) => post(`/tasks/${tid}/assignees`, { user_id }), onSuccess: refresh, onError: onErr });
  const rmAssignee = useMutation({ mutationFn: (user_id: number) => del(`/tasks/${tid}/assignees/${user_id}`), onSuccess: refresh, onError: onErr });
  const addItem = useMutation({ mutationFn: () => post(`/tasks/${tid}/checklist`, { content: newItem }), onSuccess: () => { setNewItem(""); refresh(); } });
  const toggleItem = useMutation({ mutationFn: (v: { id: number; done: boolean }) => patch(`/tasks/${tid}/checklist/${v.id}`, { done: v.done }), onSuccess: refresh });
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
  const { task, assignees, checklist, subtasks, checklist_progress, guides, my_role, dependencies = [], github_links = [] } = q.data;
  const canManage = ["owner", "manager"].includes(my_role);
  const members = membersQ.data?.members ?? [];
  const assigneeIds = new Set(assignees.map((a: any) => a.id));
  const addable = members.filter((m: any) => !assigneeIds.has(m.user.id));
  const allComments = commentsQ.data?.comments ?? [];
  // F1: 티켓 트리아지 상태
  const isRequested = task.status === "requested";
  const isRejected = task.status === "rejected";
  const isMyRequest = task.kind === "ticket" && task.requested_by === me?.id;
  const withdraw = async () => {
    if (!confirm("이 티켓 요청을 철회할까요?")) return;
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

  const tabs: { id: Tab; label: string; icon: any; count?: number }[] = [
    { id: "overview", label: "개요", icon: LayoutList },
    { id: "checklist", label: "체크리스트", icon: CheckSquare, count: checklist_progress.total > 0 ? checklist_progress.total : undefined },
    { id: "activity", label: "활동", icon: MessagesSquare, count: allComments.filter((x: any) => !x.checklist_item_id).length || undefined },
    { id: "files", label: "파일", icon: Paperclip },
  ];

  return (
    <div className="flex flex-col gap-4 pb-10">
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>

      {/* 헤더: 항상 보이는 핵심 정보 */}
      <div>
        <div className="flex items-center gap-2 font-mono text-xs text-slate-400">
          {task.item_key}
          {task.kind === "ticket" && (
            <Badge className="bg-violet-100 font-sans text-violet-700"><Ticket size={11} className="mr-0.5 inline" /> 티켓</Badge>
          )}
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{task.title}</h1>
      </div>

      {/* F1: 트리아지 배너 — requested(매니저: 승인/반려, 요청자: 대기+수정·철회) / rejected(사유는 댓글) */}
      {isRequested && (
        <Card className="flex flex-col gap-3 border-violet-200 bg-violet-50/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-violet-700">
              {canManage ? "검토가 필요한 티켓이에요 — 승인하면 보드에 올라갑니다." : "검토 대기 중 — 매니저 승인 후 진행돼요."}
            </div>
            {canManage ? (
              <TicketTriageActions taskId={task.id} members={members} onDone={refresh} />
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

      {/* status pills — requested/rejected 상태에선 전이 불가(승인/반려 API 전용)라 숨김 */}
      {!isRequested && !isRejected && (
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setField.mutate({ status: s })}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150",
              task.status === s ? STATUS_COLOR[s] + " shadow-sm ring-2 ring-brand/25" : "border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50",
            )}>
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
          </button>
        ))}
        {checklist_progress.total > 0 && (
          <span className="ml-auto hidden items-center gap-2 text-xs text-slate-400 sm:inline-flex">
            체크리스트 {checklist_progress.done}/{checklist_progress.total}
            <ProgressBar value={checklist_progress.done} total={checklist_progress.total} className="w-24" />
          </span>
        )}
      </div>
      )}

      {/* 탭 내비게이션 — 긴 스크롤 대신 섹션 전환 */}
      <div className="sticky top-[53px] z-10 -mx-4 border-b border-slate-200/80 bg-[#f7f8fa]/95 px-4 backdrop-blur md:static md:mx-0 md:px-0">
        <div className="flex gap-1 overflow-x-auto">
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
        </div>
      </div>

      {/* ───── 개요 탭 ───── */}
      {tab === "overview" && (
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
                    <Avatar name={a.full_name ?? a.email} size={22} />
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

          {/* P6: 선행 태스크 (이 태스크를 시작하기 전에 끝나야 하는 일) */}
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

          {/* F4: 출처 문서 링크 */}
          {task.source_page_id && (
            <Link href={`/projects/${pid}/pages?page=${task.source_page_id}`}
              className="inline-flex items-center gap-1.5 self-start rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-brand-50 hover:text-brand">
              📄 출처 문서 보기
            </Link>
          )}

          {task.description && <Card><div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{task.description}</div></Card>}

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

      {/* ───── 체크리스트 탭 (항목별 리뷰/피드백 스레드 포함) ───── */}
      {tab === "checklist" && (
        <div className="animate-fade-in">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <CheckSquare size={16} className="text-brand" />
              <h2 className="font-semibold text-slate-700">체크리스트</h2>
              {checklist_progress.total > 0 && <span className="text-sm text-slate-400">{checklist_progress.done}/{checklist_progress.total}</span>}
            </div>
            {checklist_progress.total > 0 && <ProgressBar value={checklist_progress.done} total={checklist_progress.total} className="mb-2" />}
            <div className="flex flex-col gap-1">
              {checklist.map((c: any) => {
                const itemComments = allComments.filter((x: any) => x.checklist_item_id === c.id);
                const open = openItem === c.id;
                return (
                  <div key={c.id} className={`rounded-lg px-1 py-1.5 transition-colors ${open ? "bg-slate-50/70" : ""}`}>
                    <div className="flex items-center gap-2.5">
                      <input type="checkbox" checked={c.done} onChange={(e) => toggleItem.mutate({ id: c.id, done: e.target.checked })}
                        className={cx("h-5 w-5 rounded accent-indigo-600 transition-transform", c.done && "animate-check-pop")} />
                      <span className={`min-w-0 flex-1 text-sm transition-colors ${c.done ? "text-slate-400 line-through" : "text-slate-700"}`}>{c.content}</span>
                      <button onClick={() => { setOpenItem(open ? null : c.id); setFb(""); }}
                        className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition hover:bg-slate-100 ${itemComments.length ? "font-medium text-brand" : "text-slate-400"}`}>
                        <MessageCircle size={13} /> {itemComments.length > 0 ? itemComments.length : "피드백"}
                      </button>
                    </div>
                    {open && (
                      <div className="animate-fade-in ml-7 mt-2 flex flex-col gap-2 border-l-2 border-brand-100 pl-3 pb-1">
                        {itemComments.map((x: any) => (
                          <div key={x.id} className="rounded-lg bg-white p-2 shadow-sm ring-1 ring-slate-100">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                              <Avatar name={x.author.full_name ?? x.author.email} size={18} />
                              {x.author.full_name ?? x.author.email}
                            </div>
                            <div className="mt-1 text-sm leading-relaxed text-slate-700 [&_a]:text-brand [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1" dangerouslySetInnerHTML={{ __html: x.body_html }} />
                          </div>
                        ))}
                        {itemComments.length === 0 && <div className="text-xs text-slate-400">아직 피드백이 없어요. 첫 리뷰를 남겨보세요.</div>}
                        <div className="flex gap-2">
                          <Input placeholder="이 항목에 피드백 남기기 (마크다운 지원)" value={fb} onChange={(e) => setFb(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && fb.trim()) addFeedback.mutate(); }} className="h-9 min-h-0 text-sm" />
                          <Button size="sm" onClick={() => addFeedback.mutate()} disabled={addFeedback.isPending || !fb.trim()}>등록</Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <Input placeholder="항목 추가" value={newItem} onChange={(e) => setNewItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newItem) addItem.mutate(); }} />
              <Button variant="outline" onClick={() => newItem && addItem.mutate()}><Plus size={16} /></Button>
            </div>
          </section>
        </div>
      )}

      {/* ───── 활동 탭 (AI 가이드 제안 + 업데이트/댓글) ───── */}
      {tab === "activity" && (
        <div className="animate-fade-in flex flex-col gap-5">
          {/* P7: AI 가이드 제안 — 초안을 사람이 검토·수정한 뒤에만 등록 (§13) */}
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
          <Attachments taskId={task.id} />
        </div>
      )}
    </div>
  );
}
