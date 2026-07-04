import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Users, Plus, List, Columns3, Calendar as CalIcon, ChevronLeft, ChevronRight, CalendarRange, MonitorPlay, NotebookPen } from "lucide-react";
import { get, post, patch } from "../lib/api";
import { Card, Badge, Button, Input, EmptyState, Spinner, Avatar, toast } from "../components/ui";
import { TaskCard } from "../components/TaskCard";
import { STATUS_LABEL, STATUS_DOT, toDayKey } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { setActiveProject, clearActiveProject } from "../lib/activeProject";

type View = "list" | "kanban" | "calendar" | "timeline";
type CalMode = "month" | "week" | "day";
const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
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
  // 미니 달력에서 넘어온 ?view=calendar&date=YYYY-MM-DD 초기값
  const urlParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const initialDate = urlParams.get("date");
  const [view, setView] = useState<View>((urlParams.get("view") as View) || "calendar"); // 캘린더(주간)가 기본 뷰
  const [title, setTitle] = useState("");
  const [memberFilter, setMemberFilter] = useState<number | null>(null);

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

  const create = useMutation({
    // 기본값: 오늘 예정일 = 오늘 (생성 즉시 캘린더·My Work에 잡히도록)
    mutationFn: () => post(`/projects/${pid}/tasks`, { title, scheduled_date: new Date(localDayKey(new Date())).toISOString() }),
    onSuccess: () => { setTitle(""); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); },
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
  const openCount = (uid: number | -1) =>
    tasks.filter((t) => t.status !== "done" && matchMember(t, uid)).length;
  const unassignedCount = openCount(-1);

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
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-brand bg-indigo-50 font-semibold text-brand" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{proj.data?.project.key ?? "…"}</span>
            {isCompleted && <Badge className="bg-emerald-100 text-emerald-700">완료됨</Badge>}
            {(myWorkQ.data?.today?.length ?? 0) > 0 && (
              <Link href="/my-work"><Badge className="bg-emerald-100 text-emerald-700 transition hover:bg-emerald-200">✓ 오늘 내 할 일 {myWorkQ.data!.today.length}</Badge></Link>
            )}
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-800">{proj.data?.project.name ?? "…"}</h1>
        </div>
        <div className="flex gap-2">
          <Link href={`/projects/${pid}/meetings`}><Button variant="outline" size="sm"><NotebookPen size={15} /> 회의록</Button></Link>
          <Link href={`/projects/${pid}/preview`}><Button variant="outline" size="sm"><MonitorPlay size={15} /> 프리뷰</Button></Link>
          <Link href={`/projects/${pid}/members`}><Button variant="outline" size="sm"><Users size={15} /> 팀원 {members.length > 0 && `(${members.length})`}</Button></Link>
          {canManage && !isCompleted && (
            <Button variant="outline" size="sm" onClick={() => { if (confirm("프로젝트를 완료하고 노하우를 추출할까요?")) complete.mutate(); }}>완료 · 추출</Button>
          )}
        </div>
      </div>

      {canManage && !isCompleted && (
        <div className="flex gap-2">
          <Input placeholder="새 태스크 제목을 입력하고 Enter" value={title}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && title) create.mutate(); }} />
          <Button onClick={() => title && create.mutate()} disabled={create.isPending}><Plus size={16} /> 추가</Button>
        </div>
      )}

      {/* ★ 팀원별 한눈에 보기 + 필터: 각 팀원의 남은 할 일 수가 보이고, 누르면 그 팀원 할 일만 표시 */}
      {members.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={chip(memberFilter == null)} onClick={() => setMemberFilter(null)}>
            전체 <span className="text-[11px] opacity-70">{tasks.filter((t) => t.status !== "done").length}</span>
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
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition ${view === v.id ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              <Icon size={15} /> {v.label}
            </button>
          );
        })}
      </div>

      {tasksQ.isLoading ? <div className="py-16"><Spinner /></div>
        : tasks.length === 0 ? (
          <EmptyState icon={<Plus size={22} />} title="아직 태스크가 없어요"
            desc={canManage ? "위 입력창에 제목을 적고 추가하면 리스트·칸반·캘린더에서 함께 볼 수 있어요." : "매니저가 태스크를 배정하면 여기에 표시돼요."} />
        )
        : view === "list" ? <ListView tasks={filtered} pid={pid} />
        : view === "kanban" ? <KanbanView tasks={filtered} pid={pid} onMove={(id, status) => setStatus.mutate({ id, status })} canManage={canManage} />
        : view === "timeline" ? <TimelineView tasks={filtered} pid={pid} />
        : <CalendarView tasks={filtered} allTasks={tasks} pid={pid} members={members} memberFilter={memberFilter} onPickMember={(id) => setMemberFilter(id)} initialDate={initialDate} />}
    </div>
  );
}

