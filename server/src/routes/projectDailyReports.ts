import type { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  dailyReportAreaReviews,
  dailyReports,
  projects,
} from "../../../shared/schema.ts";
import { db } from "../lib/db.ts";
import { err } from "../lib/errors.ts";
import { ah } from "../lib/http.ts";
import { logActivity } from "../lib/activity.ts";
import { assertProjectPm, assertReportActor, canManageArea, loadOperationalAccess } from "../lib/operationalAccess.ts";
import { buildDailyReportSnapshot, createAreaReviews, reportPeriod, reportWithDetails, type DailyReportSnapshot } from "../lib/dailyReportService.ts";
import { requireMember } from "../middleware/auth.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

async function projectForReport(projectId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw err.notFound("프로젝트를 찾을 수 없습니다.");
  return project;
}

async function reportInProject(reportId: number, projectId: number) {
  const [report] = await db
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.id, reportId), eq(dailyReports.project_id, projectId)))
    .limit(1);
  if (!report) throw err.notFound("일일보고를 찾을 수 없습니다.");
  return report;
}

function defaultHeadline(status: string, snapshot: DailyReportSnapshot): string {
  const label = status === "risk" ? "위험" : status === "warning" ? "주의" : "정상";
  const decisions = snapshot.totals.blocked + snapshot.totals.delayed;
  return `전체 일정은 ${label}이며, 오늘 ${decisions}개 위험 항목을 확인해야 합니다.`;
}

function areaKey(value: string): number | null {
  if (value === "unassigned") return null;
  const id = Number(value);
  if (!Number.isInteger(id)) throw err.badRequest("영역이 올바르지 않습니다.");
  return id;
}

