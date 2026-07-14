import { useEffect, useRef, useState } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, List, Columns3, Calendar as CalIcon, ChevronLeft, ChevronRight, CalendarRange, Ticket, Clock, Circle, Pencil, Check, X, Info, Flag, CheckSquare, Lightbulb } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Badge, Button, Input, Textarea, Select, EmptyState, Avatar, AvatarGroup, NameChip, toast, useConfirm, SkeletonList } from "../components/ui";
import { TaskCard } from "../components/TaskCard";
import { KanbanBoard } from "../components/KanbanBoard";
import { TicketRequestModal } from "../components/TicketRequestModal";
import { TicketTriageActions } from "../components/TicketTriageActions";
import { HScroll } from "../components/HScroll";
import { EventModal } from "../components/EventModal";
import { ProjectNav } from "../components/ProjectNav";
import { eventDayKey, eventTimeLabel } from "../components/EventStrip";
import { STATUS_LABEL, STATUS_DOT, PRIORITY_LABEL, PRIORITY_COLOR, toDayKey, localDayKey, dayKeyToServer, dayKeyToLocalDate, fmtDate, fmtDateFull } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { setActiveProject, clearActiveProject } from "../lib/activeProject";
import { meFirst } from "../lib/memberFold";
import { useAuth } from "../hooks/useAuth";
import { useCollapsedSet } from "../hooks/useCollapsedSet";

