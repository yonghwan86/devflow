import { Router, type Request } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { projects, projectMembers, users, invites, PROJECT_STATUS, ASSIGNABLE_ROLES, roleAtLeast } from "../../../shared/schema.ts";
import { TRASH_RETENTION_DAYS, deletionImpact, purgeProject } from "../lib/projectLifecycle.ts";
import { ah, publicUser, baseUrl } from "../lib/http.ts";
import { requireAuth, requireMember, requireRole, currentUser } from "../middleware/auth.ts";
import { generateProjectKey } from "../lib/projectKey.ts";
import { logActivity } from "../lib/activity.ts";
import { makeInviteToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { registerProjectTaskRoutes } from "./projectTasks.ts";
import { registerProjectPageRoutes } from "./projectPages.ts";
import { registerProjectOperationRoutes } from "./projectOperations.ts";
import { registerProjectDailyReportRoutes } from "./projectDailyReports.ts";
import { registerProjectReportMemoRoutes } from "./projectReportMemos.ts";
import { runSkillExtraction } from "../lib/skillExtractor.ts";

// 소유자(owner)는 프로젝트당 1명이며 다른 사람이 강등·제거할 수 없다 —
// 역할 변경/제거 대상이 owner면 차단(변경은 소유권 양도 API로만).
// 보관·삭제·복원 권한: 자기 프로젝트의 소유자·매니저, 또는 사이트 관리자(전체 프로젝트).
// requireMember를 못 쓰는 이유 — 관리자는 멤버가 아닌 프로젝트도 정리해야 하고,
// 정리하려고 참여해버리면 팀원 목록에 관리자 이름이 남는다(join-as-admin은 열람용 경로).
async function assertCanManageProject(req: Request, pid: number): Promise<{ isAdmin: boolean }> {
  // C5 보안 — 파괴적 작업은 **웹 로그인(세션) 전용**. tokens.ts:27·admin.ts·auth.ts(accept-invite-session)와 같은 규약.
  // Bearer 개인 토큰을 허용하면 REST 쓰기 게이트가 task:write 하나만 요구하므로(middleware/auth.ts:77-79)
  // MCP·시리 단축어용 최소 스코프 토큰 하나가 프로젝트 통째 영구삭제권이 된다(cascade 11개 테이블).
  // csrf도 Bearer를 면제하므로(csrf.ts:16) 브라우저 없이 curl 한 줄로 도달한다.
  if (req.tokenScopes) throw err.forbidden("프로젝트 보관·삭제는 웹 로그인(세션)에서만 가능합니다.");
  const u = await currentUser(req);
  if (!u) throw err.unauthorized();
  if (u.is_admin) return { isAdmin: true };
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, req.userId!)))
    .limit(1);
  if (!m || !roleAtLeast(m.role, "manager"))
    throw err.forbidden("프로젝트 소유자·매니저 또는 사이트 관리자만 할 수 있습니다.");
  return { isAdmin: false };
}

// 이름 타이핑 확인 — 문서·회의록 삭제(휴지통 2단계)보다 파괴적이라 서버에서도 강제한다.
// 클라 다이얼로그만 믿으면 API 오작동·스크립트 실수로 통째 삭제될 수 있다.
function assertNameConfirmed(input: string | undefined, actual: string): void {
  if ((input ?? "").trim() !== actual.trim())
    throw err.badRequest("확인을 위해 프로젝트 이름을 정확히 입력하세요.");
}

function assertNotOwner(role: string, action: "demote" | "remove"): void {
  if (role === "owner")
    throw err.badRequest(
      action === "remove"
        ? "소유자는 제거할 수 없어요. 먼저 소유권을 양도하세요."
        : "소유자 역할은 소유권 양도로만 바꿀 수 있어요.",
    );
}

