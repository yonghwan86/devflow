import { Router, type Request } from "express";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  tasks,
  taskAssignees,
  projects,
  projectMembers,
  comments,
  guideAssignees,
  users,
  pages,
  events,
  eventAttendees,
  GUIDE_STATE,
  TASK_STATUS,
  TASK_PATCH_STATUS,
} from "../../../shared/schema.ts";
import { baseUrl } from "../lib/http.ts";
import { createTaskWithKey, loadTaskForUser, taskAssigneeUsers, getTaskDetail, applyRollup, addAssignee } from "../lib/taskService.ts";
import { serializeComments } from "./comments.ts";
import { searchEmbeddings } from "../lib/embeddings.ts";
import { logActivity } from "../lib/activity.ts";
import { resolveAttendees, syncAttendees } from "../lib/eventService.ts";

// ---------- P10: MCP 서버 (Streamable HTTP, JSON-RPC 2.0) ----------
// 인증: Authorization Bearer <api_token> (P1 api_tokens 재사용). 스코프(§7.11):
//   task:read task:write comment:write guide:write project:read skill:read
const PROTOCOL_VERSION = "2025-03-26";

class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function needScope(req: Request, scope: string): void {
  if (req.tokenScopes && !req.tokenScopes.includes(scope)) {
    throw new McpError(-32603, `토큰 스코프 부족: ${scope}`);
  }
}

const canManage = (role: string) => role === "owner" || role === "manager";