type View = "list" | "kanban" | "calendar" | "timeline";
type CalMode = "month" | "week" | "day";
// F1: requested는 티켓 요청 대기(0건이면 컬럼 숨김), rejected는 "반려됨 보기" 토글로만 접근
const STATUSES = ["requested", "todo", "in_progress", "blocked", "done"] as const;
const FROZEN = new Set(["requested", "rejected"]); // 드래그·드롭 불가(전이는 승인/반려 API 전용)
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const CHIP_LIMIT = 7; // 팀원 필터 칩: 9명 이상이면 앞 7명 + "+N" 접기 (8명 이하는 전원 노출)

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
  const [chipsOpen, setChipsOpen] = useState(false); // 팀원 칩 +N 펼침 (9명 이상 팀만 해당)
  const [ticketOpen, setTicketOpen] = useState(false); // F1: 티켓 요청 모달
  const [assigneeId, setAssigneeId] = useState<number | null>(null); // 빠른 추가 시 담당자 선택
  const [showAddTask, setShowAddTask] = useState(false); // "+ 태스크" — 추가 폼(통합 카드) 펼침
  const [eventOpen, setEventOpen] = useState(false); // "+ 일정" — 어느 뷰에서도 일정 만들기(캘린더 밖 포함)
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState(0);
  const [schedDate, setSchedDate] = useState(localDayKey(new Date())); // 기간: 예정일 — 기본 오늘(생성 즉시 캘린더·My Work에 잡히게), 비우면 날짜 미지정
  const [dueDate, setDueDate] = useState(""); // 기간: 마감일(선택)
  const [editingName, setEditingName] = useState(false); // 프로젝트 이름 인라인 편집
  const [nameInput, setNameInput] = useState("");
  const [editingRange, setEditingRange] = useState(false); // 프로젝트 기간(시작~종료) 인라인 편집 — 이름 변경과 같은 패턴
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");

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
  // 접근 불가(삭제·권한 상실) 시 활성 해제 — 렌더 본문에서 하면 스토어 emit이
  // 다른 컴포넌트(MiniCalendar 등) setState를 렌더 중에 유발하므로 effect에서.
  useEffect(() => {
    if (proj.isError) clearActiveProject(pid);
  }, [proj.isError, pid]);

  // 미니달력에서 날짜/뷰가 들어오면(보드에 이미 있어도) 해당 뷰로 전환 → 화면이 안 바뀌는 문제 방지
  useEffect(() => {
    if (urlView) setView(urlView);
  }, [urlView, initialDate]);

  const create = useMutation({
    // 기간은 폼에서 입력 — 예정일 기본값 오늘(생성 즉시 캘린더·My Work에 잡히도록), 비우면 날짜 미지정. 선택 시 담당자도 바로 배정.
    mutationFn: () => post(`/projects/${pid}/tasks`, {
      title,
      ...(schedDate ? { scheduled_date: dayKeyToServer(schedDate) } : {}),
      ...(dueDate ? { due_date: dayKeyToServer(dueDate) } : {}),
      ...(assigneeId ? { assignee_ids: [assigneeId] } : {}),
      ...(desc.trim() ? { description: desc.trim() } : {}),
      ...(priority ? { priority } : {}),
    }),
    // 담당자·우선순위·기간·상세 펼침은 유지(연속 입력 편의 — 같은 날짜에 여러 개) — 제목·설명만 비움
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
  // 프로젝트 기간 저장 — 서버 PATCH가 start/end nullable 수용(둘 다 비우면 해제).
  // 역전(end<start)은 서버도 병합 후 400으로 거부(projects.ts) — 클라 min+버튼 비활성은 UX 선제 차단.
  const saveRange = useMutation({
    mutationFn: () => patch(`/projects/${pid}`, {
      start_date: rangeStart ? dayKeyToServer(rangeStart) : null,
      end_date: rangeEnd ? dayKeyToServer(rangeEnd) : null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", pid] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setEditingRange(false);
      toast("프로젝트 기간을 저장했어요.", "success");
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
  // P2: 그룹(상태) 안 순서 변경 — 목록 정렬(sort_order desc, created_at asc)의 사이값을 부여하고,
  // 간격이 소진되면 그룹 전체를 1000 간격으로 재번호. PATCH sort_order는 매니저 전용(서버 규칙).
  const reorder = useMutation({
    mutationFn: async (v: { taskId: number; beforeId: number | null; status: string }) => {
      const group = tasks.filter((t: any) => t.status === v.status && t.id !== v.taskId);
      const moving = tasks.find((t: any) => t.id === v.taskId);
      if (!moving) return;
      const rawIdx = v.beforeId == null ? group.length : group.findIndex((t: any) => t.id === v.beforeId);
      const idx = rawIdx < 0 ? group.length : rawIdx; // 대상이 사라졌으면 맨 아래로
      const a: number | null = idx > 0 ? group[idx - 1].sort_order ?? 0 : null; // 시각적 위(값 큰 쪽)
      const b: number | null = idx < group.length ? group[idx].sort_order ?? 0 : null; // 삽입 지점 아래
      let next: number | null = null;
      if (a == null && b == null) next = 1000;
      else if (a == null) next = (b as number) + 1000;
      else if (b == null) next = a - 1000;
      else if (a - b > 1) next = Math.floor((a + b) / 2);
      if (next != null) {
        await patch(`/tasks/${v.taskId}`, { sort_order: next });
        return;
      }
      const seq = [...group];
      seq.splice(idx, 0, moving);
      await Promise.all(seq.map((t: any, i: number) => patch(`/tasks/${t.id}`, { sort_order: (seq.length - i) * 1000 })));
    },
    // 실패 시에도 재조회 — 재번호가 반쯤 반영됐을 수 있어, 낡은 캐시 기준의 다음 드래그 계산 오류를 막는다
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tasks", pid] }),
    onError: (e: any) => toast(`순서 변경 실패: ${e.message}`),
  });
  const onReorder = canManage ? (taskId: number, beforeId: number | null, status: string) => reorder.mutate({ taskId, beforeId, status }) : undefined;

  const tasks = tasksQ.data?.tasks ?? [];
  // 나 먼저 — 캘린더 열·필터 칩·담당자 셀렉트 공통 (모바일에서 내 열 찾는 스와이프 제거)
  const members = meFirst(membersQ.data?.members ?? [], (m: any) => m.user.id, me?.id);
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
      {/* C12: 프로젝트 공용 탭 바 — 모든 프로젝트 화면 상단 동일 위치. 드물게 쓰는 완료·추출은 이 줄 끝으로 */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><ProjectNav pid={pid} current="board" /></div>
        {canManage && !isCompleted && (
          <Button variant="outline" size="sm" className="flex-shrink-0"
            onClick={async () => {
              if (await confirm({ title: "프로젝트 완료", message: "프로젝트를 완료하고 노하우를 추출할까요? 완료 후 스킬 탭에서 SKILL.md 초안을 확인할 수 있어요.", confirmLabel: "완료 · 추출" })) complete.mutate();
            }}>완료 · 추출</Button>
        )}
      </div>
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
          {/* S: 프로젝트 기간(시작~종료) — 타임라인 '전체' 배율의 기준. DB·서버는 원래 지원했고 입력 UI만 없었다. */}
          {(() => {
            const p = proj.data?.project;
            if (!p) return null;
            const s = toDayKey(p.start_date);
            const e2 = toDayKey(p.end_date);
            if (editingRange) {
              const invalid = !!(rangeStart && rangeEnd && rangeEnd < rangeStart);
              return (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <CalendarRange size={14} className="text-slate-400" />
                  <input type="date" className="rounded-lg border border-slate-200 px-2 py-1 text-[13px] text-slate-600 focus:outline-none" value={rangeStart}
                    onChange={(ev) => setRangeStart(ev.target.value)} title="시작일 — 비우면 미정" />
                  <span className="text-slate-300">~</span>
                  <input type="date" className="rounded-lg border border-slate-200 px-2 py-1 text-[13px] text-slate-600 focus:outline-none" value={rangeEnd} min={rangeStart || undefined}
                    onChange={(ev) => setRangeEnd(ev.target.value)} title="종료일 — 시작일보다 앞설 수 없어요" />
                  <Button size="sm" onClick={() => saveRange.mutate()} disabled={saveRange.isPending || invalid}><Check size={15} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingRange(false)}><X size={15} /></Button>
                </div>
              );
            }
            const openEdit = () => { setRangeStart(s ?? ""); setRangeEnd(e2 ?? ""); setEditingRange(true); };
            if (!s && !e2)
              return canManage && !isCompleted ? (
                <button onClick={openEdit} className="mt-1.5 flex items-center gap-1 text-xs text-slate-400 transition hover:text-brand">
                  <CalendarRange size={13} /> 기간 설정
                </button>
              ) : null;
            // D-day: 종료일까지 남은 일수(당일 = D-day). day key를 UTC 자정끼리 빼서 TZ 안전.
            const dday = e2 && !isCompleted ? Math.round((Date.parse(e2) - Date.parse(localDayKey(new Date()))) / 86400000) : null;
            return (
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-slate-500">
                <CalendarRange size={14} className="text-slate-400" />
                <span className="font-medium">{s ? fmtDateFull(s) : "미정"} ~ {e2 ? fmtDateFull(e2) : "미정"}</span>
                {dday != null && dday >= 0 && <span className="text-slate-400">· {dday === 0 ? "D-day" : `D-${dday}`}</span>}
                {canManage && !isCompleted && (
                  <button title="기간 변경" aria-label="프로젝트 기간 변경" onClick={openEdit}
                    className="rounded-lg p-1 text-slate-300 transition hover:bg-slate-100 hover:text-brand"><Pencil size={13} /></button>
                )}
              </div>
            );
          })()}
        </div>
        {/* 만들기 버튼 쌍 — 태스크(주 액션)·일정. 어느 뷰에서도 상단에 고정 */}
        {!isCompleted && (
          <div className="flex flex-shrink-0 gap-2">
            {canManage && (
              <Button size="sm" onClick={() => setShowAddTask((v) => !v)} aria-expanded={showAddTask}>
                <Plus size={15} /> 태스크
              </Button>
            )}
            <Button size="sm" variant={canManage ? "outline" : "primary"} onClick={() => setEventOpen(true)}>
              <Plus size={15} /> 일정
            </Button>
          </div>
        )}
      </div>
      {/* 부모 레벨 일정 모달 — "+ 일정"은 캘린더뿐 아니라 리스트·칸반·타임라인에서도 열림 (기본 날짜=오늘) */}
      <EventModal open={eventOpen} onClose={() => setEventOpen(false)} defaultProjectId={pid} defaultDate={localDayKey(new Date())} />

      {canManage && !isCompleted && showAddTask && (
        <div className="animate-fade-in flex flex-col gap-2.5">
          {/* 통합 폼: 연회색 패널 안에 필드마다 각자 테두리 박스(티켓 요청 모달과 같은 규약) —
              경계가 필드 테두리로 명확. 숨은 토글 없음, 웹·모바일 동일 구조.
              실행 버튼은 패널 아래 큰 [추가] 하나(웹 오른쪽 정렬, 모바일 전체 폭). */}
          <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
            <Input autoFocus className="font-medium" placeholder="새 태스크 제목을 입력하고 Enter" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && title && !create.isPending) create.mutate(); }} />
            {/* 순서: 제목 → 기간·담당자·우선순위 → 설명 — 자주 쓰는 속성이 위, 선택 자유입력이 아래 */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 shadow-sm max-sm:w-full">
                <span className="flex-shrink-0 text-[11px] font-semibold text-slate-500">예정</span>
                <input type="date" className="min-w-0 bg-transparent text-sm text-slate-700 focus:outline-none max-sm:flex-1" value={schedDate}
                  onChange={(e) => setSchedDate(e.target.value)} title="예정일 — 비우면 날짜 미지정" />
                <span className="text-slate-300">~</span>
                <span className="flex-shrink-0 text-[11px] font-semibold text-slate-500">마감</span>
                <input type="date" className="min-w-0 bg-transparent text-sm text-slate-700 focus:outline-none max-sm:flex-1" value={dueDate} min={schedDate || undefined}
                  onChange={(e) => setDueDate(e.target.value)} title="마감일(선택) — 예정일보다 앞설 수 없어요" />
              </div>
              {members.length > 0 && (
                <Select className="h-10 w-auto text-sm max-sm:flex-1" value={assigneeId ?? ""}
                  onChange={(e) => setAssigneeId(e.target.value ? Number(e.target.value) : null)} title="담당자 지정(선택)">
                  <option value="">담당자 없음</option>
                  {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}
                </Select>
              )}
              <Select className="h-10 w-auto text-sm max-sm:flex-1" value={priority} onChange={(e) => setPriority(Number(e.target.value))} title="우선순위">
                {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{i === 0 ? "우선순위 없음" : `우선순위 ${l}`}</option>)}
              </Select>
            </div>
            <Textarea rows={2} className="resize-none text-sm" placeholder="설명 (선택 · 마크다운 지원)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button size="lg" className="max-sm:w-full" onClick={() => title && create.mutate()} disabled={create.isPending}><Plus size={17} /> 추가</Button>
          </div>
        </div>
      )}
      {/* F1: member는 티켓 요청으로 작업을 제안 (매니저 승인 후 진행) */}
      {!canManage && !isCompleted && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setTicketOpen(true)}><Ticket size={15} /> 티켓 요청</Button>
        </div>
      )}
      <TicketRequestModal pid={pid} open={ticketOpen} onClose={() => setTicketOpen(false)} />

      {/* 팀원 필터(상위 컨텍스트, 왼쪽) + 뷰 스위처(오른쪽) 한 줄 — 필터는 모든 뷰에 걸리므로 위에 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {members.length > 0 && (() => {
          // 팀원이 9명 이상이면 앞 7명까지만 칩, 나머지는 +N 뒤로 — 칩 줄이 대시보드 역할을 잃지 않게 한 줄 고정.
          // 필터로 선택된 팀원은 숨김 대상이어도 항상 노출(어떤 필터가 걸려 있는지 보여야 함). 8명 이하 팀은 변화 없음.
          const overflow = members.length > CHIP_LIMIT + 1;
          const shown = !overflow || chipsOpen
            ? members
            : [...members.slice(0, CHIP_LIMIT), ...members.slice(CHIP_LIMIT).filter((m: any) => m.user.id === memberFilter)];
          const hiddenCount = members.length - shown.length;
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <button className={chip(memberFilter == null)} onClick={() => setMemberFilter(null)}>
                {/* 팀원별 카운트(openCount)와 동일 기준: done·rejected 제외 — 칩 숫자 정합 */}
                전체 <span className="text-[11px] opacity-70">{tasks.filter((t) => t.status !== "done" && t.status !== "rejected").length}</span>
              </button>
              {shown.map((m) => {
                const name = m.user.full_name ?? m.user.email;
                const n = openCount(m.user.id);
                return (
                  <button key={m.user.id} className={chip(memberFilter === m.user.id)}
                    onClick={() => setMemberFilter(memberFilter === m.user.id ? null : m.user.id)} title={`${name}의 할 일 보기`}>
                    <Avatar name={name} id={m.user.id} role={m.role} size={20} /> {name}
                    <span className={`text-xs ${n === 0 ? "text-slate-300" : "opacity-70"}`}>{n}</span>
                  </button>
                );
              })}
              {overflow && (chipsOpen
                ? <button className={chip(false)} onClick={() => setChipsOpen(false)} title="팀원 칩 접기">접기</button>
                : <button className={chip(false)} onClick={() => setChipsOpen(true)} title="나머지 팀원 칩 모두 보기">+{hiddenCount}</button>)}
              {unassignedCount > 0 && (
                <button className={chip(memberFilter === -1)} onClick={() => setMemberFilter(memberFilter === -1 ? null : -1)}>
                  미배정 <span className="text-[11px] opacity-70">{unassignedCount}</span>
                </button>
              )}
            </div>
          );
        })()}
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm sm:ml-auto">
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
      </div>

      {tasksQ.isLoading ? <SkeletonList count={4} lines={2} />
        : tasks.length === 0 ? (
          <EmptyState icon={<Plus size={22} />} title="아직 태스크가 없어요"
            desc={canManage ? "상단 '+ 태스크'를 눌러 제목을 적고 추가하면 리스트·칸반·캘린더에서 함께 볼 수 있어요." : "매니저가 태스크를 배정하면 여기에 표시돼요."}
            action={canManage && !isCompleted && !showAddTask ? <Button size="sm" onClick={() => setShowAddTask(true)}><Plus size={15} /> 태스크 추가</Button> : undefined} />
        )
        : view === "list" ? <ListView tasks={filtered} pid={pid} memberName={memberName} onReorder={onReorder} />
        : view === "kanban" ? <KanbanView tasks={filtered} pid={pid} onMove={(id, status) => setStatus.mutate({ id, status })} onReorder={onReorder} canManage={canManage} meId={me?.id ?? 0} members={members} memberName={memberName} onTriaged={() => queryClient.invalidateQueries({ queryKey: ["tasks", pid] })} />
        : view === "timeline" ? <TimelineView tasks={filtered} pid={pid} project={proj.data?.project} />
        : <CalendarView key={initialDate ?? "cal"} tasks={filtered} allTasks={tasks} pid={pid} members={members} meId={me?.id ?? null} memberFilter={memberFilter} onPickMember={(id) => setMemberFilter(id)} initialDate={initialDate} canManage={canManage && !isCompleted} />}
    </div>
  );
}

