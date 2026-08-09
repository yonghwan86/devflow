import type { Router } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dailyReportMemos,
  dailyReports,
  eventAttendees,
  events,
  projectMembers,
  projects,
  taskAssignees,
  tasks,
} from "../../../shared/schema.ts";
import { db } from "../lib/db.ts";
import { err } from "../lib/errors.ts";
import { ah } from "../lib/http.ts";
import { logActivity } from "../lib/activity.ts";
import { assertAreaInProject, assertReportActor, canManageArea, loadOperationalAccess } from "../lib/operationalAccess.ts";
import { requireMember } from "../middleware/auth.ts";

async function reportInProject(reportId: number, projectId: number) {
  const [report] = await db.select().from(dailyReports)
    .where(and(eq(dailyReports.id, reportId), eq(dailyReports.project_id, projectId))).limit(1);
  if (!report) throw err.notFound("일일보고를 찾을 수 없습니다.");
  return report;
}

async function memoInReport(memoId: number, reportId: number) {
  const [memo] = await db.select().from(dailyReportMemos)
    .where(and(eq(dailyReportMemos.id, memoId), eq(dailyReportMemos.report_id, reportId))).limit(1);
  if (!memo) throw err.notFound("회의 메모를 찾을 수 없습니다.");
  return memo;
}

const actionPayloadSchema = z.record(z.unknown()).nullable().optional();

