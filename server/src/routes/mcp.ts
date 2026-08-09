import { Router, type Request } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
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
  dailyReports,
  dailyReportAreaReviews,
  dailyReportMemos,
} from "../../../shared/schema.ts";
import { baseUrl } from "../lib/http.ts";
import { createTaskWithKey, loadTaskForUser, taskAssigneeUsers, getTaskDetail, applyRollup, addAssignee, assertValidParent } from "../lib/taskService.ts";
import { serializeComments } from "./comments.ts";
import { searchEmbeddings } from "../lib/embeddings.ts";
import { logActivity } from "../lib/activity.ts";
import { resolveAttendees, syncAttendees } from "../lib/eventService.ts";
import { appendEntry, searchEntries } from "../lib/journalService.ts";
import { assertAreaInProject, canManageArea, loadOperationalAccess } from "../lib/operationalAccess.ts";
import { reportWithDetails } from "../lib/dailyReportService.ts";

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
const canManageTask = (access: Awaited<ReturnType<typeof loadTaskForUser>>) => !!access && (
  access.reportEnabled
    ? access.operationalRole === "pm" || (access.operationalRole === "pl" && access.task.area_id != null && access.leadAreaIds.includes(access.task.area_id))
    : canManage(access.role)
);

async function mcpReportAccess(projectId: number, userId: number) {
  const access = await loadOperationalAccess(projectId, userId);
  if (!access || !access.reportEnabled)
    throw new McpError(-32602, "일일보고가 활성화된 프로젝트를 찾을 수 없거나 권한이 없습니다.");
  if (!(access.operationalRole === "pm" || (access.operationalRole === "pl" && access.leadAreaIds.length > 0)))
    throw new McpError(-32603, "PM 또는 담당 영역이 있는 PL만 일일보고를 사용할 수 있습니다.");
  return access;
}

// 살아 있는(휴지통 아님) 프로젝트의 멤버십 id만 — 집계형 읽기 도구(list_my_tasks·devflow_search·list_events)가
// 휴지통 프로젝트 콘텐츠를 노출하지 않게. loadTaskForUser의 휴지통 게이트·list_projects의 isNull 필터와 같은 규약.
// (안 거르면 Claude가 웹에서는 안 보이는 유령 태스크·일정을 근거로 작업을 시도하다 건건이 실패한다)
async function liveProjectIds(uid: number): Promise<number[]> {
  const rows = await db
    .select({ id: projectMembers.project_id })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.project_id))
    .where(and(eq(projectMembers.user_id, uid), isNull(projects.deleted_at)));
  return rows.map((r) => r.id);
}

// 날짜 인자 공용 파서 — YYYY-MM-DD만 UTC 자정으로 정규화, null=해제(비우기).
// 느슨한 new Date()는 "+09:00 자정" 하루 밀림 저장과 "2026-02-30" 롤오버를 조용히 통과시킨다 (T배치 규약).
function parseDayArg(v: unknown, label: string): Date | null {
  if (v == null) return null;
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
    throw new McpError(-32602, `${label}은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`);
  return d;
}

// assertValidParent(taskService)는 REST용 HttpError를 던진다 — MCP 응답 규약(-32602)으로 변환.
async function assertValidParentMcp(childId: number | null, parentId: number, projectId: number): Promise<void> {
  try {
    await assertValidParent(childId, parentId, projectId);
  } catch (e) {
    throw new McpError(-32602, e instanceof Error ? e.message : "상위 태스크 지정이 올바르지 않습니다.");
  }
}

async function assertAreaMcp(areaId: number, projectId: number): Promise<void> {
  try {
    await assertAreaInProject(areaId, projectId);
  } catch (e) {
    throw new McpError(-32602, e instanceof Error ? e.message : "영역 지정이 올바르지 않습니다.");
  }
}

// 태스크 필드 수정 공용 규칙 — update_task(단건)와 bulk_update_tasks(일괄)가 공유.
// "값 미전달=유지, null=비우기" (update_project_dates와 동일 규약). 반환: tasks UPDATE에 넣을 set 객체.
// 지원 외 키는 -32602로 거부 — REST PATCH의 zod .strict()와 동일 규약. 조용히 버리면 부분만 적용된 채
// 성공으로 보고돼 호출자(Claude)가 누락을 감지할 수 없다(특히 필드 에코가 없는 bulk).
function buildTaskPatch(args: Record<string, unknown>, extraAllowed: readonly string[] = []): Record<string, unknown> {
  const FIELDS = ["title", "description", "priority", "scheduled_date", "due_date"];
  const allowed = new Set<string>([...FIELDS, ...extraAllowed]);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length)
    throw new McpError(
      -32602,
      `지원하지 않는 필드: ${unknown.join(", ")} — 수정 가능: ${FIELDS.join(", ")}${unknown.includes("status") ? " (상태 변경은 update_task_status)" : ""}`,
    );
  const has = (k: string) => k in args;
  const set: Record<string, unknown> = {};
  if (has("title")) {
    const title = String(args.title ?? "").trim();
    if (!title) throw new McpError(-32602, "title은 비울 수 없습니다.");
    set.title = title;
  }
  if (has("description")) set.description = args.description == null ? null : String(args.description);
  if (has("priority")) {
    const p = Number(args.priority);
    if (!Number.isInteger(p) || p < 0 || p > 3) throw new McpError(-32602, "priority는 0(없음)~3(높음) 정수여야 합니다.");
    set.priority = p;
  }
  if (has("scheduled_date")) set.scheduled_date = parseDayArg(args.scheduled_date, "scheduled_date");
  if (has("due_date")) set.due_date = parseDayArg(args.due_date, "due_date");
  return set;
}