/* ---------------- List (grouped by status) ---------------- */
function ListView({ tasks, pid }: { tasks: any[]; pid: number }) {
  if (tasks.length === 0) return <div className="py-8 text-center text-sm text-slate-400">이 팀원에게 배정된 태스크가 없어요.</div>;
  return (
    <div className="flex flex-col gap-5">
      {STATUSES.map((s) => {
        const group = tasks.filter((t) => t.status === s);
        if (group.length === 0) return null;
        return (
          <div key={s}>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
              <span className="text-slate-400">{group.length}</span>
            </div>
            <div className="flex flex-col gap-2">{group.map((t) => <TaskCard key={t.id} t={t} pid={pid} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Kanban (drag & drop) ---------------- */
function KanbanView({ tasks, pid, onMove, canManage }: { tasks: any[]; pid: number; onMove: (id: number, status: string) => void; canManage: boolean }) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STATUSES.map((s) => {
        const group = tasks.filter((t) => t.status === s);
        return (
          <div key={s}
            onDragOver={(e) => { if (canManage) { e.preventDefault(); setOver(s); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { setOver(null); const id = Number(e.dataTransfer.getData("text/task")); if (id) onMove(id, s); }}
            className={`flex flex-col gap-2 rounded-xl p-2 transition ${over === s ? "bg-indigo-50 ring-2 ring-indigo-200" : "bg-slate-100/60"}`}>
            <div className="flex items-center gap-2 px-1 py-1 text-sm font-semibold text-slate-600">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} /> {STATUS_LABEL[s]}
              <span className="text-slate-400">{group.length}</span>
            </div>
            {group.map((t) => (
              <TaskCard key={t.id} t={t} pid={pid} compact draggable={canManage}
                onDragStart={(e) => e.dataTransfer.setData("text/task", String(t.id))} />
            ))}
            {group.length === 0 && <div className="px-1 py-4 text-center text-xs text-slate-300">비어 있음</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Calendar: week workload grid (기본) + month + per-member day ---------------- */
function CalendarView({ tasks, allTasks, pid, members, memberFilter, onPickMember, initialDate }: {
  tasks: any[]; allTasks: any[]; pid: number; members: any[]; memberFilter: number | null; onPickMember: (id: number | null) => void;
  initialDate?: string | null;
}) {
  // 미니 달력에서 특정 날짜로 진입하면 일 뷰 + 그 날짜로 시작
  const [mode, setMode] = useState<CalMode>(initialDate ? "day" : "week"); // ★ 기본: 주간 팀원별 워크로드
  const [cursor, setCursor] = useState(initialDate ? new Date(initialDate) : new Date());

  const dayOf = (t: any) => toDayKey(t.scheduled_date ?? t.due_date);
  const tasksByDay = new Map<string, any[]>();
  for (const t of tasks) { const k = dayOf(t); if (!k) continue; if (!tasksByDay.has(k)) tasksByDay.set(k, []); tasksByDay.get(k)!.push(t); }

  const weekStart = startOfWeek(cursor);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
  const headTitle =
    mode === "month" ? `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`
    : mode === "week" ? `${weekStart.getMonth() + 1}.${weekStart.getDate()} ~ ${weekEnd.getMonth() + 1}.${weekEnd.getDate()}`
    : cursor.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(["week", "month", "day"] as CalMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 ${mode === m ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              {m === "month" ? "월" : m === "week" ? "주" : "일"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, -1))}><ChevronLeft size={18} /></button>
          <div className="min-w-[8rem] text-center text-sm font-semibold text-slate-700">{headTitle}</div>
          <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setCursor((d) => shift(d, mode, 1))}><ChevronRight size={18} /></button>
          <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>오늘</Button>
        </div>
      </div>

      {mode === "month"
        ? <MonthGrid cursor={cursor} tasksByDay={tasksByDay} pid={pid} onPickDay={(d) => { setCursor(d); setMode("day"); }} />
        : mode === "week"
        ? <WeekGrid cursor={cursor} tasks={allTasks} members={members} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} onPickDay={(d) => { setCursor(d); setMode("day"); }} />
        : <DayView cursor={cursor} tasks={tasks} members={members} pid={pid} dayOf={dayOf} memberFilter={memberFilter} onPickMember={onPickMember} />}
    </div>
  );
}

function shift(d: Date, mode: CalMode, dir: number): Date {
  const n = new Date(d);
  if (mode === "month") n.setMonth(n.getMonth() + dir);
  else if (mode === "week") n.setDate(n.getDate() + dir * 7);
  else n.setDate(n.getDate() + dir);
  return n;
}
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d: Date): Date {
  const n = new Date(d);
  n.setDate(n.getDate() - n.getDay()); // back to Sunday
  return n;
}

/* ---------------- ★ Week workload grid: 열=팀원, 행=요일(일~토) — 누가 어떤 주에 무슨 일이 있는지 한눈에 ---------------- */
function WeekGrid({ cursor, tasks, members, pid, dayOf, memberFilter, onPickMember, onPickDay }: {
  cursor: Date; tasks: any[]; members: any[]; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void; onPickDay: (d: Date) => void;
}) {
  const start = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const dayKeys = days.map(localDayKey);
  const todayKey = localDayKey(new Date());

  const cols = [
    ...members.map((m) => ({ id: m.user.id as number, name: (m.user.full_name ?? m.user.email) as string })),
    { id: -1, name: "미배정" },
  ];
  const cellTasks = (colId: number, dayKey: string) =>
    tasks.filter((t) =>
      dayOf(t) === dayKey &&
      (colId === -1 ? (t.assignees ?? []).length === 0 : (t.assignees ?? []).some((a: any) => a.id === colId)));
  const weekCount = (colId: number) => dayKeys.reduce((n, k) => n + cellTasks(colId, k).length, 0);
  const visible = cols.filter((c) => (c.id === -1 ? weekCount(-1) > 0 : true)); // 팀원은 일이 없어도 항상 표시

  const grid = { display: "grid", gridTemplateColumns: `7rem repeat(${visible.length}, minmax(16rem, 1fr))` } as const;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/70">
      <div style={{ minWidth: `${7 + visible.length * 16}rem` }}>
        {/* 팀원 헤더 (클릭 → 그 팀원만 필터) */}
        <div style={grid} className="border-b border-slate-200 bg-white">
          <div className="flex items-center px-2 py-2 text-xs font-medium text-slate-400">요일 / 팀원</div>
          {visible.map((c) => {
            const total = weekCount(c.id);
            return (
              <button key={c.id} onClick={() => onPickMember(memberFilter === c.id ? null : c.id)} title="이 팀원의 할 일만 보기"
                className={`flex items-center justify-center gap-1.5 border-l border-slate-100 px-2 py-2 transition hover:bg-indigo-50/50 ${memberFilter === c.id ? "bg-indigo-50/70" : ""}`}>
                {c.id === -1
                  ? <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm text-slate-500">?</span>
                  : <Avatar name={c.name} size={28} />}
                <span className="min-w-0 truncate text-[15px] font-semibold text-slate-700">{c.name}</span>
                <span className={`rounded-full px-1.5 text-sm ${total === 0 ? "text-slate-300" : "bg-indigo-50 font-medium text-brand"}`}>{total}</span>
              </button>
            );
          })}
        </div>

        {/* 요일 행 (일~토, 요일 클릭 → 그 날짜의 일 뷰) */}
        {days.map((d, i) => {
          const k = dayKeys[i];
          const isToday = k === todayKey;
          return (
            <div key={i} style={grid} className={`border-b border-slate-200/70 last:border-b-0 ${isToday ? "bg-indigo-50/40" : ""}`}>
              <button onClick={() => onPickDay(d)} title="이 날짜의 일 뷰 보기"
                className={`flex flex-col items-start justify-center px-3 py-2 text-left transition hover:bg-slate-100/60 ${isToday ? "font-bold text-brand" : i === 0 ? "text-rose-400" : i === 6 ? "text-sky-400" : "text-slate-500"}`}>
                <span className="text-[13px]">{WEEKDAYS[i]}요일</span>
                <span className="text-lg font-bold">{d.getMonth() + 1}.{d.getDate()}</span>
                {isToday && <span className="mt-0.5 rounded bg-brand px-1.5 py-0.5 text-[11px] font-medium text-white">오늘</span>}
              </button>
              {visible.map((c) => {
                const list = cellTasks(c.id, k);
                // ★ 일 뷰와 동일한 카드형 태스크 표시
                return (
                  <div key={c.id} className="flex min-h-[76px] flex-col gap-2 border-l border-slate-200/60 p-2">
                    {list.map((t) => <TaskCard key={t.id} t={t} pid={pid} compact />)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthGrid({ cursor, tasksByDay, pid, onPickDay }: { cursor: Date; tasksByDay: Map<string, any[]>; pid: number; onPickDay: (d: Date) => void }) {
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
              className={`flex min-h-[96px] flex-col gap-1 border-b border-r border-slate-100 p-1.5 text-left transition hover:bg-slate-50 md:min-h-[110px] ${!inMonth ? "bg-slate-50/50" : ""}`}>
              <span className={`text-[13px] ${key === todayKey ? "flex h-6 w-6 items-center justify-center rounded-full bg-brand font-semibold text-white" : inMonth ? "text-slate-600" : "text-slate-300"}`}>{d.getDate()}</span>
              <div className="flex flex-col gap-0.5">
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

function DayView({ cursor, tasks, members, pid, dayOf, memberFilter, onPickMember }: {
  cursor: Date; tasks: any[]; members: any[]; pid: number; dayOf: (t: any) => string | null;
  memberFilter: number | null; onPickMember: (id: number | null) => void;
}) {
  const key = localDayKey(cursor);
  const dayTasks = tasks.filter((t) => dayOf(t) === key);
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
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((c) => {
        const list = forColumn(c.id);
        if (c.id === -1 && list.length === 0 && memberFilter == null) return null;
        return (
          <div key={c.id} className="flex w-60 flex-shrink-0 flex-col gap-2 md:w-72">
            <button onClick={() => onPickMember(memberFilter === c.id ? null : c.id)} title="이 팀원의 할 일만 보기"
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-indigo-50 ${memberFilter === c.id ? "bg-indigo-50 ring-1 ring-indigo-200" : "bg-slate-100/70"}`}>
              {c.id === -1 ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">?</span> : <Avatar name={c.name} size={24} />}
              <span className="truncate text-sm font-medium text-slate-700">{c.name}</span>
              <span className={`ml-auto text-xs ${list.length === 0 ? "text-slate-300" : "text-slate-400"}`}>{list.length}</span>
            </button>
            {list.map((t) => <TaskCard key={t.id} t={t} pid={pid} compact />)}
            {list.length === 0 && <div className="py-3 text-center text-xs text-slate-300">없음</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- P6 Timeline (Gantt-lite): 기간 바 + 선행 태스크 표시 ---------------- */
function TimelineView({ tasks, pid }: { tasks: any[]; pid: number }) {
  const depsQ = useQuery<{ dependencies: any[] }>({ queryKey: ["deps", pid], queryFn: () => get(`/dependencies?project_id=${pid}`) });
  const deps = depsQ.data?.dependencies ?? [];
  const byId = new Map(tasks.map((t: any) => [t.id, t]));
  const dated = tasks.filter((t) => t.scheduled_date || t.due_date);
  if (dated.length === 0)
    return <EmptyState title="날짜가 지정된 태스크가 없어요" desc="태스크 상세에서 오늘 예정일/마감일을 지정하면 타임라인에 표시돼요." />;

  const DAY = 86400000;
  const startOf = (t: any) => new Date(toDayKey(t.scheduled_date ?? t.due_date)!).getTime();
  const endOf = (t: any) => new Date(toDayKey(t.due_date ?? t.scheduled_date)!).getTime();
  const min = Math.min(...dated.map(startOf)) - DAY;
  const max = Math.max(...dated.map(endOf)) + 2 * DAY;
  const range = max - min;
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
                {new Date(ts).getMonth() + 1}.{new Date(ts).getDate()}
              </span>
            ))}
            {today >= min && today <= max && <span className="absolute top-0 h-full w-0.5 bg-brand/60" style={{ left: `${pct(today)}%` }} title="오늘" />}
          </div>
        </div>
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
                  className={`absolute top-1 flex h-5 items-center overflow-hidden whitespace-nowrap rounded-full px-2 text-[11px] font-medium text-white transition hover:opacity-80 ${barColor[t.status]}`}
                  style={{ left: `${pct(s)}%`, width: `${Math.max(((e - s) / range) * 100, 2.5)}%` }}
                  title={`${t.title} (${STATUS_LABEL[t.status]})`}>
                  {(t.assignees ?? []).slice(0, 2).map((a: any) => a.full_name ?? a.email).join(", ")}
                </Link>
              </div>
            </div>
          );
        })}
        <div className="px-3 py-2 text-xs text-slate-400">←KEY = 선행 태스크 (태스크 상세에서 지정) · 세로선 = 오늘</div>
      </div>
    </div>
  );
}