/* ---------------- List (grouped by status) ---------------- */
function ListView({ tasks, pid, memberName, onReorder }: {
  tasks: any[]; pid: number; memberName: (uid?: number | null) => string | null;
  onReorder?: (taskId: number, beforeId: number | null, status: string) => void;
}) {
  // C3: 칸반과 동일한 "반려됨 보기" 토글 — 리스트만 쓰는 요청자도 반려 여부를 알 수 있게
  const [showRejected, setShowRejected] = useState(false);
  // 상태 그룹 접기 — 할 일이 많으면 '진행 중'까지 한참 스크롤해야 하는 문제의 해법 (회의록 월 접기 C14와 같은 규약)
  const { collapsed, toggle } = useCollapsedSet("devflow.list.collapsed");
  const [dropAt, setDropAt] = useState<number | null>(null); // P2: 끼워넣기 대상 행 표시
  const rejected = tasks.filter((t) => t.status === "rejected");
  if (tasks.length === 0) return <div className="py-8 text-center text-sm text-slate-400">이 팀원에게 배정된 태스크가 없어요.</div>;
  const groupHeader = (s: string, count: number) => (
    <button type="button" onClick={() => toggle(s)} aria-expanded={!collapsed.has(s)}
      title={collapsed.has(s) ? "펼치기" : "접기"}
      className="mb-2 flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-slate-600 transition hover:bg-slate-100">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
      <span className="text-slate-400">{count}</span>
      <ChevronRight size={14} className={`text-slate-400 transition-transform ${collapsed.has(s) ? "" : "rotate-90"}`} />
    </button>
  );
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
            {groupHeader(s, group.length)}
            {!collapsed.has(s) && (
              // P2: 매니저는 행을 끌어 같은 그룹 안에서 순서 변경 — 행 위 드롭=그 행 위로, 그룹 빈 곳 드롭=맨 아래
              <div className="flex flex-col gap-1.5"
                onDragOver={onReorder ? (e) => e.preventDefault() : undefined}
                onDrop={onReorder ? (e) => {
                  e.preventDefault(); // 앵커 드래그의 text/uri-list 기본 동작(파이어폭스 URL 이동) 차단
                  setDropAt(null);
                  const id = Number(e.dataTransfer.getData("text/task"));
                  const src = tasks.find((x) => x.id === id);
                  if (id && src?.status === s) onReorder(id, null, s);
                } : undefined}>
                {group.map((t) => (
                  <div key={t.id} draggable={!!onReorder}
                    className={onReorder && dropAt === t.id ? "rounded-xl ring-2 ring-brand-300" : undefined}
                    onDragStart={onReorder ? (e) => e.dataTransfer.setData("text/task", String(t.id)) : undefined}
                    onDragOver={onReorder ? (e) => { e.preventDefault(); e.stopPropagation(); setDropAt(t.id); } : undefined}
                    onDragLeave={onReorder ? () => setDropAt((v) => (v === t.id ? null : v)) : undefined}
                    onDrop={onReorder ? (e) => {
                      e.preventDefault(); // 앵커 드래그의 URL 이동 기본 동작 차단
                      e.stopPropagation();
                      setDropAt(null);
                      const id = Number(e.dataTransfer.getData("text/task"));
                      const src = tasks.find((x) => x.id === id);
                      if (id && id !== t.id && src?.status === s) onReorder(id, t.id, s);
                    } : undefined}>
                    <ListRow t={t} pid={pid} requesterName={memberName(t.requested_by)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {showRejected && rejected.length > 0 && (
        <div>
          {groupHeader("rejected", rejected.length)}
          {!collapsed.has("rejected") && <div className="flex flex-col gap-1.5">{rejected.map((t) => <ListRow key={t.id} t={t} pid={pid} requesterName={memberName(t.requested_by)} />)}</div>}
        </div>
      )}
    </div>
  );
}

/* 리스트 전용 한 줄 행 — 칸반용 TaskCard(세로 카드)가 넓은 리스트에서 큰 빈 카드로 늘어나던 문제.
   상태는 이미 그룹 헤더에 있으므로 행에서 생략, 나머지 메타는 우측에 정렬. 좁으면 자연 줄바꿈. */
function ListRow({ t, pid, requesterName }: { t: any; pid: number; requesterName?: string | null }) {
  const names = (t.assignees ?? []).map((a: any) => a.full_name ?? a.email);
  const ids = (t.assignees ?? []).map((a: any) => a.id);
  return (
    <Link href={`/projects/${pid}/tasks/${t.item_key}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-slate-200/80 bg-white px-4 py-2.5 shadow-card transition hover:border-brand-200 hover:shadow-card-hover">
      <span className="font-mono text-xs text-slate-400 flex-shrink-0">{t.item_key}</span>
      <span className="flex min-w-[8rem] flex-1 items-center gap-1">
        {t.kind === "ticket" && <Ticket size={13} className="flex-shrink-0 text-violet-500" />}
        <span className={`truncate text-sm font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-800"}`}>{t.title}</span>
        {t.kind === "ticket" && requesterName && <span className="flex-shrink-0 text-xs text-violet-500">· 요청: {requesterName}</span>}
      </span>
      {/* 좁으면 메타가 다음 줄로 내려가 넘침 방지 (외곽 flex-wrap + 이 그룹 ml-auto) */}
      <span className="ml-auto flex flex-shrink-0 items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        {t.priority > 0 && <span className={`inline-flex items-center gap-0.5 ${PRIORITY_COLOR[t.priority]}`}><Flag size={11} /> {PRIORITY_LABEL[t.priority]}</span>}
        {t.due_date && <span className="text-amber-600">마감 {fmtDate(t.due_date)}</span>}
        {t.checklist?.total > 0 && <span className="inline-flex items-center gap-0.5"><CheckSquare size={11} /> {t.checklist.done}/{t.checklist.total}</span>}
        {t.guides?.total > 0 && <span className="inline-flex items-center gap-0.5 text-amber-600"><Lightbulb size={11} /> {t.guides.applied}/{t.guides.total}</span>}
        {names.length > 0 && <AvatarGroup names={names} ids={ids} size={20} />}
      </span>
    </Link>
  );
}

/* ---------------- Kanban — 공용 KanbanBoard 사용 (F2, 중복 구현 금지) ---------------- */
function KanbanView({ tasks, pid, onMove, canManage, meId, members, memberName, onTriaged, onReorder }: {
  tasks: any[]; pid: number; onMove: (id: number, status: string) => void; canManage: boolean; meId: number;
  members: any[]; memberName: (uid?: number | null) => string | null; onTriaged: () => void;
  onReorder?: (taskId: number, beforeId: number | null, status: string) => void;
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
        onReorder={onReorder}
        pidFor={() => pid}
        requesterName={(t) => memberName(t.requested_by)}
        cardExtra={(t) =>
          t.status === "requested" && canManage ? (
            <TicketTriageActions taskId={t.id} members={members} dueDate={t.due_date} onDone={onTriaged} />
          ) : null
        }
      />
    </div>
  );
}

/* ---------------- Calendar: week workload grid (기본) + month + per-member day ---------------- */
// C2: 캘린더 카드 드래그 이동 페이로드 — 열(팀원, -1=미배정)과 요일(day key)
type CalMove = { taskId: number; fromCol: number; toCol: number; fromDay: string; toDay: string };

// C8(개정 C11): 일정 배치 규칙 — "일정은 항상 누군가의 것" 원칙.
//     개인 일정=생성자 열, 참석자 있는 일정=참석자 각자의 열에 복제(생성자뿐이어도 그 사람 열 — 단독 일정),
//     공통 띠=전원 참석(진짜 공통)·0명 폴백만. 공지를 만들려면 참석자에서 "전원 선택".
function splitEventsByMember(list: any[], members: any[]) {
  const memberIds = new Set(members.map((m) => m.user.id as number));
  const common: any[] = [];
  const byMember = new Map<number, any[]>();
  const push = (id: number, e: any) => { if (!byMember.has(id)) byMember.set(id, []); byMember.get(id)!.push(e); };
  for (const e of list) {
    if (e.project_id == null) {
      // 개인 일정 — 생성자 열로 (열이 없으면 공통 띠 폴백)
      if (e.created_by != null && memberIds.has(e.created_by)) push(e.created_by, e);
      else common.push(e);
      continue;
    }
    const att = (e.attendees ?? []).map((a: any) => a.id).filter((id: number) => memberIds.has(id));
    if (att.length === 0 || att.length === members.length) common.push(e);
    else att.forEach((id: number) => push(id, e));
  }
  return { common, byMember };
}

function CalendarView({ tasks, allTasks, pid, members, meId, memberFilter, onPickMember, initialDate, canManage }: {
  tasks: any[]; allTasks: any[]; pid: number; members: any[]; meId: number | null; memberFilter: number | null; onPickMember: (id: number | null) => void;
  initialDate?: string | null; canManage: boolean;
}) {
  // 미니 달력에서 특정 날짜로 진입하면 일 뷰 + 그 날짜로 시작
  const [mode, setMode] = useState<CalMode>(initialDate ? "day" : "week"); // ★ 기본: 주간 팀원별 워크로드
  // F3: day key(YYYY-MM-DD)는 로컬 자정으로 파싱 — new Date(key)는 UTC라 음수 TZ 하루 밀림
  const [cursor, setCursor] = useState(initialDate ? dayKeyToLocalDate(initialDate) : new Date());

  // C1: 할 일/일정 필터 — 범례를 겸하는 토글 버튼 (전체 / 할 일만 / 일정만). localStorage 기억.
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

  const weekStart = startOfWeek(cursor); // "이번 주"(일~토) 고정 — 오늘부터 7일 토글은 화살표 이동으로 대체
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

  // F5: 표시 기간의 이벤트 — TZ 경계 유실 방지 위해 ±8일 패딩 요청 후 day key로 배치
  // (일반 "+ 일정"은 부모 레벨로 승격됨 — 여기선 칩 클릭 수정 + 칸 ➕ 프리필만)
  const [editingEvent, setEditingEvent] = useState<any | null>(null); // C3: 일정 칩 클릭 → 보기·수정·삭제
  // 칸 hover ➕ — 그 칸의 날짜(+주간·일 뷰는 그 팀원까지) 프리필로 일정 만들기. 기존 칸 클릭 동작은 불변.
  const [quickCreate, setQuickCreate] = useState<{ day: string; memberId?: number } | null>(null);
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

  const dragHint = mode !== "month"
    ? "할 일 카드는 끌어서 요일·담당자 이동 · 일정은 클릭해 수정 (터치 기기는 태스크 상세에서 변경)"
    : "일정은 클릭해 수정 (터치 기기는 태스크 상세에서 변경)";

  return (
    <div className="flex flex-col gap-3">
      {/* 캘린더 도구줄 — 왼쪽: 범례 겸 필터(알약) │ 눈금(세그먼트) · 오른쪽: 오늘 + 날짜 이동 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        {/* 무엇을 표시하나 — 알약(범례) */}
        <div className="flex items-center gap-1">
          {([["all", "전체"], ["tasks", "할 일"], ["events", "일정"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setCalFilter(k)} title={k === "all" ? "할 일과 일정 모두 표시" : `${label}만 표시`}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 transition ${calFilter === k ? "border-brand bg-brand font-semibold text-white shadow-sm" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"}`}>
              {k === "tasks" && <Circle size={8} className={calFilter === k ? "fill-white text-white" : "fill-brand text-brand"} />}
              {k === "events" && <Clock size={11} className={calFilter === k ? "text-white" : "text-emerald-500"} />}
              {label}
            </button>
          ))}
        </div>
        {/* 어떤 눈금으로 보나 — 세그먼트 (알약과 모양을 달리해 두 그룹 구분) */}
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(["week", "month", "day"] as CalMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 ${mode === m ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              {m === "month" ? "월" : m === "week" ? "주" : "일"}
            </button>
          ))}
        </div>
        {canManage && <span className="text-slate-300" title={dragHint}><Info size={14} /></span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setCursor(new Date())}>오늘</Button>
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, -1))} aria-label="이전"><ChevronLeft size={18} /></button>
          <div className="min-w-[7.5rem] text-center text-sm font-semibold text-slate-700">{headTitle}</div>
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, 1))} aria-label="다음"><ChevronRight size={18} /></button>
        </div>
      </div>
      {/* 칩 클릭 수정 + 칸 ➕ 프리필 전용 모달 (일반 "+ 일정"은 부모 레벨) */}
      <EventModal open={!!editingEvent || !!quickCreate}
        onClose={() => { setEditingEvent(null); setQuickCreate(null); }}
        defaultProjectId={pid} defaultDate={quickCreate?.day ?? localDayKey(cursor)}
        defaultAttendees={quickCreate?.memberId != null ? [quickCreate.memberId] : undefined}
        event={editingEvent} />

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
        ? <MonthGrid cursor={cursor} tasksByDay={tasksByDay} eventsByDay={shownEvents} pid={pid} onPickDay={(d) => { setCursor(d); setMode("day"); }} onPickEvent={setEditingEvent} onQuickCreate={(day, memberId) => setQuickCreate({ day, memberId })} />
        : mode === "week"
        ? <WeekGrid start={weekStart} tasks={showTasks ? allTasks : []} eventsByDay={shownEvents} members={members} meId={meId} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} onPickDay={(d) => { setCursor(d); setMode("day"); }} canManage={canManage} onMove={(v) => move.mutate(v)} onPickEvent={setEditingEvent} tasksHidden={!showTasks} externalDrag={trayDragging} onQuickCreate={(day, memberId) => setQuickCreate({ day, memberId })} />
        : <DayView cursor={cursor} tasks={showTasks ? tasks : []} eventsByDay={shownEvents} members={members} meId={meId} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} canManage={canManage} onMove={(v) => move.mutate(v)} onPickEvent={setEditingEvent} tasksHidden={!showTasks} externalDrag={trayDragging} onQuickCreate={(day, memberId) => setQuickCreate({ day, memberId })} />}
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
function WeekGrid({ start, tasks, eventsByDay, members, meId, pid, dayOf, memberFilter, onPickMember, onPickDay, canManage, onMove, onPickEvent, tasksHidden, externalDrag, onQuickCreate }: {
  start: Date; tasks: any[]; eventsByDay: Map<string, any[]>; members: any[]; meId: number | null; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void; onPickDay: (d: Date) => void;
  canManage: boolean; onMove: (v: CalMove) => void; onPickEvent: (e: any) => void; tasksHidden: boolean; externalDrag: boolean;
  onQuickCreate: (day: string, memberId?: number) => void;
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
  // F3: 진입 시 오늘 행으로 자동 스크롤 — "토요일이라 맨 아래라 일이 없는 줄 알았다" 방지.
  // 일정 띠가 늦게 로드되면 행 위치가 밀리므로 일정 최초 도착 시 1회만 재정렬 —
  // 이후 필터 토글·일정 추가마다 뷰포트를 뺏지 않게 잠금(alignedRef)
  const todayRowRef = useRef<HTMLDivElement | null>(null);
  const alignedRef = useRef(false);
  const totalEventChips = [...eventsByDay.values()].reduce((n, l) => n + l.length, 0);
  useEffect(() => {
    if (alignedRef.current) return;
    todayRowRef.current?.scrollIntoView({ block: "nearest" });
    if (totalEventChips > 0) alignedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalEventChips]);

  const cols = [
    ...members.map((m) => ({ id: m.user.id as number, name: (m.user.full_name ?? m.user.email) as string, role: m.role as string | undefined })),
    { id: -1, name: "미배정", role: undefined as string | undefined },
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
    <HScroll className="rounded-xl border border-slate-200 bg-slate-50/70">
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
                  : <Avatar name={c.name} id={c.id} role={c.role} size={28} />}
                <span className={`min-w-0 truncate text-[15px] ${memberFilter === c.id ? "font-bold text-brand" : "font-semibold text-slate-700"}`}>{c.name}</span>
                {c.id === meId && <span className="flex-shrink-0 rounded bg-brand-100 px-1 text-[11px] font-bold text-brand">나</span>}
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
          const evSplit = splitEventsByMember(dayEvents, members);
          return (
            <div key={i} ref={isToday ? todayRowRef : undefined} style={grid}
              className={`border-b border-slate-200/70 last:border-b-0 ${isToday ? "bg-indigo-50/60 ring-2 ring-inset ring-brand/40" : ""}`}>
              {/* C4: 공통 일정 띠 — 행 전체 폭. 개인·일부 참석 일정은 아래 해당 팀원 칸에 (C8) */}
              {evSplit.common.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }} className="flex flex-wrap items-center gap-1 border-b border-emerald-100/70 bg-emerald-50/40 px-2 py-1">
                  {evSplit.common.map((e: any) => <EventChip key={e.id} e={e} day={k} onPick={onPickEvent} />)}
                </div>
              )}
              <button onClick={() => onPickDay(d)} title="이 날짜의 일 뷰 보기"
                className={`sticky left-0 z-10 flex flex-col items-start justify-center px-3 py-2 text-left transition hover:bg-slate-100 ${isToday ? "bg-indigo-50 font-bold text-brand" : dow === 0 ? "bg-white text-rose-400" : dow === 6 ? "bg-white text-sky-400" : "bg-white text-slate-500"}`}>
                <span className="text-[13px]">{WEEKDAYS[dow]}요일</span>
                <span className="text-lg font-bold">{d.getMonth() + 1}.{d.getDate()}</span>
                {isToday && <span className="mt-0.5 rounded bg-brand px-1.5 py-0.5 text-[11px] font-medium text-white">오늘</span>}
              </button>
              {isToday && todayTotal === 0 && !dragActive && !tasksHidden && evSplit.byMember.size === 0 ? (
                <div className="group/cell relative flex min-h-[76px] items-center border-l border-slate-200/60 p-3 text-sm text-slate-400"
                  style={{ gridColumn: "2 / -1" }}>
                  오늘 예정된 할 일이 없어요{evSplit.common.length > 0 ? ` (일정 ${evSplit.common.length}건은 위 띠에)` : ""} — 이번 주 할 일 {weekTotal}건
                  {/* 병합 행도 hover ➕ 규약 유지 — 가장 수요가 큰 '오늘'에서 끊기지 않게 (팀원 열이 없어 날짜만 프리필) */}
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); onQuickCreate(k); }}
                    title="오늘 일정 만들기"
                    className="absolute right-1 top-1 z-10 hidden h-6 w-6 items-center justify-center rounded-md bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-brand hover:text-white md:group-hover/cell:flex">
                    <Plus size={13} />
                  </button>
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
                      // md:pr-8 — hover ➕ 자리 상시 확보 (칩·카드 우상단 클릭을 ➕가 가로채지 않게, DayView의 pr-9 규약과 동일)
                      className={`group/cell relative flex min-h-[76px] flex-col gap-2 border-l border-slate-200/60 p-2 transition md:pr-8 ${over === cellKey ? "bg-indigo-50 ring-2 ring-inset ring-indigo-300" : memberFilter === c.id ? "bg-brand-50/50" : ""}`}>
                      {/* 칸 hover ➕ — 명시적 버튼으로만 일정 생성 (빈 공간 클릭은 어떤 동작도 안 함: 예측 가능성) */}
                      <button type="button"
                        onClick={(e) => { e.stopPropagation(); onQuickCreate(k, c.id !== -1 ? c.id : undefined); }}
                        title={`${d.getMonth() + 1}.${d.getDate()} 일정 만들기${c.id !== -1 ? ` — ${c.name} 참석` : ""}`}
                        className="absolute right-1 top-1 z-10 hidden h-6 w-6 items-center justify-center rounded-md bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-brand hover:text-white md:group-hover/cell:flex">
                        <Plus size={13} />
                      </button>
                      {/* C8: 이 팀원의 개인·참석 일정 — 할 일 카드 위에 */}
                      {(evSplit.byMember.get(c.id) ?? []).map((e: any) => <EventChip key={`ev-${e.id}`} e={e} day={k} onPick={onPickEvent} />)}
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
    </HScroll>
  );
}