export function registerProjectDailyReportRoutes(r: Router): void {
  r.get(
    "/:projectId/daily-reports",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const date = req.query.date == null ? null : dateSchema.parse(String(req.query.date));
      const where = date
        ? and(eq(dailyReports.project_id, pid), eq(dailyReports.report_date, date))
        : eq(dailyReports.project_id, pid);
      const reports = await db.select().from(dailyReports).where(where).orderBy(desc(dailyReports.report_date), desc(dailyReports.version)).limit(date ? 20 : 30);
      res.json({ reports, my_operational_role: access.operationalRole, lead_area_ids: access.leadAreaIds });
    }),
  );

  r.get(
    "/:projectId/daily-reports/:reportId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      const detail = await reportWithDetails(report.id);
      res.json({ ...detail, my_operational_role: access.operationalRole, lead_area_ids: access.leadAreaIds });
    }),
  );

  r.post(
    "/:projectId/daily-reports/prepare",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const body = z.object({ report_date: dateSchema }).strict().parse(req.body);
      const project = await projectForReport(pid);
      let period;
      try {
        period = reportPeriod(body.report_date, project.report_cutoff_hour, project.timezone);
      } catch (error) {
        throw err.badRequest(error instanceof Error ? error.message : "보고 날짜가 올바르지 않습니다.");
      }
      const [existing] = await db
        .select()
        .from(dailyReports)
        .where(and(eq(dailyReports.project_id, pid), eq(dailyReports.report_date, body.report_date)))
        .orderBy(desc(dailyReports.version))
        .limit(1);
      if (existing) {
        const detail = await reportWithDetails(existing.id);
        return res.json({ ...detail, created: false, my_operational_role: access.operationalRole, lead_area_ids: access.leadAreaIds });
      }
      const snapshot = await buildDailyReportSnapshot(project, period);
      const [report] = await db
        .insert(dailyReports)
        .values({
          project_id: pid,
          report_date: body.report_date,
          version: 1,
          period_start: period.periodStart,
          cutoff_at: period.cutoffAt,
          snapshot: snapshot as unknown as Record<string, unknown>,
          headline: defaultHeadline("normal", snapshot),
          created_by: req.userId!,
        })
        .returning();
      await createAreaReviews(report.id, snapshot);
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.prepared", meta: { report_id: report.id, report_date: report.report_date, cutoff_at: report.cutoff_at.toISOString() } });
      const detail = await reportWithDetails(report.id);
      res.status(201).json({ ...detail, created: true, my_operational_role: access.operationalRole, lead_area_ids: access.leadAreaIds });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/refresh",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      if (!access.reportEnabled) throw err.notFound("일일보고 기능이 비활성화되어 있습니다.");
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "draft") throw err.conflict("확정된 보고서는 새로고침할 수 없습니다.");
      const project = await projectForReport(pid);
      const snapshot = await buildDailyReportSnapshot(project, { reportDate: report.report_date, periodStart: report.period_start, cutoffAt: report.cutoff_at });
      const [updated] = await db.update(dailyReports).set({ snapshot: snapshot as unknown as Record<string, unknown>, updated_at: new Date() }).where(eq(dailyReports.id, report.id)).returning();
      // 영역 구조가 추가된 경우 review만 보강하고 기존 수동 코멘트는 보존한다.
      await createAreaReviews(report.id, snapshot);
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.refreshed", meta: { report_id: report.id } });
      res.json({ report: updated, reviews: (await reportWithDetails(report.id))!.reviews });
    }),
  );

  r.patch(
    "/:projectId/daily-reports/:reportId/summary",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      if (!access.reportEnabled) throw err.notFound("일일보고 기능이 비활성화되어 있습니다.");
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "draft") throw err.conflict("확정된 보고서는 수정할 수 없습니다.");
      const body = z.object({
        overall_status: z.enum(["normal", "warning", "risk"]).optional(),
        headline: z.string().trim().max(500).nullable().optional(),
        pm_summary: z.string().trim().max(5000).nullable().optional(),
        decisions: z.string().trim().max(5000).nullable().optional(),
      }).strict().refine((value) => Object.keys(value).length > 0, "변경할 내용이 필요합니다.").parse(req.body);
      const [updated] = await db.update(dailyReports).set({ ...body, updated_at: new Date() }).where(eq(dailyReports.id, report.id)).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.summary_updated", meta: { report_id: report.id, fields: Object.keys(body) } });
      res.json({ report: updated });
    }),
  );

  r.patch(
    "/:projectId/daily-reports/:reportId/areas/:areaKey",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "draft") throw err.conflict("확정된 보고서는 수정할 수 없습니다.");
      const areaId = areaKey(req.params.areaKey);
      if (!canManageArea(access, areaId)) throw err.forbidden("자기 영역 코멘트만 수정할 수 있습니다.");
      const body = z.object({
        judgment: z.enum(["normal", "warning", "risk"]).optional(),
        note: z.string().trim().max(3000).nullable().optional(),
        impact: z.string().trim().max(3000).nullable().optional(),
        request: z.string().trim().max(3000).nullable().optional(),
      }).strict().refine((value) => Object.keys(value).length > 0, "변경할 내용이 필요합니다.").parse(req.body);
      // Drizzle의 eq(null) 대신 null 영역은 서비스가 보장한 유일 review id를 먼저 찾는다.
      const candidates = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, report.id));
      const review = candidates.find((row) => row.area_id === areaId);
      if (!review) throw err.notFound("영역 확인 항목을 찾을 수 없습니다.");
      const [updated] = await db.update(dailyReportAreaReviews).set({ ...body, updated_at: new Date() }).where(eq(dailyReportAreaReviews.id, review.id)).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.area_updated", meta: { report_id: report.id, area_id: areaId, fields: Object.keys(body) } });
      res.json({ review: updated });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/areas/:areaKey/confirm",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "draft") throw err.conflict("확정된 보고서의 영역 확인 상태는 바꿀 수 없습니다.");
      const areaId = areaKey(req.params.areaKey);
      if (!canManageArea(access, areaId)) throw err.forbidden("자기 영역만 확인할 수 있습니다.");
      const candidates = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, report.id));
      const review = candidates.find((row) => row.area_id === areaId);
      if (!review) throw err.notFound("영역 확인 항목을 찾을 수 없습니다.");
      const now = new Date();
      const [updated] = await db.update(dailyReportAreaReviews).set({
        status: "confirmed",
        confirmed_by: req.userId!,
        confirmed_for_id: access.operationalRole === "pm" && review.reviewer_id !== req.userId ? review.reviewer_id : null,
        confirmed_at: now,
        updated_at: now,
      }).where(eq(dailyReportAreaReviews.id, review.id)).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.area_confirmed", meta: { report_id: report.id, area_id: areaId, confirmed_for_id: updated.confirmed_for_id } });
      res.json({ review: updated, delegated: updated.confirmed_for_id != null });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/confirm",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      if (!access.reportEnabled) throw err.notFound("일일보고 기능이 비활성화되어 있습니다.");
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "draft") throw err.conflict("이미 확정된 보고서입니다.");
      const snapshot = report.snapshot as unknown as DailyReportSnapshot;
      const reviews = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, report.id));
      const pending = reviews.filter((review) => review.status !== "confirmed");
      const now = new Date();
      await db.update(dailyReports)
        .set({ status: "superseded", updated_at: now })
        .where(and(eq(dailyReports.project_id, pid), eq(dailyReports.report_date, report.report_date), eq(dailyReports.status, "confirmed"), ne(dailyReports.id, report.id)));
      const [updated] = await db.update(dailyReports).set({
        status: "confirmed",
        headline: report.headline || defaultHeadline(report.overall_status, snapshot),
        confirmed_by: req.userId!,
        confirmed_at: now,
        updated_at: now,
      }).where(eq(dailyReports.id, report.id)).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.confirmed", meta: { report_id: report.id, version: report.version, pending_area_ids: pending.map((review) => review.area_id) } });
      res.json({ report: updated, warnings: pending.length ? [{ code: "unconfirmed_areas", area_ids: pending.map((review) => review.area_id) }] : [] });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/corrections",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      if (!access.reportEnabled) throw err.notFound("일일보고 기능이 비활성화되어 있습니다.");
      const source = await reportInProject(Number(req.params.reportId), pid);
      if (source.status !== "confirmed" && source.status !== "superseded") throw err.conflict("확정된 보고서만 정정할 수 있습니다.");
      const body = z.object({ correction_reason: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
      const [latest] = await db.select({ version: dailyReports.version }).from(dailyReports)
        .where(and(eq(dailyReports.project_id, pid), eq(dailyReports.report_date, source.report_date)))
        .orderBy(desc(dailyReports.version)).limit(1);
      const [report] = await db.insert(dailyReports).values({
        project_id: pid,
        report_date: source.report_date,
        version: (latest?.version ?? source.version) + 1,
        status: "draft",
        period_start: source.period_start,
        cutoff_at: source.cutoff_at,
        snapshot: source.snapshot,
        overall_status: source.overall_status,
        headline: source.headline,
        pm_summary: source.pm_summary,
        decisions: source.decisions,
        correction_reason: body.correction_reason,
        created_by: req.userId!,
      }).returning();
      const sourceReviews = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, source.id));
      if (sourceReviews.length) {
        await db.insert(dailyReportAreaReviews).values(sourceReviews.map((review) => ({
          report_id: report.id,
          area_id: review.area_id,
          reviewer_id: review.reviewer_id,
          status: "pending" as const,
          judgment: review.judgment,
          note: review.note,
          impact: review.impact,
          request: review.request,
        })));
      }
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.correction_started", meta: { source_report_id: source.id, report_id: report.id, version: report.version, reason: body.correction_reason } });
      res.status(201).json(await reportWithDetails(report.id));
    }),
  );
}
