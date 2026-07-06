import { useEffect, useRef, useState } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Users, Plus, List, Columns3, Calendar as CalIcon, ChevronLeft, ChevronRight, ChevronDown, CalendarRange, MonitorPlay, NotebookPen, Ticket, FileText, Clock, Circle, Pencil, Check, X } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Badge, Button, Input, Textarea, Select, EmptyState, Avatar, toast, useConfirm, SkeletonList } from "../components/ui";
import { TaskCard } from "../components/TaskCard";
import { KanbanBoard } from "../components/KanbanBoard";
import { TicketRequestModal } from "../components/TicketRequestModal";
import { TicketTriageActions } from "../components/TicketTriageActions";
import { EventModal } from "../components/EventModal";
import { eventDayKey, eventTimeLabel } from "../components/EventStrip";
import { STATUS_LABEL, STATUS_DOT, PRIORITY_LABEL, toDayKey, localDayKey, dayKeyToServer, dayKeyToLocalDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { setActiveProject, clearActiveProject } from "../lib/activeProject";
import { useAuth } from "../hooks/useAuth";

type View = "list" | "kanban" | "calendar" | "timeline";
type CalMode = "month" | "week" | "day";
// F1: requested는 티켓 요청 대기(0건이면 컬럼 숨김), rejected는 "반려됨 보기" 토글로만 접근
const STATUSES = ["requested", "todo", "in_progress", "blocked", "done"] as const;
const FROZEN = new Set(["requested", "rejected"]); // 드래그·드롭 불가(전이는 승인/반려 API 전용)
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// memberFilter: null=전체, -1=미배정, 그 외=user_id
const matchMember = (t: any, memberFilter: number | null) =>
  memberFilter == null
    ? true
    : memberFilter === -1
      ? (t.assignees ?? []).length === 0
      : (t.assignees ?? []).some((a: any) => a.id === memberFilter);

export default function ProjectBoard() {
  const [, params] = useRoute("/projects/:id");
  const pid = Number(params?.id);
  // 미니 달력에서 넘어온 ?view=calendar&date=YYYY-MM-DD — useSearch로 반응형 구독
  // (이미 보드에 머문 상태에서 날짜를 눌러도 URL 변경을 감지해 해당 날짜로 점프)
  const search = useSearch();
  const urlParams = new URLSearchParams(search);
  const initialDate = urlParams.get("date");
  const urlView = urlParams.get("view") as View | null;
  const [view, setView] = useState<View>(urlView || "calendar"); // 캘린더(주간)가 기본 뷰
  const [title, setTitle] = useState("");
  const [memberFilter, setMemberFilter] = useState<number | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false); // F1: 티켓 요청 모달
  const [assigneeId, setAssigneeId] = useState<number | null>(null); // 빠른 추가 시 담당자 선택
  const [showDetail, setShowDetail] = useState(false); // 상세(설명·우선순위) 펼침
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState(0);
  const [editingName, setEditingName] = useState(false); // 프로젝트 이름 인라인 편집
  const [nameInput, setNameInput] = useState("");

  const { confirm, dialog } = useConfirm();
  const { user: me } = useAuth();
  const proj = useQuery<{ project: any }>({ queryKey: ["project", pid], queryFn: () => get(`/projects/${pid}`) });
  const tasksQ = useQuery<{ tasks: any[] }>({ queryKey: ["tasks", pid], queryFn: () => get(`/projects/${pid}/tasks`) });
  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const canManage = ["owner", "manager"].includes(proj.data?.project.my_role);
  const isCompleted = proj.data?.project.status === "completed";
  const myWorkQ = useQuery<{ today: any[] }>({ queryKey: ["my-work"], queryFn: () => get("/my-work") });

  // ★ 이 프로젝트를 활성(메인) 프로젝트로 기억 → 다음 접속 시 바로 이 보드로
  useEffect(() => {
    const p = proj.data?.project;
    if (p) setActiveProject({ id: p.id, key: p.key, name: p.name });
  }, [proj.data]);

  // 미니달력에서 날짜/뷰가 들어오면(보드에 이미 있어도) 해당 뷰로 전환 → 화면이 안 바뀌는 문제 방지
  useEffect(() => {
    if (urlView) setView(urlView);
  }, [urlView, initialDate]);

  const create = useMutation({
    // 기본값: 오늘 예정일 = 오늘 (생성 즉시 캘린더·My Work에 잡히도록). 선택 시 담당자도 바로 배정.
    mutationFn: () => post(`/projects/${pid}/tasks`, {
      title,
      scheduled_date: dayKeyToServer(localDayKey(new Date())),
      ...(assigneeId ? { assignee_ids: [assigneeId] } : {}),
      ...(desc.trim() ? { description: desc.trim() } : {}),
      ...(priority ? { priority } : {}),
    }),
    // 담당자·우선순위·상세 펼침은 유지(연속 입력 편의) — 제목·설명만 비움
    onSuccess: () => { setTitle(""); setDesc(""); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); },
    onError: (e: any) => toast(e.message),
  });
  const rename = useMutation({
    mutationFn: (name: string) => patch(`/projects/${pid}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", pid] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setEditingName(false);
      toast("프로젝트 이름을 변경했어요.", "success");
    },
    onError: (e: any) => toast(e.message),
  });
  const complete = useMutation({
    mutationFn: () => patch(`/projects/${pid}`, { status: "completed" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project", pid] }); toast("프로젝트를 완료했습니다. 스킬 탭에서 SKILL.md 초안을 확인하세요."); },
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: number; status: string }) => patch(`/tasks/${v.id}`, { status: v.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks", pid] }),
    onError: (e: any) => toast(e.message),
  });

  const tasks = tasksQ.data?.tasks ?? [];
  const members = membersQ.data?.members ?? [];
  const filtered = tasks.filter((t) => matchMember(t, memberFilter));
  // F1: 반려된 티켓은 "남은 할 일" 집계에서 제외
  const openCount = (uid: number | -1) =>
    tasks.filter((t) => t.status !== "done" && t.status !== "rejected" && matchMember(t, uid)).length;
  const unassignedCount = openCount(-1);
  // F1: requested_by → 이름 (티켓 카드의 "요청: {이름}")
  const memberName = (uid?: number | null) => {
    if (uid == null) return null;
    const m = members.find((x: any) => x.user.id === uid);
    return m ? (m.user.full_name ?? m.user.email) : null;
  };

  const viewTabs: { id: View; label: string; icon: any }[] = [
    { id: "calendar", label: "캘린더", icon: CalIcon },
    { id: "timeline", label: "타임라인", icon: CalendarRange },
    { id: "list", label: "리스트", icon: List },
    { id: "kanban", label: "칸반", icon: Columns3 },
  ];

  if (proj.isError) {
    clearActiveProject(pid);
    return (
      <EmptyState title="프로젝트를 열 수 없어요" desc="삭제되었거나 접근 권한이 없어요. 프로젝트 목록에서 다시 선택해주세요."
        action={<Link href="/projects"><Button size="sm">프로젝트 목록으로</Button></Link>} />
    );
  }

  const chip = (active: boolean) =>
    // G4-1: 선택 시 꽉 찬 인디고 반전으로 대비 강화
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-brand bg-brand font-semibold text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`;

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{proj.data?.project.key ?? "…"}</span>
            {isCompleted && <Badge className="bg-emerald-100 text-emerald-700">완료됨</Badge>}
            {(myWorkQ.data?.today?.length ?? 0) > 0 && (
              <Link href="/my-work"><Badge className="bg-emerald-100 text-emerald-700 transition hover:bg-emerald-200">✓ 오늘 내 할 일 {myWorkQ.data!.today.length}</Badge></Link>
            )}
          </div>
          {editingName ? (
            <div className="mt-1 flex items-center gap-1.5">
              <Input autoFocus className="max-w-xs text-lg font-bold" value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && nameInput.trim()) rename.mutate(nameInput.trim());
                  if (e.key === "Escape") setEditingName(false);
                }} />
              <Button size="sm" onClick={() => nameInput.trim() && rename.mutate(nameInput.trim())} disabled={rename.isPending}><Check size={15} /></Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}><X size={15} /></Button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{proj.data?.project.name ?? "…"}</h1>
              {canManage && !isCompleted && (
                <button title="이름 변경" aria-label="프로젝트 이름 변경"
                  onClick={() => { setNameInput(proj.data?.project.name ?? ""); setEditingName(true); }}
                  className="rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-brand"><Pencil size={15} /></button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/projects/${pid}/pages`}><Button variant="outline" size="sm"><FileText size={15} /> 문서</Button></Link>
          <Link href={`/projects/${pid}/meetings`}><Button variant="outline" size="sm"><NotebookPen size={15} /> 회의록</Button></Link>
          <Link href={`/projects/${pid}/preview`}><Button variant="outline" size="sm"><MonitorPlay size={15} /> 프리뷰</Button></Link>
          <Link href={`/projects/${pid}/members`}><Button variant="outline" size="sm"><Users size={15} /> 팀원 {members.length > 0 && `(${members.length})`}</Button></Link>
          {canManage && !isCompleted && (
            <Button variant="outline" size="sm"
              onClick={async () => {
                if (await confirm({ title: "프로젝트 완료", message: "프로젝트를 완료하고 노하우를 추출할까요? 완료 후 스킬 탭에서 SKILL.md 초안을 확인할 수 있어요.", confirmLabel: "완료 · 추출" })) complete.mutate();
              }}>완료 · 추출</Button>
          )}
        </div>
      </div>

      {canManage && !isCompleted && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-[12rem] flex-1" placeholder="새 태스크 제목을 입력하고 Enter" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && title && !create.isPending) create.mutate(); }} />
            {members.length > 0 && (
              <Select className="h-10 w-auto text-sm" value={assigneeId ?? ""}
                onChange={(e) => setAssigneeId(e.target.value ? Number(e.target.value) : null)} title="담당자 지정(선택)">
                <option value="">담당자 없음</option>
                {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}
              </Select>
            )}
            <Button onClick={() => title && create.mutate()} disabled={create.isPending}><Plus size={16} /> 추가</Button>
          </div>
          <button onClick={() => setShowDetail((v) => !v)}
            className="inline-flex w-fit items-center gap-1 text-xs text-slate-400 transition hover:text-brand">
            <ChevronDown size={13} className={`transition-transform ${showDetail ? "rotate-180" : ""}`} />
            {showDetail ? "설명·우선순위 접기" : "설명·우선순위 추가"}
          </button>
          {showDetail && (
            <div className="animate-fade-in flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
              <Textarea rows={3} placeholder="태스크 설명 (선택 · 마크다운 지원)" value={desc} onChange={(e) => setDesc(e.target.value)} className="text-sm" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-shrink-0 whitespace-nowrap text-xs font-medium text-slate-500">우선순위</span>
                <Select className="h-9 w-auto text-sm" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                  {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
                </Select>
                <span className="ml-auto whitespace-nowrap text-xs text-slate-400 max-sm:w-full max-sm:ml-0">제목까지 입력하고 "추가"를 누르면 함께 저장돼요.</span>
              </div>
            </div>
          )}
        </div>
      )}
      {/* F1: member는 티켓 요청으로 작업을 제안 (매니저 승인 후 진행) */}
      {!canManage && !isCompleted && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setTicketOpen(true)}><Ticket size={15} /> 티켓 요청</Button>
        </div>
      )}
      <TicketRequestModal pid={pid} open={ticketOpen} onClose={() => setTicketOpen(false)} />

      {/* ★ 팀원별 한눈에 보기 + 필터: 각 팀원의 남은 할 일 수가 보이고, 누르면 그 팀원 할 일만 표시 */}
      {members.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={chip(memberFilter == null)} onClick={() => setMemberFilter(null)}>
            {/* 팀원별 카운트(openCount)와 동일 기준: done·rejected 제외 — 칩 숫자 정합 */}
            전체 <span className="text-[11px] opacity-70">{tasks.filter((t) => t.status !== "done" && t.status !== "rejected").length}</span>
          </button>
          {members.map((m) => {
            const name = m.user.full_name ?? m.user.email;
            const n = openCount(m.user.id);
            return (
              <button key={m.user.id} className={chip(memberFilter === m.user.id)}
                onClick={() => setMemberFilter(memberFilter === m.user.id ? null : m.user.id)} title={`${name}의 할 일 보기`}>
                <Avatar name={name} size={20} /> {name}
                <span className={`text-xs ${n === 0 ? "text-slate-300" : "opacity-70"}`}>{n}</span>
              </button>
            );
          })}
          {unassignedCount > 0 && (
            <button className={chip(memberFilter === -1)} onClick={() => setMemberFilter(memberFilter === -1 ? null : -1)}>
              미배정 <span className="text-[11px] opacity-70">{unassignedCount}</span>
            </button>
          )}
        </div>
      )}

      <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm">
        {viewTabs.map((v) => {
          const Icon = v.icon;
          return (
            <button key={v.id} onClick={() => setView(v.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all duration-150 ${view === v.id ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              <Icon size={15} /> {v.label}
            </button>
          );
        })}
      </div>

      {tasksQ.isLoading ? <SkeletonList count={4} lines={2} />
        : tasks.length === 0 ? (
          <EmptyState icon={<Plus size={22} />} title="아직 태스크가 없어요"
            desc={canManage ? "위 입력창에 제목을 적고 추가하면 리스트·칸반·캘린더에서 함께 볼 수 있어요." : "매니저가 태스크를 배정하면 여기에 표시돼요."} />
        )
        : view === "list" ? <ListView tasks={filtered} pid={pid} memberName={memberName} />
        : view === "kanban" ? <KanbanView tasks={filtered} pid={pid} onMove={(id, status) => setStatus.mutate({ id, status })} canManage={canManage} meId={me?.id ?? 0} members={members} memberName={memberName} onTriaged={() => queryClient.invalidateQueries({ queryKey: ["tasks", pid] })} />
        : view === "timeline" ? <TimelineView tasks={filtered} pid={pid} />
        : <CalendarView key={initialDate ?? "cal"} tasks={filtered} allTasks={tasks} pid={pid} members={members} memberFilter={memberFilter} onPickMember={(id) => setMemberFilter(id)} initialDate={initialDate} canManage={canManage && !isCompleted} />}
    </div>
  );
}

/* ---------------- List (grouped by status) ---------------- */
function ListView({ tasks, pid, memberName }: { tasks: any[]; pid: number; memberName: (uid?: number | null) => string | null }) {
  // C3: 칸반과 동일한 "반려됨 보기" 토글 — 리스트만 쓰는 요청자도 반려 여부를 알 수 있게
  const [showRejected, setShowRejected] = useState(false);
  const rejected = tasks.filter((t) => t.status === "rejected");
  if (tasks.length === 0) return <div className="py-8 text-center text-sm text-slate-400">이 팀원에게 배정된 태스크가 없어요.</div>;
  return (
    <div className="flex flex-col gap-5">
      {rejected.length > 0 && (
        <label className="flex items-center gap-1.5 self-end text-xs text-slate-500">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} className="h-3.5 w-3.5 accent-rose-500" />
          반려됨 보기 ({rejected.length})
        </label>
      )}
      {STATUSES.map((s) => {
        const group = tasks.filter((t) => t.status === s);
        if (group.length === 0) return null;
        return (
          <div key={s}>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
              <span className="text-slate-400">{group.length}</span>
            </div>
            <div className="flex flex-col gap-2">{group.map((t) => <TaskCard key={t.id} t={t} pid={pid} requesterName={memberName(t.requested_by)} />)}</div>
          </div>
        );
      })}
      {showRejected && rejected.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT.rejected}`} /> {STATUS_LABEL.rejected}
            <span className="text-slate-400">{rejected.length}</span>
          </div>
          <div className="flex flex-col gap-2">{rejected.map((t) => <TaskCard key={t.id} t={t} pid={pid} requesterName={memberName(t.requested_by)} />)}</div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Kanban — 공용 KanbanBoard 사용 (F2, 중복 구현 금지) ---------------- */
function KanbanView({ tasks, pid, onMove, canManage, meId, members, memberName, onTriaged }: {
  tasks: any[]; pid: number; onMove: (id: number, status: string) => void; canManage: boolean; meId: number;
  members: any[]; memberName: (uid?: number | null) => string | null; onTriaged: () => void;
}) {
  const [showRejected, setShowRejected] = useState(false); // F1: 반려됨은 토글(기본 off)
  const requestedCount = tasks.filter((t) => t.status === "requested").length;
  const rejectedCount = tasks.filter((t) => t.status === "rejected").length;
  // requested 컬럼은 0건이면 숨김(클러터 방지), rejected는 토글 시에만. FROZEN 컬럼은 드롭 대상 아님.
  const columns = [
    ...STATUSES.filter((s) => s !== "requested" || requestedCount > 0).map((s) => ({ id: s as string, droppable: !FROZEN.has(s) })),
    ...(showRejected ? [{ id: "rejected", droppable: false }] : []),
  ];
  return (
    <div className="flex flex-col gap-2">
      {rejectedCount > 0 && (
        <label className="flex items-center gap-1.5 self-end text-xs text-slate-500">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} className="h-3.5 w-3.5 accent-rose-500" />
          반려됨 보기 ({rejectedCount})
        </label>
      )}
      <KanbanBoard
        tasks={tasks}
        columns={columns}
        // 서버 규칙과 동일: 매니저 이상 or 담당자 본인(자기 태스크 상태 변경) — MyWork 칸반과 일관
        canDrag={(t) => (canManage || (t.assignees ?? []).some((a: any) => a.id === meId)) && !FROZEN.has(t.status)}
        onDrop={(id, status) => onMove(id, status)}
        pidFor={() => pid}
        requesterName={(t) => memberName(t.requested_by)}
        cardExtra={(t) =>
          t.status === "requested" && canManage ? (
            <TicketTriageActions taskId={t.id} members={members} onDone={onTriaged} />
          ) : null
        }
      />
    </div>
  );
}

/* ---------------- Calendar: week workload grid (기본) + month + per-member day ---------------- */
// C2: 캘린더 카드 드래그 이동 페이로드 — 열(팀원, -1=미배정)과 요일(day key)
type CalMove = { taskId: number; fromCol: number; toCol: number; fromDay: string; toDay: string };

function CalendarView({ tasks, allTasks, pid, members, memberFilter, onPickMember, initialDate, canManage }: {
  tasks: any[]; allTasks: any[]; pid: number; members: any[]; memberFilter: number | null; onPickMember: (id: number | null) => void;
  initialDate?: string | null; canManage: boolean;
}) {
  // 미니 달력에서 특정 날짜로 진입하면 일 뷰 + 그 날짜로 시작
  const [mode, setMode] = useState<CalMode>(initialDate ? "day" : "week"); // ★ 기본: 주간 팀원별 워크로드
  // F3: day key(YYYY-MM-DD)는 로컬 자정으로 파싱 — new Date(key)는 UTC라 음수 TZ 하루 밀림
  const [cursor, setCursor] = useState(initialDate ? dayKeyToLocalDate(initialDate) : new Date());
  // F3: 주간 범위 토글 — "이번 주"(일~토) / "오늘부터 7일". 선택은 localStorage 기억.
  const [weekRange, setWeekRange] = useState<"week" | "next7">(
    () => (localStorage.getItem("devflow.cal.range") as "week" | "next7") || "week",
  );
  const pickRange = (v: "week" | "next7") => {
    setWeekRange(v);
    localStorage.setItem("devflow.cal.range", v);
    if (v === "next7") setCursor(new Date()); // 7일 모드 첫날 = 오늘
  };

  // C1: 할 일/일정 필터 — 범례를 겸하는 토글 버튼 (전체 / 할 일만 / 일정만). weekRange처럼 localStorage 기억.
  const [calFilter, setCalFilterState] = useState<"all" | "tasks" | "events">(
    () => (localStorage.getItem("devflow.cal.filter") as "all" | "tasks" | "events") || "all",
  );
  const setCalFilter = (v: "all" | "tasks" | "events") => { setCalFilterState(v); localStorage.setItem("devflow.cal.filter", v); };
  const showTasks = calFilter !== "events";
  const showEvents = calFilter !== "tasks";

  // C3: 날짜(예정·마감) 없는 할 일 — 캘린더·타임라인 어디에도 안 보이던 태스크의 진입점
  const undated = allTasks.filter((t) => !t.scheduled_date && !t.due_date && !["requested", "rejected", "done"].includes(t.status));
  const [trayDragging, setTrayDragging] = useState(false); // 트레이에서 끌기 시작 → 그리드에 드롭 대상 표시

  const dayOf = (t: any) => toDayKey(t.scheduled_date ?? t.due_date);
  const tasksByDay = new Map<string, any[]>();
  for (const t of showTasks ? tasks : []) { const k = dayOf(t); if (!k) continue; if (!tasksByDay.has(k)) tasksByDay.set(k, []); tasksByDay.get(k)!.push(t); }

  const weekStart = weekRange === "week" ? startOfWeek(cursor) : new Date(cursor);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

  // F5: 표시 기간의 이벤트 — TZ 경계 유실 방지 위해 ±8일 패딩 요청 후 day key로 배치
  const [eventOpen, setEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<any | null>(null); // C3: 일정 칩 클릭 → 보기·수정·삭제
  const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const rangeBase = mode === "month" ? new Date(cursor.getFullYear(), cursor.getMonth(), 1) : mode === "week" ? weekStart : cursor;
  const rangeEndBase = mode === "month" ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0) : mode === "week" ? weekEnd : cursor;
  const evFrom = localDayKey(addDays(rangeBase, -8));
  const evTo = localDayKey(addDays(rangeEndBase, 8));
  const eventsQ = useQuery<{ events: any[] }>({
    queryKey: ["events", pid, evFrom, evTo],
    queryFn: () => get(`/events?from=${evFrom}&to=${evTo}`),
  });
  // C3: 이 프로젝트 캘린더에는 이 프로젝트 일정 + 개인 일정만 (타 프로젝트 일정 혼입 방지)
  //     멀티데이 일정(ends_at이 다른 날)은 시작~종료의 모든 날짜 셀에 배치 — 조회 범위로 클램프
  const eventsByDay = new Map<string, any[]>();
  const nextDayKey = (key: string) => { const d = dayKeyToLocalDate(key); d.setDate(d.getDate() + 1); return localDayKey(d); };
  for (const e of eventsQ.data?.events ?? []) {
    if (e.project_id != null && e.project_id !== pid) continue;
    const startKey = eventDayKey(e);
    const endKey = e.ends_at ? (e.all_day ? String(e.ends_at).slice(0, 10) : localDayKey(new Date(e.ends_at))) : startKey;
    let k = startKey < evFrom ? evFrom : startKey;
    const stop = endKey > evTo ? evTo : endKey;
    for (; k <= stop; k = nextDayKey(k)) {
      if (!eventsByDay.has(k)) eventsByDay.set(k, []);
      eventsByDay.get(k)!.push(e);
    }
  }
  for (const list of eventsByDay.values()) list.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  const shownEvents = showEvents ? eventsByDay : new Map<string, any[]>();

  // ★ C2: 캘린더 카드 DnD — 요일 이동=scheduled_date 변경, 열 이동=담당자 추가/제거(-1=미배정 열은 해당 단계 생략).
  //   추가(서버 멱등) 후 제거 순서라 중간에 실패해도 담당자가 유실되지 않는다. 기존 REST API 재사용.
  const move = useMutation({
    mutationFn: async (v: CalMove) => {
      if (v.toDay !== v.fromDay) await patch(`/tasks/${v.taskId}`, { scheduled_date: dayKeyToServer(v.toDay) });
      if (v.toCol !== v.fromCol) {
        if (v.toCol !== -1) await post(`/tasks/${v.taskId}/assignees`, { user_id: v.toCol });
        if (v.fromCol !== -1) await del(`/tasks/${v.taskId}/assignees/${v.fromCol}`);
      }
    },
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", pid] });
      queryClient.invalidateQueries({ queryKey: ["my-work"] }); // 오늘 내 할 일 수(배지) 갱신
      // due_date만 있던 태스크는 마감일 자리에 보이던 것 — 옮기면 예정일이 새로 잡히고 마감일은 그대로임을 안내
      const t = allTasks.find((x) => x.id === v.taskId);
      if (t && !t.scheduled_date && t.due_date && v.toDay !== v.fromDay)
        toast(`예정일을 ${v.toDay}로 잡았어요 — 마감일(${toDayKey(t.due_date)})은 그대로예요.`, "success");
    },
    onError: (e: any) => { toast(e.message); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); },
  });

  const headTitle =
    mode === "month" ? `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`
    : mode === "week" ? `${weekStart.getMonth() + 1}.${weekStart.getDate()} ~ ${weekEnd.getMonth() + 1}.${weekEnd.getDate()}`
    : cursor.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            {(["week", "month", "day"] as CalMode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
                {m === "month" ? "월" : m === "week" ? "주" : "일"}
              </button>
            ))}
          </div>
          {mode === "week" && (
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs">
              <button onClick={() => pickRange("week")}
                className={`rounded-md px-2 py-1 ${weekRange === "week" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>이번 주</button>
              <button onClick={() => pickRange("next7")}
                className={`rounded-md px-2 py-1 ${weekRange === "next7" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>오늘부터 7일</button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, -1))}><ChevronLeft size={18} /></button>
          <div className="min-w-[8rem] text-center text-sm font-semibold text-slate-700">{headTitle}</div>
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, 1))}><ChevronRight size={18} /></button>
          <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>오늘</Button>
          <Button size="sm" variant="outline" onClick={() => setEventOpen(true)}>+ 일정</Button>
        </div>
      </div>
      <EventModal open={eventOpen || !!editingEvent} onClose={() => { setEventOpen(false); setEditingEvent(null); }}
        defaultProjectId={pid} defaultDate={localDayKey(cursor)} event={editingEvent} />

      {/* C1: 범례 겸 필터 — 버튼을 누르면 해당 종류만 표시 */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {([["all", "전체"], ["tasks", "할 일"], ["events", "일정"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setCalFilter(k)} title={k === "all" ? "할 일과 일정 모두 표시" : `${label}만 표시`}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 transition ${calFilter === k ? "border-brand bg-brand font-semibold text-white shadow-sm" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"}`}>
            {k === "tasks" && <Circle size={8} className={calFilter === k ? "fill-white text-white" : "fill-brand text-brand"} />}
            {k === "events" && <Clock size={11} className={calFilter === k ? "text-white" : "text-emerald-500"} />}
            {label}
          </button>
        ))}
        {canManage && mode !== "month" && <span className="ml-1 hidden text-slate-300 sm:inline">· 할 일 카드는 끌어서 요일·담당자 이동 · 일정은 클릭해 수정</span>}
        {canManage && <span className="ml-1 text-slate-300 sm:hidden">· 터치 기기는 태스크 상세에서 날짜·담당자 변경</span>}
      </div>

      {/* C3: 날짜 미지정 할 일 트레이 — 끌어서 캘린더에 놓으면 예정일이 잡힘 */}
      {showTasks && undated.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2">
          <span className="text-xs font-medium text-slate-500">
            날짜 미지정 {undated.length}건{canManage && mode !== "month" ? " — 카드를 끌어 요일·담당자 칸에 놓으면 예정일이 잡혀요" : ""}
          </span>
          {undated.map((t) => (
            <span key={t.id} draggable={canManage} title={t.title}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/task", String(t.id));
                e.dataTransfer.setData("text/task-from", "-1"); // 열 이동 없음 취급 — 드롭한 팀원만 추가
                e.dataTransfer.setData("text/task-day", "");
                setTrayDragging(true);
              }}
              onDragEnd={() => setTrayDragging(false)}
              className={`inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 ${canManage ? "cursor-grab active:cursor-grabbing hover:border-brand-200" : ""}`}>
              <span className="font-mono text-[10px] text-slate-400">{t.item_key}</span>
              <span className="truncate">{t.title}</span>
            </span>
          ))}
        </div>
      )}

      {mode === "month"
        ? <MonthGrid cursor={cursor} tasksByDay={tasksByDay} eventsByDay={shownEvents} pid={pid} onPickDay={(d) => { setCursor(d); setMode("day"); }} onPickEvent={setEditingEvent} />
        : mode === "week"
        ? <WeekGrid start={weekStart} tasks={showTasks ? allTasks : []} eventsByDay={shownEvents} members={members} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} onPickDay={(d) => { setCursor(d); setMode("day"); }} canManage={canManage} onMove={(v) => move.mutate(v)} onPickEvent={setEditingEvent} tasksHidden={!showTasks} externalDrag={trayDragging} />
        : <DayView cursor={cursor} tasks={showTasks ? tasks : []} eventsByDay={shownEvents} members={members} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} canManage={canManage} onMove={(v) => move.mutate(v)} onPickEvent={setEditingEvent} tasksHidden={!showTasks} externalDrag={trayDragging} />}
    </div>
  );
}

