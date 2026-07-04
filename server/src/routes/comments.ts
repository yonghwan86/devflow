import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, asc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { comments, guideAssignees, taskAssignees, checklistItems, users, GUIDE_STATE } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser } from "../lib/taskService.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const canManage = (role: string) => role === "owner" || role === "manager";

// Assemble a comment with rendered (sanitized) html + guide-assignee states (+ checklist item context).
async function serializeComments(taskId: number) {
  const rows = await db
    .select({ c: comments, author: users })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.author_id))
    .where(eq(comments.task_id, taskId))
    .orderBy(asc(comments.created_at));
  const ids = rows.map((r) => r.c.id);
  const gaRows = ids.length
    ? await db
        .select({ ga: guideAssignees, user: users })
        .from(guideAssignees)
        .innerJoin(users, eq(users.id, guideAssignees.user_id))
        .where(inArray(guideAssignees.comment_id, ids))
    : [];
  const gaByComment = new Map<number, any[]>();
  for (const g of gaRows) {
    if (!gaByComment.has(g.ga.comment_id)) gaByComment.set(g.ga.comment_id, []);
    gaByComment.get(g.ga.comment_id)!.push({
      id: g.ga.id,
      user: publicUser(g.user),
      state: g.ga.state,
      note: g.ga.note,
      done_at: g.ga.done_at,
    });
  }
  // 체크리스트 항목 컨텍스트 (checklist_item_id가 있는 댓글의 항목 내용 표시용)
  const items = await db
    .select({ id: checklistItems.id, content: checklistItems.content })
    .from(checklistItems)
    .where(eq(checklistItems.task_id, taskId));
  const itemContent = new Map(items.map((i) => [i.id, i.content]));

  return rows.map((r) => {
    const assignees = gaByComment.get(r.c.id) ?? [];
    const applied = assignees.filter((a) => a.state === "applied").length;
    return {
      id: r.c.id,
      body: r.c.body,
      body_html: renderMarkdown(r.c.body),
      parent_id: r.c.parent_id,
      checklist_item_id: r.c.checklist_item_id,
      checklist_item_content: r.c.checklist_item_id ? itemContent.get(r.c.checklist_item_id) ?? null : null,
      is_guide: r.c.is_guide,
      author: publicUser(r.author),
      created_at: r.c.created_at,
      guide_assignees: assignees,
      guide_progress: r.c.is_guide ? { applied, total: assignees.length } : null,
    };
  });
}

export function commentsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // List comments for a task (member-only).
  r.get(
    "/",
    ah(async (req, res) => {
      const taskId = Number(req.query.task_id);
      const acc = await loadTaskForUser(taskId, req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      res.json({ comments: await serializeComments(taskId) });
    }),
  );

  // Create comment or guide (optionally attached to a checklist item for per-item feedback).
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          task_id: z.number().int(),
          body: z.string().min(1),
          parent_id: z.number().int().optional(),
          checklist_item_id: z.number().int().optional(),
          is_guide: z.boolean().optional(),
        })
        .parse(req.body);
      const acc = await loadTaskForUser(body.task_id, req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (body.is_guide && !canManage(acc.role)) throw err.forbidden("가이드는 owner/manager만 등록할 수 있습니다.");

      // checklist_item_id는 반드시 같은 태스크의 항목이어야 함 (교차 참조 차단)
      if (body.checklist_item_id != null) {
        const [item] = await db
          .select()
          .from(checklistItems)
          .where(and(eq(checklistItems.id, body.checklist_item_id), eq(checklistItems.task_id, body.task_id)))
          .limit(1);
        if (!item) throw err.badRequest("이 태스크의 체크리스트 항목이 아닙니다.");
      }

      const [c] = await db
        .insert(comments)
        .values({
          task_id: body.task_id,
          author_id: req.userId!,
          body: body.body,
          parent_id: body.parent_id ?? null,
          checklist_item_id: body.checklist_item_id ?? null,
          is_guide: !!body.is_guide,
        })
        .returning();

      // ★ Guide -> create a pending guide_assignee row for every task assignee (per-member tracking).
      if (body.is_guide) {
        const assignees = await db
          .select({ user_id: taskAssignees.user_id })
          .from(taskAssignees)
          .where(eq(taskAssignees.task_id, body.task_id));
        if (assignees.length) {
          await db
            .insert(guideAssignees)
            .values(assignees.map((a) => ({ comment_id: c.id, user_id: a.user_id, state: "pending" as const })))
            .onConflictDoNothing();
        }
        await logActivity({ project_id: acc.task.project_id, task_id: body.task_id, user_id: req.userId, action: "guide.created", meta: { comment_id: c.id, assignees: assignees.length, checklist_item_id: body.checklist_item_id ?? null } });
      } else {
        await logActivity({ project_id: acc.task.project_id, task_id: body.task_id, user_id: req.userId, action: "comment.created", meta: { comment_id: c.id, checklist_item_id: body.checklist_item_id ?? null } });
      }
      res.status(201).json({ comment: (await serializeComments(body.task_id)).find((x) => x.id === c.id) });
    }),
  );

  // ★ Per-member guide performance: applied / skipped + note. Updates only the caller's row.
  r.patch(
    "/:commentId/guide",
    ah(async (req, res) => {
      const body = z.object({ state: z.enum(GUIDE_STATE), note: z.string().optional() }).strict().parse(req.body);
      const commentId = Number(req.params.commentId);
      const [c] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
      if (!c || !c.is_guide) throw err.notFound("가이드를 찾을 수 없습니다.");
      const acc = await loadTaskForUser(c.task_id, req.userId!);
      if (!acc) throw err.forbidden();

      // must be an assignee of this guide (only the assignee can mark their own row)
      const [ga] = await db
        .select()
        .from(guideAssignees)
        .where(and(eq(guideAssignees.comment_id, commentId), eq(guideAssignees.user_id, req.userId!)))
        .limit(1);
      if (!ga) throw err.forbidden("이 가이드의 대상자가 아닙니다.");

      await db
        .update(guideAssignees)
        .set({ state: body.state, note: body.note ?? null, done_at: body.state === "pending" ? null : new Date() })
        .where(eq(guideAssignees.id, ga.id));
      await logActivity({ project_id: acc.task.project_id, task_id: c.task_id, user_id: req.userId, action: "guide.performed", meta: { comment_id: commentId, state: body.state } });
      res.json({ comment: (await serializeComments(c.task_id)).find((x) => x.id === commentId) });
    }),
  );

  // Delete a comment (author or manager/owner).
  r.delete(
    "/:commentId",
    ah(async (req, res) => {
      const commentId = Number(req.params.commentId);
      const [c] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
      if (!c) throw err.notFound();
      const acc = await loadTaskForUser(c.task_id, req.userId!);
      if (!acc) throw err.forbidden();
      if (c.author_id !== req.userId! && !canManage(acc.role)) throw err.forbidden();
      await db.delete(comments).where(eq(comments.id, commentId));
      res.json({ ok: true });
    }),
  );

  return r;
}
