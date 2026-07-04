import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, Clock, Lightbulb, Bell, Circle, Users } from "lucide-react";
import { get, patch } from "../lib/api";
import { Card, Badge, Button, EmptyState, Spinner, AvatarGroup, toast } from "../components/ui";
import { STATUS_COLOR, STATUS_LABEL, fmtDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { enablePush } from "../hooks/usePush";

interface MW { today: any[]; team_today: any[]; due_soon: any[]; pending_guides: any[]; }

function TaskRow({ t }: { t: any }) {
  const complete = useMutation({
    mutationFn: () => patch(`/tasks/${t.id}`, { status: "done" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-work"] }),
    onError: (e: any) => toast(`처리 실패: ${e.message}`),
  });
  return (
    <Card className="flex items-center gap-3 py-3">
      <button onClick={() => complete.mutate()} disabled={complete.isPending} title="완료 처리"
        className="text-slate-300 transition hover:text-emerald-500">
        <Circle size={22} />
      </button>
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

export default function MyWork() {
  const { data, isLoading } = useQuery<MW>({ queryKey: ["my-work"], queryFn: () => get("/my-work") });
  if (isLoading) return <div className="py-16"><Spinner /></div>;
  const mw = data!;
  const teamToday = mw.team_today ?? [];
  const empty = mw.today.length === 0 && teamToday.length === 0 && mw.pending_guides.length === 0 && mw.due_soon.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-800">My Work</h1>
        <Button variant="outline" size="sm" onClick={() => enablePush().then((ok) => toast(ok ? "알림이 켜졌습니다." : "알림을 켜려면 HTTPS(터널) 접속이 필요합니다."))}>
          <Bell size={15} /> 알림 켜기
        </Button>
      </div>

      {empty ? (
        <EmptyState icon={<CheckCircle2 size={22} />} title="오늘은 배정된 일이 없어요"
          desc="내 담당 태스크와 우리 팀의 오늘 할 일이 여기에 모여요. 프로젝트에서 태스크에 오늘 예정일과 담당자를 지정해보세요." />
      ) : (
        <>
          <Section icon={<CheckCircle2 size={15} className="text-emerald-600" />} title="오늘 내 할 일" count={mw.today.length} tint="bg-emerald-50">
            {mw.today.length ? <div className="flex flex-col gap-2">{mw.today.map((t) => <TaskRow key={t.id} t={t} />)}</div>
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
        </>
      )}
    </div>
  );
}