/* F5: 캘린더 셀용 이벤트 칩 — 태스크와 다른 색(에메랄드) + 시간 표시.
   C3: 클릭 → 상세·수정 모달(부모 셀의 날짜 이동 클릭에 삼켜지지 않게 stopPropagation).
   멀티데이는 렌더링 중인 날짜(day)에 따라 시작시각/~종료시각/"계속" 라벨 분기. */
function EventChip({ e, day, onPick }: { e: any; day?: string; onPick?: (e: any) => void }) {
  const startKey = eventDayKey(e);
  const endKey = e.ends_at ? (e.all_day ? String(e.ends_at).slice(0, 10) : localDayKey(new Date(e.ends_at))) : startKey;
  const hhmm = (x: any) => { const d = new Date(x); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const label = !day || day === startKey ? eventTimeLabel(e)
    : day === endKey && !e.all_day && e.ends_at ? `~${hhmm(e.ends_at)}` : "계속";
  return (
    <span role="button" tabIndex={0}
      onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onPick?.(e); }}
      onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); onPick?.(e); } }}
      className="flex cursor-pointer items-center gap-1 truncate rounded border-l-[3px] border-emerald-500 bg-emerald-50 px-1 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
      title={`${e.title}${e.project_name ? ` · ${e.project_name}` : " · 개인"} (일정 — 클릭해 보기·수정)`}>
      <Clock size={10} className="flex-shrink-0" />
      <span className="font-mono text-[10px] font-semibold">{label}</span>
      <span className="truncate">{e.title}</span>
      {e.project_id == null && <span className="flex-shrink-0 rounded bg-emerald-100 px-1 text-[9px] font-semibold">개인</span>}
    </span>
  );
}