function MonthGrid({ cursor, tasksByDay, eventsByDay, pid, onPickDay, onPickEvent, onQuickCreate }: { cursor: Date; tasksByDay: Map<string, any[]>; eventsByDay: Map<string, any[]>; pid: number; onPickDay: (d: Date) => void; onPickEvent: (e: any) => void; onQuickCreate: (day: string, memberId?: number) => void }) {
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
            // ➕는 별도 버튼이어야 해서(버튼 안 버튼 금지) 래퍼 div가 셀 배경·테두리를 맡고,
            // 기존 "칸 클릭 = 일 뷰 이동"은 내부 버튼이 그대로 담당 — 클릭 의미 불변
            <div key={i} className="group/cell relative border-b border-r border-slate-100">
              {/* 오늘 ring·배경은 버튼 자신에 — 래퍼에 두면 hover 배경(자식)이 inset ring을 덮어 강조가 사라짐 */}
              <button onClick={() => onPickDay(d)}
                className={`flex h-full min-h-[96px] w-full flex-col gap-1 p-1.5 text-left transition hover:bg-slate-50 md:min-h-[110px] ${!inMonth ? "bg-slate-50/50" : ""} ${key === todayKey ? "bg-indigo-50/50 ring-2 ring-inset ring-brand/40" : ""}`}>
                <span className={`text-[13px] ${key === todayKey ? "flex h-6 w-6 items-center justify-center rounded-full bg-brand font-semibold text-white" : inMonth ? "text-slate-600" : "text-slate-300"}`}>{d.getDate()}</span>
                {key === todayKey && <span className="text-[10px] font-semibold text-brand">오늘</span>}
                <div className="flex flex-col gap-0.5">
                  {/* F5: 일정을 태스크와 병렬 표시 (다른 색) — 클릭 시 수정 모달, 초과분은 주간 뷰와 동일한 +N */}
                  {(eventsByDay.get(key) ?? []).slice(0, 2).map((e) => <EventChip key={`ev-${e.id}`} e={e} day={key} onPick={onPickEvent} />)}
                  {(eventsByDay.get(key) ?? []).length > 2 && <span className="px-1 text-[10px] text-emerald-600 underline">+{(eventsByDay.get(key) ?? []).length - 2} 일정</span>}
                  {dayTasks.slice(0, 3).map((t) => (
                    <span key={t.id} className="flex items-center gap-1 truncate rounded bg-indigo-50 px-1 py-0.5 text-xs text-brand">
                      {(t.assignees ?? []).slice(0, 2).map((a: any) => (
                        <Avatar key={a.id} name={a.full_name ?? a.email} id={a.id} size={15} />
                      ))}
                      <span className="truncate">{t.title}</span>
                    </span>
                  ))}
                  {dayTasks.length > 3 && <span className="px-1 text-xs text-slate-400">+{dayTasks.length - 3}</span>}
                </div>
              </button>
              {/* 칸 hover ➕ — 그 날짜 프리필 일정 만들기 */}
              <button type="button"
                onClick={(e) => { e.stopPropagation(); onQuickCreate(key); }}
                title={`${d.getMonth() + 1}.${d.getDate()} 일정 만들기`}
                className="absolute right-1 top-1 z-10 hidden h-6 w-6 items-center justify-center rounded-md bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-brand hover:text-white md:group-hover/cell:flex">
                <Plus size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayView({ cursor, tasks, eventsByDay, members, meId, pid, dayOf, memberFilter, onPickMember, canManage, onMove, onPickEvent, tasksHidden, externalDrag, onQuickCreate }: {
  cursor: Date; tasks: any[]; eventsByDay: Map<string, any[]>; members: any[]; meId: number | null; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void; canManage: boolean; onMove: (v: CalMove) => void;
  onPickEvent: (e: any) => void; tasksHidden: boolean; externalDrag: boolean; onQuickCreate: (day: string, memberId?: number) => void;
}) {
  // C2 DnD: 같은 날 안에서 팀원 칸 사이 드래그 → 담당자 이동
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragActive = dragging || externalDrag;
  const key = localDayKey(cursor);
  const dayTasks = tasks.filter((t) => dayOf(t) === key);
  const dayEvents = eventsByDay.get(key) ?? [];
  const evSplit = splitEventsByMember(dayEvents, members); // C8: 공통=상단 띠, 개인·일부 참석=팀원 칸
  // one column per member + an "unassigned" column (필터 중이면 해당 칸만)
  const allColumns = [
    ...members.map((m) => ({ id: m.user.id, name: m.user.full_name ?? m.user.email, role: m.role as string | undefined })),
    { id: -1, name: "미배정", role: undefined as string | undefined },
  ];
  const columns = memberFilter == null ? allColumns : allColumns.filter((c) => c.id === memberFilter);
  const forColumn = (colId: number) =>
    dayTasks.filter((t) => (colId === -1 ? (t.assignees ?? []).length === 0 : (t.assignees ?? []).some((a: any) => a.id === colId)));

  // 팀원 칸은 태스크가 없어도 항상 표시 → 누가 일이 있고 없는지 한눈에 보임
  return (
    <div className="flex flex-col gap-2">
    {evSplit.common.length > 0 && (
      <div className="flex flex-wrap gap-1.5">{evSplit.common.map((e) => <EventChip key={e.id} e={e} day={key} onPick={onPickEvent} />)}</div>
    )}
    {tasksHidden ? (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">
        할 일 숨김 중 — 일정만 표시하고 있어요
        {/* 팀원 칸이 숨어 hover ➕가 사라지므로 날짜 프리필 진입점을 남김 */}
        <button type="button" onClick={() => onQuickCreate(key)}
          className="rounded-md bg-brand-50 px-2 py-0.5 font-medium text-brand transition hover:bg-brand-100">
          + 이 날짜 일정
        </button>
      </div>
    ) : (
    <HScroll className="pb-2">
    <div className="flex gap-3" onDragEnd={() => { setOver(null); setDragging(false); }}>
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
              setDragging(false);
              const taskId = Number(e.dataTransfer.getData("text/task"));
              const fromCol = Number(e.dataTransfer.getData("text/task-from"));
              // 트레이(날짜 미지정) 드롭도 지원 — fromDay를 페이로드에서 읽어야 날짜 PATCH가 실행됨 (WeekGrid와 동일)
              const fromDay = e.dataTransfer.getData("text/task-day");
              if (!taskId || (fromCol === c.id && fromDay === key)) return;
              onMove({ taskId, fromCol, toCol: c.id, fromDay, toDay: key });
            }}
            className={`group/cell relative flex w-60 flex-shrink-0 flex-col gap-2 rounded-xl transition md:w-72 ${over === c.id ? "bg-indigo-50 ring-2 ring-inset ring-indigo-300" : ""}`}>
            <button onClick={() => onPickMember(memberFilter === c.id ? null : c.id)} title="이 팀원의 할 일만 보기"
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-indigo-50 md:pr-9 ${memberFilter === c.id ? "bg-indigo-50 ring-1 ring-indigo-200" : "bg-slate-100/70"}`}>
              {c.id === -1 ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">?</span> : <Avatar name={c.name} id={c.id} role={c.role} size={24} />}
              <span className="truncate text-sm font-medium text-slate-700">{c.name}</span>
              {c.id === meId && <span className="flex-shrink-0 rounded bg-brand-100 px-1 text-[10px] font-bold text-brand">나</span>}
              <span className={`ml-auto text-xs ${list.length === 0 ? "text-slate-300" : "text-slate-400"}`}>{list.length}</span>
            </button>
            {/* 칸 hover ➕ — 이 날짜·이 팀원 프리필 일정 만들기 (헤더 오른쪽, md:pr-9로 자리 확보) */}
            <button type="button"
              onClick={(e) => { e.stopPropagation(); onQuickCreate(key, c.id !== -1 ? c.id : undefined); }}
              title={`일정 만들기${c.id !== -1 ? ` — ${c.name} 참석` : ""}`}
              className="absolute right-1.5 top-1.5 z-10 hidden h-6 w-6 items-center justify-center rounded-md bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-brand hover:text-white md:group-hover/cell:flex">
              <Plus size={13} />
            </button>
            {/* C8: 이 팀원의 개인·참석 일정 */}
            {(evSplit.byMember.get(c.id) ?? []).map((e: any) => <EventChip key={`ev-${e.id}`} e={e} day={key} onPick={onPickEvent} />)}
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
            {list.length === 0 && !(evSplit.byMember.get(c.id)?.length) && <div className="py-3 text-center text-xs text-slate-300">없음</div>}
          </div>
        );
      })}
    </div>
    </HScroll>
    )}
    </div>
  );
}

/* ---------------- P6 Timeline (Gantt-lite): 기간 바 + 선행 태스크 표시 ----------------
 * S: 배율 2단 — 월(일별·기본): 하루 폭 고정 + 가로 스크롤(막대가 월 경계에서 안 잘림), 일 숫자 눈금·주말 음영.
 *    전체: 프로젝트 기간(설정 시) ∪ 태스크 범위를 화면 폭에 % 배치로 압축(스크롤 없음), 연보라 띠 = 프로젝트 기간.
 *    빈 곳 클릭 시 그 날짜의 월 보기로 점프. */
function TimelineView({ tasks, pid, project }: { tasks: any[]; pid: number; project?: any }) {
  const depsQ = useQuery<{ dependencies: any[] }>({ queryKey: ["deps", pid], queryFn: () => get(`/dependencies?project_id=${pid}`) });
  const deps = depsQ.data?.dependencies ?? [];
  const byId = new Map(tasks.map((t: any) => [t.id, t]));
  // 반려된 티켓은 간트에서 제외(칸반 정책과 일치). 무날짜 태스크는 표시 불가 — 하단에 개수 안내.
  const dated = tasks.filter((t) => (t.scheduled_date || t.due_date) && t.status !== "rejected");
  const undatedCount = tasks.filter((t) => !t.scheduled_date && !t.due_date && t.status !== "rejected").length;

  const DAY = 86400000;
  // 배율 — 선택은 localStorage 기억(캘린더 필터 devflow.cal.filter와 같은 규약)
  const [scale, setScaleState] = useState<"month" | "all">(
    () => (localStorage.getItem("devflow.timeline.scale") as "month" | "all") || "month",
  );
  const setScale = (v: "month" | "all") => { setScaleState(v); localStorage.setItem("devflow.timeline.scale", v); };
  const LABEL_W = 176; // 태스크 이름 고정 열(sticky)
  // 예정일·마감일이 뒤집혀 있어도(과거 데이터) 음수 기간이 나오지 않게 정규화
  const rawS = (t: any) => new Date(toDayKey(t.scheduled_date ?? t.due_date)!).getTime();
  const rawE = (t: any) => new Date(toDayKey(t.due_date ?? t.scheduled_date)!).getTime();
  const startOf = (t: any) => Math.min(rawS(t), rawE(t));
  const endOf = (t: any) => Math.max(rawS(t), rawE(t));
  // 프로젝트 기간(태스크 날짜와 같은 UTC 자정 저장) — 전체 모드의 기준 범위 + 연보라 띠. 역전 저장도 정규화.
  const rawPS = project?.start_date ? new Date(toDayKey(project.start_date)!).getTime() : null;
  const rawPE = project?.end_date ? new Date(toDayKey(project.end_date)!).getTime() : null;
  const [projS, projE] = rawPS != null && rawPE != null && rawPE < rawPS ? [rawPE, rawPS] : [rawPS, rawPE];
  const taskLo = dated.length ? Math.min(...dated.map(startOf)) : null;
  const taskHi = dated.length ? Math.max(...dated.map(endOf)) : null;
  const monthStartOf = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const nextMonthStart = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
  const todayTs = new Date(localDayKey(new Date())).getTime();
  // 범위: 월 = 태스크 범위를 월 경계로 확장(달력 페이지가 깔끔하게 넘어가게) · 전체 = (태스크 ∪ 프로젝트 기간) ±2일
  const lo = [taskLo, ...(scale === "all" ? [projS] : [])].filter((v): v is number => v != null);
  const hi = [taskHi, ...(scale === "all" ? [projE] : [])].filter((v): v is number => v != null);
  const min = scale === "month"
    ? monthStartOf(lo.length ? Math.min(...lo) : todayTs)
    : (lo.length ? Math.min(...lo) - 2 * DAY : 0);
  const max = scale === "month"
    ? nextMonthStart(hi.length ? Math.max(...hi) : todayTs)
    : (hi.length ? Math.max(...hi) + 2 * DAY : DAY);
  const days = Math.round((max - min) / DAY);
  // 월 모드 하루 폭 — 화면(스크롤 컨테이너 가시 폭)에 한 달(31일)이 딱 차게 동적 계산.
  // 최소 28px(일 숫자 가독 하한) — 좁은 화면(모바일)은 자연히 가로 스크롤로 넘어간다.
  const [viewW, setViewW] = useState(0);
  const DAY_W = Math.max(28, Math.floor(((viewW || 1080) - LABEL_W) / 31));
  const trackW = days * DAY_W; // 월 모드 전용 — 전체 모드 트랙은 flex-1
  const xOf = (ts: number) => ((ts - min) / DAY) * DAY_W; // 월: 타임스탬프 → px
  // 위치·폭 — 월: px(고정 배율), 전체: %(컨테이너 폭 맞춤)
  const posL = (ts: number) => (scale === "month" ? xOf(ts) : `${((ts - min) / (max - min)) * 100}%`);
  const posW = (s: number, e: number) => (scale === "month" ? ((e - s) / DAY) * DAY_W : `${((e - s) / (max - min)) * 100}%`);
  const today = todayTs;

  // C4: 일정 마커 — 시간축이 있는 뷰라 일정(회의·마감·행사)을 함께 표시. 훅이라 early return보다 위에.
  const [editingEvent, setEditingEvent] = useState<any | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didScrollRef = useRef(false);
  const jumpTsRef = useRef<number | null>(null); // 전체 모드에서 클릭한 날짜 — 월 전환 후 스크롤 목표
  const allTrackRef = useRef<HTMLDivElement>(null); // 전체 모드 클릭 위치 → 날짜 환산 기준(헤더 트랙)
  // 가시 폭 측정 — 월 모드 "화면 폭 = 한 달" 유지 (리사이즈 포함).
  // window resize 병행 배선: 일부 웹뷰에서 ResizeObserver가 발화하지 않음 (HScroll과 동일 규약)
  useEffect(() => {
    if (scale !== "month") return;
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, [scale, dated.length]);
  // 월 모드 진입 시 오늘(또는 전체 모드에서 클릭한 날짜)이 속한 달의 1일로 스크롤 — 달력 페이지 스냅.
  // viewW 측정 전(=하루 폭 미확정)에는 건너뛰어 최종 배율로 정확히 한 번만 맞춘다.
  useEffect(() => {
    if (scale !== "month" || !scrollRef.current || viewW === 0) return;
    if (jumpTsRef.current != null) {
      scrollRef.current.scrollLeft = Math.max(0, ((monthStartOf(jumpTsRef.current) - min) / DAY) * DAY_W);
      jumpTsRef.current = null;
      didScrollRef.current = true;
      return;
    }
    if (didScrollRef.current || dated.length === 0) return;
    if (today >= min && today <= max) {
      scrollRef.current.scrollLeft = Math.max(0, ((monthStartOf(today) - min) / DAY) * DAY_W);
      didScrollRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, viewW, dated.length, today, min, max]);
  const evFrom = new Date(min).toISOString().slice(0, 10);
  const evTo = new Date(max).toISOString().slice(0, 10);
  const eventsQ = useQuery<{ events: any[] }>({
    queryKey: ["events", pid, "timeline", evFrom, evTo],
    queryFn: () => get(`/events?from=${evFrom}&to=${evTo}`),
    enabled: dated.length > 0 && scale === "month", // 전체 모드는 일정 행 숨김(압축 배율에서 ◆가 뭉개짐)
  });
  const evs = (eventsQ.data?.events ?? []).filter((e) => e.project_id == null || e.project_id === pid);

  if (dated.length === 0)
    return <EmptyState title="날짜가 지정된 태스크가 없어요" desc="매니저가 태스크 상세(또는 캘린더의 날짜 미지정 트레이)에서 예정일/마감일을 지정하면 타임라인에 표시돼요." />;
  const rows = [...dated].sort((a, b) => startOf(a) - startOf(b));
  const barColor: Record<string, string> = { todo: "bg-indigo-400", in_progress: "bg-blue-500", blocked: "bg-amber-500", done: "bg-emerald-500" };

  // 월 세그먼트(두 배율 공통) — 타임스탬프가 UTC 자정이라 UTC getter 사용(F3)
  const monthSegs: { label: string; start: number; end: number }[] = [];
  for (let d = new Date(Date.UTC(new Date(min).getUTCFullYear(), new Date(min).getUTCMonth(), 1)); d.getTime() < max; ) {
    const segStart = Math.max(d.getTime(), min);
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    monthSegs.push({
      label: scale === "month" ? `${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}` : `${d.getUTCMonth() + 1}월`,
      start: segStart,
      end: Math.min(next.getTime(), max),
    });
    d = next;
  }
  // 월 모드: 일 숫자 눈금(토=파랑·일=빨강·오늘=보라 원). 전체 모드는 월 라벨만.
  const dayTicks: { ts: number; n: number; dow: number }[] = [];
  if (scale === "month") for (let ts = min; ts < max; ts += DAY) { const d = new Date(ts); dayTicks.push({ ts, n: d.getUTCDate(), dow: d.getUTCDay() }); }
  // 월 모드 배경: 주말(토+일) 음영 + 하루 눈금선 — 행마다 DOM을 늘리지 않게 반복 그라데이션으로
  const satOffset = ((6 - new Date(min).getUTCDay() + 7) % 7) * DAY_W;
  const gridStyle = scale === "month"
    ? {
        backgroundImage: `repeating-linear-gradient(to right, #f8fafc 0, #f8fafc ${2 * DAY_W}px, transparent ${2 * DAY_W}px, transparent ${7 * DAY_W}px), repeating-linear-gradient(to right, #f1f5f9 0, #f1f5f9 1px, transparent 1px, transparent ${DAY_W}px)`,
        backgroundPosition: `${satOffset}px 0, 0 0`,
      }
    : undefined;

  const todayLine = today >= min && today <= max;
  const hasBand = scale === "all" && (projS != null || projE != null);
  const bandL = projS ?? min;
  const bandR = projE != null ? projE + DAY : max; // 종료일 포함, 한쪽만 설정 시 개방
  // 일부 임베디드 웹뷰가 smooth scrollTo를 조용히 무시함 — HScroll.step과 같은 폴백(120ms 후 미이동 시 즉시 점프)
  const smoothTo = (left: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const from = el.scrollLeft;
    el.scrollTo({ left, behavior: "smooth" });
    window.setTimeout(() => { if (Math.abs(el.scrollLeft - from) < 1 && Math.abs(left - from) >= 1) el.scrollLeft = left; }, 120);
  };
  // 달력처럼 월 1일 단위 스냅 이동 — 화면 폭 = 한 달이라 ◀▶가 곧 "지난달/다음달 페이지"
  const jumpMonth = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const leftTs = min + (el.scrollLeft / DAY_W) * DAY; // 현재 왼쪽 경계의 날짜
    let target = dir === 1 ? nextMonthStart(leftTs) : monthStartOf(leftTs);
    if (dir === -1 && leftTs - target < DAY / 2) target = monthStartOf(target - DAY); // 이미 1일이면 한 달 더 뒤로
    smoothTo(Math.max(0, xOf(target)));
  };
  const scrollToToday = () => smoothTo(Math.max(0, xOf(Math.max(monthStartOf(today), min))));
  // 전체 모드: 빈 곳 클릭 → 그 날짜의 월(일별) 보기로. 막대·라벨(링크)·일정 클릭은 원래 동작 유지.
  const onAllClick = (e: any) => {
    const el = allTrackRef.current;
    if (scale !== "all" || !el) return;
    if ((e.target as HTMLElement).closest("a,button")) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left) return; // 라벨 열은 무시
    jumpTsRef.current = min + Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (max - min);
    setScale("month");
  };

  const projBand = hasBand && (
    <span className="absolute inset-y-0 bg-brand-50/70" style={{ left: posL(bandL), width: posW(bandL, bandR) }} />
  );

  return (
    <div className="flex flex-col gap-2">
      {/* 도구줄 — 배율 탭(프로젝트 목록 '내/전체'와 같은 세그먼트 규약) + 월 모드 전용 이동 버튼 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm">
          <button onClick={() => setScale("month")}
            className={`rounded-lg px-3 py-1.5 transition ${scale === "month" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            월 <span className="max-sm:hidden">(일별)</span>
          </button>
          <button onClick={() => setScale("all")}
            className={`rounded-lg px-3 py-1.5 transition ${scale === "all" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            전체
          </button>
        </div>
        {scale === "month" ? (
          <>
            <Button size="sm" variant="outline" onClick={scrollToToday}>오늘</Button>
            <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => jumpMonth(-1)} aria-label="이전 달"><ChevronLeft size={18} /></button>
            <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => jumpMonth(1)} aria-label="다음 달"><ChevronRight size={18} /></button>
            <span className="text-xs text-slate-400">화면 폭 = 한 달 · 달력처럼 한 달씩 넘김 · 주말 음영</span>
          </>
        ) : (
          <span className="text-xs text-slate-400">프로젝트 전체 기간 한눈에 · 빈 곳을 클릭하면 그 날짜의 월(일별) 보기로</span>
        )}
      </div>

      {(() => {
        const inner = (
          <div style={scale === "month" ? { width: LABEL_W + trackW } : undefined}>
            {/* 날짜 축: 월 = 월 라벨(크게) + 일 숫자 / 전체 = 월 라벨 + 프로젝트 시작·종료 플래그 */}
            <div className="flex border-b border-slate-200">
              <div className={`sticky left-0 z-20 flex flex-shrink-0 items-end border-r border-slate-200 bg-white px-3 pb-1 text-xs font-medium text-slate-400 ${scale === "all" ? "w-44 max-sm:w-28" : ""}`}
                style={scale === "month" ? { width: LABEL_W, height: 46 } : { height: 40 }}>태스크</div>
              <div ref={allTrackRef} className={`relative ${scale === "all" ? "min-w-0 flex-1" : ""}`} style={scale === "month" ? { width: trackW, height: 46 } : { height: 40 }}>
                {projBand}
                {monthSegs.map((m, i) => (
                  <div key={i} className="absolute top-0 h-full overflow-hidden border-l border-slate-200" style={{ left: posL(m.start), width: posW(m.start, m.end) }}>
                    {scale === "month"
                      ? <span className="whitespace-nowrap px-1.5 pt-1 text-[13px] font-bold text-slate-700">{m.label}</span>
                      : <span className="block whitespace-nowrap px-1.5 pt-[21px] text-[11px] font-semibold text-slate-500">{m.label}</span>}
                  </div>
                ))}
                {scale === "month" && dayTicks.map((d) => (
                  <span key={d.ts}
                    className={`absolute bottom-1 -translate-x-1/2 text-[10.5px] ${d.ts === today ? "z-10 rounded-full bg-brand px-1 font-bold text-white" : d.dow === 0 ? "text-rose-400" : d.dow === 6 ? "text-blue-400" : "text-slate-400"}`}
                    style={{ left: xOf(d.ts) + DAY_W / 2 }}>{d.n}</span>
                ))}
                {scale === "all" && projS != null && (
                  <span className="absolute top-1 z-10 whitespace-nowrap rounded-md border border-brand-200 bg-white px-1 text-[10px] font-semibold text-brand" style={{ left: posL(projS) }}>시작 {fmtDate(new Date(projS).toISOString())}</span>
                )}
                {scale === "all" && projE != null && (
                  <span className="absolute top-1 z-10 -translate-x-full whitespace-nowrap rounded-md border border-brand-200 bg-white px-1 text-[10px] font-semibold text-brand" style={{ left: posL(projE + DAY) }}>종료 {fmtDate(new Date(projE).toISOString())}</span>
                )}
                {todayLine && <span className="absolute top-0 z-10 h-full w-0.5 bg-brand" style={{ left: posL(today) }} title="오늘" />}
              </div>
            </div>
            {/* C4: 일정 행(월 모드 전용) — ◆(하루)·막대(멀티데이), 클릭하면 수정 모달 */}
            {scale === "month" && evs.length > 0 && (
              <div className="flex border-b border-emerald-100/70 bg-emerald-50/30">
                <div className="sticky left-0 z-20 flex flex-shrink-0 items-center gap-1 border-r border-slate-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700" style={{ width: LABEL_W }}>
                  <Clock size={11} /> 일정 {evs.length}
                </div>
                <div className="relative h-7" style={{ width: trackW, ...gridStyle }}>
                  {todayLine && <span className="absolute top-0 h-full w-0.5 bg-brand/25" style={{ left: xOf(today) }} />}
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
                        style={{ left: xOf(Math.max(s, min)), width: Math.max(((Math.min(en, max) - Math.max(s, min)) / DAY) * DAY_W, 16) }}>
                        {e.title}
                      </button>
                    ) : (
                      <button key={e.id} onClick={() => setEditingEvent(e)} title={label}
                        className="absolute top-0.5 -translate-x-1/2 text-sm leading-6 text-emerald-500 transition hover:scale-125 hover:text-emerald-600"
                        style={{ left: Math.min(Math.max(xOf(s + DAY / 2), 0), trackW) }}>
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
                <div key={t.id} className="flex items-stretch border-b border-slate-50 last:border-b-0">
                  <Link href={`/projects/${pid}/tasks/${t.item_key}`}
                    className={`sticky left-0 z-20 flex flex-shrink-0 items-center truncate border-r border-slate-200 bg-white px-3 transition hover:bg-slate-50 ${scale === "all" ? "w-44 py-1 max-sm:w-28" : "py-1.5"}`}
                    style={scale === "month" ? { width: LABEL_W } : undefined}>
                    {scale === "month" ? (
                      <span className="min-w-0 truncate">
                        <span className="mr-1.5 font-mono text-xs text-slate-400">{t.item_key}</span>
                        {(t.assignees ?? []).slice(0, 3).map((a: any) => <NameChip key={a.id} name={a.full_name ?? a.email} id={a.id} className="mr-1" />)}
                        <span className={`text-sm font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-700"}`}>{t.title}</span>
                        {myDeps.length > 0 && (
                          <span className="ml-1.5 text-[11px] text-amber-600" title="선행 태스크">← {myDeps.map((d: any) => d.item_key).join(", ")}</span>
                        )}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate text-xs">
                        <span className="mr-1 font-mono text-[10px] text-slate-400">{t.item_key}</span>
                        <span className={`font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-600"}`}>{t.title}</span>
                      </span>
                    )}
                  </Link>
                  <div className={`relative ${scale === "all" ? "h-6 min-w-0 flex-1" : "h-8 hover:bg-slate-50/60"}`} style={scale === "month" ? { width: trackW, ...gridStyle } : undefined}>
                    {projBand}
                    {todayLine && <span className="absolute top-0 h-full w-0.5 bg-brand/25" style={{ left: posL(today) }} />}
                    {scale === "month" ? (
                      <Link href={`/projects/${pid}/tasks/${t.item_key}`}
                        className={`absolute top-1.5 flex h-5 items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-1 text-[11px] font-medium text-white transition hover:opacity-80 ${barColor[t.status] ?? STATUS_DOT[t.status] ?? "bg-slate-300"}`}
                        style={{ left: xOf(s), width: Math.max(((e - s) / DAY) * DAY_W, 8) }}
                        title={`${t.title} (${STATUS_LABEL[t.status]}) — ${(t.assignees ?? []).map((a: any) => a.full_name ?? a.email).join(", ") || "미배정"}`}>
                        {(t.assignees ?? []).slice(0, 3).map((a: any) => <NameChip key={a.id} name={a.full_name ?? a.email} id={a.id} />)}
                      </Link>
                    ) : (
                      <Link href={`/projects/${pid}/tasks/${t.item_key}`}
                        className={`absolute top-[7px] block h-2.5 rounded-full transition hover:opacity-80 ${barColor[t.status] ?? STATUS_DOT[t.status] ?? "bg-slate-300"}`}
                        style={{ left: posL(s), width: posW(s, e), minWidth: 6 }}
                        title={`${t.title} (${STATUS_LABEL[t.status]}) — ${(t.assignees ?? []).map((a: any) => a.full_name ?? a.email).join(", ") || "미배정"}`} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
        return scale === "month" ? (
          <HScroll scrollRef={scrollRef} className="rounded-xl border border-slate-200 bg-white">{inner}</HScroll>
        ) : (
          <div className="cursor-zoom-in rounded-xl border border-slate-200 bg-white" onClick={onAllClick}>{inner}</div>
        );
      })()}
      <div className="px-1 text-xs text-slate-400">
        {scale === "month" ? (
          <>
            ←KEY = 선행 태스크 (태스크 상세에서 지정) · 보라 세로선 = 오늘
            {evs.length > 0 && <span className="ml-2 text-emerald-600">· ◆/초록 막대 = 일정 (클릭해 수정)</span>}
          </>
        ) : (
          <>보라 세로선 = 오늘{hasBand ? " · 연보라 띠 = 프로젝트 기간" : " · 프로젝트 기간이 아직 없어 태스크 범위만 표시해요 (프로젝트명 아래에서 설정)"}</>
        )}
        {undatedCount > 0 && <span className="ml-2 text-amber-500">· 날짜 미지정 {undatedCount}건은 표시되지 않아요 (캘린더 상단 트레이에서 배치)</span>}
      </div>
      <EventModal open={!!editingEvent} onClose={() => setEditingEvent(null)} event={editingEvent} />
    </div>
  );
}
