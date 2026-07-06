import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, checklistItems, comments, TASK_PATCH_STATUS } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser, applyRollup, taskAssigneeUsers, guideProgressForTask, checklistProgress, getTaskDetail, addAssignee, assertValidParent } from "../lib/taskService.ts";
import { sendPushToUser } from "../lib/push.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const canManage = (role: string) => role === "owner" || role === "manager";

// R0-5: 체크리스트 조작 권한 — 해당 태스크 담당자 또는 owner/manager만.
async function canTouchChecklist(taskId: number, role: string, userId: number): Promise<boolean> {
  if (canManage(role)) return true;
  const [mine] = await db
    .select()
    .from(taskAssignees)
    .where(and(eq(taskAssignees.task_id, taskId), eq(taskAssignees.user_id, userId)))
    .limit(1);
  return !!mine;
}

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
          // F1: 일반 PATCH로는 requested/rejected로 전이 불가 (승인/반려 API 전용)
          status: z.enum(TASK_PATCH_STATUS).optional(),
          priority: z.number().int().min(0).max(3).optional(),
          label: z.string().nullable().optional(),
          due_date: z.coerce.date().nullable().optional(),
          scheduled_date: z.coerce.date().nullable().optional(),
          parent_task_id: z.number().int().nullable().optional(),
          sort_order: z.number().int().optional(),
        })
        .strict()
        .parse(req.body);

      // F1: requested/rejected 상태의 태스크는 일반 PATCH로 status 전이 불가(매니저 포함).
      // requested → 승인/반려 API로만(알림·이력 일원화), rejected → 재요청은 새 티켓으로.
      if (patch.status && (acc.task.status === "requested" || acc.task.status === "rejected")) {
        throw err.conflict(
          acc.task.status === "requested"
            ? "요청 상태 티켓은 승인/반려로만 처리할 수 있습니다."
            : "반려된 티켓의 상태는 변경할 수 없습니다. 필요하면 새 티켓으로 요청하세요.",
        );
      }

      if (!canManage(acc.role)) {
        const keys = Object.keys(patch);
        // F1: 요청자는 자기 requested 티켓의 title/description/priority만 수정 가능
        const isMyRequestedTicket =
          acc.task.kind === "ticket" && acc.task.status === "requested" && acc.task.requested_by === req.userId;
        if (isMyRequestedTicket) {
          const allowed = new Set(["title", "description", "priority"]);
          if (keys.some((k) => !allowed.has(k)))
            throw err.forbidden("검토 대기 중인 티켓은 제목·설명·우선순위만 수정할 수 있습니다.");
        } else {
          // members: only status changes on their own assigned tasks
          const [mine] = await db
            .select()
            .from(taskAssignees)
            .where(and(eq(taskAssignees.task_id, acc.task.id), eq(taskAssignees.user_id, req.userId!)))
            .limit(1);
          if (!mine || keys.some((k) => k !== "status")) throw err.forbidden("담당한 태스크의 상태만 변경할 수 있습니다.");
        }
      }

      // parent_task_id 지정 시 같은 프로젝트 + 순환 방지 검증 (매니저만 여기 도달)
      if (patch.parent_task_id != null) {
        await assertValidParent(acc.task.id, patch.parent_task_id, acc.task.project_id);
      }

      // 날짜 정합: 병합 후 상태 기준(부분 PATCH 대응) — 마감일이 예정일보다 앞서면 거부.
      // 단, 날짜 필드를 건드리지 않는 요청(status-only 등)은 검사하지 않음 —
      // 과거에 이미 뒤집혀 저장된 태스크의 상태 변경까지 엉뚱한 400으로 막히는 것 방지.
      if (patch.scheduled_date !== undefined || patch.due_date !== undefined) {
        const finalScheduled = patch.scheduled_date !== undefined ? patch.scheduled_date : acc.task.scheduled_date;
        const finalDue = patch.due_date !== undefined ? patch.due_date : acc.task.due_date;
        if (finalScheduled && finalDue && new Date(finalDue).getTime() < new Date(finalScheduled).getTime())
          throw err.badRequest("마감일이 예정일보다 빠를 수 없습니다.");
      }

      // done→done 같은 무변화 status 재전송(칸반 재드롭·pill 재클릭)에 completed_at을 덮어쓰지 않는다
      const statusChanged = !!patch.status && patch.status !== acc.task.status;
      const set: Record<string, unknown> = { ...patch, updated_at: new Date() };
      if (statusChanged) {
        set.completed_at = patch.status === "done" ? new Date() : null;
      }
      const [t] = await db.update(tasks).set(set).where(eq(tasks.id, acc.task.id)).returning();
      if (statusChanged) {
        await applyRollup(t.id);
        await logActivity({ project_id: t.project_id, task_id: t.id, user_id: req.userId, action: "task.status_changed", meta: { status: patch.status } });
      } else {
        await logActivity({ project_id: t.project_id, task_id: t.id, user_id: req.userId, action: "task.updated", meta: { fields: Object.keys(patch) } });
      }
      const [fresh] = await db.select().from(tasks).where(eq(tasks.id, t.id)).limit(1);
      res.json({ task: fresh });
    }),
  );

  // Delete (owner/manager) — F1: member 본인은 자기 requested 티켓만 철회 가능.
  r.delete(
    "/:taskId",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      const isMyRequestedTicket =
        acc.task.kind === "ticket" && acc.task.status === "requested" && acc.task.requested_by === req.userId;
      if (!canManage(acc.role) && !isMyRequestedTicket) throw err.forbidden();
      await db.delete(tasks).where(eq(tasks.id, acc.task.id));
      // 삭제된 태스크는 FK 참조 불가 — task_id는 비우고 meta로 감사 기록(기존 잠재 버그 수정)
      await logActivity({
        project_id: acc.task.project_id,
        task_id: null,
        user_id: req.userId,
        action: !canManage(acc.role) && isMyRequestedTicket ? "ticket.withdrawn" : "task.deleted",
        meta: { item_key: acc.task.item_key, task_id: acc.task.id, title: acc.task.title },
      });
      res.json({ ok: true });
    }),
  );

  // ── F1-3: 티켓 승인 — requested → todo/in_progress/blocked + 담당자 배정(가이드 백필 포함) ──
  r.post(
    "/:taskId/approve",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw err.forbidden("owner/manager만 승인할 수 있습니다.");
      if (!(acc.task.kind === "ticket" && acc.task.status === "requested"))
        throw err.conflict("요청 상태의 티켓만 승인할 수 있습니다.");
      const body = z
        .object({
          status: z.enum(["todo", "in_progress", "blocked"]).optional(),
          assignee_ids: z.array(z.number().int()).optional(),
          scheduled_date: z.coerce.date().nullable().optional(), // 승인과 동시에 착수일 지정 (무날짜 증발 방지)
        })
        .strict()
        .parse(req.body);
      // 착수일이 희망 마감일보다 늦으면 거부 — 이후 모든 PATCH가 날짜 정합 오류로 막히는 상태 방지
      if (body.scheduled_date && acc.task.due_date && new Date(acc.task.due_date).getTime() < body.scheduled_date.getTime())
        throw err.badRequest(`착수일이 희망 마감일(${new Date(acc.task.due_date).toISOString().slice(0, 10)})보다 늦어요. 착수일을 조정하세요.`);
      const newStatus = body.status ?? "todo";
      await db
        .update(tasks)
        .set({
          status: newStatus,
          ...(body.scheduled_date !== undefined ? { scheduled_date: body.scheduled_date } : {}),
          updated_at: new Date(),
        })
        .where(eq(tasks.id, acc.task.id));
      // 담당자 배정 — addAssignee 헬퍼 재사용(멤버십 검증 + 가이드 pending 백필)
      for (const uid of [...new Set(body.assignee_ids ?? [])]) {
        const ok = await addAssignee(acc.task.id, acc.task.project_id, uid);
        if (!ok) throw err.badRequest("프로젝트 멤버만 배정할 수 있습니다.");
      }
      await logActivity({
        project_id: acc.task.project_id,
        task_id: acc.task.id,
        user_id: req.userId,
        action: "ticket.approved",
        meta: { status: newStatus, assignee_ids: body.assignee_ids ?? [] },
      });
      if (acc.task.requested_by) {
        await sendPushToUser(acc.task.requested_by, {
          title: "티켓이 승인되었어요",
          body: `${acc.task.item_key} ${acc.task.title}`,
          url: `/projects/${acc.task.project_id}/tasks/${acc.task.item_key}`,
        });
      }
      const [fresh] = await db.select().from(tasks).where(eq(tasks.id, acc.task.id)).limit(1);
      res.json({ task: fresh, assignees: await taskAssigneeUsers(acc.task.id) });
    }),
  );

  // ── F1-3: 티켓 반려 — 사유 필수, completed_at 미설정, 사유는 댓글로 이력화 ──
  r.post(
    "/:taskId/reject",
    ah(async (req, res) => {
      const acc = await loadTaskForUser(Number(req.params.taskId), req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw err.forbidden("owner/manager만 반려할 수 있습니다.");
      if (!(acc.task.kind === "ticket" && acc.task.status === "requested"))
        throw err.conflict("요청 상태의 티켓만 반려할 수 있습니다.");
      const body = z
        .object({ reason: z.string().trim().min(1, "반려 사유를 입력하세요.") })
        .strict()
        .parse(req.body);
      // rejected는 done이 아니다 — completed_at 세팅 금지
      await db.update(tasks).set({ status: "rejected", updated_at: new Date() }).where(eq(tasks.id, acc.task.id));
      await db.insert(comments).values({
        task_id: acc.task.id,
        author_id: req.userId!,
        body: `**반려 사유**: ${body.reason}`,
        is_guide: false,
      });
      await logActivity({
        project_id: acc.task.project_id,
        task_id: acc.task.id,
        user_id: req.userId,
        action: "ticket.rejected",
        meta: { reason: body.reason },
      });
      if (acc.task.requested_by) {
        await sendPushToUser(acc.task.requested_by, {
          title: "티켓이 반려되었어요",
          body: `${acc.task.item_key} ${acc.task.title} — ${body.reason}`,
          url: `/projects/${acc.task.project_id}/tasks/${acc.task.item_key}`,
        });
      }
      const [fresh] = await db.select().from(tasks).where(eq(tasks.id, acc.task.id)).limit(1);
      res.json({ task: fresh });
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
      // F1 리팩터: addAssignee 헬퍼(멤버십 검증 + 가이드 pending 백필) — 승인 API와 공유
      const ok = await addAssignee(acc.task.id, acc.task.project_id, body.user_id);
      if (!ok) throw err.badRequest("프로젝트 멤버만 배정할 수 있습니다.");
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
      if (!(await canTouchChecklist(acc.task.id, acc.role, req.userId!)))
        throw err.forbidden("담당자 또는 매니저만 체크리스트를 수정할 수 있습니다.");
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
      if (!(await canTouchChecklist(acc.task.id, acc.role, req.userId!)))
        throw err.forbidden("담당자 또는 매니저만 체크리스트를 수정할 수 있습니다.");
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
      // G3-3: 추가·수정(토글)은 담당자+매니저지만, 삭제는 매니저 전용(오삭제 방지)
      if (!canManage(acc.role)) throw err.forbidden("체크리스트 삭제는 매니저만 할 수 있습니다.");
      await db
        .delete(checklistItems)
        .where(and(eq(checklistItems.id, Number(req.params.itemId)), eq(checklistItems.task_id, acc.task.id)));
      res.json({ ok: true });
    }),
  );

  return r;
}
