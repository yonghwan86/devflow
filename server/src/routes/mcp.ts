import { Router, type Request } from "express";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  tasks,
  taskAssignees,
  projects,
  projectMembers,
  comments,
  guideAssignees,
  GUIDE_STATE,
} from "../../../shared/schema.ts";
import { requireAuth } from "../middleware/auth.ts";
import { err } from "../lib/errors.ts";
import { createTaskWithKey, loadTaskForUser, taskAssigneeUsers, getTaskDetail } from "../lib/taskService.ts";
import { searchEmbeddings } from "../lib/embeddings.ts";
import { logActivity } from "../lib/activity.ts";

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
    name: "create_task",
    description: "프로젝트에 태스크를 생성합니다 (owner/manager 전용).",
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
];

async function callTool(req: Request, name: string, args: any): Promise<unknown> {
  const uid = req.userId!;
  switch (name) {
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
    default:
      throw new McpError(-32601, `알 수 없는 도구: ${name}`);
  }
}

export function mcpRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  // R0-2: MCP는 Bearer api_token 전용 — 세션 접근 차단(세션은 tokenScopes가 없어 스코프 검사를 전부 우회하므로).
  // tokenScopes는 middleware/auth.ts의 Bearer 경로에서만 세팅된다.
  r.use((req, _res, next) => {
    if (!req.tokenScopes) return next(err.unauthorized("MCP는 API 토큰(Bearer)으로만 접근할 수 있습니다."));
    next();
  });

  r.post("/", async (req, res) => {
    const msg = req.body;
    if (Array.isArray(msg)) {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch는 지원하지 않습니다." } });
    }
    const { id, method, params } = msg ?? {};
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => res.status(200).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

    try {
      if (method === "initialize") {
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "devflow-mcp", version: "0.1.0" },
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
