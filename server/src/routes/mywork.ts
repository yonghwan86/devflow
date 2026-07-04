import { Router } from "express";
import { and, eq, ne, inArray, notInArray, sql, lte, gte } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, taskAssignees, projects, projectMembers, comments, guideAssignees } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { taskAssigneeUsers } from "../lib/taskService.ts";

// My Work (§6): today's scheduled tasks + due-soon + unperformed guides, across all projects.
// team_today: 같은 프로젝트 팀원들의 오늘 할 일(크로스 체킹·가이드용). 서버측 멤버십 필터 유지(§10.5).
export function myWorkRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    "/",
    ah(async (req, res) => {
      const uid = req.userId!;
      const tz = process.env.TZ ?? "Asia/Seoul";
      const isToday = sql`(${tasks.scheduled_date} AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date`;

      const assignedTaskIds = (
        await db.select({ id: taskAssignees.task_id }).from(taskAssignees).where(eq(taskAssignees.user_id, uid))
      ).map((a) => a.id);

      // 내가 멤버인 프로젝트 (team_today의 범위 — 비멤버 프로젝트는 절대 노출 안 됨)
      const myProjectIds = (
        await db.select({ id: projectMembers.project_id }).from(projectMembers).where(eq(projectMembers.user_id, uid))
      ).map((m) => m.id);

      const projectName = (pid: number, rows: { id: number; name: string }[]) =>
        rows.find((p) => p.id === pid)?.name ?? "";

      let today: any[] = [];
      let dueSoon: any[] = [];
      if (assignedTaskIds.length) {
        // Today's scheduled tasks (Asia/Seoul day), not done.
        today = await db
          .select()
          .from(tasks)
          .where(and(inArray(tasks.id, assignedTaskIds), ne(tasks.status, "done"), isToday));
        // Due within 48h, not done.
        const soon = new Date(Date.now() + 48 * 3600_000);
        dueSoon = await db
          .select()
          .from(tasks)
          .where(
            and(
              inArray(tasks.id, assignedTaskIds),
              ne(tasks.status, "done"),
              lte(tasks.due_date, soon),
              gte(tasks.due_date, new Date(Date.now() - 24 * 3600_000)),
            ),
          );
      }

      // ★ 팀원들의 오늘 할 일: 내가 속한 프로젝트의 오늘 태스크 중 내 담당이 아닌 것.
      let teamToday: any[] = [];
      if (myProjectIds.length) {
        const conds = [inArray(tasks.project_id, myProjectIds), ne(tasks.status, "done"), isToday];
        if (assignedTaskIds.length) conds.push(notInArray(tasks.id, assignedTaskIds));
        teamToday = await db.select().from(tasks).where(and(...conds));
      }

      const pids = [...new Set([...today, ...dueSoon, ...teamToday].map((t) => t.project_id))];
      const projRows = pids.length
        ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pids))
        : [];
      today = today.map((t) => ({ ...t, project_name: projectName(t.project_id, projRows) }));
      dueSoon = dueSoon.map((t) => ({ ...t, project_name: projectName(t.project_id, projRows) }));
      teamToday = await Promise.all(
        teamToday.map(async (t) => ({
          ...t,
          project_name: projectName(t.project_id, projRows),
          assignees: await taskAssigneeUsers(t.id),
        })),
      );

      // Unperformed guides assigned to me (state = pending). ★ P3 core metric.
      const pendingGuides = await db
        .select({
          guide_id: guideAssignees.id,
          comment_id: comments.id,
          body: comments.body,
          task_id: comments.task_id,
          project_id: tasks.project_id,
          item_key: tasks.item_key,
          task_title: tasks.title,
        })
        .from(guideAssignees)
        .innerJoin(comments, eq(comments.id, guideAssignees.comment_id))
        .innerJoin(tasks, eq(tasks.id, comments.task_id))
        .where(and(eq(guideAssignees.user_id, uid), eq(guideAssignees.state, "pending")));

      res.json({ today, team_today: teamToday, due_soon: dueSoon, pending_guides: pendingGuides });
    }),
  );

  return r;
}
