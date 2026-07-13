import type { Router } from "express";
import { z } from "zod";
import { and, asc, eq, desc, isNull } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, pages } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { err } from "../lib/errors.ts";
import { requireMember } from "../middleware/auth.ts";
import { createTaskWithKey, taskAssigneeUsers, guideProgressForTask, checklistProgress, getTaskDetail, assertValidParent } from "../lib/taskService.ts";
import { logActivity } from "../lib/activity.ts";
import { notifyProjectManagers } from "../lib/push.ts";

// F4: source_page_id는 같은 프로젝트의 문서만 허용 (크로스 프로젝트 참조 차단).
// 휴지통(soft delete) 문서도 새 출처로는 불가 — 기존 태스크의 연결 유지와는 별개(신규 생성 시에만 검증)
async function assertPageInProject(pageId: number, projectId: number): Promise<void> {
  const [p] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.project_id, projectId), isNull(pages.deleted_at)))
    .limit(1);
  if (!p) throw err.badRequest("source_page_id가 이 프로젝트의 문서가 아닙니다.");
}

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
        // 등록순(먼저 등록이 위) — 문서 분해 태스크가 문서 순서로 보이게. 드래그 순서(sort_order desc)가 우선.
        // id asc 최종 tie-break: 일괄 생성분은 created_at이 같아 이것 없이는 문서 순서가 보장 안 된다.
        .orderBy(desc(tasks.sort_order), asc(tasks.created_at), asc(tasks.id));
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

  // Create — owner/manager는 일반 태스크, member는 티켓(requested)으로 생성 (F1).
  // ★ 클라이언트가 보내는 kind/status/requested_by는 절대 신뢰하지 않는다 — 서버가 role로 강제.
  r.post(
    "/:projectId/tasks",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const role = req.membership!.role;

      if (role === "member") {
        // member: 허용 입력만 추출(비허용 필드는 무시 — non-strict zod가 kind/status/assignee_ids 등을 벗겨냄)
        const body = z
          .object({
            title: z.string().min(1),
            description: z.string().optional(),
            priority: z.number().int().min(0).max(3).optional(),
            due_date: z.coerce.date().optional(), // 희망 마감일(제안)
            source_page_id: z.number().int().optional(), // F4: 문서 파생
          })
          .parse(req.body);
        if (body.source_page_id !== undefined) await assertPageInProject(body.source_page_id, pid);
        const t = await createTaskWithKey({
          ...body,
          project_id: pid,
          created_by: req.userId!,
          kind: "ticket",
          status: "requested",
          requested_by: req.userId!,
        });
        await logActivity({ project_id: pid, task_id: t.id, user_id: req.userId, action: "ticket.requested", meta: { item_key: t.item_key } });
        await notifyProjectManagers(pid, {
          title: "새 티켓 요청",
          body: `${t.item_key} ${t.title}`,
          url: `/projects/${pid}/tasks/${t.item_key}`,
        });
        return res.status(201).json({
          task: { ...t, assignees: [], checklist: { done: 0, total: 0 }, guides: { applied: 0, total: 0 } },
        });
      }

      // owner/manager: 기존과 동일 (kind=task, status=todo 기본)
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
          source_page_id: z.number().int().optional(), // F4: 문서 파생
        })
        .parse(req.body);
      if (body.source_page_id !== undefined) await assertPageInProject(body.source_page_id, pid);
      if (body.parent_task_id !== undefined) await assertValidParent(null, body.parent_task_id, pid);
      if (body.scheduled_date && body.due_date && body.due_date.getTime() < body.scheduled_date.getTime())
        throw err.badRequest("마감일이 예정일보다 빠를 수 없습니다.");
      const t = await createTaskWithKey({ ...body, project_id: pid, created_by: req.userId! });
      await logActivity({ project_id: pid, task_id: t.id, user_id: req.userId, action: "task.created", meta: { item_key: t.item_key } });
      res.status(201).json({
        task: { ...t, assignees: await taskAssigneeUsers(t.id), checklist: { done: 0, total: 0 }, guides: { applied: 0, total: 0 } },
      });
    }),
  );
}
