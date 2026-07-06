import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, or, isNull, desc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { skills, projectMembers, SKILL_STATUS, roleAtLeast } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth, requireMember, requireRole } from "../middleware/auth.ts";
import { runSkillExtraction, toSkillMarkdown } from "../lib/skillExtractor.ts";
import { err } from "../lib/errors.ts";

export function skillsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // Org library: published skills (all) + drafts from projects the user belongs to.
  r.get(
    "/",
    ah(async (req, res) => {
      const myProjects = (
        await db.select({ pid: projectMembers.project_id }).from(projectMembers).where(eq(projectMembers.user_id, req.userId!))
      ).map((m) => m.pid);
      const projectFilter = req.query.project_id ? Number(req.query.project_id) : null;
      let rows;
      if (projectFilter) {
        if (!myProjects.includes(projectFilter)) throw err.forbidden("프로젝트 멤버가 아닙니다.");
        rows = await db.select().from(skills).where(eq(skills.project_id, projectFilter)).orderBy(desc(skills.created_at));
      } else {
        // published (org-wide) OR drafts within my projects
        rows = await db
          .select()
          .from(skills)
          .where(or(eq(skills.status, "published"), myProjects.length ? inArray(skills.project_id, myProjects) : eq(skills.status, "published")))
          .orderBy(desc(skills.created_at));
      }
      res.json({ skills: rows });
    }),
  );

  r.get(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(skills).where(eq(skills.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      // access: published is public to any authed user; drafts require project membership
      if (s.status !== "published" && s.project_id) {
        const [m] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.project_id, s.project_id), eq(projectMembers.user_id, req.userId!)))
          .limit(1);
        if (!m) throw err.forbidden();
      }
      res.json({ skill: s });
    }),
  );

  // Export as SKILL.md text (for Claude Code / Cowork skill folder).
  r.get(
    "/:id/export",
    ah(async (req, res) => {
      const [s] = await db.select().from(skills).where(eq(skills.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      if (s.status !== "published" && s.project_id) {
        const [m] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.project_id, s.project_id), eq(projectMembers.user_id, req.userId!)))
          .limit(1);
        if (!m) throw err.forbidden();
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${s.name}.SKILL.md"`);
      res.send(toSkillMarkdown(s));
    }),
  );

  // Edit / publish a draft (strict whitelist). Project owner/manager or creator.
  r.patch(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(skills).where(eq(skills.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      let allowed = s.created_by === req.userId!;
      if (!allowed && s.project_id) {
        const [m] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.project_id, s.project_id), eq(projectMembers.user_id, req.userId!)))
          .limit(1);
        allowed = !!m && roleAtLeast(m.role, "manager");
      }
      if (!allowed) throw err.forbidden();
      const patch = z
        .object({
          title: z.string().min(1).optional(),
          category: z.string().optional(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          body: z.string().optional(),
          antipatterns: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          status: z.enum(SKILL_STATUS).optional(),
        })
        .strict()
        .parse(req.body);
      const [row] = await db.update(skills).set({ ...patch, updated_at: new Date() }).where(eq(skills.id, s.id)).returning();
      res.json({ skill: row });
    }),
  );

  // Manually trigger extraction for a project (manager). Also auto-runs on project 'completed'.
  r.post(
    "/extract/:projectId",
    requireMember(),
    requireRole("manager"),
    ah(async (req, res) => {
      const ids = await runSkillExtraction(req.membership!.project_id, req.userId!);
      const rows = ids.length ? await db.select().from(skills).where(inArray(skills.id, ids)) : [];
      res.status(201).json({ skills: rows });
    }),
  );

  return r;
}
