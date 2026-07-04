import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  tasks,
  taskAssignees,
  checklistItems,
  projectMembers,
  users,
  comments,
  guideAssignees,
  taskDependencies,
  githubLinks,
  type Task,
  type MemberRole,
} from "../../../shared/schema.ts";
import { publicUser } from "./http.ts";

export interface TaskAccess {
  task: Task;
  role: MemberRole;
}

// Load a task and verify the requesting user is a member of its project (§10.5 object-level authz).
export async function loadTaskForUser(taskId: number, userId: number): Promise<TaskAccess | null> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return null;
  const [m] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, t.project_id), eq(projectMembers.user_id, userId)))
    .limit(1);
  if (!m) return null;
  return { task: t, role: m.role };
}

// ★ Atomic item_key generation (§5): single UPDATE ... RETURNING avoids number collisions.
export async function createTaskWithKey(input: {
  project_id: number;
  title: string;
  description?: string | null;
  priority?: number;
  label?: string | null;
  due_date?: Date | null;
  scheduled_date?: Date | null;
  parent_task_id?: number | null;
  created_by: number;
  assignee_ids?: number[];
}): Promise<Task> {
  return db.transaction(async (tx) => {
    const res: any = await tx.execute(
      sql`UPDATE projects SET next_task_seq = next_task_seq + 1, updated_at = now()
          WHERE id = ${input.project_id}
          RETURNING key, next_task_seq - 1 AS assigned`,
    );
    const row = res.rows[0];
    if (!row) throw new Error("project not found");
    const itemKey = `${row.key}-${row.assigned}`;

    const [t] = await tx
      .insert(tasks)
      .values({
        project_id: input.project_id,
        item_key: itemKey,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 0,
        label: input.label ?? null,
        due_date: input.due_date ?? null,
        scheduled_date: input.scheduled_date ?? null,
        parent_task_id: input.parent_task_id ?? null,
        created_by: input.created_by,
      })
      .returning();

    const ids = [...new Set(input.assignee_ids ?? [])];
    if (ids.length) {
      // only assign users who are members of the project
      const members = await tx
        .select({ user_id: projectMembers.user_id })
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, input.project_id), inArray(projectMembers.user_id, ids)));
      const valid = members.map((m) => m.user_id);
      if (valid.length)
        await tx.insert(taskAssignees).values(valid.map((uid) => ({ task_id: t.id, user_id: uid })));
    }
    return t;
  });
}

// Subtask rollup (§5): all children done -> parent done; a child reopening -> parent reopens.
export async function applyRollup(taskId: number): Promise<void> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t?.parent_task_id) return;
  const children = await db.select().from(tasks).where(eq(tasks.parent_task_id, t.parent_task_id));
  if (children.length === 0) return;
  const allDone = children.every((c) => c.status === "done");
  const [parent] = await db.select().from(tasks).where(eq(tasks.id, t.parent_task_id)).limit(1);
  if (!parent) return;
  if (allDone && parent.status !== "done") {
    await db
      .update(tasks)
      .set({ status: "done", completed_at: new Date(), updated_at: new Date() })
      .where(eq(tasks.id, parent.id));
  } else if (!allDone && parent.status === "done") {
    await db
      .update(tasks)
      .set({ status: "in_progress", completed_at: null, updated_at: new Date() })
      .where(eq(tasks.id, parent.id));
  }
}

// Assignees for a task (public shape).
export async function taskAssigneeUsers(taskId: number) {
  const rows = await db
    .select({ user: users })
    .from(taskAssignees)
    .innerJoin(users, eq(users.id, taskAssignees.user_id))
    .where(eq(taskAssignees.task_id, taskId));
  return rows.map((r) => publicUser(r.user));
}

// Guide progress badge (applied / total) across a task's guide comments (P3 surfaces it).
export async function guideProgressForTask(taskId: number): Promise<{ applied: number; total: number }> {
  const guideComments = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.task_id, taskId), eq(comments.is_guide, true)));
  if (guideComments.length === 0) return { applied: 0, total: 0 };
  const cids = guideComments.map((c) => c.id);
  const rows = await db.select().from(guideAssignees).where(inArray(guideAssignees.comment_id, cids));
  const total = rows.length;
  const applied = rows.filter((r) => r.state === "applied").length;
  return { applied, total };
}

// Checklist progress (done / total).
export async function checklistProgress(taskId: number): Promise<{ done: number; total: number }> {
  const rows = await db.select().from(checklistItems).where(eq(checklistItems.task_id, taskId));
  return { total: rows.length, done: rows.filter((r) => r.done).length };
}

// Full task detail payload (shared by /tasks/:id and by-key resolver).
export async function getTaskDetail(taskId: number) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return null;
  const checklist = await db
    .select()
    .from(checklistItems)
    .where(eq(checklistItems.task_id, taskId))
    .orderBy(checklistItems.sort_order);
  const subtasks = await db.select().from(tasks).where(eq(tasks.parent_task_id, taskId));
  // P6: 선행 태스크 / P8: GitHub 링크
  const depRows = await db
    .select({ dep: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.depends_on_task_id))
    .where(eq(taskDependencies.task_id, taskId));
  const links = await db.select().from(githubLinks).where(eq(githubLinks.task_id, taskId));
  return {
    task: t,
    assignees: await taskAssigneeUsers(taskId),
    checklist,
    subtasks,
    checklist_progress: await checklistProgress(taskId),
    guides: await guideProgressForTask(taskId),
    dependencies: depRows.map((r) => ({ id: r.dep.id, item_key: r.dep.item_key, title: r.dep.title, status: r.dep.status })),
    github_links: links,
  };
}
