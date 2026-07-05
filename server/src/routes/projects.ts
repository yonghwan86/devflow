import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { projects, projectMembers, users, invites, PROJECT_STATUS, MEMBER_ROLE } from "../../../shared/schema.ts";
import { ah, publicUser, baseUrl } from "../lib/http.ts";
import { requireAuth, requireMember, requireRole, currentUser } from "../middleware/auth.ts";
import { generateProjectKey } from "../lib/projectKey.ts";
import { logActivity } from "../lib/activity.ts";
import { makeInviteToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { registerProjectTaskRoutes } from "./projectTasks.ts";
import { registerProjectPageRoutes } from "./projectPages.ts";
import { runSkillExtraction } from "../lib/skillExtractor.ts";

// G1: 프로젝트에는 매니저가 1명 이상 있어야 한다. 마지막 매니저의 강등/제거를 서버가 최종 차단.
async function assertNotLastManager(projectId: number, excludeMemberId: number): Promise<void> {
  const managers = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.role, "manager")));
  const remaining = managers.filter((m) => m.id !== excludeMemberId);
  if (remaining.length === 0) throw err.badRequest("프로젝트에는 매니저가 1명 이상 필요합니다.");
}

export function projectsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // List — server-side membership filter (§8, §12).
  r.get(
    "/",
    ah(async (req, res) => {
      const memberships = await db
        .select({ project_id: projectMembers.project_id, role: projectMembers.role })
        .from(projectMembers)
        .where(eq(projectMembers.user_id, req.userId!));
      const ids = memberships.map((m) => m.project_id);
      if (ids.length === 0) return res.json({ projects: [] });
      const rows = await db.select().from(projects).where(inArray(projects.id, ids));
      const roleById = new Map(memberships.map((m) => [m.project_id, m.role]));
      res.json({ projects: rows.map((p) => ({ ...p, my_role: roleById.get(p.id) })) });
    }),
  );

  // Create — creator becomes owner.
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          key: z.string().optional(),
          start_date: z.coerce.date().optional(),
          end_date: z.coerce.date().optional(),
        })
        .parse(req.body);
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
      await db.insert(projectMembers).values({ project_id: p.id, user_id: req.userId!, role: "manager" });
      await logActivity({ project_id: p.id, user_id: req.userId, action: "project.created", meta: { key } });
      res.status(201).json({ project: { ...p, my_role: "manager" } });
    }),
  );

  // G2-1: 전체 프로젝트 (사이트 관리자 전용). ★ /:projectId 파라미터 라우트보다 먼저 등록해야
  // "all"이 projectId로 매칭되지 않는다. my_role=멤버면 역할, 아니면 null + 멤버 수.
  r.get(
    "/all",
    ah(async (req, res) => {
      const u = await currentUser(req);
      if (!u?.is_admin) throw err.forbidden("관리자만 접근할 수 있습니다.");
      const all = await db.select().from(projects);
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
        await db.insert(projectMembers).values({ project_id: pid, user_id: req.userId!, role: "manager" });
        await logActivity({ project_id: pid, user_id: req.userId, action: "member.admin_joined", meta: {} });
      }
      res.status(201).json({ ok: true, project_id: pid, my_role: "manager" });
    }),
  );

  // Detail (any member).
  r.get(
    "/:projectId",
    requireMember(),
    ah(async (req, res) => {
      const [p] = await db.select().from(projects).where(eq(projects.id, req.membership!.project_id)).limit(1);
      res.json({ project: { ...p, my_role: req.membership!.role } });
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
      const [p] = await db
        .update(projects)
        .set({ ...patch, updated_at: new Date() })
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

  // Members list.
  r.get(
    "/:projectId/members",
    requireMember(),
    ah(async (req, res) => {
      const rows = await db
        .select({ id: projectMembers.id, role: projectMembers.role, joined_at: projectMembers.joined_at, user: users })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.user_id))
        .where(eq(projectMembers.project_id, req.membership!.project_id));
      res.json({ members: rows.map((m) => ({ id: m.id, role: m.role, joined_at: m.joined_at, user: publicUser(m.user) })) });
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
      const body = z.object({ user_id: z.number().int(), role: z.enum(MEMBER_ROLE).default("member") }).strict().parse(req.body);
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
        .values({ project_id: pid, user_id: user.id, role: body.role })
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.added", meta: { member_id: m.id, user_id: user.id, role: body.role } });
      res.status(201).json({ member: { ...m, user: publicUser(user) } });
    }),
  );

  // Change role (manager). 마지막 매니저 강등 방지.
  r.patch(
    "/:projectId/members/:memberId",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const body = z.object({ role: z.enum(MEMBER_ROLE) }).strict().parse(req.body);
      const pid = req.membership!.project_id;
      const [target] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.id, Number(req.params.memberId)), eq(projectMembers.project_id, pid)))
        .limit(1);
      if (!target) throw err.notFound("멤버를 찾을 수 없습니다.");
      // manager → member 강등 시, 대상이 유일한 매니저면 차단
      if (target.role === "manager" && body.role !== "manager") await assertNotLastManager(pid, target.id);
      const [m] = await db
        .update(projectMembers)
        .set({ role: body.role })
        .where(eq(projectMembers.id, target.id))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.role_changed", meta: { member_id: m.id, role: body.role } });
      res.json({ member: m });
    }),
  );

  // Remove member (manager). 마지막 매니저 제거 방지.
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
      if (m.role === "manager") await assertNotLastManager(pid, m.id);
      await db.delete(projectMembers).where(eq(projectMembers.id, m.id));
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.removed", meta: { member_id: m.id } });
      res.json({ ok: true });
    }),
  );

  // Create invite (manager) — returns one-time link.
  r.post(
    "/:projectId/invites",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const body = z
        .object({ email: z.string().email(), role: z.enum(MEMBER_ROLE).default("member"), expires_in_hours: z.number().min(1).max(720).default(72) })
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
  registerProjectTaskRoutes(r);
  // F4 문서 페이지 routes (트리 + 마크다운 + 태스크 파생)
  registerProjectPageRoutes(r);

  return r;
}
