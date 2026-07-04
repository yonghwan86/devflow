import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskDependencies, projectMembers } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser } from "../lib/taskService.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const canManage = (role: string) => role === "owner" || role === "manager";

// 사이클 검사: depends_on에서 의존 사슬을 따라가 task에 도달하면 사이클 (P6, Redmine precedes/follows 참고)
async function createsCycle(taskId: number, dependsOn: number): Promise<boolean> {
  const visited = new Set<number>([dependsOn]);
  let frontier = [dependsOn];
  while (frontier.length) {
    const rows = await db
      .select()
      .from(taskDependencies)
      .where(inArray(taskDependencies.task_id, frontier));
    frontier = [];
    for (const r of rows) {
      if (r.depends_on_task_id === taskId) return true;
      if (!visited.has(r.depends_on_task_id)) {
        visited.add(r.depends_on_task_id);
        frontier.push(r.depends_on_task_id);
      }
    }
  }
  return false;
}

export function dependenciesRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // 프로젝트 전체 의존성 (타임라인 뷰) — 서버측 멤버십 검사
  r.get(
    "/",
    ah(async (req, res) => {
      const projectId = Number(req.query.project_id);
      if (!Number.isInteger(projectId)) throw err.badRequest("project_id가 필요합니다.");
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, req.userId!)))
        .limit(1);
      if (!m) throw err.notFound("프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const taskIds = (
        await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.project_id, projectId))
      ).map((t) => t.id);
      const deps = taskIds.length
        ? await db.select().from(taskDependencies).where(inArray(taskDependencies.task_id, taskIds))
        : [];
      res.json({ dependencies: deps });
    }),
  );

  // 의존성 추가 (owner/manager). 같은 프로젝트 + 자기참조/사이클 금지.
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({ task_id: z.number().int(), depends_on_task_id: z.number().int() })
        .strict()
        .parse(req.body);
      if (body.task_id === body.depends_on_task_id) throw err.badRequest("자기 자신에게 의존할 수 없습니다.");

      const acc = await loadTaskForUser(body.task_id, req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw err.forbidden("의존성은 owner/manager만 관리할 수 있습니다.");
      const dep = await loadTaskForUser(body.depends_on_task_id, req.userId!);
      if (!dep) throw err.notFound("선행 태스크를 찾을 수 없거나 권한이 없습니다.");
      if (dep.task.project_id !== acc.task.project_id) throw err.badRequest("같은 프로젝트의 태스크만 연결할 수 있습니다.");

      if (await createsCycle(body.task_id, body.depends_on_task_id))
        throw err.badRequest("순환 의존이 생겨 추가할 수 없습니다.");

      await db
        .insert(taskDependencies)
        .values({ task_id: body.task_id, depends_on_task_id: body.depends_on_task_id })
        .onConflictDoNothing();
      await logActivity({
        project_id: acc.task.project_id,
        task_id: body.task_id,
        user_id: req.userId,
        action: "dependency.added",
        meta: { depends_on_task_id: body.depends_on_task_id },
      });
      res.status(201).json({ ok: true });
    }),
  );

  // 의존성 제거 (owner/manager)
  r.delete(
    "/:taskId/:dependsOnId",
    ah(async (req, res) => {
      const taskId = Number(req.params.taskId);
      const dependsOnId = Number(req.params.dependsOnId);
      const acc = await loadTaskForUser(taskId, req.userId!);
      if (!acc) throw err.notFound();
      if (!canManage(acc.role)) throw err.forbidden("의존성은 owner/manager만 관리할 수 있습니다.");
      await db
        .delete(taskDependencies)
        .where(and(eq(taskDependencies.task_id, taskId), eq(taskDependencies.depends_on_task_id, dependsOnId)));
      await logActivity({
        project_id: acc.task.project_id,
        task_id: taskId,
        user_id: req.userId,
        action: "dependency.removed",
        meta: { depends_on_task_id: dependsOnId },
      });
      res.json({ ok: true });
    }),
  );

  return r;
}