export function registerProjectReportMemoRoutes(r: Router): void {
  r.get(
    "/:projectId/daily-reports/:reportId/memos",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      const memos = await db.select().from(dailyReportMemos)
        .where(eq(dailyReportMemos.report_id, report.id)).orderBy(asc(dailyReportMemos.created_at), asc(dailyReportMemos.id));
      res.json({ memos });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/memos",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      if (report.status !== "confirmed") throw err.conflict("보고서를 확정한 뒤 회의 메모를 작성할 수 있습니다.");
      const body = z.object({
        area_id: z.number().int().nullable().optional(),
        body: z.string().trim().min(1).max(5000),
        action_type: z.enum(["task_create", "task_update", "event_create", "note"]).default("note"),
        action_payload: actionPayloadSchema,
      }).strict().parse(req.body);
      const areaId = body.area_id ?? null;
      if (areaId != null) await assertAreaInProject(areaId, pid);
      if (!canManageArea(access, areaId)) throw err.forbidden("자기 영역의 회의 메모만 작성할 수 있습니다.");
      const [memo] = await db.insert(dailyReportMemos).values({
        report_id: report.id,
        area_id: areaId,
        author_id: req.userId!,
        body: body.body,
        action_type: body.action_type,
        action_payload: body.action_payload as Record<string, unknown> | null | undefined,
      }).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.memo_created", meta: { report_id: report.id, memo_id: memo.id, area_id: areaId, action_type: memo.action_type } });
      res.status(201).json({ memo });
    }),
  );

  r.patch(
    "/:projectId/daily-reports/:reportId/memos/:memoId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      const memo = await memoInReport(Number(req.params.memoId), report.id);
      if (memo.status !== "pending") throw err.conflict("반영 대기 중인 메모만 수정할 수 있습니다.");
      const isPm = access.operationalRole === "pm";
      if (!isPm && (memo.author_id !== req.userId || !canManageArea(access, memo.area_id)))
        throw err.forbidden("작성한 자기 영역 메모만 수정할 수 있습니다.");
      const body = z.object({
        body: z.string().trim().min(1).max(5000).optional(),
        action_type: z.enum(["task_create", "task_update", "event_create", "note"]).optional(),
        action_payload: actionPayloadSchema,
      }).strict().refine((value) => Object.keys(value).length > 0, "변경할 내용이 필요합니다.").parse(req.body);
      const [updated] = await db.update(dailyReportMemos).set({
        ...body,
        action_payload: body.action_payload as Record<string, unknown> | null | undefined,
        updated_at: new Date(),
      }).where(eq(dailyReportMemos.id, memo.id)).returning();
      res.json({ memo: updated });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/memos/:memoId/reject",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      const memo = await memoInReport(Number(req.params.memoId), report.id);
      if (!canManageArea(access, memo.area_id)) throw err.forbidden("자기 영역의 메모만 처리할 수 있습니다.");
      if (memo.status !== "pending") throw err.conflict("이미 처리된 메모입니다.");
      const [updated] = await db.update(dailyReportMemos).set({ status: "rejected", reviewed_by: req.userId!, updated_at: new Date() })
        .where(and(eq(dailyReportMemos.id, memo.id), eq(dailyReportMemos.status, "pending"))).returning();
      if (!updated) throw err.conflict("이미 처리된 메모입니다.");
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.memo_rejected", meta: { report_id: report.id, memo_id: memo.id } });
      res.json({ memo: updated });
    }),
  );

  r.post(
    "/:projectId/daily-reports/:reportId/memos/:memoId/apply",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertReportActor(access);
      const report = await reportInProject(Number(req.params.reportId), pid);
      const memo = await memoInReport(Number(req.params.memoId), report.id);
      if (!canManageArea(access, memo.area_id)) throw err.forbidden("자기 영역의 메모만 반영할 수 있습니다.");
      if (memo.status !== "pending") throw err.conflict("이미 처리된 메모입니다.");
      // 트랜잭션 안에서 전역 db 헬퍼를 다시 호출하면 단일 연결 테스트 DB가 교착될 수 있다.
      // 영역 소속 검증은 claim 트랜잭션에 들어가기 전에 끝낸다.
      const rawPayload = (memo.action_payload ?? {}) as Record<string, unknown>;
      const requestedAreaId = rawPayload.area_id;
      if (requestedAreaId != null) {
        if (!Number.isInteger(requestedAreaId)) throw err.badRequest("영역이 올바르지 않습니다.");
        await assertAreaInProject(requestedAreaId as number, pid);
      }

      const result = await db.transaction(async (tx) => {
        const [claimed] = await tx.update(dailyReportMemos).set({
          status: "applied",
          reviewed_by: req.userId!,
          applied_at: new Date(),
          updated_at: new Date(),
        }).where(and(eq(dailyReportMemos.id, memo.id), eq(dailyReportMemos.status, "pending"))).returning();
        if (!claimed) throw err.conflict("이미 처리된 메모입니다.");
        const payload = (claimed.action_payload ?? {}) as Record<string, unknown>;
        let targetTaskId: number | null = null;
        let targetEventId: number | null = null;

        if (claimed.action_type === "task_create") {
          const body = z.object({
            title: z.string().trim().min(1).max(500),
            description: z.string().max(10000).nullable().optional(),
            priority: z.number().int().min(0).max(3).optional(),
            label: z.string().max(100).nullable().optional(),
            due_date: z.coerce.date().nullable().optional(),
            scheduled_date: z.coerce.date().nullable().optional(),
            assignee_ids: z.array(z.number().int()).optional(),
            area_id: z.number().int().nullable().optional(),
          }).strict().parse(payload);
          const areaId = body.area_id ?? claimed.area_id;
          if (!canManageArea(access, areaId)) throw err.forbidden("자기 영역의 태스크만 만들 수 있습니다.");
          if (body.scheduled_date && body.due_date && body.due_date < body.scheduled_date)
            throw err.badRequest("마감일이 예정일보다 빠를 수 없습니다.");
          const seqResult: any = await tx.execute(sql`UPDATE projects SET next_task_seq = next_task_seq + 1, updated_at = now()
            WHERE id = ${pid} RETURNING key, next_task_seq - 1 AS assigned`);
          const seq = seqResult.rows[0];
          if (!seq) throw err.notFound("프로젝트를 찾을 수 없습니다.");
          const [task] = await tx.insert(tasks).values({
            project_id: pid,
            item_key: `${seq.key}-${seq.assigned}`,
            title: body.title,
            description: body.description ?? null,
            priority: body.priority ?? 0,
            label: body.label ?? null,
            due_date: body.due_date ?? null,
            scheduled_date: body.scheduled_date ?? null,
            area_id: areaId,
            created_by: req.userId!,
          }).returning();
          targetTaskId = task.id;
          const ids = [...new Set(body.assignee_ids ?? [])];
          if (ids.length) {
            const members = await tx.select({ user_id: projectMembers.user_id }).from(projectMembers)
              .where(and(eq(projectMembers.project_id, pid), inArray(projectMembers.user_id, ids)));
            if (members.length) await tx.insert(taskAssignees).values(members.map((member) => ({ task_id: task.id, user_id: member.user_id })));
          }
        } else if (claimed.action_type === "task_update") {
          const body = z.object({
            task_id: z.number().int(),
            title: z.string().trim().min(1).max(500).optional(),
            description: z.string().max(10000).nullable().optional(),
            status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
            priority: z.number().int().min(0).max(3).optional(),
            due_date: z.coerce.date().nullable().optional(),
            scheduled_date: z.coerce.date().nullable().optional(),
            area_id: z.number().int().nullable().optional(),
          }).strict().refine((value) => Object.keys(value).some((key) => key !== "task_id"), "태스크에서 변경할 값이 필요합니다.").parse(payload);
          const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, body.task_id), eq(tasks.project_id, pid))).limit(1);
          if (!task) throw err.notFound("반영할 태스크를 찾을 수 없습니다.");
          if (!canManageArea(access, task.area_id)) throw err.forbidden("자기 영역의 태스크만 변경할 수 있습니다.");
          if (body.area_id !== undefined && !canManageArea(access, body.area_id)) throw err.forbidden("태스크를 다른 영역으로 이동할 수 없습니다.");
          const finalScheduled = body.scheduled_date !== undefined ? body.scheduled_date : task.scheduled_date;
          const finalDue = body.due_date !== undefined ? body.due_date : task.due_date;
          if (finalScheduled && finalDue && finalDue < finalScheduled) throw err.badRequest("마감일이 예정일보다 빠를 수 없습니다.");
          const { task_id: _taskId, ...fields } = body;
          const statusChanged = body.status !== undefined && body.status !== task.status;
          await tx.update(tasks).set({
            ...fields,
            completed_at: statusChanged ? (body.status === "done" ? new Date() : null) : task.completed_at,
            updated_at: new Date(),
          }).where(eq(tasks.id, task.id));
          targetTaskId = task.id;
        } else if (claimed.action_type === "event_create") {
          const body = z.object({
            title: z.string().trim().min(1).max(500),
            description: z.string().max(10000).nullable().optional(),
            starts_at: z.coerce.date(),
            ends_at: z.coerce.date().nullable().optional(),
            all_day: z.boolean().optional(),
            remind_minutes: z.number().int().nullable().optional(),
            attendee_ids: z.array(z.number().int()).optional(),
          }).strict().parse(payload);
          if (body.ends_at && body.ends_at < body.starts_at) throw err.badRequest("종료 시각이 시작 시각보다 빠를 수 없습니다.");
          const [event] = await tx.insert(events).values({
            project_id: pid,
            title: body.title,
            description: body.description ?? null,
            starts_at: body.starts_at,
            ends_at: body.ends_at ?? null,
            all_day: body.all_day ?? false,
            remind_minutes: body.remind_minutes ?? null,
            created_by: req.userId!,
          }).returning();
          targetEventId = event.id;
          const ids = [...new Set([req.userId!, ...(body.attendee_ids ?? [])])];
          const members = await tx.select({ user_id: projectMembers.user_id }).from(projectMembers)
            .where(and(eq(projectMembers.project_id, pid), inArray(projectMembers.user_id, ids)));
          if (members.length) await tx.insert(eventAttendees).values(members.map((member) => ({ event_id: event.id, user_id: member.user_id })));
        }

        const [updated] = await tx.update(dailyReportMemos).set({ target_task_id: targetTaskId, target_event_id: targetEventId })
          .where(eq(dailyReportMemos.id, claimed.id)).returning();
        return updated;
      });

      await logActivity({ project_id: pid, task_id: result.target_task_id, user_id: req.userId, action: "report.memo_applied", meta: { report_id: report.id, memo_id: result.id, action_type: result.action_type, target_task_id: result.target_task_id, target_event_id: result.target_event_id } });
      res.json({ memo: result });
    }),
  );
}
