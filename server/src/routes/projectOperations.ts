import type { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { OPERATIONAL_ROLE, projectAreas, projectMembers, projects, users } from "../../../shared/schema.ts";
import { db } from "../lib/db.ts";
import { err } from "../lib/errors.ts";
import { ah, publicUser } from "../lib/http.ts";
import { logActivity } from "../lib/activity.ts";
import { assertProjectPm, canManageArea, loadOperationalAccess } from "../lib/operationalAccess.ts";
import { requireMember } from "../middleware/auth.ts";

async function memberInProject(projectId: number, userId: number) {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  return row ?? null;
}

export function registerProjectOperationRoutes(r: Router): void {
  r.patch(
    "/:projectId/report-settings",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      const body = z
        .object({
          daily_report_enabled: z.boolean().optional(),
          report_cutoff_hour: z.number().int().min(0).max(23).optional(),
          report_meeting_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
          timezone: z.literal("Asia/Seoul").optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, "변경할 설정이 필요합니다.")
        .parse(req.body);
      const [project] = await db
        .update(projects)
        .set({ ...body, updated_at: new Date() })
        .where(eq(projects.id, pid))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "report.settings_changed", meta: body });
      res.json({ project });
    }),
  );

  r.get(
    "/:projectId/areas",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const rows = await db
        .select({ area: projectAreas, lead: users })
        .from(projectAreas)
        .leftJoin(users, eq(users.id, projectAreas.lead_user_id))
        .where(eq(projectAreas.project_id, pid))
        .orderBy(asc(projectAreas.sort_order), asc(projectAreas.id));
      res.json({
        areas: rows.map(({ area, lead }) => ({ ...area, lead: lead ? publicUser(lead) : null })),
        my_operational_role: req.membership!.operational_role,
      });
    }),
  );

  r.post(
    "/:projectId/areas",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(1000).nullable().optional(),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          sort_order: z.number().int().optional(),
          lead_user_id: z.number().int().nullable().optional(),
        })
        .strict()
        .parse(req.body);
      if (body.lead_user_id != null && !(await memberInProject(pid, body.lead_user_id)))
        throw err.badRequest("PL은 프로젝트 멤버 중에서 지정해야 합니다.");
      const [area] = await db
        .insert(projectAreas)
        .values({ ...body, project_id: pid, created_by: req.userId! })
        .returning();
      if (body.lead_user_id != null) {
        await db
          .update(projectMembers)
          .set({ operational_role: "pl" })
          .where(and(
            eq(projectMembers.project_id, pid),
            eq(projectMembers.user_id, body.lead_user_id),
            eq(projectMembers.operational_role, "worker"),
          ));
      }
      await logActivity({ project_id: pid, user_id: req.userId, action: "area.created", meta: { area_id: area.id, name: area.name, lead_user_id: area.lead_user_id } });
      res.status(201).json({ area });
    }),
  );

  r.patch(
    "/:projectId/areas/:areaId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const areaId = Number(req.params.areaId);
      const access = await loadOperationalAccess(pid, req.userId!);
      if (!access || !canManageArea(access, areaId)) throw err.forbidden("PM 또는 해당 영역 PL만 변경할 수 있습니다.");
      const isPm = access.operationalRole === "pm";
      const pmSchema = z.object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        sort_order: z.number().int().optional(),
        lead_user_id: z.number().int().nullable().optional(),
      }).strict();
      const plSchema = z.object({
        description: z.string().trim().max(1000).nullable().optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        sort_order: z.number().int().optional(),
      }).strict();
      const body = (isPm ? pmSchema : plSchema)
        .refine((value) => Object.keys(value).length > 0, "변경할 내용이 필요합니다.")
        .parse(req.body);
      const leadUserId = "lead_user_id" in body ? body.lead_user_id as number | null | undefined : undefined;
      if (leadUserId != null && !(await memberInProject(pid, leadUserId)))
        throw err.badRequest("PL은 프로젝트 멤버 중에서 지정해야 합니다.");
      const [area] = await db
        .update(projectAreas)
        .set({ ...body, updated_at: new Date() })
        .where(and(eq(projectAreas.id, areaId), eq(projectAreas.project_id, pid)))
        .returning();
      if (!area) throw err.notFound("영역을 찾을 수 없습니다.");
      if (leadUserId != null) {
        await db
          .update(projectMembers)
          .set({ operational_role: "pl" })
          .where(and(
            eq(projectMembers.project_id, pid),
            eq(projectMembers.user_id, leadUserId),
            eq(projectMembers.operational_role, "worker"),
          ));
      }
      await logActivity({ project_id: pid, user_id: req.userId, action: "area.updated", meta: { area_id: area.id, fields: Object.keys(body) } });
      res.json({ area });
    }),
  );

  r.delete(
    "/:projectId/areas/:areaId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      const [area] = await db
        .delete(projectAreas)
        .where(and(eq(projectAreas.id, Number(req.params.areaId)), eq(projectAreas.project_id, pid)))
        .returning();
      if (!area) throw err.notFound("영역을 찾을 수 없습니다.");
      await logActivity({ project_id: pid, user_id: req.userId, action: "area.deleted", meta: { area_id: area.id, name: area.name } });
      res.json({ ok: true });
    }),
  );

  r.patch(
    "/:projectId/members/:userId/operational-role",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const access = await loadOperationalAccess(pid, req.userId!);
      assertProjectPm(access);
      const userId = Number(req.params.userId);
      const body = z.object({ operational_role: z.enum(OPERATIONAL_ROLE) }).strict().parse(req.body);
      const target = await memberInProject(pid, userId);
      if (!target) throw err.notFound("멤버를 찾을 수 없습니다.");
      if (target.operational_role === "pm" && body.operational_role !== "pm") {
        const pms = await db.select({ id: projectMembers.id }).from(projectMembers)
          .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.operational_role, "pm")));
        if (pms.length <= 1) throw err.conflict("프로젝트에는 최소 한 명의 PM이 필요합니다. 다른 PM을 먼저 지정하세요.");
      }
      if (body.operational_role === "worker") {
        const [ledArea] = await db
          .select({ id: projectAreas.id })
          .from(projectAreas)
          .where(and(eq(projectAreas.project_id, pid), eq(projectAreas.lead_user_id, userId)))
          .limit(1);
        if (ledArea) throw err.conflict("담당 영역의 PL을 먼저 변경한 뒤 담당자로 바꾸세요.");
      }
      const [membership] = await db
        .update(projectMembers)
        .set({
          operational_role: body.operational_role,
          // 기존 라우트/MCP도 같은 책임 범위를 따르도록 호환 역할을 함께 정렬한다.
          role: target.role === "owner" ? "owner" : body.operational_role === "pm" ? "manager" : "member",
        })
        .where(eq(projectMembers.id, target.id))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "member.operational_role_changed", meta: { user_id: userId, operational_role: body.operational_role } });
      res.json({ membership });
    }),
  );
}
