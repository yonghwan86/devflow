import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "./db.ts";
import {
  activityLog,
  dailyReportAreaReviews,
  dailyReports,
  projectAreas,
  taskAssignees,
  tasks,
  users,
  type Project,
  type Task,
} from "../../../shared/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportPeriod {
  reportDate: string;
  periodStart: Date;
  cutoffAt: Date;
}

export interface ReportTaskSnapshot {
  id: number;
  item_key: string;
  title: string;
  status: string;
  area_id: number | null;
  priority: number;
  scheduled_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  assignees: Array<{ id: number; name: string }>;
}

export interface DailyReportSnapshot {
  generated_at: string;
  report_date: string;
  period_start: string;
  cutoff_at: string;
  totals: { total: number; done: number; progress: number; completed: number; in_progress: number; blocked: number; delayed: number; planned: number };
  areas: Array<{
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
  }>;
  completed: ReportTaskSnapshot[];
  in_progress: ReportTaskSnapshot[];
  blocked: ReportTaskSnapshot[];
  delayed: ReportTaskSnapshot[];
  planned: ReportTaskSnapshot[];
  cutoff_unresolved: ReportTaskSnapshot[];
  late_changes: Array<{ task_id: number | null; item_key: string | null; title: string | null; action: string; changed_at: string }>;
}

function assertDateKey(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("report_date must be YYYY-MM-DD");
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d)
    throw new Error("invalid report_date");
}