export function projectsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // List — server-side membership filter (§8, §12).
  r.get(
    "/",
    ah(async (req, res) => {
      const memberships = await db
        .select({ project_id: projectMembers.project_id, role: projectMembers.role, operational_role: projectMembers.operational_role })
        .from(projectMembers)
        .where(eq(projectMembers.user_id, req.userId!));
      const ids = memberships.map((m) => m.project_id);
      if (ids.length === 0) return res.json({ projects: [] });
      // 휴지통에 있는 프로젝트는 목록에서 제외 — 복원·영구삭제는 GET /trash에서만 다룬다.
      const rows = await db
        .select()
        .from(projects)
        .where(and(inArray(projects.id, ids), isNull(projects.deleted_at)));
      const roleById = new Map(memberships.map((m) => [m.project_id, m.role]));
      const operationalRoleById = new Map(memberships.map((m) => [m.project_id, m.operational_role]));
      res.json({ projects: rows.map((p) => ({ ...p, my_role: roleById.get(p.id), my_operational_role: operationalRoleById.get(p.id) })) });
    }),
  );

  // Create — 생성자가 소유자(owner)가 된다. projects.owner_id와 멤버 role 모두 owner로 일치.
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          key: z.string().optional(),
          // .nullable() 필수 — 없으면 z.coerce가 null을 new Date(null)=1970-01-01로 오변환한다 (PATCH·MCP의 null=해제 규약과 일치)
          start_date: z.coerce.date().nullable().optional(),
          end_date: z.coerce.date().nullable().optional(),
        })
        .parse(req.body);
      // 기간 역전 방지 — 종료일이 시작일보다 앞설 수 없다 (태스크 due<scheduled와 같은 규칙)
      if (body.start_date && body.end_date && body.end_date.getTime() < body.start_date.getTime())
        throw err.badRequest("종료일이 시작일보다 앞설 수 없습니다.");
      const key = await generateProjectKey(body.name, body.key);
      const [p] = await db
        .insert(projects)
        .values({
          key,
          name: body.name,
          description: body.description ?? null,
          owner_id: req.userId!,
          start_date: body.start_date ?? null,
          end_date: body.end_date ?? null,
        })
        .returning();
      await db.insert(projectMembers).values({ project_id: p.id, user_id: req.userId!, role: "owner", operational_role: "pm" });
      await logActivity({ project_id: p.id, user_id: req.userId, action: "project.created", meta: { key } });
      res.status(201).json({ project: { ...p, my_role: "owner", my_operational_role: "pm" } });
    }),
  );

  // G2-1: 전체 프로젝트 (사이트 관리자 전용). ★ /:projectId 파라미터 라우트보다 먼저 등록해야
  // "all"이 projectId로 매칭되지 않는다. my_role=멤버면 역할, 아니면 null + 멤버 수.
  r.get(
    "/all",
    ah(async (req, res) => {
      const u = await currentUser(req);
      if (!u?.is_admin) throw err.forbidden("관리자만 접근할 수 있습니다.");
      const all = await db.select().from(projects).where(isNull(projects.deleted_at));
      const mine = await db
        .select({ project_id: projectMembers.project_id, role: projectMembers.role })
        .from(projectMembers)
        .where(eq(projectMembers.user_id, req.userId!));
      const roleById = new Map(mine.map((m) => [m.project_id, m.role]));
      const counts = await db
        .select({ project_id: projectMembers.project_id, count: sql<number>`count(*)::int` })
        .from(projectMembers)
        .groupBy(projectMembers.project_id);
      const countById = new Map(counts.map((c) => [c.project_id, c.count]));
      res.json({
        projects: all.map((p) => ({ ...p, my_role: roleById.get(p.id) ?? null, member_count: countById.get(p.id) ?? 0 })),
      });
    }),
  );

  // 휴지통 목록. ★ "/:projectId"보다 먼저 등록해야 한다 (리터럴 > 파라미터 — /all과 같은 이유).
  // 내가 관리할 수 있는 것만 보인다: 내 프로젝트(매니저 이상) + 관리자면 전체.
  r.get(
    "/trash",
    ah(async (req, res) => {
      const u = await currentUser(req);
      const trashed = await db
        .select()
        .from(projects)
        .where(isNotNull(projects.deleted_at))
        .orderBy(desc(projects.deleted_at));
      let visible = trashed;
      if (!u?.is_admin) {
        const mine = await db
          .select({ pid: projectMembers.project_id, role: projectMembers.role })
          .from(projectMembers)
          .where(eq(projectMembers.user_id, req.userId!));
        const manageable = new Set(mine.filter((m) => roleAtLeast(m.role, "manager")).map((m) => m.pid));
        visible = trashed.filter((p) => manageable.has(p.id));
      }
      res.json({
        retention_days: TRASH_RETENTION_DAYS,
        projects: visible.map((p) => ({
          ...p,
          // 남은 일수 — 0이면 다음 크론에서 사라진다. 올림해서 "오늘 지나면 0일"이 되지 않게.
          days_left: Math.max(
            0,
            Math.ceil((p.deleted_at!.getTime() + TRASH_RETENTION_DAYS * 86400_000 - Date.now()) / 86400_000),
          ),
        })),
      });
    }),
  );

  // G2-2: 원클릭 매니저 참여 (사이트 관리자 전용). requireMember를 쓰면 안 됨 — 아직 멤버가 아니다.
  // 멱등: 이미 멤버면 그대로 성공 반환.
  r.post(
    "/:projectId/join-as-admin",
    ah(async (req, res) => {
      const u = await currentUser(req);
      if (!u?.is_admin) throw err.forbidden("관리자만 접근할 수 있습니다.");
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      const [proj] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!proj) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      const [existing] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, req.userId!)))
        .limit(1);
      if (!existing) {
        await db.insert(projectMembers).values({ project_id: pid, user_id: req.userId!, role: "manager", operational_role: "pm" });
        await logActivity({ project_id: pid, user_id: req.userId, action: "member.admin_joined", meta: {} });
      }
      res.status(201).json({ ok: true, project_id: pid, my_role: "manager", my_operational_role: "pm" });
    }),
  );

  // Detail (any member).
  r.get(
    "/:projectId",
    requireMember(),
    ah(async (req, res) => {
      const [p] = await db.select().from(projects).where(eq(projects.id, req.membership!.project_id)).limit(1);
      res.json({ project: { ...p, my_role: req.membership!.role, my_operational_role: req.membership!.operational_role } });
    }),
  );

  // Update (owner only) — PATCH partial whitelist (§10.3 mass-assignment).
  r.patch(
    "/:projectId",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const patch = z
        .object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          status: z.enum(PROJECT_STATUS).optional(),
          start_date: z.coerce.date().nullable().optional(),
          end_date: z.coerce.date().nullable().optional(),
          github_repo: z.string().nullable().optional(),
          auto_complete_on_pr_merge: z.boolean().optional(),
          require_checklist_done_before_auto_complete: z.boolean().optional(),
          require_guide_applied_before_done: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      const pid = req.membership!.project_id;
      const [before] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      // 기간 역전 방지 — 부분 PATCH는 기존 값과 병합한 결과로 검증(한쪽만 보내는 갱신 커버)
      const nextStart = patch.start_date !== undefined ? patch.start_date : before.start_date;
      const nextEnd = patch.end_date !== undefined ? patch.end_date : before.end_date;
      if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime())
        throw err.badRequest("종료일이 시작일보다 앞설 수 없습니다.");
      const [p] = await db
        .update(projects)
        // 기간은 검증한 병합쌍을 통째로 기록 — 부분 write면 동시 PATCH 두 건이 각자 검증을 통과하고 합쳐져 역전 row가 될 수 있다
        .set({ ...patch, start_date: nextStart, end_date: nextEnd, updated_at: new Date() })
        .where(eq(projects.id, pid))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "project.updated", meta: { patch } });

      // P5 trigger: transition to 'completed' kicks off SKILL.md extraction.
      if (patch.status === "completed" && before.status !== "completed") {
        await runSkillExtraction(pid, req.userId!).catch((e) => console.error("[skill-extract]", e));
      }
      res.json({ project: p });
    }),
  );

  // 삭제 영향 요약 — 다이얼로그가 "무엇이 사라지고 무엇이 남는지"를 보여주기 위한 조회.
  r.get(
    "/:projectId/deletion-impact",
    ah(async (req, res) => {
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      await assertCanManageProject(req, pid);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      res.json({ project: { id: p.id, name: p.name, key: p.key }, impact: await deletionImpact(pid), retention_days: TRASH_RETENTION_DAYS });
    }),
  );

  // 보관/보관 해제. PATCH /:projectId로도 status를 바꿀 수 있지만 그건 requireMember 게이트라
  // **참여하지 않은 관리자**가 쓸 수 없다(정리하려고 참여하면 팀원 목록에 이름이 남는다).
  r.post(
    "/:projectId/archive",
    ah(async (req, res) => {
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      await assertCanManageProject(req, pid);
      const body = z.object({ archived: z.boolean() }).strict().parse(req.body);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      if (p.deleted_at) throw err.badRequest("휴지통에 있는 프로젝트입니다. 먼저 복원하세요.");
      // 완료(completed)는 노하우 추출을 마친 상태라 보관 해제로 덮어쓰지 않는다.
      const next = body.archived ? "archived" : p.status === "archived" ? "active" : p.status;
      const [updated] = await db
        .update(projects)
        .set({ status: next, updated_at: new Date() })
        .where(eq(projects.id, pid))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: body.archived ? "project.archived" : "project.unarchived", meta: {} });
      res.json({ project: updated });
    }),
  );

  // 휴지통으로 이동(소프트 삭제). 30일 안에 복원할 수 있고, 그 전에 즉시 영구삭제도 가능하다.
  // 검수 전 노하우 초안은 **차단하지 않는다** — 소유자가 퇴사하면 아무도 게시할 수 없어
  // 프로젝트를 영영 못 지우는 데드락이 된다. 대신 경고로 알리고(클라), 초안은 프로젝트가
  // 사라져도 '미분류'로 작성자·관리자에게 계속 보인다(skills.ts 조회 보정).
  r.post(
    "/:projectId/trash",
    ah(async (req, res) => {
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      await assertCanManageProject(req, pid);
      const body = z.object({ confirm_name: z.string() }).strict().parse(req.body);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      if (p.deleted_at) throw err.badRequest("이미 휴지통에 있습니다.");
      assertNameConfirmed(body.confirm_name, p.name);
      const [updated] = await db
        .update(projects)
        .set({ deleted_at: new Date(), deleted_by: req.userId!, updated_at: new Date() })
        .where(and(eq(projects.id, pid), isNull(projects.deleted_at)))
        .returning();
      if (!updated) throw err.badRequest("이미 휴지통에 있습니다.");
      await logActivity({ project_id: pid, user_id: req.userId, action: "project.trashed", meta: { name: p.name } });
      res.json({ project: updated, retention_days: TRASH_RETENTION_DAYS });
    }),
  );

  // 휴지통에서 복원.
  r.post(
    "/:projectId/restore",
    ah(async (req, res) => {
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      await assertCanManageProject(req, pid);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      if (!p.deleted_at) throw err.badRequest("휴지통에 있는 프로젝트가 아닙니다.");
      const [restored] = await db
        .update(projects)
        .set({ deleted_at: null, deleted_by: null, updated_at: new Date() })
        .where(eq(projects.id, pid))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "project.restored", meta: { name: p.name } });
      res.json({ project: restored });
    }),
  );

  // 즉시 영구 삭제 — 30일을 기다리지 않고 지금 지운다. 되돌릴 수 없다.
  // 휴지통을 거친 것만 허용해 "활성 프로젝트 원클릭 소멸"을 막는다(2단계 강제).
  r.post(
    "/:projectId/purge",
    ah(async (req, res) => {
      const pid = Number(req.params.projectId);
      if (!Number.isInteger(pid)) throw err.badRequest("projectId가 필요합니다.");
      await assertCanManageProject(req, pid);
      const body = z.object({ confirm_name: z.string() }).strict().parse(req.body);
      const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw err.notFound("프로젝트를 찾을 수 없습니다.");
      if (!p.deleted_at) throw err.badRequest("먼저 휴지통으로 옮겨야 영구 삭제할 수 있습니다.");
      assertNameConfirmed(body.confirm_name, p.name);
      await purgeProject(pid, req.userId!);
      res.json({ ok: true, purged: true });
    }),
  );

  // Members list.
  r.get(
    "/:projectId/members",
    requireMember(),
    ah(async (req, res) => {
      const rows = await db
        .select({ id: projectMembers.id, role: projectMembers.role, operational_role: projectMembers.operational_role, joined_at: projectMembers.joined_at, user: users })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.user_id))
        .where(eq(projectMembers.project_id, req.membership!.project_id))
        // 가입순 고정 — ORDER BY 없이는 PG가 순서를 보장하지 않아 캘린더 열 순서가 UPDATE 후 뒤바뀔 수 있다
        .orderBy(projectMembers.joined_at, projectMembers.id);
      res.json({ members: rows.map((m) => ({ id: m.id, role: m.role, operational_role: m.operational_role, joined_at: m.joined_at, user: publicUser(m.user) })) });
    }),
  );

  // G1-5: 이 프로젝트에 아직 없는 활성 사용자 목록 (매니저 전용, 프로젝트 스코프 — 전역 회원 목록 API를 만들지 않음).
  // 이메일 정확 타이핑 대신 선택 방식으로 팀원을 추가하기 위한 후보 목록.
  r.get(
    "/:projectId/addable-users",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const existing = await db
        .select({ user_id: projectMembers.user_id })
        .from(projectMembers)
        .where(eq(projectMembers.project_id, pid));
      const existingIds = new Set(existing.map((m) => m.user_id));
      const rows = await db.select().from(users).where(eq(users.is_active, true));
      const addable = rows.filter((u) => !existingIds.has(u.id)).map(publicUser);
      res.json({ users: addable });
    }),
  );

  // G1-5: 이미 가입된 활성 사용자를 user_id로 직접 추가 (매니저 전용). 이메일 방식 제거 — addable-users에서 선택.
  r.post(
    "/:projectId/members",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const body = z.object({ user_id: z.number().int(), role: z.enum(ASSIGNABLE_ROLES).default("member") }).strict().parse(req.body);
      const pid = req.membership!.project_id;
      const [user] = await db.select().from(users).where(eq(users.id, body.user_id)).limit(1);
      if (!user || !user.is_active) throw err.notFound("가입된 사용자를 찾을 수 없습니다. 아직 가입 전이라면 초대 링크를 사용하세요.");
      const [existingMembership] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, user.id)))
        .limit(1);
      if (existingMembership) throw err.conflict("이미 프로젝트에 참여 중인 사용자입니다.");
      const [m] = await db
        .insert(projectMembers)
        .values({ project_id: pid, user_id: user.id, role: body.role, operational_role: body.role === "manager" ? "pm" : "worker" })
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.added", meta: { member_id: m.id, user_id: user.id, role: body.role } });
      res.status(201).json({ member: { ...m, user: publicUser(user) } });
    }),
  );

  // Change role (manager 이상). 대상은 manager/member만 지정 가능 — owner는 양도 API로만.
  r.patch(
    "/:projectId/members/:memberId",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const body = z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict().parse(req.body);
      const pid = req.membership!.project_id;
      const [target] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.id, Number(req.params.memberId)), eq(projectMembers.project_id, pid)))
        .limit(1);
      if (!target) throw err.notFound("멤버를 찾을 수 없습니다.");
      // 소유자 행은 이 API로 바꿀 수 없다(강등 차단) — 소유권 양도로만.
      assertNotOwner(target.role, "demote");
      const [m] = await db
        .update(projectMembers)
        .set({ role: body.role, operational_role: body.role === "manager" ? "pm" : target.operational_role })
        .where(eq(projectMembers.id, target.id))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.role_changed", meta: { member_id: m.id, role: body.role } });
      res.json({ member: m });
    }),
  );

  // Remove member (manager 이상). 소유자는 제거 불가.
  r.delete(
    "/:projectId/members/:memberId",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.id, Number(req.params.memberId)), eq(projectMembers.project_id, pid)))
        .limit(1);
      if (!m) throw err.notFound("멤버를 찾을 수 없습니다.");
      assertNotOwner(m.role, "remove");
      await db.delete(projectMembers).where(eq(projectMembers.id, m.id));
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.removed", meta: { member_id: m.id } });
      res.json({ ok: true });
    }),
  );

  // 소유권 양도 (owner 전용). 대상=프로젝트 멤버. 현 소유자는 manager로 내려오고,
  // 대상이 owner가 되며 projects.owner_id도 함께 갱신 — 항상 owner 정확히 1명 유지.
  r.post(
    "/:projectId/transfer-owner",
    requireMember(),
    requireRole("owner"),
    ah(async (req, res) => {
      const body = z.object({ user_id: z.number().int() }).strict().parse(req.body);
      const pid = req.membership!.project_id;
      if (body.user_id === req.userId!) throw err.badRequest("이미 소유자입니다.");
      const [target] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, body.user_id)))
        .limit(1);
      if (!target) throw err.notFound("프로젝트 멤버가 아닌 사용자에게는 양도할 수 없습니다.");
      await db.transaction(async (tx) => {
        await tx
          .update(projectMembers)
          .set({ role: "manager", operational_role: "pm" })
          .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, req.userId!)));
        await tx.update(projectMembers).set({ role: "owner", operational_role: "pm" }).where(eq(projectMembers.id, target.id));
        await tx.update(projects).set({ owner_id: body.user_id, updated_at: new Date() }).where(eq(projects.id, pid));
      });
      await logActivity({ project_id: pid, user_id: req.userId, action: "project.owner_transferred", meta: { to_user_id: body.user_id } });
      res.json({ ok: true, new_owner_id: body.user_id });
    }),
  );

  // Create invite (manager) — returns one-time link.
  r.post(
    "/:projectId/invites",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const body = z
        .object({ email: z.string().email(), role: z.enum(ASSIGNABLE_ROLES).default("member"), expires_in_hours: z.number().min(1).max(720).default(72) })
        .parse(req.body);
      const { token, hash } = makeInviteToken();
      const pid = req.membership!.project_id;
      const [inv] = await db
        .insert(invites)
        .values({
          email: body.email.toLowerCase(),
          project_id: pid,
          role: body.role,
          token_hash: hash,
          expires_at: new Date(Date.now() + body.expires_in_hours * 3600_000),
          created_by: req.userId!,
        })
        .returning({ id: invites.id, email: invites.email, role: invites.role, expires_at: invites.expires_at });
      await logActivity({ project_id: pid, user_id: req.userId, action: "invite.created", meta: { email: body.email, role: body.role } });
      // Plaintext token surfaced once; link for the invitee.
      // 초대 링크는 실제 접속 도메인 기준으로 생성 (localhost 고정 방지)
      res.status(201).json({ invite: inv, token, invite_url: `${baseUrl(req)}/invite?token=${token}` });
    }),
  );

  // P2 task routes nested under a project (list/create/board views).
  registerProjectOperationRoutes(r);
  registerProjectDailyReportRoutes(r);
  registerProjectReportMemoRoutes(r);
  registerProjectTaskRoutes(r);
  // F4 문서 페이지 routes (트리 + 마크다운 + 태스크 파생)
  registerProjectPageRoutes(r);

  return r;
}
