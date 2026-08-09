import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileCheck2,
  ListChecks,
  MonitorPlay,
  Plus,
  Printer,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";
import { ApiError, get, patch, post } from "../lib/api";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, SkeletonList, Textarea, cx, toast, useConfirm } from "../components/ui";
import { ProjectNav } from "../components/ProjectNav";

type Judgment = "normal" | "warning" | "risk";
type ReportTask = {
  id: number;
  item_key: string;
  title: string;
  status: string;
  area_id: number | null;
  priority: number;
  assignees: Array<{ id: number; name: string }>;
};
type SnapshotArea = {
  id: number | null;
  name: string;
  color: string;
  lead: { id: number; name: string } | null;
  total: number;
  done: number;
  progress: number;
  completed: number;
  in_progress: number;
  blocked: number;
  delayed: number;
  planned: number;
};
type Snapshot = {
  generated_at: string;
  report_date: string;
  period_start: string;
  cutoff_at: string;
  totals: { total: number; done: number; progress: number; completed: number; in_progress: number; blocked: number; delayed: number; planned: number };
  areas: SnapshotArea[];
  completed: ReportTask[];
  in_progress: ReportTask[];
  blocked: ReportTask[];
  delayed: ReportTask[];
  planned: ReportTask[];
  cutoff_unresolved: ReportTask[];
  late_changes: Array<{ task_id: number | null; item_key: string | null; title: string | null; action: string; changed_at: string }>;
};
type Report = {
  id: number;
  project_id: number;
  report_date: string;
  version: number;
  status: "draft" | "confirmed" | "superseded";
  period_start: string;
  cutoff_at: string;
  snapshot: Snapshot;
  overall_status: Judgment;
  headline: string | null;
  pm_summary: string | null;
  decisions: string | null;
  correction_reason: string | null;
  confirmed_at: string | null;
  updated_at: string;
};
type Review = {
  id: number;
  area_id: number | null;
  reviewer_id: number | null;
  status: "pending" | "confirmed";
  judgment: Judgment;
  note: string | null;
  impact: string | null;
  request: string | null;
  confirmed_by: number | null;
  confirmed_for_id: number | null;
  confirmed_at: string | null;
};
type ReportDetail = { report: Report; reviews: Review[]; my_operational_role: "pm" | "pl"; lead_area_ids: number[] };
type Memo = { id: number; area_id: number | null; author_id: number; body: string; action_type: string; status: string; target_task_id: number | null; target_event_id: number | null; created_at: string };

const judgmentMeta: Record<Judgment, { label: string; badge: string; border: string }> = {
  normal: { label: "정상", badge: "bg-emerald-100 text-emerald-700", border: "border-emerald-200" },
  warning: { label: "주의", badge: "bg-amber-100 text-amber-700", border: "border-amber-200" },
  risk: { label: "위험", badge: "bg-red-100 text-red-700", border: "border-red-200" },
};

function kstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function shiftDate(value: string, days: number) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400_000).toISOString().slice(0, 10);
}
function defaultMeetingDate(meetingTime = "09:30") {
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const today = kstDateKey(now);
  return hhmm <= meetingTime ? today : shiftDate(today, 1);
}
function dateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function apiMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

