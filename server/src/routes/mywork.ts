import { Router } from "express";
import { and, eq, ne, inArray, notInArray, sql, lte, gte } from "drizzle-orm";
import type { Task } from "../../../shared/schema.ts";
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

      // ── F2: 칸반용 board_tasks + summary (기존 응답 필드는 그대로 유지) ──
      const dayKeyTz = (d: Date | null | undefined) =>
        d ? new Date(d).toLocaleDateString("sv-SE", { timeZone: tz }) : null; // YYYY-MM-DD (tz 기준)
      const todayKey = dayKeyTz(new Date())!;

      // ① 내가 담당자인 미완료(done/rejected 제외) 태스크
      const assignedOpen: Task[] = assignedTaskIds.length
        ? await db
            .select()
            .from(tasks)
            .where(and(inArray(tasks.id, assignedTaskIds), notInArray(tasks.status, ["done", "rejected"])))
        : [];
      // ③ 최근 7일 내 완료한 담당 태스크
      const weekAgo = new Date(Date.now() - 7 * 86400_000);
      const doneRecent: Task[] = assignedTaskIds.length
        ? await db
            .select()
            .from(tasks)
            .where(and(inArray(tasks.id, assignedTaskIds), eq(tasks.status, "done"), gte(tasks.completed_at, weekAgo)))
        : [];
      // ② 내가 요청한 requested/rejected 티켓 — 요청자는 담당자가 아니므로 별도 쿼리로 합친다(★)
      const myTickets: Task[] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.requested_by, uid), inArray(tasks.status, ["requested", "rejected"])));

      const boardMap = new Map<number, Task>();
      for (const t of [...assignedOpen, ...doneRecent, ...myTickets]) boardMap.set(t.id, t);
      const boardRaw = [...boardMap.values()];

      const boardPids = [...new Set(boardRaw.map((t) => t.project_id))];
      const boardProjRows = boardPids.length
        ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, boardPids))
        : [];
      const boardTasks = await Promise.all(
        boardRaw.map(async (t) => ({
          id: t.id,
          project_id: t.project_id,
          project_name: projectName(t.project_id, boardProjRows),
          item_key: t.item_key,
          title: t.title,
          status: t.status,
          kind: t.kind,
          requested_by: t.requested_by,
          priority: t.priority,
          due_date: t.due_date,
          scheduled_date: t.scheduled_date,
          completed_at: t.completed_at,
          assignees: await taskAssigneeUsers(t.id),
        })),
      );

      // summary — overdue = due_date < 오늘 && status ∉ {done, rejected} (tz 기준 day key 비교)
      const statusCounts: Record<string, number> = {};
      for (const t of boardTasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
      const active = boardTasks.filter((t) => t.status !== "done" && t.status !== "rejected");
      const todayDue = active.filter((t) => dayKeyTz(t.due_date) === todayKey).length;
      const overdue = active.filter((t) => {
        const k = dayKeyTz(t.due_date);
        return k != null && k < todayKey;
      }).length;
      // 이번 주(월~일) 일별 완료 수 — doneRecent의 completed_at 기준
      const now = new Date();
      const dowSun0 = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now) === "Sun"
          ? 0
          : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
              new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now),
            ) + 1,
      );
      const daysSinceMonday = (dowSun0 + 6) % 7; // 월=0 … 일=6
      const weekKeys: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getTime() - (daysSinceMonday - i) * 86400_000);
        weekKeys.push(dayKeyTz(d)!);
      }
      const completedThisWeek = weekKeys.map(
        (k) => doneRecent.filter((t) => dayKeyTz(t.completed_at) === k).length,
      );

      res.json({
        today,
        team_today: teamToday,
        due_soon: dueSoon,
        pending_guides: pendingGuides,
        board_tasks: boardTasks,
        summary: {
          status_counts: statusCounts,
          today_due: todayDue,
          overdue,
          completed_this_week: completedThisWeek, // 월~일
        },
      });
    }),
  );

  return r;
}