function shiftDateKey(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

export function localDateKey(date: Date, timezone = "Asia/Seoul"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function reportPeriod(reportDate: string, cutoffHour: number, timezone = "Asia/Seoul"): ReportPeriod {
  assertDateKey(reportDate);
  if (timezone !== "Asia/Seoul") throw new Error("현재는 Asia/Seoul 시간대만 지원합니다.");
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 23) throw new Error("invalid cutoff hour");
  const previousDate = shiftDateKey(reportDate, -1);
  const cutoffAt = new Date(`${previousDate}T${String(cutoffHour).padStart(2, "0")}:00:00+09:00`);
  return { reportDate, cutoffAt, periodStart: new Date(cutoffAt.getTime() - DAY_MS) };
}

function statusFromActivity(meta: Record<string, unknown> | null): string | null {
  const value = meta?.to_status ?? meta?.status;
  return typeof value === "string" ? value : null;
}

function statusAtCutoff(task: Task, cutoffAt: Date, statusLogs: Array<{ action: string; meta: Record<string, unknown> | null; created_at: Date }>): { status: string | null; unresolved: boolean } {
  if (task.created_at.getTime() > cutoffAt.getTime()) return { status: null, unresolved: false };
  if (task.completed_at && task.completed_at.getTime() <= cutoffAt.getTime()) return { status: "done", unresolved: false };
  if (task.updated_at.getTime() <= cutoffAt.getTime()) return { status: task.status, unresolved: false };
  const latest = [...statusLogs]
    .filter((row) => row.created_at.getTime() <= cutoffAt.getTime())
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .map((row) => statusFromActivity(row.meta))
    .find((value): value is string => !!value);
  if (latest) return { status: latest, unresolved: false };
  const firstAfter = [...statusLogs]
    .filter((row) => row.created_at.getTime() > cutoffAt.getTime())
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
    .map((row) => typeof row.meta?.from_status === "string" ? row.meta.from_status : null)
    .find((value): value is string => !!value);
  if (firstAfter) return { status: firstAfter, unresolved: false };
  // 상태 이력이 생기기 전의 오래된 데이터는 현재 상태를 과거 사실로 꾸미지 않는다.
  if (task.status === "todo" || task.status === "requested") return { status: task.status, unresolved: false };
  return { status: null, unresolved: true };
}

export async function buildDailyReportSnapshot(project: Project, period: ReportPeriod): Promise<DailyReportSnapshot> {
  const [allTasks, areas, allLogs] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.project_id, project.id)).orderBy(asc(tasks.created_at), asc(tasks.id)),
    db.select({ area: projectAreas, lead: users })
      .from(projectAreas)
      .leftJoin(users, eq(users.id, projectAreas.lead_user_id))
      .where(eq(projectAreas.project_id, project.id))
      .orderBy(asc(projectAreas.sort_order), asc(projectAreas.id)),
    db.select({ task_id: activityLog.task_id, action: activityLog.action, meta: activityLog.meta, created_at: activityLog.created_at })
      .from(activityLog)
      .where(and(eq(activityLog.project_id, project.id), lte(activityLog.created_at, new Date()))),
  ]);

  const taskIds = allTasks.map((task) => task.id);
  const assignments = taskIds.length
    ? await db.select({ task_id: taskAssignees.task_id, id: users.id, full_name: users.full_name, email: users.email })
        .from(taskAssignees)
        .innerJoin(users, eq(users.id, taskAssignees.user_id))
        .where(inArray(taskAssignees.task_id, taskIds))
    : [];
  const assigneeMap = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of assignments) {
    const list = assigneeMap.get(row.task_id) ?? [];
    list.push({ id: row.id, name: row.full_name || row.email });
    assigneeMap.set(row.task_id, list);
  }
  const logsByTask = new Map<number, typeof allLogs>();
  for (const row of allLogs) {
    if (row.task_id == null) continue;
    const list = logsByTask.get(row.task_id) ?? [];
    list.push(row);
    logsByTask.set(row.task_id, list);
  }
  const statusMap = new Map<number, { status: string | null; unresolved: boolean }>();
  for (const task of allTasks) statusMap.set(task.id, statusAtCutoff(task, period.cutoffAt, logsByTask.get(task.id) ?? []));

  const snap = (task: Task, forcedStatus?: string | null): ReportTaskSnapshot => ({
    id: task.id,
    item_key: task.item_key,
    title: task.title,
    status: forcedStatus ?? task.status,
    area_id: task.area_id,
    priority: task.priority,
    scheduled_date: task.scheduled_date?.toISOString() ?? null,
    due_date: task.due_date?.toISOString() ?? null,
    completed_at: task.completed_at?.toISOString() ?? null,
    assignees: assigneeMap.get(task.id) ?? [],
  });

  const officialAtCutoff = allTasks.filter((task) => {
    const state = statusMap.get(task.id)!;
    return state.status != null && !["requested", "rejected"].includes(state.status);
  });
  const completed = allTasks.filter((task) => task.completed_at && task.completed_at > period.periodStart && task.completed_at <= period.cutoffAt).map((task) => snap(task, "done"));
  const inProgress = officialAtCutoff.filter((task) => statusMap.get(task.id)!.status === "in_progress").map((task) => snap(task, "in_progress"));
  const blocked = officialAtCutoff.filter((task) => statusMap.get(task.id)!.status === "blocked").map((task) => snap(task, "blocked"));
  const delayed = officialAtCutoff.filter((task) => {
    const status = statusMap.get(task.id)!.status;
    return !!task.due_date && task.due_date < period.cutoffAt && status !== "done";
  }).map((task) => snap(task, statusMap.get(task.id)!.status));
  const planned = officialAtCutoff.filter((task) =>
    !!task.scheduled_date && localDateKey(task.scheduled_date, project.timezone) === period.reportDate && statusMap.get(task.id)!.status !== "done",
  ).map((task) => snap(task, statusMap.get(task.id)!.status));
  const unresolved = allTasks.filter((task) => statusMap.get(task.id)?.unresolved).map((task) => snap(task, null));

  const completedIds = new Set(completed.map((task) => task.id));
  const inProgressIds = new Set(inProgress.map((task) => task.id));
  const blockedIds = new Set(blocked.map((task) => task.id));
  const delayedIds = new Set(delayed.map((task) => task.id));
  const plannedIds = new Set(planned.map((task) => task.id));
  const areaRows = [
    ...areas.map(({ area, lead }) => ({ id: area.id as number | null, name: area.name, color: area.color, lead: lead ? { id: lead.id, name: lead.full_name || lead.email } : null })),
    { id: null, name: areas.length ? "미분류" : "전체 프로젝트", color: "#64748b", lead: null },
  ];
  const areaSnapshots = areaRows
    .map((area) => {
      const matches = (task: Task) => area.id == null ? task.area_id == null : task.area_id === area.id;
      const scoped = officialAtCutoff.filter(matches);
      const done = scoped.filter((task) => statusMap.get(task.id)!.status === "done").length;
      return {
        ...area,
        total: scoped.length,
        done,
        progress: scoped.length ? Math.round(done / scoped.length * 100) : 0,
        completed: scoped.filter((task) => completedIds.has(task.id)).length,
        in_progress: scoped.filter((task) => inProgressIds.has(task.id)).length,
        blocked: scoped.filter((task) => blockedIds.has(task.id)).length,
        delayed: scoped.filter((task) => delayedIds.has(task.id)).length,
        planned: scoped.filter((task) => plannedIds.has(task.id)).length,
      };
    })
    .filter((area) => area.id != null || area.total > 0 || areas.length === 0);

  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const lateChanges = allLogs
    .filter((row) => row.task_id != null && row.created_at > period.cutoffAt)
    .map((row) => {
      const task = row.task_id == null ? null : taskById.get(row.task_id) ?? null;
      return { task_id: row.task_id, item_key: task?.item_key ?? null, title: task?.title ?? null, action: row.action, changed_at: row.created_at.toISOString() };
    });

  const doneTotal = officialAtCutoff.filter((task) => statusMap.get(task.id)!.status === "done").length;
  return {
    generated_at: new Date().toISOString(),
    report_date: period.reportDate,
    period_start: period.periodStart.toISOString(),
    cutoff_at: period.cutoffAt.toISOString(),
    totals: {
      total: officialAtCutoff.length,
      done: doneTotal,
      progress: officialAtCutoff.length ? Math.round(doneTotal / officialAtCutoff.length * 100) : 0,
      completed: completed.length,
      in_progress: inProgress.length,
      blocked: blocked.length,
      delayed: delayed.length,
      planned: planned.length,
    },
    areas: areaSnapshots,
    completed,
    in_progress: inProgress,
    blocked,
    delayed,
    planned,
    cutoff_unresolved: unresolved,
    late_changes: lateChanges,
  };
}

export async function createAreaReviews(reportId: number, snapshot: DailyReportSnapshot): Promise<void> {
  const values = snapshot.areas.map((area) => ({
    report_id: reportId,
    area_id: area.id,
    reviewer_id: area.lead?.id ?? null,
  }));
  if (values.length) await db.insert(dailyReportAreaReviews).values(values).onConflictDoNothing();
}

export async function reportWithDetails(reportId: number) {
  const [report] = await db.select().from(dailyReports).where(eq(dailyReports.id, reportId)).limit(1);
  if (!report) return null;
  const reviews = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, reportId)).orderBy(asc(dailyReportAreaReviews.id));
  return { report, reviews };
}
