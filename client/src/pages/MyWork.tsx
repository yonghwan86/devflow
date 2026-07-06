import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, Clock, Lightbulb, Bell, Circle, Users, List, Columns3, AlertTriangle } from "lucide-react";
import { get, patch } from "../lib/api";
import { Card, Badge, Button, EmptyState, AvatarGroup, toast, SkeletonList } from "../components/ui";
import { STATUS_COLOR, STATUS_LABEL, STATUS_DOT, fmtDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { enablePush } from "../hooks/usePush";
import { KanbanBoard } from "../components/KanbanBoard";
import { EventStrip } from "../components/EventStrip";

interface MW {
  today: any[]; team_today: any[]; due_soon: any[]; pending_guides: any[];
  board_tasks: any[];
  summary: { status_counts: Record<string, number>; today_due: number; overdue: number; completed_this_week: number[] };
}

// F2: 상단 시각화 스트립 — 상태 카운트 칩 + 오늘 마감/지연 + 이번 주 완료 미니 바 (순수 CSS, 한 줄 수준)
function SummaryStrip({ s }: { s: MW["summary"] }) {
  const order = ["requested", "todo", "in_progress", "blocked", "done", "rejected"];
  const max = Math.max(1, ...s.completed_this_week);
  const dayLabels = ["월", "화", "수", "목", "금", "토", "일"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {order.filter((k) => (s.status_counts[k] ?? 0) > 0).map((k) => (
          <span key={k} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${STATUS_COLOR[k]}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[k]}`} /> {STATUS_LABEL[k]} {s.status_counts[k]}
          </span>
        ))}
      </div>
      <span className="text-slate-300">|</span>
      <span className={s.today_due > 0 ? "font-semibold text-amber-600" : "text-slate-400"}>오늘 마감 {s.today_due}</span>
      <span className={`inline-flex items-center gap-1 ${s.overdue > 0 ? "font-semibold text-rose-600" : "text-slate-400"}`}>
        {s.overdue > 0 && <AlertTriangle size={12} />} 지연 {s.overdue}
      </span>
      <span className="text-slate-300">|</span>
      <span className="inline-flex items-end gap-1 text-slate-400" title="이번 주 완료 (월~일)">
        완료
        <span className="flex items-end gap-0.5">
          {s.completed_this_week.map((n, i) => (
            <span key={i} className="flex flex-col items-center gap-0.5">
              <span className={`w-2 rounded-sm ${n > 0 ? "bg-emerald-400" : "bg-slate-100"}`}
                style={{ height: `${4 + (n / max) * 14}px` }} title={`${dayLabels[i]} ${n}건`} />
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

function TaskRow({ t, noComplete }: { t: any; noComplete?: boolean }) {
  const complete = useMutation({
    mutationFn: () => patch(`/tasks/${t.id}`, { status: "done" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-work"] }),
    onError: (e: any) => toast(`처리 실패: ${e.message}`),
  });
  return (
    <Card className="flex items-center gap-3 py-3">
      {!noComplete && (
      <button onClick={() => complete.mutate()} disabled={complete.isPending} title="완료 처리"
        className="text-slate-300 transition hover:text-emerald-500">
        <Circle size={22} />
      </button>
      )}
      <Link href={`/projects/${t.project_id}/tasks/${t.item_key}`} className="min-w-0 flex-1">
        <div className="truncate font-medium text-slate-800">{t.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
          <span className="font-mono">{t.item_key}</span>
          {t.project_name && <span>· {t.project_name}</span>}
          {t.due_date && <span className="text-amber-600">· 마감 {fmtDate(t.due_date)}</span>}
        </div>
      </Link>
      <Badge className={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
    </Card>
  );
}

// 팀원 오늘 할 일 — 크로스 체킹용. 클릭해서 들어가면 댓글/가이드를 남길 수 있다.
function TeamRow({ t }: { t: any }) {
  const names: string[] = (t.assignees ?? []).map((a: any) => a.full_name ?? a.email);
  return (
    <Card className="flex items-center gap-3 py-3">
      <AvatarGroup names={names.length ? names : ["?"]} size={24} />
      <Link href={`/projects/${t.project_id}/tasks/${t.item_key}`} className="min-w-0 flex-1">
        <div className="truncate font-medium text-slate-800">{t.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
          <span className="font-mono">{t.item_key}</span>
          {t.project_name && <span>· {t.project_name}</span>}
          {names.length > 0 && <span>· {names.join(", ")}</span>}
          {names.length === 0 && <span>· 미배정</span>}
        </div>
      </Link>
      <Badge className={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
    </Card>
  );
}

function Section({ icon, title, count, tint, children }: any) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-md ${tint}`}>{icon}</span>
        <h2 className="font-semibold text-slate-700">{title}</h2>
        <span className="text-sm text-slate-400">{count}</span>
      </div>
      {children}
    </section>
  );
}

// F2: 칸반 컬럼 — 요청됨(내 요청)/할 일/진행 중/막힘/완료(7일)/반려됨
const MW_COLUMNS = [
  { id: "requested", label: "요청됨 (내 요청)", droppable: false },
  { id: "todo", droppable: true },
  { id: "in_progress", droppable: true },
  { id: "blocked", droppable: true },
  { id: "done", label: "완료 (7일)", droppable: true },
  { id: "rejected", droppable: false },
];

export default function MyWork() {
  const { data, isLoading, isError } = useQuery<MW>({ queryKey: ["my-work"], queryFn: () => get("/my-work") });
  // 리스트/칸반 토글 — 기본 리스트(기존 UX 유지), 선택은 localStorage 기억
  const [mwView, setMwView] = useState<"list" | "board">(
    () => (localStorage.getItem("devflow.mywork.view") as "list" | "board") || "list",
  );
  const pickView = (v: "list" | "board") => { setMwView(v); localStorage.setItem("devflow.mywork.view", v); };
  const moveStatus = useMutation({
    mutationFn: (v: { id: number; status: string }) => patch(`/tasks/${v.id}`, { status: v.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-work"] }),
    onError: (e: any) => toast(`변경 실패: ${e.message}`),
  });

  if (isLoading) return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Work</h1>
      </div>
      <SkeletonList count={3} lines={1} />
    </div>
  );
  if (isError || !data) return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Work</h1>
      <div className="py-16 text-center text-sm text-slate-400">할 일을 불러오지 못했어요. 잠시 후 다시 시도해주세요.</div>
    </div>
  );
  const mw = data;
  const teamToday = mw.team_today ?? [];
  const board = mw.board_tasks ?? [];
  // 리스트 모드 보강: 칸반 데이터(board_tasks)에서 파생 — 서버 변경 불필요
  const undated = board.filter((t) => !t.scheduled_date && !t.due_date && !["requested", "rejected", "done"].includes(t.status));
  const rejectedMine = board.filter((t) => t.status === "rejected");
  const empty = mw.today.length === 0 && teamToday.length === 0 && mw.pending_guides.length === 0 && mw.due_soon.length === 0 && board.length === 0;
  // 반려/요청 컬럼은 해당 건이 없으면 숨김
  const columns = MW_COLUMNS.filter((c) =>
    (c.id !== "requested" && c.id !== "rejected") || board.some((t) => t.status === c.id));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Work</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            <button onClick={() => pickView("list")}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 ${mwView === "list" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              <List size={14} /> 리스트
            </button>
            <button onClick={() => pickView("board")}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 ${mwView === "board" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              <Columns3 size={14} /> 칸반
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => enablePush().then((ok) => toast(ok ? "알림이 켜졌습니다." : "알림을 켜려면 HTTPS(터널) 접속이 필요합니다."))}>
            <Bell size={15} /> 알림 켜기
          </Button>
        </div>
      </div>

      {/* F5: 오늘 내 일정(개인 + 참석 프로젝트 일정) 시간순 */}
      <EventStrip />

      {mw.summary && board.length > 0 && <SummaryStrip s={mw.summary} />}

      {mwView === "board" && !empty ? (
        <KanbanBoard
          tasks={board}
          columns={columns}
          // 서버가 최종 판단(F1 규칙) — UI에선 requested/rejected만 잠금
          canDrag={(t) => t.status !== "requested" && t.status !== "rejected"}
          onDrop={(id, status) => moveStatus.mutate({ id, status })}
          pidFor={(t) => t.project_id}
          requesterName={(t) => (t.kind === "ticket" ? "나" : null)}
        />
      ) : empty ? (
        <EmptyState icon={<CheckCircle2 size={22} />} title="오늘은 배정된 일이 없어요"
          desc="내 담당 태스크와 우리 팀의 오늘 할 일이 여기에 모여요. 프로젝트에서 태스크에 오늘 예정일과 담당자를 지정해보세요." />
      ) : (
        <>
          <Section icon={<CheckCircle2 size={15} className="text-emerald-600" />} title="오늘 내 할 일" count={mw.today.length} tint="bg-emerald-50">
            {mw.today.length ? <div className="stagger-children flex flex-col gap-2">{mw.today.map((t) => <TaskRow key={t.id} t={t} />)}</div>
              : <div className="text-sm text-slate-400">오늘 내게 배정된 할 일이 없습니다.</div>}
          </Section>

          {teamToday.length > 0 && (
            <Section icon={<Users size={15} className="text-indigo-600" />} title="팀원 오늘 할 일" count={teamToday.length} tint="bg-indigo-50">
              <div className="flex flex-col gap-2">{teamToday.map((t) => <TeamRow key={t.id} t={t} />)}</div>
            </Section>
          )}

          {mw.pending_guides.length > 0 && (
            <Section icon={<Lightbulb size={15} className="text-amber-600" />} title="미수행 가이드" count={mw.pending_guides.length} tint="bg-amber-50">
              <div className="flex flex-col gap-2">
                {mw.pending_guides.map((g) => (
                  <Link key={g.guide_id} href={`/projects/${g.project_id}/tasks/${g.item_key}`}>
                    <Card className="border-amber-100 bg-amber-50/40 transition hover:border-amber-200">
                      <div className="text-xs text-slate-400"><span className="font-mono">{g.item_key}</span> · {g.task_title}</div>
                      <div className="mt-1 line-clamp-2 text-sm text-slate-700">{g.body}</div>
                    </Card>
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {mw.due_soon.length > 0 && (
            <Section icon={<Clock size={15} className="text-rose-600" />} title="마감 임박" count={mw.due_soon.length} tint="bg-rose-50">
              <div className="flex flex-col gap-2">{mw.due_soon.map((t) => <TaskRow key={t.id} t={t} />)}</div>
            </Section>
          )}

          {/* C4: 날짜 미지정 배정 태스크 — today(오늘)·due_soon(마감) 어디에도 안 잡혀 증발하던 것 */}
          {undated.length > 0 && (
            <Section icon={<Circle size={15} className="text-slate-500" />} title="날짜 미지정 내 할 일" count={undated.length} tint="bg-slate-100">
              <div className="flex flex-col gap-2">{undated.map((t) => <TaskRow key={t.id} t={t} />)}</div>
              <div className="mt-1.5 text-xs text-slate-400">프로젝트 캘린더의 "날짜 미지정" 트레이에서 끌어 예정일을 잡을 수 있어요.</div>
            </Section>
          )}

          {/* C4: 반려된 내 요청 — 리스트 모드에서도 반려 여부를 알 수 있게 (칸반에는 반려 컬럼 존재) */}
          {rejectedMine.length > 0 && (
            <Section icon={<AlertTriangle size={15} className="text-rose-600" />} title="반려된 내 요청" count={rejectedMine.length} tint="bg-rose-50">
              <div className="flex flex-col gap-2">{rejectedMine.map((t) => <TaskRow key={t.id} t={t} noComplete />)}</div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
