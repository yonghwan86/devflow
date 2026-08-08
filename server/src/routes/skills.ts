import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq, inArray, or, isNull, desc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { skills, projectMembers, SKILL_STATUS, roleAtLeast } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth, requireMember, requireRole, currentUser } from "../middleware/auth.ts";
import { runSkillExtraction, toSkillMarkdown } from "../lib/skillExtractor.ts";
import { err } from "../lib/errors.ts";

// 노하우 열람 권한 — 목록(GET /)·상세(GET /:id)·내보내기(GET /:id/export)가 **같은 규칙**을 써야 한다.
// 기존 코드는 `status !== "published" && s.project_id` 였는데, 프로젝트 영구삭제로 project_id가
// NULL이 된 **고아 초안**에서는 뒷조건이 거짓이라 멤버십 검사를 통째로 건너뛰었다
// → 비공개 초안이 아무 로그인 사용자에게나 열렸다. 고아는 작성자·사이트 관리자에게만 보인다.
async function assertSkillVisible(req: Request, s: { status: string; project_id: number | null; created_by: number | null }): Promise<void> {
  if (s.status === "published") return; // 게시본은 조직 전체 공개
  if (s.project_id) {
    const [m] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.project_id, s.project_id), eq(projectMembers.user_id, req.userId!)))
      .limit(1);
    if (!m) throw err.forbidden();
    return;
  }
  // 고아 초안(프로젝트가 삭제됨)
  if (s.created_by && s.created_by === req.userId) return; // 본인 글은 토큰으로도 열람 가능
  // 관리자 승격 열람은 **세션 전용**. Bearer(req.tokenScopes)로는 열지 않는다 —
  // 최소 스코프로 발급한 MCP 토큰 하나가 전사 비공개 초안의 열쇠가 되면 안 된다(C5와 같은 감각).
  if (!req.tokenScopes) {
    const u = await currentUser(req);
    if (u?.is_admin) return;
  }
  throw err.forbidden();
}

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
        // ★ 고아 노하우(project_id IS NULL — 프로젝트가 삭제돼 SET NULL 된 것)는 위 두 조건 어디에도
        //   안 걸려 "DB에는 있는데 아무도 못 보는" 상태가 된다. 프로젝트를 지워도 배움은 남아야 하므로
        //   작성자 본인과 사이트 관리자에게는 계속 보이게 한다(원래 프로젝트 멤버에게만 보이던 초안이라
        //   조직 전체 공개는 하지 않는다 — 검수 후 published로 올리면 그때 전체 공개).
        // 관리자 승격 가시성은 세션 전용 — assertSkillVisible과 같은 규칙(토큰은 본인 글까지만).
        const u = req.tokenScopes ? null : await currentUser(req);
        const visible = [
          eq(skills.status, "published"),
          ...(myProjects.length ? [inArray(skills.project_id, myProjects)] : []),
          u?.is_admin ? isNull(skills.project_id) : and(isNull(skills.project_id), eq(skills.created_by, req.userId!))!,
        ];
        rows = await db
          .select()
          .from(skills)
          .where(or(...visible))
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
      await assertSkillVisible(req, s);
      res.json({ skill: s });
    }),
  );

  // Export as SKILL.md text (for Claude Code / Cowork skill folder).
  r.get(
    "/:id/export",
    ah(async (req, res) => {
      const [s] = await db.select().from(skills).where(eq(skills.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      await assertSkillVisible(req, s);
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