function shift(d: Date, mode: CalMode, dir: number): Date {
  const n = new Date(d);
  if (mode === "month") n.setMonth(n.getMonth() + dir);
  else if (mode === "week") n.setDate(n.getDate() + dir * 7);
  else n.setDate(n.getDate() + dir);
  return n;
}
// localDayKey는 format.ts로 승격됨 (F3 날짜 규약) — import 사용
function startOfWeek(d: Date): Date {
  const n = new Date(d);
  n.setDate(n.getDate() - n.getDay()); // back to Sunday
  return n;
}

/* ---------------- ★ Week workload grid: 열=팀원, 행=날짜 — 누가 어떤 주에 무슨 일이 있는지 한눈에 ---------------- */
function WeekGrid({ start, tasks, eventsByDay, members, pid, dayOf, memberFilter, onPickMember, onPickDay, canManage, onMove, onPickEvent, tasksHidden, externalDrag }: {
  start: Date; tasks: any[]; eventsByDay: Map<string, any[]>; members: any[]; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void; onPickDay: (d: Date) => void;
  canManage: boolean; onMove: (v: CalMove) => void; onPickEvent: (e: any) => void; tasksHidden: boolean; externalDrag: boolean;
}) {
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const dayKeys = days.map(localDayKey);
  const todayKey = localDayKey(new Date());
  // ★ C2 DnD: 셀(팀원×요일)이 드롭 대상. dragId는 "오늘 예정된 일이 없어요" 병합 행을
  //   드래그 중에만 일반 셀 그리드로 되돌려 오늘 행에도 떨어뜨릴 수 있게 하는 용도.
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const isTaskDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("text/task");
  const dragActive = dragId != null || externalDrag; // externalDrag = 날짜 미지정 트레이에서 끌어오는 중
  // F3: 진입 시 오늘 행으로 1회 자동 스크롤 — "토요일이라 맨 아래라 일이 없는 줄 알았다" 방지
  const todayRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    todayRowRef.current?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cols = [
    ...members.map((m) => ({ id: m.user.id as number, name: (m.user.full_name ?? m.user.email) as string })),
    { id: -1, name: "미배정" },
  ];
  const cellTasks = (colId: number, dayKey: string) =>
    tasks.filter((t) =>
      dayOf(t) === dayKey &&
      (colId === -1 ? (t.assignees ?? []).length === 0 : (t.assignees ?? []).some((a: any) => a.id === colId)));
  const weekCount = (colId: number) => dayKeys.reduce((n, k) => n + cellTasks(colId, k).length, 0);
  // 팀원은 일이 없어도 항상 표시. 미배정 열은 드래그 중에도 표시(담당 해제 드롭 대상 확보)
  const visible = cols.filter((c) => (c.id === -1 ? weekCount(-1) > 0 || dragActive : true));

  const grid = { display: "grid", gridTemplateColumns: `7rem repeat(${visible.length}, minmax(16rem, 1fr))` } as const;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/70">
      <div style={{ minWidth: `${7 + visible.length * 16}rem` }} onDragEnd={() => { setDragId(null); setOver(null); }}>
        {/* 팀원 헤더 (클릭 → 그 팀원만 필터) */}
        <div style={grid} className="border-b border-slate-200 bg-white">
          {/* C3: 첫 열 sticky — 모바일 가로 스크롤 시 요일이 화면에 남도록 (불투명 배경 필수) */}
          <div className="sticky left-0 z-10 flex items-center bg-white px-2 py-2 text-xs font-medium text-slate-400">요일 / 팀원</div>
          {visible.map((c) => {
            const total = weekCount(c.id);
            return (
              <button key={c.id} onClick={() => onPickMember(memberFilter === c.id ? null : c.id)} title="이 팀원의 할 일만 보기"
                className={`flex items-center justify-center gap-1.5 border-l border-slate-100 px-2 py-2 transition hover:bg-brand-50/50 ${memberFilter === c.id ? "bg-brand-100 ring-2 ring-inset ring-brand" : ""}`}>
                {c.id === -1
                  ? <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm text-slate-500">?</span>
                  : <Avatar name={c.name} size={28} />}
                <span className={`min-w-0 truncate text-[15px] ${memberFilter === c.id ? "font-bold text-brand" : "font-semibold text-slate-700"}`}>{c.name}</span>
                <span className={`rounded-full px-1.5 text-sm ${total === 0 ? "text-slate-300" : "bg-indigo-50 font-medium text-brand"}`}>{total}</span>
              </button>
            );
          })}
        </div>

        {/* 날짜 행 (요일 클릭 → 그 날짜의 일 뷰). 오늘 행은 뚜렷하게 강조 + 자동 스크롤 대상 */}
        {(() => { const weekTotal = visible.reduce((n, c) => n + weekCount(c.id), 0); return days.map((d, i) => {
          const k = dayKeys[i];
          const isToday = k === todayKey;
          const dow = d.getDay();
          const todayTotal = isToday ? visible.reduce((n, c) => n + cellTasks(c.id, k).length, 0) : -1;
          const dayEvents = eventsByDay.get(k) ?? [];
          return (
            <div key={i} ref={isToday ? todayRowRef : undefined} style={grid}
              className={`border-b border-slate-200/70 last:border-b-0 ${isToday ? "bg-indigo-50/60 ring-2 ring-inset ring-brand/40" : ""}`}>
              {/* C4: 일정 띠 — 좁은 날짜 칸 대신 행 전체 폭으로 (제목이 제대로 보임). 클릭 시 수정 모달 */}
              {dayEvents.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }} className="flex flex-wrap items-center gap-1 border-b border-emerald-100/70 bg-emerald-50/40 px-2 py-1">
                  {dayEvents.map((e: any) => <EventChip key={e.id} e={e} day={k} onPick={onPickEvent} />)}
                </div>
              )}
              <button onClick={() => onPickDay(d)} title="이 날짜의 일 뷰 보기"
                className={`sticky left-0 z-10 flex flex-col items-start justify-center px-3 py-2 text-left transition hover:bg-slate-100 ${isToday ? "bg-indigo-50 font-bold text-brand" : dow === 0 ? "bg-white text-rose-400" : dow === 6 ? "bg-white text-sky-400" : "bg-white text-slate-500"}`}>
                <span className="text-[13px]">{WEEKDAYS[dow]}요일</span>
                <span className="text-lg font-bold">{d.getMonth() + 1}.{d.getDate()}</span>
                {isToday && <span className="mt-0.5 rounded bg-brand px-1.5 py-0.5 text-[11px] font-medium text-white">오늘</span>}
              </button>
              {isToday && todayTotal === 0 && !dragActive && !tasksHidden ? (
                <div className="flex min-h-[76px] items-center border-l border-slate-200/60 p-3 text-sm text-slate-400"
                  style={{ gridColumn: "2 / -1" }}>
                  오늘 예정된 할 일이 없어요{dayEvents.length > 0 ? ` (일정 ${dayEvents.length}건은 위 띠에)` : ""} — 이번 주 할 일 {weekTotal}건
                </div>
              ) : (
                visible.map((c) => {
                  const list = cellTasks(c.id, k);
                  const cellKey = `${c.id}:${k}`;
                  // ★ 일 뷰와 동일한 카드형 태스크 표시 + 드롭 대상(요일·담당자 이동)
                  return (
                    <div key={c.id}
                      onDragOver={(e) => { if (isTaskDrag(e)) { e.preventDefault(); setOver(cellKey); } }}
                      // 셀 안의 카드 위로 지나갈 때 하이라이트가 깜빡이지 않게 — 진짜 셀 밖으로 나갈 때만 해제
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === cellKey ? null : o)); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setOver(null); setDragId(null);
                        const taskId = Number(e.dataTransfer.getData("text/task"));
                        const fromCol = Number(e.dataTransfer.getData("text/task-from"));
                        const fromDay = e.dataTransfer.getData("text/task-day");
                        if (!taskId || (fromCol === c.id && fromDay === k)) return;
                        onMove({ taskId, fromCol, toCol: c.id, fromDay, toDay: k });
                      }}
                      className={`flex min-h-[76px] flex-col gap-2 border-l border-slate-200/60 p-2 transition ${over === cellKey ? "bg-indigo-50 ring-2 ring-inset ring-indigo-300" : memberFilter === c.id ? "bg-brand-50/50" : ""}`}>
                      {list.map((t) => (
                        <TaskCard key={t.id} t={t} pid={pid} compact
                          draggable={canManage && !FROZEN.has(t.status)}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/task", String(t.id));
                            e.dataTransfer.setData("text/task-from", String(c.id));
                            e.dataTransfer.setData("text/task-day", k);
                            setDragId(t.id);
                          }} />
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          );
        }); })()}
      </div>
    </div>
  );
}

