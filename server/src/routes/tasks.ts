import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, checklistItems, projectMembers, comments, guideAssignees, TASK_STATUS } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser, applyRollup, taskAssigneeUsers, guideProgressForTask, checklistProgress, getTaskDetail } from "../lib/taskService.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const canManage = (role: string) => role === "owner" || role === "manager";

export function tasksRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // Detail (any project member).
  r.get(
    "/:taskId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      const detail = await getTaskDetail(acc.task.id);
      res.json({ ...detail, my_role: acc.role });
    }),
  );

  // Update — PATCH strict whitelist (§10.3). Members may only toggle status of tasks they are assigned to.
  r.patch(
    "/:taskId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      const patch = z
        .object({
          title: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          status: z.enum(TASK_STATUS).optional(),
          priority: z.number().int().min(0).max(3).optional(),
          label: z.string().nullable().optional(),
          due_date: z.coerce.date().nullable().optional(),
          scheduled_date: z.coerce.date().nullable().optional(),
          parent_task_id: z.number().int().nullable().optional(),
          sort_order: z.number().int().optional(),
        })
        .strict()
        .parse(req.body);

      if (!canManage(acc.role)) {
        // members: only status changes on their own assigned tasks
        const keys = Object.keys(patch);
        const [mine] = await db
          .select()
          .from(taskAssignees)
          .where(and(eq(taskAssignees.task_id, acc.task.id), eq(taskAssignees.user_id, req.userId!)))
          .limit(1);
        if (!mine || keys.some((k) => k !== "status")) throw err.forbidden("담당한 태스크의 상태만 변경할 수 있습니다.");
      }

      const set: Record<string, unknown> = { ...patch, updated_at: new Date() };
      if (patch.status) {
        set.completed_at = patch.status === "done" ? new Date() : null;
      }
      const [t] = await db.update(tasks).set(set).where(eq(tasks.id, acc.task.id)).returning();
      if (patch.status) {
        await applyRollup(t.id);
        await logActivity({ project_id: t.project_id, task_id: t.id, user_id: req.userId, action: "task.status_changed", meta: { status: patch.status } });
      } else {
        await logActivity({ project_id: t.project_id, task_id: t.id, user_id: req.userId, action: "task.updated", meta: { fields: Object.keys(patch) } });
      }
      const [fresh] = await db.select().from(tasks).where(eq(tasks.id, t.id)).limit(1);
      res.json({ task: fresh });
    }),
  );

  // Delete (owner/manager).
  r.delete(
    "/:taskId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw err.forbidden();
      await db.delete(tasks).where(eq(tasks.id, acc.task.id));
      await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: req.userId, action: "task.deleted" });
      res.json({ ok: true });
    }),
  );

  // Assignees (owner/manager). Daily assignment happens by setting scheduled_date + assignee.
  r.post(
    "/:taskId/assignees",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound();
      if (!canManage(acc.role)) throw err.forbidden();
      const body = z.object({ user_id: z.number().int() }).parse(req.body);
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, acc.task.project_id), eq(projectMembers.user_id, body.user_id)))
        .limit(1);
      if (!m) throw err.badRequest("프로젝트 멤버만 배정할 수 있습니다.");
      await db.insert(taskAssignees).values({ task_id: acc.task.id, user_id: body.user_id }).onConflictDoNothing();
      // Backfill pending guide rows so a late assignee is tracked on existing guides (per-member tracking).
      const guides = await db
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.task_id, acc.task.id), eq(comments.is_guide, true)));
      if (guides.length) {
        await db
          .insert(guideAssignees)
          .values(guides.map((g) => ({ comment_id: g.id, user_id: body.user_id, state: "pending" as const })))
          .onConflictDoNothing();
      }
      await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: req.userId, action: "task.assigned", meta: { user_id: body.user_id } });
      res.status(201).json({ assignees: await taskAssigneeUsers(acc.task.id) });
    }),
  );

  r.delete(
    "/:taskId/assignees/:userId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound();
      if (!canManage(acc.role)) throw err.forbidden();
      await db
        .delete(taskAssignees)
        .where(and(eq(taskAssignees.task_id, acc.task.id), eq(taskAssignees.user_id, Number(req.params.userId))));
      res.json({ assignees: await taskAssigneeUsers(acc.task.id) });
    }),
  );

  // Checklist items.
  r.post(
    "/:taskId/checklist",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound();
      const body = z.object({ content: z.string().min(1) }).parse(req.body);
      const [c] = await db.insert(checklistItems).values({ task_id: acc.task.id, content: body.content }).returning();
      res.status(201).json({ item: c });
    }),
  );

  r.patch(
    "/:taskId/checklist/:itemId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound();
      const body = z.object({ done: z.boolean().optional(), content: z.string().min(1).optional() }).strict().parse(req.body);
      const set: Record<string, unknown> = { ...body };
      if (body.done !== undefined) {
        set.done_at = body.done ? new Date() : null;
        set.done_by = body.done ? req.userId! : null;
      }
      const [c] = await db
        .update(checklistItems)
        .set(set)
        .where(and(eq(checklistItems.id, Number(req.params.itemId)), eq(checklistItems.task_id, acc.task.id)))
        .returning();
      if (!c) throw err.notFound();
      res.json({ item: c, progress: await checklistProgress(acc.task.id) });
    }),
  );

  r.delete(
    "/:taskId/checklist/:itemId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound();
      await db
        .delete(checklistItems)
        .where(and(eq(checklistItems.id, Number(req.params.itemId)), eq(checklistItems.task_id, acc.task.id)));
      res.json({ ok: true });
    }),
  );

  return r;
}