// 마감<예정 역전 검증 — 병합(기존값+패치) 후 최종 상태 기준, 날짜를 건드릴 때만 (REST PATCH와 동일 규칙)
function assertDatesAfterMerge(set: Record<string, unknown>, current: { scheduled_date: Date | null; due_date: Date | null }): void {
  if (!("scheduled_date" in set) && !("due_date" in set)) return;
  const sched = ("scheduled_date" in set ? set.scheduled_date : current.scheduled_date) as Date | null;
  const due = ("due_date" in set ? set.due_date : current.due_date) as Date | null;
  if (sched && due && due.getTime() < sched.getTime())
    throw new McpError(-32602, "마감일(due_date)이 예정일(scheduled_date)보다 앞설 수 없습니다.");
}

const TOOLS = [
  {
    name: "list_projects",
    description: "내가 속한 프로젝트 목록(id·key·name·기간(start/end_date)·내 역할)을 가져옵니다. 태스크 생성 등에 필요한 project_id를 이름으로 찾을 때 먼저 호출하세요.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_project_dates",
    description:
      "프로젝트 기간(시작일~종료일)을 설정·변경·해제합니다 (owner/manager 전용). 보낸 필드만 바뀌고 안 보낸 필드는 유지, null을 보내면 해제. 종료일은 시작일보다 앞설 수 없습니다. 이 기간은 웹 타임라인 '전체' 보기의 기준이 됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        start_date: { type: ["string", "null"], description: "YYYY-MM-DD — 생략하면 유지, null이면 해제" },
        end_date: { type: ["string", "null"], description: "YYYY-MM-DD — 생략하면 유지, null이면 해제 (시작일보다 앞설 수 없음)" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
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
    description:
      "프로젝트에 공식 태스크를 생성합니다 (PM 또는 해당 영역 PL). 영역 프로젝트에서 PL은 area_id가 필수입니다. 회의·마감·교육·행사 같은 '일정'은 create_event를 쓰세요.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
        scheduled_date: { type: "string", description: "YYYY-MM-DD — 개인 '오늘 할 일' 목록에 올라가는 날짜입니다. 작업 시작일이 아니므로 WBS 기간 표현 목적으로 넣지 마세요(매일 할 일 화면에 쌓입니다). 확실치 않으면 비워두세요." },
        due_date: { type: "string", description: "YYYY-MM-DD (마감일 — 예정일보다 앞설 수 없음)" },
        assignee_ids: { type: "array", items: { type: "number" } },
        parent_task_id: { type: "number", description: "상위 태스크 id — 같은 프로젝트만, 계층(WBS) 표현용" },
        area_id: { type: ["number", "null"], description: "영역 id — PL은 자기 담당 영역 필수, PM은 null(미분류) 가능" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description:
      "태스크의 제목·설명·우선순위·예정일·마감일·상위 태스크를 수정합니다 (owner/manager 전용). 보낸 필드만 바뀌고, null을 보내면 그 필드를 비웁니다(scheduled_date·due_date·description·parent_task_id). 상태 변경은 update_task_status, 여러 건 일괄 수정은 bulk_update_tasks를 쓰세요.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        title: { type: "string" },
        description: { type: ["string", "null"], description: "null이면 설명 비우기" },
        priority: { type: "number", description: "0(없음)~3(높음)" },
        scheduled_date: { type: ["string", "null"], description: "YYYY-MM-DD — 개인 '오늘 할 일' 날짜(작업 시작일 아님). null이면 해제" },
        due_date: { type: ["string", "null"], description: "YYYY-MM-DD, null이면 해제" },
        parent_task_id: { type: ["number", "null"], description: "상위 태스크 변경 — null이면 최상위로 승격" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "bulk_create_tasks",
    description:
      "태스크 여러 건을 한 번에 생성합니다 (PM 또는 해당 영역 PL, 최대 200건). 영역 프로젝트에서 PL은 각 항목에 자기 area_id가 필요합니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        tasks: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "이 요청 안에서만 쓰는 임시 키 (parent_ref 참조용)" },
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "number", description: "0(없음)~3(높음)" },
              scheduled_date: { type: "string", description: "YYYY-MM-DD — 개인 '오늘 할 일' 날짜. WBS 기간 표현 목적으로 넣지 말 것(일괄 등록 시 비워두는 것이 기본)" },
              due_date: { type: "string", description: "YYYY-MM-DD" },
              assignee_ids: { type: "array", items: { type: "number" } },
              parent_task_id: { type: "number", description: "이미 존재하는 태스크를 상위로" },
              parent_ref: { type: "string", description: "이 요청의 앞선 항목 ref를 상위로 (parent_task_id와 동시 지정 불가)" },
              area_id: { type: ["number", "null"], description: "영역 id" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["project_id", "tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "bulk_update_tasks",
    description:
      "태스크 여러 건에 같은 변경을 일괄 적용합니다 (owner/manager 전용, 최대 200건). patch의 보낸 필드만 바뀌고 null은 비우기 — 예: 예정일 일괄 제거는 patch에 {\"scheduled_date\": null}. 부분 실패를 허용하며 실패 항목은 errors로 돌려줍니다.",
    inputSchema: {
      type: "object",
      properties: {
        task_ids: { type: "array", items: { type: "number" }, maxItems: 200 },
        patch: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: ["string", "null"] },
            priority: { type: "number" },
            scheduled_date: { type: ["string", "null"], description: "YYYY-MM-DD, null이면 해제" },
            due_date: { type: ["string", "null"], description: "YYYY-MM-DD, null이면 해제" },
          },
          additionalProperties: false,
        },
      },
      required: ["task_ids", "patch"],
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
        remind_minutes: { type: "number", description: "선택 — 시작 몇 분 전 리마인더(기본: 시간 일정 30분 전, 종일 없음). -1=알림 없음, 최대 1440(하루 전). 종일 일정은 0=당일 아침 9시·720=전날 저녁 9시 (시간 일정에 0 불가)" },
      },
      required: ["title", "starts_at"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description:
      "기간 내 일정 목록을 참석자·생성자 정보와 함께 가져옵니다. 기본 scope는 'project'(project_id 필수) — 프로젝트 작업 중 다른 프로젝트·개인 일정이 섞여 오해하는 것을 막습니다. 개인 일정만 보려면 'personal', 내가 볼 수 있는 전부(모든 내 프로젝트+개인)는 'all'을 명시하세요.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        scope: { type: "string", enum: ["project", "personal", "all"], description: "기본 'project'" },
        project_id: { type: "number", description: "scope='project'일 때 필수 — 이 프로젝트 일정만" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_daily_report",
    description: "PM/PL이 확정 또는 준비 중인 일일보고를 조회합니다. report_id를 주거나 report_date(YYYY-MM-DD)의 최신 버전을 조회할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        report_id: { type: "number" },
        report_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_daily_report_area_note",
    description: "준비 중인 일일보고의 자기 영역 판단·영향·요청을 저장합니다. PM은 모든 영역을 수정할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" }, report_id: { type: "number" }, area_id: { type: ["number", "null"] },
        judgment: { type: "string", enum: ["normal", "warning", "risk"] },
        note: { type: ["string", "null"] }, impact: { type: ["string", "null"] }, request: { type: ["string", "null"] },
      },
      required: ["project_id", "report_id", "area_id"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_daily_report_area",
    description: "준비 중인 일일보고에서 자기 영역을 확인합니다. PM이 대신 확인하면 대리 확인 이력이 남습니다.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "number" }, report_id: { type: "number" }, area_id: { type: ["number", "null"] }, confirm: { type: "boolean", description: "실제 확인 실행은 true 필수" } },
      required: ["project_id", "report_id", "area_id", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "add_daily_report_meeting_memo",
    description: "확정된 일일보고에 회의 메모를 남깁니다. 과거 보고서는 수정하지 않고 후속 반영 대기에 저장합니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" }, report_id: { type: "number" }, area_id: { type: ["number", "null"] }, body: { type: "string" },
        action_type: { type: "string", enum: ["task_create", "task_update", "event_create", "note"] },
        action_payload: { type: "object", description: "후속 반영 후보 값. 실제 적용은 웹에서 검토 후 실행합니다." },
      },
      required: ["project_id", "report_id", "area_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "journal_append",
    description:
      "사용자의 '내 기록'(완전 개인 저널)의 오늘 페이지에 시각 스탬프와 함께 텍스트를 추가합니다. 사용자가 아이디어·배운 것·메모를 '기록해줘'라고 하면 이 도구를 쓰세요. 본인 기록에만 쓰이며 팀원·관리자는 볼 수 없습니다.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "기록할 내용 (마크다운 가능)" },
        tags: { type: "array", items: { type: "string" }, description: "선택 — 분류 태그 (예: [\"아이디어\", \"리액트\"] — #이 자동으로 붙음)" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "journal_search",
    description:
      "사용자의 '내 기록'(개인 저널)에서 부분일치로 검색해 날짜·스니펫을 돌려줍니다. 사용자가 과거에 저장해 둔 아이디어·지식이 현재 작업과 관련 있을 것 같으면 먼저 검색해 보세요. 태그 검색은 q에 '#태그' 그대로.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "검색어" },
        limit: { type: "number", description: "선택 — 최대 결과 수 (기본 10, 최대 30)" },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
];

async function callTool(req: Request, name: string, args: any): Promise<unknown> {
  const uid = req.userId!;
  // 휴지통 프로젝트 차단 — MCP는 도구마다 멤버십 검사를 인라인으로 하고 공용 게이트가 없어서,
  // project_id를 받는 모든 도구에 대해 여기서 한 번에 막는다(웹의 requireMember와 같은 규약).
  // 안 막으면 Claude가 삭제 예정 프로젝트에 태스크·문서를 계속 쌓고 30일 뒤 전부 사라진다.
  // ★ 멤버십 인지형: 멤버일 때만 휴지통 안내를 던진다 — projects 단독 조회로 먼저 던지면 비멤버가
  //   스코프 무관 토큰으로 임의 project_id의 존재+휴지통 여부를 메시지 차이로 열거할 수 있다(존재 오라클).
  //   비멤버·비존재는 여기서 판단하지 않고 각 도구의 통일 메시지("찾을 수 없거나 권한이 없습니다")에 맡긴다.
  if (args?.project_id != null) {
    const pid = Number(args.project_id);
    if (Number.isInteger(pid)) {
      const [row] = await db
        .select({ deleted_at: projects.deleted_at })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.project_id))
        .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (row?.deleted_at) throw new McpError(-32602, "휴지통에 있는 프로젝트예요. 앱에서 복원한 뒤에 사용하세요.");
    }
  }
  switch (name) {
    case "list_projects": {
      needScope(req, "project:read");
      const rows = await db
        .select({ id: projects.id, key: projects.key, name: projects.name, start_date: projects.start_date, end_date: projects.end_date, role: projectMembers.role, operational_role: projectMembers.operational_role, daily_report_enabled: projects.daily_report_enabled })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.project_id))
        // 휴지통 프로젝트는 Claude에게도 보이면 안 된다 — 보이면 거기에 태스크를 쌓다가
        // 30일 뒤 통째로 사라진다(웹의 requireMember 게이트와 같은 규약).
        .where(and(eq(projectMembers.user_id, uid), isNull(projects.deleted_at)));
      return { projects: rows };
    }
    case "update_project_dates": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!m) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(m.role)) throw new McpError(-32603, "프로젝트 기간 변경은 owner/manager만 가능합니다.");
      const has = (k: string) => args != null && k in args;
      if (!has("start_date") && !has("end_date"))
        throw new McpError(-32602, "start_date 또는 end_date 중 하나는 보내야 합니다.");
      const parseDay = (v: unknown, label: string): Date | null => {
        if (v == null) return null; // null = 해제
        const s = String(v);
        // create_event(parseWhen)·list_events와 동일 규약: YYYY-MM-DD만 UTC 자정으로 정규화.
        // 느슨한 new Date()는 "+09:00 자정" 하루 밀림 저장, "2026-02-30" 롤오버를 조용히 통과시킨다.
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : null;
        if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
          throw new McpError(-32602, `${label}은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`);
        return d;
      };
      const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      // 부분 갱신: 보낸 필드만 반영, 안 보낸 필드는 기존값 유지 — 병합 결과로 역전 검증(REST PATCH와 동일 규칙)
      const nextStart = has("start_date") ? parseDay(args.start_date, "start_date") : proj.start_date;
      const nextEnd = has("end_date") ? parseDay(args.end_date, "end_date") : proj.end_date;
      if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime())
        throw new McpError(-32602, "종료일(end_date)이 시작일(start_date)보다 앞설 수 없습니다.");
      const [p] = await db
        .update(projects)
        .set({ start_date: nextStart, end_date: nextEnd, updated_at: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
      await logActivity({ project_id: projectId, user_id: uid, action: "project.updated", meta: { patch: { start_date: nextStart, end_date: nextEnd }, via: "mcp" } });
      return { project: { id: p.id, key: p.key, name: p.name, start_date: p.start_date, end_date: p.end_date } };
    }
    case "list_my_tasks": {
      needScope(req, "task:read");
      const ids = (
        await db.select({ id: taskAssignees.task_id }).from(taskAssignees).where(eq(taskAssignees.user_id, uid))
      ).map((a) => a.id);
      if (!ids.length) return { tasks: [] };
      // 휴지통 프로젝트의 태스크 제외 — loadTaskForUser 게이트와 동일 규약(안 거르면 유령 태스크가 목록에 남는다)
      const rows = await db
        .select({ t: tasks })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.project_id))
        .where(and(inArray(tasks.id, ids), ne(tasks.status, "done"), isNull(projects.deleted_at)));
      return { tasks: rows.map(({ t }) => ({ id: t.id, item_key: t.item_key, title: t.title, status: t.status, scheduled_date: t.scheduled_date, due_date: t.due_date, project_id: t.project_id })) };
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
        .select({ user: users, role: projectMembers.role, operational_role: projectMembers.operational_role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.user_id))
        .where(eq(projectMembers.project_id, projectId));
      return { members: rows.map((r) => ({ user_id: r.user.id, name: r.user.full_name ?? r.user.email, email: r.user.email, role: r.role, operational_role: r.operational_role })) };
    }
    case "assign_task": {
      needScope(req, "task:write");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManageTask(acc)) throw new McpError(-32603, "담당자 배정은 PM 또는 해당 영역 PL만 가능합니다.");
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
      // 보드 리스트와 같은 정렬 규약 (projectTasks.ts) — Claude가 받는 순서 = 화면 순서
      let rows = await db.select().from(tasks).where(eq(tasks.project_id, projectId))
        .orderBy(desc(tasks.sort_order), asc(tasks.created_at), asc(tasks.id));
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
      if (!canManageTask(acc)) {
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
        await logActivity({ project_id: acc.task.project_id, task_id: acc.task.id, user_id: uid, action: "task.status_changed", meta: { from_status: acc.task.status, to_status: status, status, via: "mcp" } });
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
      const operational = await loadOperationalAccess(projectId, uid);
      const areaId = args?.area_id == null ? null : Number(args.area_id);
      if (areaId != null) await assertAreaMcp(areaId, projectId);
      if (operational?.reportEnabled) {
        if (!canManageArea(operational, areaId)) throw new McpError(-32603, "PM 또는 해당 영역 PL만 태스크를 만들 수 있습니다. PL은 area_id가 필요합니다.");
      } else if (!canManage(m.role)) throw new McpError(-32603, "태스크 생성은 owner/manager만 가능합니다.");
      if (!args?.title) throw new McpError(-32602, "title이 필요합니다.");
      // 엄격 날짜 파싱으로 통일 — 기존 느슨한 new Date()는 "2026-7-1" 하루 밀림·"2026-02-30" 롤오버를 통과시켰다
      const schedDate = parseDayArg(args.scheduled_date, "scheduled_date");
      const dueDate = parseDayArg(args.due_date, "due_date");
      // REST(projectTasks.ts)와 같은 규칙 — 마감일이 예정일보다 앞서면 거부
      if (schedDate && dueDate && dueDate.getTime() < schedDate.getTime())
        throw new McpError(-32602, "마감일(due_date)이 예정일(scheduled_date)보다 앞설 수 없습니다.");
      const parentId = args?.parent_task_id == null ? null : Number(args.parent_task_id);
      if (parentId != null) await assertValidParentMcp(null, parentId, projectId); // REST 생성과 동일 검증
      const t = await createTaskWithKey({
        project_id: projectId,
        title: String(args.title),
        description: args.description ? String(args.description) : null,
        scheduled_date: schedDate,
        due_date: dueDate,
        parent_task_id: parentId,
        assignee_ids: Array.isArray(args.assignee_ids) ? args.assignee_ids.map(Number) : [],
        area_id: areaId,
        created_by: uid,
      });
      await logActivity({ project_id: projectId, task_id: t.id, user_id: uid, action: "task.created", meta: { item_key: t.item_key, via: "mcp" } });
      return { task: { id: t.id, item_key: t.item_key, title: t.title }, assignees: await taskAssigneeUsers(t.id) };
    }
    case "update_task": {
      needScope(req, "task:write");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManageTask(acc))
        throw new McpError(-32603, "태스크 수정은 PM 또는 해당 영역 PL만 가능합니다. (담당자 본인의 상태 변경은 update_task_status)");
      const set = buildTaskPatch(args ?? {}, ["task_id", "parent_task_id"]);
      const hasParent = args != null && "parent_task_id" in args;
      if (!Object.keys(set).length && !hasParent)
        throw new McpError(-32602, "수정할 필드를 하나 이상 보내세요: title, description, priority, scheduled_date, due_date, parent_task_id");
      assertDatesAfterMerge(set, acc.task);
      if (hasParent) {
        const parentId = args.parent_task_id == null ? null : Number(args.parent_task_id);
        if (parentId != null) await assertValidParentMcp(acc.task.id, parentId, acc.task.project_id);
        set.parent_task_id = parentId; // null = 최상위로 승격
      }
      const [t] = await db
        .update(tasks)
        .set({ ...set, updated_at: new Date() })
        .where(eq(tasks.id, acc.task.id))
        .returning();
      await logActivity({ project_id: t.project_id, task_id: t.id, user_id: uid, action: "task.updated", meta: { fields: Object.keys(set), via: "mcp" } });
      return {
        task: {
          id: t.id, item_key: t.item_key, title: t.title, description: t.description, priority: t.priority,
          scheduled_date: t.scheduled_date, due_date: t.due_date, parent_task_id: t.parent_task_id, status: t.status,
        },
      };
    }
    case "bulk_create_tasks": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
        .limit(1);
      if (!m) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
      const operational = await loadOperationalAccess(projectId, uid);
      if (operational?.reportEnabled) {
        if (!(["pm", "pl"] as string[]).includes(operational.operationalRole)) throw new McpError(-32603, "PM 또는 PL만 태스크를 만들 수 있습니다.");
      } else if (!canManage(m.role)) throw new McpError(-32603, "태스크 생성은 owner/manager만 가능합니다.");
      const list = args?.tasks;
      if (!Array.isArray(list) || list.length === 0) throw new McpError(-32602, "tasks 배열(1건 이상)이 필요합니다.");
      if (list.length > 200)
        throw new McpError(-32602, `한 번에 최대 200건까지 생성할 수 있습니다 (요청 ${list.length}건 — 나눠서 호출하세요).`);
      // 부분 실패 허용: 항목별 독립 처리, 실패는 errors로 — 전체 롤백보다 재시도 범위가 명확 (요청서 ④ 설계).
      const refIds = new Map<string, number>(); // 생성 "성공"한 항목의 ref → id (parent_ref 해석용)
      const seenRefs = new Set<string>(); // 성공 여부 무관, 등장한 모든 ref — 실패한 항목의 ref를 뒤 항목이
      // 조용히 차지해 자식이 엉뚱한 부모에 붙는 것을 차단 (중복은 항상 거부)
      const created: { ref: string | null; id: number; item_key: string; title: string }[] = [];
      const errors: { index: number; ref: string | null; title: string | null; message: string }[] = [];
      for (let i = 0; i < list.length; i++) {
        const item = (list[i] ?? {}) as Record<string, unknown>;
        const ref = item.ref == null ? null : String(item.ref);
        const dupRef = ref != null && seenRefs.has(ref);
        if (ref != null) seenRefs.add(ref);
        try {
          const title = String(item.title ?? "").trim();
          if (!title) throw new McpError(-32602, "title이 필요합니다.");
          if (dupRef) throw new McpError(-32602, `ref '${ref}'가 중복됩니다.`);
          const schedDate = parseDayArg(item.scheduled_date, "scheduled_date");
          const dueDate = parseDayArg(item.due_date, "due_date");
          if (schedDate && dueDate && dueDate.getTime() < schedDate.getTime())
            throw new McpError(-32602, "마감일(due_date)이 예정일(scheduled_date)보다 앞설 수 없습니다.");
          if (item.parent_task_id != null && item.parent_ref != null)
            throw new McpError(-32602, "parent_task_id와 parent_ref는 동시에 지정할 수 없습니다.");
          let parentId: number | null = null;
          if (item.parent_ref != null) {
            const p = refIds.get(String(item.parent_ref));
            if (p == null)
              throw new McpError(-32602, `parent_ref '${String(item.parent_ref)}'를 찾을 수 없습니다 — 부모 항목이 배열에서 먼저 와야 하고, 실패한 항목은 참조할 수 없습니다.`);
            parentId = p; // 이 요청에서 방금 만든 같은 프로젝트 태스크 — 추가 검증 불필요
          } else if (item.parent_task_id != null) {
            parentId = Number(item.parent_task_id);
            await assertValidParentMcp(null, parentId, projectId);
          }
          const priority = item.priority == null ? 0 : Number(item.priority);
          if (!Number.isInteger(priority) || priority < 0 || priority > 3)
            throw new McpError(-32602, "priority는 0(없음)~3(높음) 정수여야 합니다.");
          const areaId = item.area_id == null ? null : Number(item.area_id);
          if (areaId != null) await assertAreaMcp(areaId, projectId);
          if (operational?.reportEnabled && !canManageArea(operational, areaId))
            throw new McpError(-32603, "PL은 자기 담당 area_id의 태스크만 만들 수 있습니다.");
          const t = await createTaskWithKey({
            project_id: projectId,
            title,
            description: item.description ? String(item.description) : null,
            priority,
            scheduled_date: schedDate,
            due_date: dueDate,
            parent_task_id: parentId,
            assignee_ids: Array.isArray(item.assignee_ids) ? item.assignee_ids.map(Number) : [],
            area_id: areaId,
            created_by: uid,
          });
          if (ref != null) refIds.set(ref, t.id);
          created.push({ ref, id: t.id, item_key: t.item_key, title: t.title });
          // 활동 로그 실패가 "생성 성공"을 실패로 둔갑시키지 않게 개별 무해화 — 안 감싸면 위 push 후
          // 바깥 catch로 넘어가 같은 항목이 tasks와 errors에 이중 기록된다(집계 오염).
          try {
            await logActivity({ project_id: projectId, task_id: t.id, user_id: uid, action: "task.created", meta: { item_key: t.item_key, via: "mcp", bulk: true } });
          } catch { /* 부가 기록 실패는 무시 */ }
        } catch (e) {
          errors.push({ index: i, ref, title: item.title == null ? null : String(item.title), message: e instanceof Error ? e.message : String(e) });
        }
      }
      return { created: created.length, failed: errors.length, tasks: created, errors };
    }
    case "bulk_update_tasks": {
      needScope(req, "task:write");
      const rawIds = args?.task_ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) throw new McpError(-32602, "task_ids 배열(1건 이상)이 필요합니다.");
      if (rawIds.length > 200)
        throw new McpError(-32602, `한 번에 최대 200건까지 수정할 수 있습니다 (요청 ${rawIds.length}건 — 나눠서 호출하세요).`);
      const patch = (args?.patch ?? {}) as Record<string, unknown>;
      const set = buildTaskPatch(patch); // 공통 검증(형식·null 규약)은 한 번만 — 역전은 태스크별 병합 판정
      if (!Object.keys(set).length)
        throw new McpError(-32602, "patch에 수정할 필드를 하나 이상 보내세요: title, description, priority, scheduled_date, due_date");
      const ids = [...new Set(rawIds.map(Number))];
      const updated: { id: number; item_key: string }[] = [];
      const errors: { task_id: number; message: string }[] = [];
      for (const id of ids) {
        try {
          const acc = await loadTaskForUser(id, uid);
          if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
          if (!canManageTask(acc)) throw new McpError(-32603, "태스크 수정은 PM 또는 해당 영역 PL만 가능합니다.");
          assertDatesAfterMerge(set, acc.task);
          const [t] = await db
            .update(tasks)
            .set({ ...set, updated_at: new Date() })
            .where(eq(tasks.id, acc.task.id))
            .returning();
          updated.push({ id: t.id, item_key: t.item_key });
          try {
            await logActivity({ project_id: t.project_id, task_id: t.id, user_id: uid, action: "task.updated", meta: { fields: Object.keys(set), via: "mcp", bulk: true } });
          } catch { /* bulk_create와 동일 — 부가 기록 실패로 이중 집계 금지 */ }
        } catch (e) {
          errors.push({ task_id: id, message: e instanceof Error ? e.message : String(e) });
        }
      }
      return { updated: updated.length, failed: errors.length, tasks: updated, errors };
    }
    case "add_guide": {
      needScope(req, "guide:write");
      const acc = await loadTaskForUser(Number(args?.task_id), uid);
      if (!acc) throw new McpError(-32602, "태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManageTask(acc)) throw new McpError(-32603, "가이드는 PM 또는 해당 영역 PL만 등록할 수 있습니다.");
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
      let pids = await liveProjectIds(uid); // 휴지통 프로젝트 콘텐츠는 검색 결과에서도 제외
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
      let remindMinutes: number | null = null;
      if (args?.remind_minutes != null) {
        remindMinutes = Number(args.remind_minutes);
        if (!Number.isInteger(remindMinutes) || remindMinutes < -1 || remindMinutes > 1440)
          throw new McpError(-32602, "remind_minutes는 -1(없음)~1440(하루 전) 사이 정수여야 합니다.");
        // 시간 지정 일정의 0은 발송 창이 공집합 — 저장돼도 영영 안 울리는 함정이라 거부
        if (remindMinutes === 0 && !isAllDay)
          throw new McpError(-32602, "시간 지정 일정의 리마인드는 10분 전부터입니다. (0은 종일 일정 전용)");
      }
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
          remind_minutes: remindMinutes,
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
      const pids = await liveProjectIds(uid); // 휴지통 프로젝트 일정 제외 — scope=project 게이트·list_projects 은닉과 일관
      // 개인 일정 가시성 조건 (GET /api/events와 동일): project_id IS NULL AND (생성자 OR 참석자)
      const personalCond = async () => {
        const attIds = (
          await db.select({ id: eventAttendees.event_id }).from(eventAttendees).where(eq(eventAttendees.user_id, uid))
        ).map((x) => x.id);
        return and(
          isNull(events.project_id),
          attIds.length ? or(eq(events.created_by, uid), inArray(events.id, attIds)) : eq(events.created_by, uid),
        );
      };
      // scope 기본 'project' — 프로젝트 작업 중 무스코프 호출로 타 프로젝트·개인 일정이 섞여
      // "등록한 적 없는 일정이 보인다"로 오해하는 실사고(개선 요청서 ①)를 구조적으로 차단.
      const scope = String(args?.scope ?? "project");
      let visible;
      if (scope === "project") {
        if (args?.project_id == null)
          throw new McpError(-32602, "scope='project'(기본)에는 project_id가 필요합니다. 개인 일정만 보려면 scope='personal', 내가 볼 수 있는 전부는 scope='all'을 명시하세요.");
        const target = Number(args.project_id);
        if (!pids.includes(target)) throw new McpError(-32602, "프로젝트를 찾을 수 없거나 권한이 없습니다.");
        visible = eq(events.project_id, target);
      } else if (scope === "personal") {
        visible = await personalCond();
      } else if (scope === "all") {
        // 명시적 전체 조회: 내 프로젝트 일정 + 개인 일정 (구 기본 동작)
        visible = or(pids.length ? inArray(events.project_id, pids) : sql`false`, await personalCond());
      } else {
        throw new McpError(-32602, "scope는 project | personal | all 중 하나여야 합니다.");
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
    case "get_daily_report": {
      needScope(req, "project:read");
      const projectId = Number(args?.project_id);
      const access = await mcpReportAccess(projectId, uid);
      let report;
      if (args?.report_id != null) {
        [report] = await db.select().from(dailyReports)
          .where(and(eq(dailyReports.id, Number(args.report_id)), eq(dailyReports.project_id, projectId))).limit(1);
      } else if (args?.report_date != null) {
        const date = String(args.report_date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new McpError(-32602, "report_date는 YYYY-MM-DD 형식이어야 합니다.");
        [report] = await db.select().from(dailyReports)
          .where(and(eq(dailyReports.project_id, projectId), eq(dailyReports.report_date, date)))
          .orderBy(desc(dailyReports.version)).limit(1);
      } else {
        [report] = await db.select().from(dailyReports).where(eq(dailyReports.project_id, projectId))
          .orderBy(desc(dailyReports.report_date), desc(dailyReports.version)).limit(1);
      }
      if (!report) throw new McpError(-32602, "일일보고를 찾을 수 없습니다.");
      const detail = await reportWithDetails(report.id);
      return { ...detail, my_operational_role: access.operationalRole, lead_area_ids: access.leadAreaIds };
    }
    case "update_daily_report_area_note": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const access = await mcpReportAccess(projectId, uid);
      const [report] = await db.select().from(dailyReports)
        .where(and(eq(dailyReports.id, Number(args?.report_id)), eq(dailyReports.project_id, projectId))).limit(1);
      if (!report) throw new McpError(-32602, "일일보고를 찾을 수 없습니다.");
      if (report.status !== "draft") throw new McpError(-32603, "준비 중인 보고서만 수정할 수 있습니다.");
      const areaId = args?.area_id == null ? null : Number(args.area_id);
      if (!canManageArea(access, areaId)) throw new McpError(-32603, "자기 영역 코멘트만 수정할 수 있습니다.");
      const reviews = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, report.id));
      const review = reviews.find((row) => row.area_id === areaId);
      if (!review) throw new McpError(-32602, "영역 확인 항목을 찾을 수 없습니다.");
      const allowed = ["judgment", "note", "impact", "request"];
      const set: Record<string, unknown> = {};
      for (const key of allowed) if (key in (args ?? {})) set[key] = args[key];
      if (!Object.keys(set).length) throw new McpError(-32602, "judgment, note, impact, request 중 하나 이상이 필요합니다.");
      if (set.judgment != null && !["normal", "warning", "risk"].includes(String(set.judgment)))
        throw new McpError(-32602, "judgment는 normal|warning|risk 중 하나여야 합니다.");
      const [updated] = await db.update(dailyReportAreaReviews).set({ ...set, updated_at: new Date() })
        .where(eq(dailyReportAreaReviews.id, review.id)).returning();
      await logActivity({ project_id: projectId, user_id: uid, action: "report.area_updated", meta: { report_id: report.id, area_id: areaId, fields: Object.keys(set), via: "mcp" } });
      return { review: updated };
    }
    case "confirm_daily_report_area": {
      needScope(req, "task:write");
      if (args?.confirm !== true) throw new McpError(-32602, "실제 확인하려면 confirm=true가 필요합니다.");
      const projectId = Number(args?.project_id);
      const access = await mcpReportAccess(projectId, uid);
      const [report] = await db.select().from(dailyReports)
        .where(and(eq(dailyReports.id, Number(args?.report_id)), eq(dailyReports.project_id, projectId))).limit(1);
      if (!report) throw new McpError(-32602, "일일보고를 찾을 수 없습니다.");
      if (report.status !== "draft") throw new McpError(-32603, "준비 중인 보고서만 영역 확인할 수 있습니다.");
      const areaId = args?.area_id == null ? null : Number(args.area_id);
      if (!canManageArea(access, areaId)) throw new McpError(-32603, "자기 영역만 확인할 수 있습니다.");
      const reviews = await db.select().from(dailyReportAreaReviews).where(eq(dailyReportAreaReviews.report_id, report.id));
      const review = reviews.find((row) => row.area_id === areaId);
      if (!review) throw new McpError(-32602, "영역 확인 항목을 찾을 수 없습니다.");
      const now = new Date();
      const [updated] = await db.update(dailyReportAreaReviews).set({
        status: "confirmed", confirmed_by: uid,
        confirmed_for_id: access.operationalRole === "pm" && review.reviewer_id !== uid ? review.reviewer_id : null,
        confirmed_at: now, updated_at: now,
      }).where(eq(dailyReportAreaReviews.id, review.id)).returning();
      await logActivity({ project_id: projectId, user_id: uid, action: "report.area_confirmed", meta: { report_id: report.id, area_id: areaId, confirmed_for_id: updated.confirmed_for_id, via: "mcp" } });
      return { review: updated, delegated: updated.confirmed_for_id != null };
    }
    case "add_daily_report_meeting_memo": {
      needScope(req, "task:write");
      const projectId = Number(args?.project_id);
      const access = await mcpReportAccess(projectId, uid);
      const [report] = await db.select().from(dailyReports)
        .where(and(eq(dailyReports.id, Number(args?.report_id)), eq(dailyReports.project_id, projectId))).limit(1);
      if (!report) throw new McpError(-32602, "일일보고를 찾을 수 없습니다.");
      if (report.status !== "confirmed") throw new McpError(-32603, "회의 메모는 확정된 보고서에만 추가할 수 있습니다.");
      const areaId = args?.area_id == null ? null : Number(args.area_id);
      if (!canManageArea(access, areaId)) throw new McpError(-32603, "자기 영역의 회의 메모만 작성할 수 있습니다.");
      const body = String(args?.body ?? "").trim();
      if (!body || body.length > 5000) throw new McpError(-32602, "body는 1~5000자여야 합니다.");
      const actionType = String(args?.action_type ?? "note");
      if (!["task_create", "task_update", "event_create", "note"].includes(actionType))
        throw new McpError(-32602, "action_type이 올바르지 않습니다.");
      const [memo] = await db.insert(dailyReportMemos).values({
        report_id: report.id, area_id: areaId, author_id: uid, body,
        action_type: actionType as "task_create" | "task_update" | "event_create" | "note",
        action_payload: args?.action_payload && typeof args.action_payload === "object" ? args.action_payload : {},
      }).returning();
      await logActivity({ project_id: projectId, user_id: uid, action: "report.memo_created", meta: { report_id: report.id, memo_id: memo.id, area_id: areaId, action_type: actionType, via: "mcp" } });
      return { memo };
    }
    case "journal_append": {
      needScope(req, "journal:write");
      const text = String(args?.text ?? "").trim();
      if (!text) throw new McpError(-32602, "text가 비어 있습니다.");
      if (text.length > 20_000) throw new McpError(-32602, "text는 2만 자까지입니다.");
      const tags = Array.isArray(args?.tags) ? args.tags.map(String).slice(0, 10) : undefined;
      const entry = await appendEntry(uid, text, { tags });
      return { entry_date: entry.entry_date, appended: true };
    }
    case "journal_search": {
      needScope(req, "journal:write");
      const q = String(args?.q ?? "").trim();
      if (!q) throw new McpError(-32602, "q가 비어 있습니다.");
      const results = await searchEntries(uid, q, args?.limit != null ? Number(args.limit) : 10);
      return { total: results.length, results };
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
          serverInfo: { name: "devflow-mcp", version: "0.5.0" }, // 일일보고 도구 추가 — 커넥터 캐시 판별용
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
