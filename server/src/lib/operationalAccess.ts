import { and, eq } from "drizzle-orm";
import { db } from "./db.ts";
import { err } from "./errors.ts";
import { projectAreas, projectMembers, projects, type MemberRole, type OperationalRole } from "../../../shared/schema.ts";

export interface OperationalAccess {
  projectId: number;
  userId: number;
  legacyRole: MemberRole;
  operationalRole: OperationalRole;
  reportEnabled: boolean;
  leadAreaIds: number[];
}

export async function loadOperationalAccess(projectId: number, userId: number): Promise<OperationalAccess | null> {
  const [membership] = await db
    .select({
      role: projectMembers.role,
      operational_role: projectMembers.operational_role,
      daily_report_enabled: projects.daily_report_enabled,
      deleted_at: projects.deleted_at,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.project_id))
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  if (!membership || membership.deleted_at) return null;
  const leads = await db
    .select({ id: projectAreas.id })
    .from(projectAreas)
    .where(and(eq(projectAreas.project_id, projectId), eq(projectAreas.lead_user_id, userId)));
  return {
    projectId,
    userId,
    legacyRole: membership.role,
    operationalRole: membership.operational_role,
    reportEnabled: membership.daily_report_enabled,
    leadAreaIds: leads.map((row) => row.id),
  };
}

export function isProjectPm(access: OperationalAccess): boolean {
  return access.operationalRole === "pm";
}

export function isProjectPl(access: OperationalAccess): boolean {
  return access.operationalRole === "pl" && access.leadAreaIds.length > 0;
}

export function assertReportActor(access: OperationalAccess | null): asserts access is OperationalAccess {
  if (!access) throw err.forbidden("프로젝트 멤버가 아닙니다.");
  if (!access.reportEnabled) throw err.notFound("이 프로젝트에는 일일보고 기능이 활성화되지 않았습니다.");
  if (!(isProjectPm(access) || isProjectPl(access))) throw err.forbidden("PM 또는 PL만 일일보고를 사용할 수 있습니다.");
}

export function assertProjectPm(access: OperationalAccess | null): asserts access is OperationalAccess {
  if (!access || !isProjectPm(access)) throw err.forbidden("PM만 변경할 수 있습니다.");
}

export function canManageArea(access: OperationalAccess, areaId: number | null): boolean {
  if (isProjectPm(access)) return true;
  return areaId != null && isProjectPl(access) && access.leadAreaIds.includes(areaId);
}

export async function assertAreaInProject(areaId: number, projectId: number): Promise<void> {
  const [area] = await db
    .select({ id: projectAreas.id })
    .from(projectAreas)
    .where(and(eq(projectAreas.id, areaId), eq(projectAreas.project_id, projectId)))
    .limit(1);
  if (!area) throw err.badRequest("이 프로젝트의 영역이 아닙니다.");
}
