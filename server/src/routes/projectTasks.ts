import type { Router } from "express";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireMember, requireRole } from "../middleware/auth.ts";
import { createTaskWithKey, taskAssigneeUsers, guideProgressForTask, checklistProgress, getTaskDetail } from "../lib/taskService.ts";
import { logActivity } from "../lib/activity.ts";

// Task routes nested under /projects/:projectId (P2). Same data powers List/Kanban/Calendar.
export function registerProjectTaskRoutes(r: Router): void {
  // List — server-side membership enforced by requireMember (§8/§12).
  r.get(
    "/:projectId/tasks",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const rows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.project_id, pid))
        .orderBy(desc(tasks.sort_order), desc(tasks.created_at));
      const enriched = await Promise.all(
        rows.map(async (t) => ({
          ...t,
          assignees: await taskAssigneeUsers(t.id),
          checklist: await checklistProgress(t.id),
          guides: await guideProgressForTask(t.id),
        })),
      );
      res.json({ tasks: enriched });
    }),
  );

  // Resolve a task by its item_key (board/MyWork links use item_key).
  r.get(
    "/:projectId/tasks/by-key/:itemKey",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const [t] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.project_id, pid), eq(tasks.item_key, req.params.itemKey)))
        .limit(1);
      if (!t) return res.status(404).json({ error: { code: "not_found", message: "태스크를 찾을 수 없습니다." } });
      const detail = await getTaskDetail(t.id);
      res.json({ ...detail, my_role: req.membership!.role });
    }),
  );

  // Create — owner/manager. Atomic item_key.
  r.post(
    "/:projectId/tasks",
    requireMember(),
    requireRole("owner", "manager"),
    ah(async (req, res) => {
      const body = z
        .object({
          title: z.string().min(1),
          description: z.string().optional(),
          priority: z.number().int().min(0).max(3).optional(),
          label: z.string().optional(),
          due_date: z.coerce.date().optional(),
          scheduled_date: z.coerce.date().optional(),
          parent_task_id: z.number().int().optional(),
          assignee_ids: z.array(z.number().int()).optional(),
        })
        .parse(req.body);
      const pid = req.membership!.project_id;
      const t = await createTaskWithKey({ ...body, project_id: pid, created_by: req.userId! });
      await logActivity({ project_id: pid, task_id: t.id, user_id: req.userId, action: "task.created", meta: { item_key: t.item_key } });
      res.status(201).json({
        task: { ...t, assignees: await taskAssigneeUsers(t.id), checklist: { done: 0, total: 0 }, guides: { applied: 0, total: 0 } },
      });
    }),
  );
}