const TOOLS = [
  {
    name: "list_projects",
    description: "내가 속한 프로젝트 목록(id·key·name·내 역할)을 가져옵니다. 태스크 생성 등에 필요한 project_id를 이름으로 찾을 때 먼저 호출하세요.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_my_tasks",
    description: "내가 담당자로 배정된 미완료 태스크 목록을 가져옵니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_task",
    description: "item_key(예: PRJ-12)로 태스크 상세(체크리스트·진행률 포함)를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { item_key: { type: "string", description: "태스크 키 (예: PRJ-12)" } },
      required: ["item_key"],
      additionalProperties: false,
    },
  },
  {
    name: "list_project_members",
    description: "프로젝트 팀원 목록(user_id·이름·이메일·역할)을 가져옵니다. 태스크 담당자 지정 시 user_id를 이름으로 찾을 때 사용하세요.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "number" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "assign_task",
    description: "태스크에 담당자를 배정합니다 (owner/manager 전용). 가이드 pending 백필 포함.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" }, user_id: { type: "number" } },
      required: ["task_id", "user_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pages",
    description: "프로젝트 문서(pages) 목록(id·parent_id·제목)을 가져옵니다.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "number" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description: "프로젝트에 마크다운 문서를 생성합니다. parent_id로 트리 구성. ## 섹션+불릿 구조로 쓰면 웹의 '분해' 기능이 태스크+체크리스트로 변환할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        content: { type: "string", description: "마크다운 본문" },
        parent_id: { type: "number", description: "선택 — 부모 문서 id" },
        sort_order: { type: "number", description: "선택 — 트리 정렬 순서" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_project_tasks",
    description: "프로젝트의 태스크 목록(item_key·제목·상태·담당자)을 가져옵니다. status로 필터 가능.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        status: { type: "string", enum: [...TASK_STATUS], description: "선택 — 이 상태만 필터" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_task_status",
    description:
      "태스크 상태를 변경합니다 (todo|in_progress|blocked|done). 담당자 본인 또는 owner/manager만. requested/rejected 티켓은 승인/반려 API 전용이라 변경 불가.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        status: { type: "string", enum: [...TASK_PATCH_STATUS] },
      },
      required: ["task_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task_comments",
    description: "태스크의 댓글·가이드 목록을 가져옵니다. 가이드는 담당자별 수행 상태(pending/applied/skipped)를 포함합니다.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_task",
    description: "프로젝트에 태스크(할 일)를 생성합니다 (owner/manager 전용). 회의·마감·교육·행사 같은 '일정'은 create_event를 쓰세요 — 태스크로 만들면 담당자 없는 할 일로 잘못 표시됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
        scheduled_date: { type: "string", description: "YYYY-MM-DD (오늘 할 일 날짜)" },
        assignee_ids: { type: "array", items: { type: "number" } },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "add_guide",
    description: "태스크에 가이드 댓글을 답니다. 담당자별 수행 추적 행이 자동 생성됩니다 (owner/manager 전용).",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" }, body: { type: "string" } },
      required: ["task_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_guide_done",
    description: "내게 배정된 가이드를 수행완료(applied)/해당없음(skipped)으로 표시합니다.",
    inputSchema: {
      type: "object",
      properties: {
        comment_id: { type: "number" },
        state: { type: "string", enum: [...GUIDE_STATE] },
        note: { type: "string" },
      },
      required: ["comment_id", "state"],
      additionalProperties: false,
    },
  },
  {
    name: "devflow_search",
    description: "내가 속한 프로젝트의 태스크·댓글·스킬 지식베이스를 의미 기반으로 검색합니다.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, project_id: { type: "number" } },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description:
      "일정(이벤트)을 생성합니다. 회의·마감·교육·행사 등 '시간이 정해진 일'은 태스크(create_task)가 아니라 이 도구를 쓰세요 — 캘린더에 일정으로 표시되고 30분 전 리마인더가 갑니다. project_id를 주면 프로젝트 일정(팀 전체 공개), 생략하면 개인 일정.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        starts_at: { type: "string", description: "시작 — 시간 일정은 ISO 8601(예: 2026-07-14T10:00:00+09:00), 종일 일정(all_day:true)은 날짜만 YYYY-MM-DD" },
        ends_at: { type: "string", description: "선택 — 종료. 시간 일정은 ISO 8601, 종일 일정은 YYYY-MM-DD" },
        all_day: { type: "boolean", description: "선택 — 종일 일정 여부" },
        project_id: { type: "number", description: "선택 — 프로젝트 일정으로 만들 때" },
        description: { type: "string", description: "선택 — 설명" },
        attendee_ids: { type: "array", items: { type: "number" }, description: "선택 — 참석자 user_id 목록(프로젝트 멤버만, list_project_members로 조회). 참석자에게 초대 푸시가 발송됩니다" },
        include_creator: { type: "boolean", description: "선택(기본 true) — false면 등록자 본인은 불참(대리 등록: '제윤이 일정 잡아줘'). 본인이 리마인더를 받으려면 true 유지" },
      },
      required: ["title", "starts_at"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description: "기간 내 일정 목록(내 프로젝트 일정 + 개인 일정, 참석 여부 무관)을 참석자·생성자 정보와 함께 가져옵니다.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        project_id: { type: "number", description: "선택 — 이 프로젝트 일정만" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
];

async function callTool(req: Request, name: string, args: any): Promise<unknown> {
  const uid = req.userId!;
  switch (name) {
    case "list_projects": {
      needScope(req, "project:read");
      const rows = await db
        .select({ id: projects.id, key: projects.key, name: projects.name, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.project_id))
        .where(eq(projectMembers.user_id, uid));
      return { projects: rows };
    }
    case "list_my_tasks": {
      needScope(req, "task:read");
      const ids = (
        await db.select({ id: taskAssignees.task_id }).from(taskAssignees).where(eq(taskAssignees.user_id, uid))
      ).map((a) => a.id);
      if (!ids.length) return { tasks: [] };
      const rows = await db
        .select()
        .from(tasks)
        .where(and(inArray(tasks.id, ids), ne(tasks.status, "done")));
      return { tasks: rows.map((t) => ({ id: t.id, item_key: t.item_key, title: t.title, status: t.status, scheduled_date: t.scheduled_date, due_date: t.due_date, project_id: t.project_id })) };
    }
    case "get_task": {
      needScope(req, "task:read");
      const key = String(args?.item_key ?? "");
      const [t] = await db.select().from(tasks).where(eq(tasks.item_key, key)).limit(1);
      if (!t) throw new McpError(-32602, "태스크를 찾을 수 없습니다.");
      const acc = await loadTaskForUser(t.id, uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      return await getTaskDetail(t.id);
    }
    case "list_project_members": {
      needScope(req, "project:read");
      const projectId = Number(args?.project_id);
      const [me] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!me) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const rows = await db
        .select({ user: users, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.user_id))
        .where(eq(projectMembers.project_id, projectId));
      return { members: rows.map((r) => ({ user_id: r.user.id, name: r.user.full_name ?? r.user.email, email: r.user.email, role: r.role })) };
    }
    case "assign_task": {
      needScope(req, "task:write");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw new McpError(-32603, "담당자 배정은 owner/manager만 가능합니다.");
      const targetId = Number(args?.user_id);
      const ok = await addAssignee(acc.task.id, acc.task.project_id, targetId);
      if (!ok) throw new McpError(-32602, "프로젝트 멤버만 배정할 수 있습니다.");
      await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: uid, action: "task.assigned", meta: { user_id: targetId, via: "mcp" } });
      return { ok: true, task_id: acc.task.id, assignees: await taskAssigneeUsers(acc.task.id) };
    }
    case "list_pages": {
      needScope(req, "project:read");
      const projectId = Number(args?.project_id);
      const [me] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!me) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const rows = await db
        .select({ id: pages.id, parent_id: pages.parent_id, title: pages.title, sort_order: pages.sort_order, updated_at: pages.updated_at })
        .from(pages)
        // 휴지통(soft delete) 문서 제외 — REST 목록과 동일 규약 (휴지통 열람은 매니저 전용)
        .where(and(eq(pages.project_id, projectId), isNull(pages.deleted_at)));
      return { pages: rows };
    }
    case "create_page": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const [me] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!me) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const title = String(args?.title ?? "").trim();
      if (!title || title.length > 300) throw new McpError(-32602, "title은 1~300자여야 합니다.");
      let parentId: number | null = null;
      if (args?.parent_id != null) {
        parentId = Number(args.parent_id);
        const [parent] = await db
          .select({ id: pages.id })
          .from(pages)
          // 휴지통 문서를 부모로 허용하면 복원 시 그 아래로 편입되는 유령 트리가 생김 — REST와 동일하게 차단
          .where(and(eq(pages.id, parentId), eq(pages.project_id, projectId), isNull(pages.deleted_at)))
          .limit(1);
        if (!parent) throw new McpError(-32602, "부모 문서를 찾을 수 없습니다(같은 프로젝트만).");
      }
      const [p] = await db
        .insert(pages)
        .values({
          project_id: projectId,
          title,
          content: args?.content != null ? String(args.content) : "",
          parent_id: parentId,
          sort_order: args?.sort_order != null ? Number(args.sort_order) : 0,
          created_by: uid,
          updated_by: uid,
        })
        .returning();
      await logActivity({ project_id: projectId, user_id: uid, action: "page.created", meta: { page_id: p.id, title: p.title, via: "mcp" } });
      return { page: { id: p.id, title: p.title, parent_id: p.parent_id } };
    }
    case "list_project_tasks": {
      needScope(req, "task:read");
      const projectId = Number(args?.project_id);
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!m) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const statusFilter = args?.status != null ? String(args.status) : null;
      if (statusFilter && !(TASK_STATUS as readonly string[]).includes(statusFilter))
        throw new McpError(-32602, `status는 ${TASK_STATUS.join("|")} 중 하나여야 합니다.`);
      let rows = await db.select().from(tasks).where(eq(tasks.project_id, projectId));
      if (statusFilter) rows = rows.filter((t) => t.status === statusFilter);
      // 담당자 이름 벌크 조인 (태스크별 N+1 방지)
      const ids = rows.map((t) => t.id);
      const aRows = ids.length
        ? await db
            .select({ task_id: taskAssignees.task_id, user: users })
            .from(taskAssignees)
            .innerJoin(users, eq(users.id, taskAssignees.user_id))
            .where(inArray(taskAssignees.task_id, ids))
        : [];
      const byTask = new Map<number, { id: number; name: string }[]>();
      for (const a of aRows) {
        if (!byTask.has(a.task_id)) byTask.set(a.task_id, []);
        byTask.get(a.task_id)!.push({ id: a.user.id, name: a.user.full_name ?? a.user.email });
      }
      return {
        total: rows.length,
        tasks: rows.map((t) => ({
          id: t.id, item_key: t.item_key, title: t.title, status: t.status, kind: t.kind,
          priority: t.priority, scheduled_date: t.scheduled_date, due_date: t.due_date,
          assignees: byTask.get(t.id) ?? [],
        })),
      };
    }
    case "update_task_status": {
      needScope(req, "task:write");
      const status = String(args?.status ?? "");
      if (!(TASK_PATCH_STATUS as readonly string[]).includes(status))
        throw new McpError(-32602, `status는 ${TASK_PATCH_STATUS.join("|")} 중 하나여야 합니다.`);
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      // F1 불변식(REST PATCH와 동일): requested/rejected는 승인/반려 API 전용 — MCP로 우회 금지.
      if (acc.task.status === "requested" || acc.task.status === "rejected")
        throw new McpError(
          -32603,
          acc.task.status === "requested"
            ? "요청 상태 티켓은 승인/반려로만 처리할 수 있습니다."
            : "반려된 티켓의 상태는 변경할 수 없습니다.",
        );
      // 권한: 매니저 이상 or 담당자 본인(자기 태스크 상태만) — REST와 동일 규칙.
      if (!canManage(acc.role)) {
        const [mine] = await db
          .select()
          .from(taskAssignees)
          .where(and(eq(taskAssignees.task_id, acc.task.id), eq(taskAssignees.user_id, uid)))
          .limit(1);
        if (!mine) throw new McpError(-32603, "담당한 태스크의 상태만 변경할 수 있습니다.");
      }
      // REST PATCH와 동일 불변식: 같은 상태 재전송(LLM 재시도 흔함)에 completed_at을 덮어쓰지 않음
      const statusChanged = status !== acc.task.status;
      await db
        .update(tasks)
        .set({
          status: status as (typeof TASK_PATCH_STATUS)[number],
          ...(statusChanged ? { completed_at: status === "done" ? new Date() : null } : {}),
          updated_at: new Date(),
        })
        .where(eq(tasks.id, acc.task.id));
      if (statusChanged) {
        await applyRollup(acc.task.id); // 부모 태스크 진행률 롤업 (REST와 동일)
        await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: uid, action: "task.status_changed", meta: { status, via: "mcp" } });
      }
      return { ok: true, task: { id: acc.task.id, item_key: acc.task.item_key, title: acc.task.title, status } };
    }
    case "get_task_comments": {
      needScope(req, "task:read");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      const rows = await serializeComments(acc.task.id);
      // body_html은 LLM에 불필요(토큰 절약) — 마크다운 body만 반환.
      return { comments: rows.map(({ body_html: _html, ...rest }) => rest) };
    }
    case "create_task": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!m) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(m.role)) throw new McpError(-32603, "태스크 생성은 owner/manager만 가능합니다.");
      if (!args?.title) throw new McpError(-32602, "title이 필요합니다.");
      const t = await createTaskWithKey({
        project_id: projectId,
        title: String(args.title),
        description: args.description ? String(args.description) : null,
        scheduled_date: args.scheduled_date ? new Date(String(args.scheduled_date)) : null,
        assignee_ids: Array.isArray(args.assignee_ids) ? args.assignee_ids.map(Number) : [],
        created_by: uid,
      });
      await logActivity({ project_id: projectId, task_id: t.id, user_id: uid, action: "task.created", meta: { item_key: t.item_key, via: "mcp" } });
      return { task: { id: t.id, item_key: t.item_key, title: t.title }, assignees: await taskAssigneeUsers(t.id) };
    }
    case "add_guide": {
      needScope(req, "guide:write");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw new McpError(-32603, "가이드는 owner/manager만 등록할 수 있습니다.");
      if (!args?.body) throw new McpError(-32602, "body가 필요합니다.");
      const [c] = await db
        .insert(comments)
        .values({ task_id: acc.task.id, author_id: uid, body: String(args.body), is_guide: true })
        .returning();
      const assignees = await db
        .select({ user_id: taskAssignees.user_id })
        .from(taskAssignees)
        .where(eq(taskAssignees.task_id, acc.task.id));
      if (assignees.length) {
        await db
          .insert(guideAssignees)
          .values(assignees.map((a) => ({ comment_id: c.id, user_id: a.user_id, state: "pending" as const })))
          .onConflictDoNothing();
      }
      await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: uid, action: "guide.created", meta: { comment_id: c.id, via: "mcp" } });
      return { comment_id: c.id, assignees: assignees.length };
    }
    case "mark_guide_done": {
      needScope(req, "guide:write");
      const commentId = Number(args?.comment_id);
      const state = String(args?.state) as (typeof GUIDE_STATE)[number];
      if (!GUIDE_STATE.includes(state)) throw new McpError(-32602, "state는 pending|applied|skipped 중 하나여야 합니다.");
      const [c] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
      if (!c || !c.is_guide) throw new McpError(-32602, "가이드를 찾을 수 없습니다.");
      const acc = await loadTaskForUser(c.task_id, uid);
      if (!acc) throw new McpError(-32602, "권한이 없습니다.");
      const [ga] = await db
        .select()
        .from(guideAssignees)
        .where(and(eq(guideAssignees.comment_id, commentId), eq(guideAssignees.user_id, uid)))
        .limit(1);
      if (!ga) throw new McpError(-32603, "이 가이드의 대상자가 아닙니다.");
      await db
        .update(guideAssignees)
        .set({ state, note: args?.note ? String(args.note) : null, done_at: state === "pending" ? null : new Date() })
        .where(eq(guideAssignees.id, ga.id));
      await logActivity({ project_id: acc.task.project_id, task_id: c.task_id, user_id: uid, action: "guide.performed", meta: { comment_id: commentId, state, via: "mcp" } });
      return { ok: true, state };
    }
    case "devflow_search": {
      needScope(req, "project:read");
      const q = String(args?.q ?? "");
      if (!q) throw new McpError(-32602, "q가 필요합니다.");
      let pids = (
        await db.select({ id: projectMembers.project_id }).from(projectMembers).where(eq(projectMembers.user_id, uid))
      ).map((m) => m.id);
      if (args?.project_id != null) {
        const target = Number(args.project_id);
        if (!pids.includes(target)) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
        pids = [target];
      }
      const hits = await searchEmbeddings(q, pids, 8);
      return { results: hits.map((h) => ({ ...h, content: h.content.slice(0, 300) })) };
    }
    case "create_event": {
      needScope(req, "task:write");
      const title = String(args?.title ?? "").trim();
      if (!title || title.length > 300) throw new McpError(-32602, "title은 1~300자여야 합니다.");
      // 날짜만(YYYY-MM-DD) 오면 F5 종일 규약(UTC 자정)으로 정규화 — "+09:00 자정" 같은 값이 하루 밀려 보이는 사고 방지.
      // 오프셋 없는 로컬 시각("2026-07-20T10:00")은 서버 TZ에 따라 달라지므로 거부(오프셋 명시 요구).
      const parseWhen = (v: unknown) => {
        const s = String(v ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00.000Z`);
        // 구분자 T/공백 모두 감지, 소문자 z 오프셋 허용(RFC3339) — 오프셋 없으면 거부
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/i.test(s) && !/(z|[+-]\d{2}:?\d{2})$/i.test(s)) return new Date(NaN);
        return new Date(s);
      };
      const WHEN_MSG = "ISO 8601(시간대 오프셋 필수, 예: 2026-07-14T10:00:00+09:00) 또는 날짜만(YYYY-MM-DD)이어야 합니다.";
      const starts = parseWhen(args?.starts_at);
      if (isNaN(starts.getTime())) throw new McpError(-32602, `starts_at은 ${WHEN_MSG}`);
      let ends: Date | null = null;
      if (args?.ends_at != null) {
        ends = parseWhen(args.ends_at);
        if (isNaN(ends.getTime())) throw new McpError(-32602, `ends_at은 ${WHEN_MSG}`);
        if (ends.getTime() < starts.getTime()) throw new McpError(-32602, "종료 시각이 시작 시각보다 빠릅니다.");
      }
      const isAllDay = args?.all_day === true;
      if (isAllDay && (starts.getTime() % 86400_000 !== 0 || (ends && ends.getTime() % 86400_000 !== 0)))
        throw new McpError(-32602, "종일 일정(all_day)의 starts_at/ends_at은 날짜만(YYYY-MM-DD) 보내세요.");
      let projectId: number | null = null;
      if (args?.project_id != null) {
        projectId = Number(args.project_id);
        const [m] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
          .limit(1);
        if (!m) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      }
      // C9: REST와 동일한 공용 규칙 — 참석자 멤버십 검증·생성자 포함 여부·초대 push까지 일치
      const finalAttendees = await resolveAttendees({
        creatorId: uid,
        projectId,
        attendeeIds: Array.isArray(args?.attendee_ids) ? args.attendee_ids.map(Number) : [],
        includeCreator: args?.include_creator !== false,
      });
      const [ev] = await db
        .insert(events)
        .values({
          project_id: projectId,
          title,
          description: args?.description != null ? String(args.description) : null,
          starts_at: starts,
          ends_at: ends,
          all_day: isAllDay,
          created_by: uid,
        })
        .returning();
      await syncAttendees(ev, finalAttendees, uid);
      if (projectId != null)
        await logActivity({ project_id: projectId, user_id: uid, action: "event.created", meta: { event_id: ev.id, title: ev.title, via: "mcp" } });
      // 모델이 결과를 검증할 수 있게 최종 참석자(이름 포함)·생성자를 응답에 포함
      const attRows = finalAttendees.length
        ? await db.select().from(users).where(inArray(users.id, finalAttendees))
        : [];
      return {
        event: {
          id: ev.id, title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at,
          all_day: ev.all_day, project_id: ev.project_id, created_by: uid,
          attendees: attRows.map((u) => ({ id: u.id, name: u.full_name ?? u.email })),
        },
      };
    }
    case "list_events": {
      needScope(req, "project:read");
      const from = String(args?.from ?? "");
      const to = String(args?.to ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
        throw new McpError(-32602, "from/to는 YYYY-MM-DD 형식이어야 합니다.");
      const fromTs = new Date(`${from}T00:00:00.000Z`);
      const toTs = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400_000); // to+1일
      const pids = (
        await db.select({ id: projectMembers.project_id }).from(projectMembers).where(eq(projectMembers.user_id, uid))
      ).map((r) => r.id);
      let visible;
      if (args?.project_id != null) {
        const target = Number(args.project_id);
        if (!pids.includes(target)) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
        visible = eq(events.project_id, target);
      } else {
        // GET /api/events와 동일한 가시성: 내 프로젝트 일정 + 개인 일정(생성자 or 참석자)
        const attIds = (
          await db.select({ id: eventAttendees.event_id }).from(eventAttendees).where(eq(eventAttendees.user_id, uid))
        ).map((x) => x.id);
        visible = or(
          pids.length ? inArray(events.project_id, pids) : sql`false`,
          and(
            isNull(events.project_id),
            attIds.length ? or(eq(events.created_by, uid), inArray(events.id, attIds)) : eq(events.created_by, uid),
          ),
        );
      }
      const rows = await db
        .select()
        .from(events)
        .where(and(visible, lt(events.starts_at, toTs), gte(sql`coalesce(${events.ends_at}, ${events.starts_at})`, fromTs)));
      rows.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
      // 참석자 벌크 조인 — "누구 일정인지"를 모델이 알 수 있게 (N+1 방지)
      const evIds = rows.map((e) => e.id);
      const attRows = evIds.length
        ? await db
            .select({ event_id: eventAttendees.event_id, user: users })
            .from(eventAttendees)
            .innerJoin(users, eq(users.id, eventAttendees.user_id))
            .where(inArray(eventAttendees.event_id, evIds))
        : [];
      const attBy = new Map<number, { id: number; name: string }[]>();
      for (const a of attRows) {
        if (!attBy.has(a.event_id)) attBy.set(a.event_id, []);
        attBy.get(a.event_id)!.push({ id: a.user.id, name: a.user.full_name ?? a.user.email });
      }
      return {
        total: rows.length,
        events: rows.map((e) => ({
          id: e.id, title: e.title, description: e.description,
          starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, project_id: e.project_id,
          created_by: e.created_by, attendees: attBy.get(e.id) ?? [],
        })),
      };
    }
    default:
      throw new McpError(-32601, `알 수 없는 도구: ${name}`);
  }
}

export function mcpRouter(): Router {
  const r = Router();
  // MCP는 Bearer api_token 전용(세션 차단 — 세션은 tokenScopes가 없어 스코프 검사를 우회하므로).
  // 401에는 RFC 9728 WWW-Authenticate로 보호 리소스 메타데이터 위치를 알려 OAuth 디스커버리를 유도.
  r.use((req, res, next) => {
    if (!req.tokenScopes) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "인증이 필요합니다. OAuth 또는 API 토큰(Bearer)이 필요합니다." } });
    }
    next();
  });

  r.post("/", async (req, res) => {
    const msg = req.body;
    if (Array.isArray(msg)) {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch는 지원하지 않습니다." } });
    }
    const { id, method, params } = msg ?? {};
    // claude.ai 커넥터는 Streamable HTTP 응답을 text/event-stream(SSE)로 받길 요구한다(스펙보다 엄격).
    // Accept에 text/event-stream이 있으면 SSE로, 아니면(curl·테스트 등) JSON으로 응답 — 콘텐츠 협상.
    const wantsSse = String(req.headers.accept ?? "").includes("text/event-stream");
    const send = (body: unknown) => {
      if (wantsSse) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no"); // 프록시(nginx) 버퍼링 방지
        res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return res.end();
      }
      return res.json(body);
    };
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

    try {
      if (method === "initialize") {
        return reply({
          // 클라이언트가 요청한 프로토콜 버전을 그대로 수용(호환성 최대화), 없으면 서버 기본.
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "devflow-mcp", version: "0.2.0" }, // 도구 스키마 변경 시 범프 — 커넥터 캐시 판별용
        });
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return res.status(202).end(); // notification: 응답 본문 없음
      }
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools: TOOLS });
      if (method === "tools/call") {
        const name = String(params?.name ?? "");
        try {
          const result = await callTool(req, name, params?.arguments ?? {});
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
        } catch (e: any) {
          if (e instanceof McpError) return fail(e.code, e.message);
          return reply({ content: [{ type: "text", text: `오류: ${e?.message ?? e}` }], isError: true });
        }
      }
      return fail(-32601, `알 수 없는 메서드: ${method}`);
    } catch (e: any) {
      return fail(-32603, String(e?.message ?? e));
    }
  });

  // SSE 스트림은 미지원(단일 요청/응답 모드) — GET은 405
  r.get("/", (_req, res) => res.status(405).json({ error: { code: "method_not_allowed", message: "POST JSON-RPC만 지원합니다." } }));

  return r;
}