function MonthGrid({ cursor, tasksByDay, eventsByDay, pid, onPickDay, onPickEvent }: { cursor: Date; tasksByDay: Map<string, any[]>; eventsByDay: Map<string, any[]>; pid: number; onPickDay: (d: Date) => void; onPickEvent: (e: any) => void }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back to Sunday
  const todayKey = localDayKey(new Date());
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-7 border-b border-slate-100 text-center text-xs font-medium text-slate-400">
        {WEEKDAYS.map((w, i) => <div key={w} className={`py-2 ${i === 0 ? "text-rose-400" : i === 6 ? "text-sky-400" : ""}`}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const key = localDayKey(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const dayTasks = tasksByDay.get(key) ?? [];
          return (
            <button key={i} onClick={() => onPickDay(d)}
              className={`flex min-h-[96px] flex-col gap-1 border-b border-r border-slate-100 p-1.5 text-left transition hover:bg-slate-50 md:min-h-[110px] ${!inMonth ? "bg-slate-50/50" : ""} ${key === todayKey ? "bg-indigo-50/50 ring-2 ring-inset ring-brand/40" : ""}`}>
              <span className={`text-[13px] ${key === todayKey ? "flex h-6 w-6 items-center justify-center rounded-full bg-brand font-semibold text-white" : inMonth ? "text-slate-600" : "text-slate-300"}`}>{d.getDate()}</span>
              {key === todayKey && <span className="text-[10px] font-semibold text-brand">오늘</span>}
              <div className="flex flex-col gap-0.5">
                {/* F5: 일정을 태스크와 병렬 표시 (다른 색) — 클릭 시 수정 모달, 초과분은 주간 뷰와 동일한 +N */}
                {(eventsByDay.get(key) ?? []).slice(0, 2).map((e) => <EventChip key={`ev-${e.id}`} e={e} day={key} onPick={onPickEvent} />)}
                {(eventsByDay.get(key) ?? []).length > 2 && <span className="px-1 text-[10px] text-emerald-600 underline">+{(eventsByDay.get(key) ?? []).length - 2} 일정</span>}
                {dayTasks.slice(0, 3).map((t) => (
                  <span key={t.id} className="flex items-center gap-1 truncate rounded bg-indigo-50 px-1 py-0.5 text-xs text-brand">
                    {(t.assignees ?? []).slice(0, 2).map((a: any) => (
                      <Avatar key={a.id} name={a.full_name ?? a.email} size={15} />
                    ))}
                    <span className="truncate">{t.title}</span>
                  </span>
                ))}
                {dayTasks.length > 3 && <span className="px-1 text-xs text-slate-400">+{dayTasks.length - 3}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayView({ cursor, tasks, eventsByDay, members, pid, dayOf, memberFilter, onPickMember, canManage, onMove, onPickEvent, tasksHidden, externalDrag }: {
  cursor: Date; tasks: any[]; eventsByDay: Map<string, any[]>; members: any[]; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void; canManage: boolean; onMove: (v: CalMove) => void;
  onPickEvent: (e: any) => void; tasksHidden: boolean; externalDrag: boolean;
}) {
  // C2 DnD: 같은 날 안에서 팀원 칸 사이 드래그 → 담당자 이동
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragActive = dragging || externalDrag;
  const key = localDayKey(cursor);
  const dayTasks = tasks.filter((t) => dayOf(t) === key);
  const dayEvents = eventsByDay.get(key) ?? [];
  // one column per member + an "unassigned" column (필터 중이면 해당 칸만)
  const allColumns = [
    ...members.map((m) => ({ id: m.user.id, name: m.user.full_name ?? m.user.email })),
    { id: -1, name: "미배정" },
  ];
  const columns = memberFilter == null ? allColumns : allColumns.filter((c) => c.id === memberFilter);
  const forColumn = (colId: number) =>
    dayTasks.filter((t) => (colId === -1 ? (t.assignees ?? []).length === 0 : (t.assignees ?? []).some((a: any) => a.id === colId)));

  // 팀원 칸은 태스크가 없어도 항상 표시 → 누가 일이 있고 없는지 한눈에 보임
  return (
    <div className="flex flex-col gap-2">
    {dayEvents.length > 0 && (
      <div className="flex flex-wrap gap-1.5">{dayEvents.map((e) => <EventChip key={e.id} e={e} day={key} onPick={onPickEvent} />)}</div>
    )}
    {tasksHidden ? (
      <div className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">할 일 숨김 중 — 일정만 표시하고 있어요</div>
    ) : (
    <div className="flex gap-3 overflow-x-auto pb-2" onDragEnd={() => { setOver(null); setDragging(false); }}>
      {columns.map((c) => {
        const list = forColumn(c.id);
        if (c.id === -1 && list.length === 0 && memberFilter == null && !dragActive) return null;
        return (
          <div key={c.id}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("text/task")) { e.preventDefault(); setOver(c.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.id ? null : o)); }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const taskId = Number(e.dataTransfer.getData("text/task"));
              const fromCol = Number(e.dataTransfer.getData("text/task-from"));
              if (!taskId || fromCol === c.id) return;
              onMove({ taskId, fromCol, toCol: c.id, fromDay: key, toDay: key });
            }}
            className={`flex w-60 flex-shrink-0 flex-col gap-2 rounded-xl transition md:w-72 ${over === c.id ? "bg-indigo-50 ring-2 ring-inset ring-indigo-300" : ""}`}>
            <button onClick={() => onPickMember(memberFilter === c.id ? null : c.id)} title="이 팀원의 할 일만 보기"
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-indigo-50 ${memberFilter === c.id ? "bg-indigo-50 ring-1 ring-indigo-200" : "bg-slate-100/70"}`}>
              {c.id === -1 ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">?</span> : <Avatar name={c.name} size={24} />}
              <span className="truncate text-sm font-medium text-slate-700">{c.name}</span>
              <span className={`ml-auto text-xs ${list.length === 0 ? "text-slate-300" : "text-slate-400"}`}>{list.length}</span>
            </button>
            {list.map((t) => (
              <TaskCard key={t.id} t={t} pid={pid} compact
                draggable={canManage && !FROZEN.has(t.status)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/task", String(t.id));
                  e.dataTransfer.setData("text/task-from", String(c.id));
                  e.dataTransfer.setData("text/task-day", key);
                  setDragging(true);
                }} />
            ))}
            {list.length === 0 && <div className="py-3 text-center text-xs text-slate-300">없음</div>}
          </div>
        );
      })}
    </div>
    )}
    </div>
  );
}

/* ---------------- P6 Timeline (Gantt-lite): 기간 바 + 선행 태스크 표시 ---------------- */
function TimelineView({ tasks, pid }: { tasks: any[]; pid: number }) {
  const depsQ = useQuery<{ dependencies: any[] }>({ queryKey: ["deps", pid], queryFn: () => get(`/dependencies?project_id=${pid}`) });
  const deps = depsQ.data?.dependencies ?? [];
  const byId = new Map(tasks.map((t: any) => [t.id, t]));
  // 반려된 티켓은 간트에서 제외(칸반 정책과 일치). 무날짜 태스크는 표시 불가 — 하단에 개수 안내.
  const dated = tasks.filter((t) => (t.scheduled_date || t.due_date) && t.status !== "rejected");
  const undatedCount = tasks.filter((t) => !t.scheduled_date && !t.due_date && t.status !== "rejected").length;

  const DAY = 86400000;
  // 예정일·마감일이 뒤집혀 있어도(과거 데이터) 음수 기간이 나오지 않게 정규화
  const rawS = (t: any) => new Date(toDayKey(t.scheduled_date ?? t.due_date)!).getTime();
  const rawE = (t: any) => new Date(toDayKey(t.due_date ?? t.scheduled_date)!).getTime();
  const startOf = (t: any) => Math.min(rawS(t), rawE(t));
  const endOf = (t: any) => Math.max(rawS(t), rawE(t));
  const min = dated.length ? Math.min(...dated.map(startOf)) - DAY : 0;
  const max = dated.length ? Math.max(...dated.map(endOf)) + 2 * DAY : DAY;
  const range = max - min;

  // C4: 일정 마커 — 시간축이 있는 뷰라 일정(회의·마감·행사)을 함께 표시. 훅이라 early return보다 위에.
  const [editingEvent, setEditingEvent] = useState<any | null>(null);
  const evFrom = new Date(min).toISOString().slice(0, 10);
  const evTo = new Date(max).toISOString().slice(0, 10);
  const eventsQ = useQuery<{ events: any[] }>({
    queryKey: ["events", pid, "timeline", evFrom, evTo],
    queryFn: () => get(`/events?from=${evFrom}&to=${evTo}`),
    enabled: dated.length > 0,
  });
  const evs = (eventsQ.data?.events ?? []).filter((e) => e.project_id == null || e.project_id === pid);

  if (dated.length === 0)
    return <EmptyState title="날짜가 지정된 태스크가 없어요" desc="매니저가 태스크 상세(또는 캘린더의 날짜 미지정 트레이)에서 예정일/마감일을 지정하면 타임라인에 표시돼요." />;
  const days = Math.round(range / DAY);
  const pct = (ts: number) => ((ts - min) / range) * 100;
  const today = new Date(localDayKey(new Date())).getTime();
  const rows = [...dated].sort((a, b) => startOf(a) - startOf(b));
  const barColor: Record<string, string> = { todo: "bg-indigo-400", in_progress: "bg-blue-500", blocked: "bg-amber-500", done: "bg-emerald-500" };

  const step = Math.max(1, Math.ceil(days / 14));
  const ticks: number[] = [];
  for (let ts = min + DAY; ts <= max; ts += step * DAY) ticks.push(ts);

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <div className="min-w-[760px]">
        {/* 날짜 눈금 */}
        <div className="flex border-b border-slate-100">
          <div className="w-64 flex-shrink-0 px-3 py-2 text-xs font-medium text-slate-400">태스크</div>
          <div className="relative h-8 flex-1">
            {ticks.map((ts, i) => (
              <span key={i} className="absolute top-2 -translate-x-1/2 text-[11px] text-slate-400" style={{ left: `${pct(ts)}%` }}>
                {/* 타임스탬프가 UTC 자정 기준이라 로컬 getter는 음수 TZ에서 하루 밀림 — UTC getter 사용 (F3) */}
                {new Date(ts).getUTCMonth() + 1}.{new Date(ts).getUTCDate()}
              </span>
            ))}
            {today >= min && today <= max && <span className="absolute top-0 h-full w-0.5 bg-brand/60" style={{ left: `${pct(today)}%` }} title="오늘" />}
          </div>
        </div>
        {/* C4: 일정 행 — ◆(하루)·막대(멀티데이), 클릭하면 수정 모달 */}
        {evs.length > 0 && (
          <div className="flex border-b border-emerald-100/70 bg-emerald-50/30">
            <div className="flex w-64 flex-shrink-0 items-center gap-1 px-3 py-1.5 text-[11px] font-semibold text-emerald-700">
              <Clock size={11} /> 일정 {evs.length}
            </div>
            <div className="relative h-7 flex-1">
              {today >= min && today <= max && <span className="absolute top-0 h-full w-0.5 bg-brand/20" style={{ left: `${pct(today)}%` }} />}
              {evs.map((e) => {
                const sKey = eventDayKey(e);
                const eKey = e.ends_at ? (e.all_day ? String(e.ends_at).slice(0, 10) : localDayKey(new Date(e.ends_at))) : sKey;
                const s = new Date(sKey).getTime();
                const en = new Date(eKey).getTime() + DAY;
                const multi = en - s > DAY;
                const label = `${e.title}${e.project_name ? "" : " (개인)"} — ${eventTimeLabel(e)} · 클릭해 보기·수정`;
                return multi ? (
                  <button key={e.id} onClick={() => setEditingEvent(e)} title={label}
                    className="absolute top-1.5 flex h-4 items-center overflow-hidden whitespace-nowrap rounded-full bg-emerald-400/90 px-1.5 text-[10px] font-medium text-white transition hover:bg-emerald-500"
                    style={{ left: `${pct(Math.max(s, min))}%`, width: `${Math.max(((Math.min(en, max) - Math.max(s, min)) / range) * 100, 2)}%` }}>
                    {e.title}
                  </button>
                ) : (
                  <button key={e.id} onClick={() => setEditingEvent(e)} title={label}
                    className="absolute top-0.5 -translate-x-1/2 text-sm leading-6 text-emerald-500 transition hover:scale-125 hover:text-emerald-600"
                    style={{ left: `${pct(s + DAY / 2)}%` }}>
                    ◆
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {rows.map((t) => {
          const s = startOf(t);
          const e = endOf(t) + DAY;
          const myDeps = deps
            .filter((d: any) => d.task_id === t.id)
            .map((d: any) => byId.get(d.depends_on_task_id))
            .filter(Boolean);
          return (
            <div key={t.id} className="flex items-center border-b border-slate-50 py-1.5 last:border-b-0 hover:bg-slate-50/60">
              <Link href={`/projects/${pid}/tasks/${t.item_key}`} className="w-64 flex-shrink-0 truncate px-3">
                <span className="mr-1.5 font-mono text-xs text-slate-400">{t.item_key}</span>
                <span className={`text-sm font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-700"}`}>{t.title}</span>
                {myDeps.length > 0 && (
                  <span className="ml-1.5 text-[11px] text-amber-600" title="선행 태스크">← {myDeps.map((d: any) => d.item_key).join(", ")}</span>
                )}
              </Link>
              <div className="relative h-7 flex-1">
                {today >= min && today <= max && <span className="absolute top-0 h-full w-0.5 bg-brand/20" style={{ left: `${pct(today)}%` }} />}
                <Link href={`/projects/${pid}/tasks/${t.item_key}`}
                  className={`absolute top-1 flex h-5 items-center overflow-hidden whitespace-nowrap rounded-full px-2 text-[11px] font-medium text-white transition hover:opacity-80 ${barColor[t.status] ?? STATUS_DOT[t.status] ?? "bg-slate-300"}`}
                  style={{ left: `${pct(s)}%`, width: `${Math.max(((e - s) / range) * 100, 2.5)}%` }}
                  title={`${t.title} (${STATUS_LABEL[t.status]})`}>
                  {(t.assignees ?? []).slice(0, 2).map((a: any) => a.full_name ?? a.email).join(", ")}
                </Link>
              </div>
            </div>
          );
        })}
        <div className="px-3 py-2 text-xs text-slate-400">
          ←KEY = 선행 태스크 (태스크 상세에서 지정) · 세로선 = 오늘
          {evs.length > 0 && <span className="ml-2 text-emerald-600">· ◆/초록 막대 = 일정 (클릭해 수정)</span>}
          {undatedCount > 0 && <span className="ml-2 text-amber-500">· 날짜 미지정 {undatedCount}건은 표시되지 않아요 (캘린더 상단 트레이에서 배치)</span>}
        </div>
        <EventModal open={!!editingEvent} onClose={() => setEditingEvent(null)} event={editingEvent} />
      </div>
    </div>
  );
}
