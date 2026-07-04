import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { projects, projectMembers, users, invites, PROJECT_STATUS, MEMBER_ROLE } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { requireAuth, requireMember, requireRole } from "../middleware/auth.ts";
import { generateProjectKey } from "../lib/projectKey.ts";
import { logActivity } from "../lib/activity.ts";
import { makeInviteToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { registerProjectTaskRoutes } from "./projectTasks.ts";
import { runSkillExtraction } from "../lib/skillExtractor.ts";

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
      await db.insert(projectMembers).values({ project_id: p.id, user_id: req.userId!, role: "owner" });
      await logActivity({ project_id: p.id, user_id: req.userId, action: "project.created", meta: { key } });
      res.status(201).json({ project: { ...p, my_role: "owner" } });
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
    requireRole("owner"),
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

  // Add existing user directly (owner/manager).
  r.post(
    "/:projectId/members",
    requireMember(),
    requireRole("owner", "manager"),
    ah(async (req, res) => {
      const body = z.object({ email: z.string().email(), role: z.enum(MEMBER_ROLE).default("member") }).parse(req.body);
      const [u] = await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1);
      if (!u) throw err.notFound("해당 사용자가 없습니다. 초대 링크를 사용하세요.");
      const pid = req.membership!.project_id;
      const [m] = await db
        .insert(projectMembers)
        .values({ project_id: pid, user_id: u.id, role: body.role })
        .onConflictDoNothing()
        .returning();
      if (!m) throw err.conflict("이미 멤버입니다.");
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.added", meta: { user_id: u.id, role: body.role } });
      res.status(201).json({ member: { id: m.id, role: m.role, user: publicUser(u) } });
    }),
  );

  // Change role (owner).
  r.patch(
    "/:projectId/members/:memberId",
    requireMember(),
    requireRole("owner"),
    ah(async (req, res) => {
      const body = z.object({ role: z.enum(MEMBER_ROLE) }).strict().parse(req.body);
      const pid = req.membership!.project_id;
      const [m] = await db
        .update(projectMembers)
        .set({ role: body.role })
        .where(and(eq(projectMembers.id, Number(req.params.memberId)), eq(projectMembers.project_id, pid)))
        .returning();
      if (!m) throw err.notFound("멤버를 찾을 수 없습니다.");
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.role_changed", meta: { member_id: m.id, role: body.role } });
      res.json({ member: m });
    }),
  );

  // Remove member (owner). Cannot remove the owner.
  r.delete(
    "/:projectId/members/:memberId",
    requireMember(),
    requireRole("owner"),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const [m] = await db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.id, Number(req.params.memberId)), eq(projectMembers.project_id, pid)))
        .limit(1);
      if (!m) throw err.notFound("멤버를 찾을 수 없습니다.");
      if (m.role === "owner") throw err.badRequest("owner는 제거할 수 없습니다.");
      await db.delete(projectMembers).where(eq(projectMembers.id, m.id));
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.removed", meta: { member_id: m.id } });
      res.json({ ok: true });
    }),
  );

  // Create invite (owner/manager) — returns one-time link.
  r.post(
    "/:projectId/invites",
    requireMember(),
    requireRole("owner", "manager"),
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
      res.status(201).json({ invite: inv, token, invite_url: `${env.APP_BASE_URL}/invite?token=${token}` });
    }),
  );

  // P2 task routes nested under a project (list/create/board views).
  registerProjectTaskRoutes(r);

  return r;
}