export function DailyReports() {
  const [, params] = useRoute("/projects/:id/reports");
  const pid = Number(params?.id);
  const [, navigate] = useLocation();
  const projectQ = useQuery<{ project: any }>({ queryKey: ["project", pid], queryFn: () => get(`/projects/${pid}`) });
  const project = projectQ.data?.project;
  const [date, setDate] = useState("");
  useEffect(() => { if (project && !date) setDate(defaultMeetingDate(project.report_meeting_time)); }, [project, date]);
  const reportsQ = useQuery<{ reports: Report[] }>({
    queryKey: ["daily-reports", pid], queryFn: () => get(`/projects/${pid}/daily-reports`), enabled: !!project?.daily_report_enabled,
  });
  const prepare = useMutation({
    mutationFn: () => post<ReportDetail>(`/projects/${pid}/daily-reports/prepare`, { report_date: date }),
    onSuccess: (data) => navigate(`/projects/${pid}/reports/${data.report.id}`),
    onError: (error) => toast(apiMessage(error, "보고 준비에 실패했습니다.")),
  });

  if (projectQ.isLoading) return <SkeletonList count={3} />;
  if (project && !["pm", "pl"].includes(project.my_operational_role)) return (
    <div className="space-y-5">
      <ProjectNav pid={pid} />
      <EmptyState
        icon={<ShieldAlert size={28} />}
        title="PM·PL 전용 화면입니다"
        desc="담당자는 보드에서 자신의 태스크와 일정을 확인하면 됩니다. 일일보고 준비와 회의용 보기는 PM·PL만 사용할 수 있습니다."
      />
    </div>
  );
  if (!project?.daily_report_enabled) return (
    <div className="space-y-5">
      <ProjectNav pid={pid} />
      <EmptyState icon={<ClipboardList size={28} />} title="일일보고가 아직 꺼져 있어요" desc="PM이 팀원 화면의 프로젝트 운영 설정에서 활성화할 수 있습니다." />
    </div>
  );

  return (
    <div className="space-y-5">
      <ProjectNav pid={pid} current="reports" />
      <PageHeader title="일일보고" desc="태스크 데이터를 자동 집계하고, PL 확인 뒤 PM이 회의 전에 확정합니다."
        actions={<Link href={`/projects/${pid}/members`}><Button variant="outline">{project.my_operational_role === "pm" ? "운영 설정" : "내 영역 관리"}</Button></Link>} />
      <Card className="border-brand-100 bg-gradient-to-br from-white to-brand-50/50 p-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="text-lg font-bold text-slate-900">다음 회의 보고 준비</div>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              선택한 회의일 전날 <strong>{project.report_cutoff_hour}:00</strong>까지의 개발을 고정 구간으로 집계합니다. 이후 변경은 다음 보고에 표시됩니다.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="회의일"><Input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
            <Button size="lg" disabled={!date || prepare.isPending} onClick={() => prepare.mutate()}>
              <FileCheck2 size={18} /> {prepare.isPending ? "집계 중…" : "보고 준비 열기"}
            </Button>
          </div>
        </div>
      </Card>
      <section>
        <h2 className="mb-3 text-lg font-bold text-slate-900">최근 보고서</h2>
        {reportsQ.isLoading ? <SkeletonList count={3} /> : (reportsQ.data?.reports.length ?? 0) === 0 ? (
          <EmptyState icon={<ListChecks size={28} />} title="아직 작성한 보고서가 없어요" desc="회의일을 선택하고 첫 보고 준비를 여세요." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {reportsQ.data!.reports.map((report) => (
              <Link key={report.id} href={`/projects/${pid}/reports/${report.id}`}>
                <Card className="h-full cursor-pointer transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div><div className="font-bold text-slate-900">{report.report_date} 회의 보고</div><div className="mt-1 text-sm text-slate-500">버전 {report.version}</div></div>
                    <Badge className={report.status === "confirmed" ? "bg-brand-100 text-brand" : report.status === "draft" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}>
                      {report.status === "confirmed" ? "확정" : report.status === "draft" ? "준비 중" : "이전 버전"}
                    </Badge>
                  </div>
                  <p className="mt-4 line-clamp-2 text-sm leading-relaxed text-slate-600">{report.headline || "전체 일정 상태를 확인하세요."}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TaskSection({ title, tasks, tone = "default" }: { title: string; tasks: ReportTask[]; tone?: "default" | "risk" }) {
  return (
    <Card className={cx(tone === "risk" && "border-red-200")}>
      <div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-900">{title}</h3><Badge className={tone === "risk" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}>{tasks.length}</Badge></div>
      {tasks.length === 0 ? <p className="text-sm text-slate-400">해당 항목이 없습니다.</p> : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-sm">
              <span className="font-mono text-xs font-semibold text-brand">{task.item_key}</span>
              <span className="min-w-0 flex-1 font-medium text-slate-700">{task.title}</span>
              <span className="text-xs text-slate-400">{task.assignees.map((a) => a.name).join(", ") || "미배정"}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function DailyReportDetail() {
  const [, params] = useRoute("/projects/:id/reports/:reportId");
  const pid = Number(params?.id);
  const reportId = Number(params?.reportId);
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const detailQ = useQuery<ReportDetail>({ queryKey: ["daily-report", pid, reportId], queryFn: () => get(`/projects/${pid}/daily-reports/${reportId}`) });
  const memosQ = useQuery<{ memos: Memo[] }>({ queryKey: ["report-memos", pid, reportId], queryFn: () => get(`/projects/${pid}/daily-reports/${reportId}/memos`), enabled: detailQ.data?.report.status === "confirmed" });
  const detail = detailQ.data;
  const report = detail?.report;
  const snapshot = report?.snapshot;
  const isPm = detail?.my_operational_role === "pm";
  const leadAreaIds = detail?.lead_area_ids ?? [];
  const [summary, setSummary] = useState({ overall_status: "normal" as Judgment, headline: "", pm_summary: "", decisions: "" });
  const [areaDrafts, setAreaDrafts] = useState<Record<string, { judgment: Judgment; note: string; impact: string; request: string }>>({});
  const [memoBody, setMemoBody] = useState("");
  const [memoType, setMemoType] = useState("note");
  const [memoArea, setMemoArea] = useState<string>("unassigned");
  const [actionTitle, setActionTitle] = useState("");
  const [actionTaskId, setActionTaskId] = useState("");
  const [actionDate, setActionDate] = useState("");

  useEffect(() => {
    if (!report) return;
    setSummary({ overall_status: report.overall_status, headline: report.headline ?? "", pm_summary: report.pm_summary ?? "", decisions: report.decisions ?? "" });
    const drafts: typeof areaDrafts = {};
    for (const review of detail.reviews) drafts[String(review.area_id ?? "unassigned")] = { judgment: review.judgment, note: review.note ?? "", impact: review.impact ?? "", request: review.request ?? "" };
    setAreaDrafts(drafts);
    if (!isPm && leadAreaIds[0] != null) setMemoArea(String(leadAreaIds[0]));
    if (isPm && report.snapshot.areas.length && !report.snapshot.areas.some((area) => String(area.id ?? "unassigned") === memoArea))
      setMemoArea(String(report.snapshot.areas[0].id ?? "unassigned"));
  }, [report?.id, report?.updated_at, detail?.reviews, isPm, memoArea]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["daily-report", pid, reportId] });
  const saveSummary = useMutation({
    mutationFn: () => patch(`/projects/${pid}/daily-reports/${reportId}/summary`, summary),
    onSuccess: () => { toast("전체 판단을 저장했습니다.", "success"); invalidate(); },
    onError: (error) => toast(apiMessage(error, "저장에 실패했습니다.")),
  });
  const saveArea = useMutation({
    mutationFn: (key: string) => patch(`/projects/${pid}/daily-reports/${reportId}/areas/${key}`, areaDrafts[key]),
    onSuccess: () => { toast("영역 판단을 저장했습니다.", "success"); invalidate(); },
    onError: (error) => toast(apiMessage(error, "영역 저장에 실패했습니다.")),
  });
  const confirmArea = useMutation({
    mutationFn: (key: string) => post(`/projects/${pid}/daily-reports/${reportId}/areas/${key}/confirm`, {}),
    onSuccess: (data: any) => { toast(data.delegated ? "PM이 대신 확인했습니다." : "영역 확인을 완료했습니다.", "success"); invalidate(); },
    onError: (error) => toast(apiMessage(error, "영역 확인에 실패했습니다.")),
  });
  const refresh = useMutation({
    mutationFn: () => post(`/projects/${pid}/daily-reports/${reportId}/refresh`, {}),
    onSuccess: () => { toast("자동 집계를 새로고침했습니다.", "success"); invalidate(); },
    onError: (error) => toast(apiMessage(error, "새로고침에 실패했습니다.")),
  });
  const confirmReport = useMutation({
    mutationFn: () => post(`/projects/${pid}/daily-reports/${reportId}/confirm`, {}),
    onSuccess: (data: any) => { toast(data.warnings?.length ? "미확인 영역을 기록하고 보고서를 확정했습니다." : "보고서를 확정했습니다.", "success"); invalidate(); },
    onError: (error) => toast(apiMessage(error, "보고서 확정에 실패했습니다.")),
  });
  const createMemo = useMutation({
    mutationFn: () => {
      const areaId = memoArea === "unassigned" ? null : Number(memoArea);
      let payload: Record<string, unknown> = {};
      if (memoType === "task_create") payload = { title: actionTitle || memoBody, area_id: areaId };
      if (memoType === "task_update") payload = { task_id: Number(actionTaskId), ...(actionTitle ? { title: actionTitle } : {}), ...(actionDate ? { scheduled_date: `${actionDate}T00:00:00.000Z` } : {}) };
      if (memoType === "event_create") payload = { title: actionTitle || memoBody, starts_at: actionDate ? `${actionDate}T09:00:00+09:00` : new Date().toISOString(), all_day: true };
      return post(`/projects/${pid}/daily-reports/${reportId}/memos`, { area_id: areaId, body: memoBody, action_type: memoType, action_payload: payload });
    },
    onSuccess: () => { setMemoBody(""); setActionTitle(""); setActionTaskId(""); toast("회의 메모를 후속 반영 대기에 추가했습니다.", "success"); queryClient.invalidateQueries({ queryKey: ["report-memos", pid, reportId] }); },
    onError: (error) => toast(apiMessage(error, "메모 저장에 실패했습니다.")),
  });
  const processMemo = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "apply" | "reject" }) => post(`/projects/${pid}/daily-reports/${reportId}/memos/${id}/${action}`, {}),
    onSuccess: (_data, value) => { toast(value.action === "apply" ? "향후 작업에 반영했습니다." : "메모를 반려했습니다.", "success"); queryClient.invalidateQueries({ queryKey: ["report-memos", pid, reportId] }); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); },
    onError: (error) => toast(apiMessage(error, "메모 처리에 실패했습니다.")),
  });

  if (detailQ.isLoading) return <SkeletonList count={5} />;
  if (detailQ.isError || !report || !snapshot) return <EmptyState icon={<ShieldAlert size={28} />} title="일일보고를 열 수 없어요" desc={apiMessage(detailQ.error, "PM 또는 PL 권한과 프로젝트 설정을 확인하세요.")} />;
  const draft = report.status === "draft";
  const pendingReviews = detail.reviews.filter((review) => review.status === "pending");

  return (
    <div className="space-y-5">
      {dialog}
      <ProjectNav pid={pid} current="reports" />
      <PageHeader title={`${report.report_date} 일일보고`} desc={`${dateTime(report.period_start)} 이후 ~ ${dateTime(report.cutoff_at)}까지 귀속 · v${report.version}`}
        actions={<>
          {draft && isPm && <Button variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCcw size={16} /> 집계 새로고침</Button>}
          {report.status === "confirmed" && <Link href={`/projects/${pid}/reports/${reportId}/present`}><Button><MonitorPlay size={17} /> 회의용 보고 보기</Button></Link>}
        </>} />

      <Card className={cx("p-5", judgmentMeta[report.overall_status].border)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2"><Badge className={judgmentMeta[report.overall_status].badge}>{judgmentMeta[report.overall_status].label}</Badge><Badge className={report.status === "confirmed" ? "bg-brand-100 text-brand" : "bg-amber-100 text-amber-700"}>{report.status === "confirmed" ? "회의 전 확정" : "준비 중"}</Badge></div>
            <h1 className="text-2xl font-extrabold leading-snug text-slate-950">{report.headline || "전체 일정 상태를 확인해 주세요."}</h1>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[['전체 진척', `${snapshot.totals.progress}%`], ['구간 완료', snapshot.totals.completed], ['막힘', snapshot.totals.blocked], ['지연', snapshot.totals.delayed]].map(([label, value]) => (
              <div key={String(label)} className="min-w-24 rounded-xl bg-slate-50 px-3 py-2"><div className="text-xl font-black text-slate-900">{value}</div><div className="text-xs text-slate-500">{label}</div></div>
            ))}
          </div>
        </div>
      </Card>

      <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold text-slate-900">영역별 현황</h2><span className="text-sm text-slate-500">{pendingReviews.length ? `${pendingReviews.length}개 확인 대기` : "모든 영역 확인"}</span></div>
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {snapshot.areas.map((area) => {
            const key = String(area.id ?? "unassigned");
            const review = detail.reviews.find((item) => item.area_id === area.id);
            const editable = draft && (isPm || (area.id != null && leadAreaIds.includes(area.id)));
            const form = areaDrafts[key] ?? { judgment: "normal" as Judgment, note: "", impact: "", request: "" };
            return (
              <Card key={key} className={cx("border-t-4", review?.status === "confirmed" ? "border-t-emerald-400" : "border-t-amber-400")}>
                <div className="flex items-start justify-between gap-2">
                  <div><div className="font-bold text-slate-900">{area.name}</div><div className="mt-0.5 text-xs text-slate-500">{area.lead ? `PL ${area.lead.name}` : isPm ? "PM 직접 관리" : "PL 미지정"}</div></div>
                  <Badge className={review?.status === "confirmed" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>{review?.status === "confirmed" ? <><Check size={12} /> 확인</> : "대기"}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1.5 text-center text-xs">
                  <div className="rounded-lg bg-slate-50 p-2"><strong className="block text-base text-slate-800">{area.progress}%</strong>진척</div>
                  <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><strong className="block text-base">{area.completed}</strong>완료</div>
                  <div className="rounded-lg bg-red-50 p-2 text-red-700"><strong className="block text-base">{area.blocked}</strong>막힘</div>
                  <div className="rounded-lg bg-amber-50 p-2 text-amber-700"><strong className="block text-base">{area.delayed}</strong>지연</div>
                </div>
                {editable ? (
                  <div className="mt-3 space-y-2">
                    <Select value={form.judgment} onChange={(event) => setAreaDrafts((all) => ({ ...all, [key]: { ...form, judgment: event.target.value as Judgment } }))}><option value="normal">정상</option><option value="warning">주의</option><option value="risk">위험</option></Select>
                    <Textarea rows={2} placeholder="판단과 현재 상황" value={form.note} onChange={(event) => setAreaDrafts((all) => ({ ...all, [key]: { ...form, note: event.target.value } }))} />
                    <Textarea rows={2} placeholder="일정·품질 영향" value={form.impact} onChange={(event) => setAreaDrafts((all) => ({ ...all, [key]: { ...form, impact: event.target.value } }))} />
                    <Input placeholder="PM에게 필요한 지원·결정" value={form.request} onChange={(event) => setAreaDrafts((all) => ({ ...all, [key]: { ...form, request: event.target.value } }))} />
                    <div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => saveArea.mutate(key)}>저장</Button>{review?.status !== "confirmed" && <Button size="sm" onClick={() => confirmArea.mutate(key)}>{isPm && review?.reviewer_id !== undefined && review?.reviewer_id !== null && review.reviewer_id !== review.confirmed_by ? "대신 확인" : "영역 확인"}</Button>}</div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">{review?.note || "추가 코멘트가 없습니다."}{review?.impact && <div className="mt-1 text-amber-700">영향: {review.impact}</div>}{review?.request && <div className="mt-1 font-medium text-brand">요청: {review.request}</div>}</div>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-2"><TaskSection title="구간 내 완료" tasks={snapshot.completed} /><TaskSection title="오늘 계획" tasks={snapshot.planned} /><TaskSection title="진행 중" tasks={snapshot.in_progress} /><TaskSection title="막힘·지원 필요" tasks={snapshot.blocked} tone="risk" /><TaskSection title="지연" tasks={snapshot.delayed} tone="risk" /></div>

      {snapshot.cutoff_unresolved.length > 0 && <Card className="border-amber-200 bg-amber-50"><div className="flex gap-2 text-amber-800"><AlertTriangle size={19} /><div><strong>마감 시점 상태를 복원할 수 없는 이전 데이터 {snapshot.cutoff_unresolved.length}건</strong><p className="mt-1 text-sm">현재 상태를 과거 사실로 임의 표시하지 않았습니다. PM이 원 태스크 이력을 확인해 주세요.</p></div></div></Card>}
      {snapshot.late_changes.length > 0 && <Card><h3 className="font-bold text-slate-900">마감 이후 변경 · 다음 보고 반영</h3><p className="mt-1 text-sm text-slate-500">보고 마감 뒤 {snapshot.late_changes.length}건의 변경이 있습니다. 현재 확정본 실적에는 섞지 않습니다.</p></Card>}

      {draft && isPm && (
        <Card className="space-y-3 p-5">
          <h2 className="text-lg font-bold text-slate-900">PM 전체 판단</h2>
          <div className="grid gap-3 md:grid-cols-[180px_1fr]"><Field label="전체 상태"><Select value={summary.overall_status} onChange={(event) => setSummary({ ...summary, overall_status: event.target.value as Judgment })}><option value="normal">정상</option><option value="warning">주의</option><option value="risk">위험</option></Select></Field><Field label="회의 첫 문장"><Input value={summary.headline} onChange={(event) => setSummary({ ...summary, headline: event.target.value })} /></Field></div>
          <Field label="전체 요약"><Textarea rows={3} value={summary.pm_summary} onChange={(event) => setSummary({ ...summary, pm_summary: event.target.value })} /></Field>
          <Field label="오늘 결정할 사항"><Textarea rows={3} value={summary.decisions} onChange={(event) => setSummary({ ...summary, decisions: event.target.value })} /></Field>
          <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => saveSummary.mutate()}>판단 저장</Button><Button size="lg" onClick={async () => {
            const message = pendingReviews.length ? `${pendingReviews.length}개 영역이 아직 확인 전입니다. 현재 데이터와 미확인 사실을 기록하고 확정할까요?` : "이 버전을 회의용 보고서로 확정할까요? 이후에는 정정 버전으로만 바꿀 수 있습니다.";
            if (await confirm({ title: "보고서 확정", message, confirmLabel: "회의 전 확정" })) confirmReport.mutate();
          }}><CheckCircle2 size={18} /> 보고서 확정</Button></div>
        </Card>
      )}

      {report.status === "confirmed" && (
        <Card className="space-y-4 p-5">
          <div><h2 className="text-lg font-bold text-slate-900">회의 메모와 후속 반영</h2><p className="mt-1 text-sm text-slate-500">확정된 과거 실적은 바꾸지 않습니다. 합의한 변경을 미래 태스크·일정 후보로 남기세요.</p></div>
          <div className="grid gap-3 lg:grid-cols-4">
            <Field label="영역"><Select value={memoArea} onChange={(event) => setMemoArea(event.target.value)}>{snapshot.areas.filter((area) => isPm || (area.id != null && leadAreaIds.includes(area.id))).map((area) => <option key={String(area.id)} value={String(area.id ?? "unassigned")}>{area.name}</option>)}</Select></Field>
            <Field label="반영 종류"><Select value={memoType} onChange={(event) => setMemoType(event.target.value)}><option value="note">기록만</option><option value="task_create">새 태스크</option><option value="task_update">기존 태스크 수정</option><option value="event_create">새 일정</option></Select></Field>
            {memoType === "task_update" ? <Field label="대상 태스크 ID"><Input type="number" value={actionTaskId} onChange={(event) => setActionTaskId(event.target.value)} /></Field> : memoType !== "note" ? <Field label="태스크·일정 제목"><Input value={actionTitle} onChange={(event) => setActionTitle(event.target.value)} /></Field> : <div />}
            {(memoType === "event_create" || memoType === "task_update") && <Field label={memoType === "event_create" ? "일정 날짜" : "새 예정일 (선택)"}><Input type="date" value={actionDate} onChange={(event) => setActionDate(event.target.value)} /></Field>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row"><Textarea rows={2} placeholder="회의에서 합의한 변경과 이유" value={memoBody} onChange={(event) => setMemoBody(event.target.value)} /><Button disabled={!memoBody.trim() || (memoType === "task_update" && (!actionTaskId || (!actionTitle.trim() && !actionDate)))} onClick={() => createMemo.mutate()}><Plus size={17} /> 메모 추가</Button></div>
          <div className="space-y-2">
            {(memosQ.data?.memos ?? []).map((memo) => (
              <div key={memo.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Badge className={memo.status === "pending" ? "bg-amber-100 text-amber-700" : memo.status === "applied" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}>{memo.status === "pending" ? "반영 대기" : memo.status === "applied" ? "반영됨" : "반려"}</Badge><span className="text-xs text-slate-400">{memo.action_type}</span></div><p className="mt-1 text-sm text-slate-700">{memo.body}</p>{memo.target_task_id && <div className="mt-1 text-xs text-brand">태스크 ID #{memo.target_task_id}에 반영됨</div>}</div>
                {memo.status === "pending" && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => processMemo.mutate({ id: memo.id, action: "reject" })}>반려</Button><Button size="sm" onClick={() => processMemo.mutate({ id: memo.id, action: "apply" })}>검토 후 반영</Button></div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export function DailyReportPresent() {
  const [, params] = useRoute("/projects/:id/reports/:reportId/present");
  const pid = Number(params?.id);
  const reportId = Number(params?.reportId);
  const detailQ = useQuery<ReportDetail>({ queryKey: ["daily-report", pid, reportId], queryFn: () => get(`/projects/${pid}/daily-reports/${reportId}`) });
  const report = detailQ.data?.report;
  const snapshot = report?.snapshot;
  const [memo, setMemo] = useState("");
  const areaId = detailQ.data?.my_operational_role === "pl" ? detailQ.data.lead_area_ids[0] ?? null : null;
  const addMemo = useMutation({
    mutationFn: () => post(`/projects/${pid}/daily-reports/${reportId}/memos`, { area_id: areaId, body: memo, action_type: "note", action_payload: {} }),
    onSuccess: () => { setMemo(""); toast("회의 메모를 저장했습니다.", "success"); },
    onError: (error) => toast(apiMessage(error, "메모 저장에 실패했습니다.")),
  });
  if (detailQ.isLoading) return <SkeletonList count={5} />;
  if (!report || !snapshot || report.status !== "confirmed") return <EmptyState icon={<ShieldAlert size={28} />} title="확정된 보고서만 회의용으로 볼 수 있어요" />;
  return (
    <div className="report-present mx-auto max-w-6xl space-y-6 bg-white p-4 sm:p-8">
      <div className="no-print flex flex-wrap items-center justify-between gap-2"><Link href={`/projects/${pid}/reports/${reportId}`}><Button variant="outline"><ArrowLeft size={16} /> 보고 준비로</Button></Link><Button variant="outline" onClick={() => window.print()}><Printer size={16} /> PDF로 인쇄</Button></div>
      <header className="border-b-2 border-slate-900 pb-5"><div className="flex items-center gap-2 text-base font-semibold text-brand"><ClipboardList size={20} /> {report.report_date} 일일보고 · 확정 v{report.version}</div><h1 className="mt-3 text-3xl font-black leading-tight text-slate-950 sm:text-4xl">{report.headline}</h1><p className="mt-3 text-lg text-slate-600">{report.pm_summary || "태스크 집계와 영역별 판단을 기준으로 보고합니다."}</p></header>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{[['전체 진척', `${snapshot.totals.progress}%`], ['구간 완료', snapshot.totals.completed], ['진행', snapshot.totals.in_progress], ['막힘', snapshot.totals.blocked], ['지연', snapshot.totals.delayed]].map(([label, value]) => <div key={String(label)} className="rounded-2xl bg-slate-50 p-4 text-center"><div className="text-3xl font-black text-slate-900">{value}</div><div className="mt-1 text-sm text-slate-500">{label}</div></div>)}</div>
      <section><h2 className="mb-3 text-2xl font-black text-slate-900">영역별 현황</h2><div className="grid gap-3 md:grid-cols-2">{snapshot.areas.map((area) => { const review = detailQ.data!.reviews.find((item) => item.area_id === area.id); return <Card key={String(area.id)} className={judgmentMeta[review?.judgment ?? "normal"].border}><div className="flex justify-between gap-2"><div><h3 className="text-xl font-bold text-slate-900">{area.name}</h3><p className="text-sm text-slate-500">{area.lead ? `PL ${area.lead.name}` : "PM 직접 관리"}</p></div><Badge className={judgmentMeta[review?.judgment ?? "normal"].badge}>{judgmentMeta[review?.judgment ?? "normal"].label}</Badge></div><div className="mt-3 text-lg font-semibold">진척 {area.progress}% · 완료 {area.completed} · 막힘 {area.blocked} · 지연 {area.delayed}</div>{review?.note && <p className="mt-2 text-base leading-relaxed text-slate-600">{review.note}</p>}{review?.request && <p className="mt-2 font-semibold text-brand">요청: {review.request}</p>}</Card>; })}</div></section>
      <div className="grid gap-4 lg:grid-cols-2"><TaskSection title="구간 내 완료" tasks={snapshot.completed} /><TaskSection title="막힘·지원 필요" tasks={snapshot.blocked} tone="risk" /><TaskSection title="오늘 계획" tasks={snapshot.planned} /><Card><h3 className="text-xl font-bold text-slate-900">오늘 결정할 사항</h3><p className="mt-3 whitespace-pre-wrap text-lg leading-relaxed text-slate-700">{report.decisions || "별도 결정사항이 없습니다."}</p></Card></div>
      <Card className="no-print border-brand-200 bg-brand-50/40 p-5"><h2 className="text-lg font-bold text-slate-900">회의 중 메모</h2><p className="mt-1 text-sm text-slate-500">보고서는 바꾸지 않고, 합의한 변경을 회의 후속 검토함에 남깁니다.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Textarea rows={2} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="결정·변경 내용을 기록하세요" /><Button disabled={!memo.trim()} onClick={() => addMemo.mutate()}>메모 저장</Button></div></Card>
    </div>
  );
}
