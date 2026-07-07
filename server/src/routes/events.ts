import { Router } from "express";
import { z } from "zod";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { events, eventAttendees, projects, projectMembers, users, roleAtLeast } from "../../../shared/schema.ts";
import type { EventRow } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";
import { assertAllDayConvention, resolveAttendees, syncAttendees } from "../lib/eventService.ts";

// F5: 일정 이벤트.
// 조회 권한 — 프로젝트 일정: 프로젝트 멤버 / 개인 일정(project_id null): 생성자 OR 참석자.
// 수정·삭제 — 생성자 본인, 또는 프로젝트 일정이면 해당 프로젝트 owner/manager. 참석자-only는 불가.
// PATCH whitelist에서 project_id 제외(개인↔프로젝트 이동 미지원 — 삭제 후 재생성. HANDOFF 기록).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 종일 규약·참석자 검증·초대 push는 lib/eventService.ts로 이동 (MCP·회의록 경로와 공유 — C9)

async function myProjectIds(uid: number): Promise<number[]> {
  const rows = await db
    .select({ id: projectMembers.project_id })
    .from(projectMembers)
    .where(eq(projectMembers.user_id, uid));
  return rows.map((r) => r.id);
}

async function attendeeUserIds(eventId: number): Promise<number[]> {
  const rows = await db
    .select({ user_id: eventAttendees.user_id })
    .from(eventAttendees)
    .where(eq(eventAttendees.event_id, eventId));
  return rows.map((r) => r.user_id);
}

// 이벤트 열람 가능 여부 (없으면 null)
async function loadEventForUser(eventId: number, uid: number): Promise<{ ev: EventRow; canEdit: boolean } | null> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev) return null;
  if (ev.project_id != null) {
    const [m] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.project_id, ev.project_id), eq(projectMembers.user_id, uid)))
      .limit(1);
    if (!m) return null;
    const canEdit = ev.created_by === uid || roleAtLeast(m.role, "manager");
    return { ev, canEdit };
  }
  // 개인 일정: 생성자 OR 참석자 — 참석자 조인만 쓰면 생성자가 누락되니 OR 필수
  if (ev.created_by === uid) return { ev, canEdit: true };
  const atts = await attendeeUserIds(ev.id);
  if (atts.includes(uid)) return { ev, canEdit: false }; // 참석자-only는 열람만
  return null;
}

async function enrich(rows: EventRow[]) {
  const pids = [...new Set(rows.map((e) => e.project_id).filter((x): x is number => x != null))];
  const projRows = pids.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pids))
    : [];
  return Promise.all(
    rows.map(async (e) => {
      const attIds = await attendeeUserIds(e.id);
      const atts = attIds.length ? await db.select().from(users).where(inArray(users.id, attIds)) : [];
      return {
        ...e,
        project_name: e.project_id != null ? projRows.find((p) => p.id === e.project_id)?.name ?? "" : null,
        attendees: atts.map(publicUser),
      };
    }),
  );
}

const bodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().nullable().optional(),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date().nullable().optional(),
  all_day: z.boolean().optional(),
  project_id: z.number().int().nullable().optional(),
  attendee_ids: z.array(z.number().int()).optional(), // 생성자 외 추가 참석자 (C9 규약)
  include_creator: z.boolean().optional(), // false = 대리 등록(생성자 불참). 기본 true — 기존 클라이언트 불변
});

export function eventsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // 기간 조회 — from/to(YYYY-MM-DD) 필수. 클라이언트는 TZ 경계 유실 방지를 위해 ±1일 패딩 요청 후
  // 배치 단계에서 day key로 필터한다.
  r.get(
    "/",
    ah(async (req, res) => {
      const uid = req.userId!;
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw err.badRequest("from/to (YYYY-MM-DD)가 필요합니다.");
      const fromTs = new Date(`${from}T00:00:00.000Z`);
      const toTs = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400_000); // to+1일(UTC자정)

      const pids = await myProjectIds(uid);
      const attEventIds = (
        await db.select({ id: eventAttendees.event_id }).from(eventAttendees).where(eq(eventAttendees.user_id, uid))
      ).map((x) => x.id);

      const visible = or(
        pids.length ? inArray(events.project_id, pids) : sql`false`,
        and(
          isNull(events.project_id),
          attEventIds.length ? or(eq(events.created_by, uid), inArray(events.id, attEventIds)) : eq(events.created_by, uid),
        ),
      );
      const rows = await db
        .select()
        .from(events)
        .where(and(visible, lt(events.starts_at, toTs), gte(sql`coalesce(${events.ends_at}, ${events.starts_at})`, fromTs)));
      res.json({ events: await enrich(rows) });
    }),
  );

  // 생성 — 개인 일정: 누구나 / 프로젝트 일정: 해당 프로젝트 멤버만. 생성자는 자동 참석자.
  r.post(
    "/",
    ah(async (req, res) => {
      const uid = req.userId!;
      const body = bodySchema.strict().parse(req.body);
      if (body.ends_at && body.ends_at.getTime() < body.starts_at.getTime())
        throw err.badRequest("종료 시각이 시작 시각보다 빠릅니다.");
      assertAllDayConvention(body.all_day ?? false, body.starts_at, body.ends_at ?? null);
      const projectId = body.project_id ?? null;
      if (projectId != null) {
        const [m] = await db
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, uid)))
          .limit(1);
        if (!m) throw err.forbidden("프로젝트 멤버만 프로젝트 일정을 만들 수 있습니다.");
      }
      // C9: 최종 참석자 = 공용 규칙(생성자 포함 여부·빈 목록 정규화·멤버십 검증)으로 계산
      const finalAttendees = await resolveAttendees({
        creatorId: uid,
        projectId,
        attendeeIds: body.attendee_ids,
        includeCreator: body.include_creator,
      });

      const [ev] = await db
        .insert(events)
        .values({
          project_id: projectId,
          title: body.title,
          description: body.description ?? null,
          starts_at: body.starts_at,
          ends_at: body.ends_at ?? null,
          all_day: body.all_day ?? false,
          created_by: uid,
        })
        .returning();
      await syncAttendees(ev, finalAttendees, uid);
      if (projectId != null)
        await logActivity({ project_id: projectId, user_id: uid, action: "event.created", meta: { event_id: ev.id, title: ev.title } });
      const [full] = await enrich([ev]);
      res.status(201).json({ event: full });
    }),
  );

  r.get(
    "/:eventId",
    ah(async (req, res) => {
      const acc = await loadEventForUser(Number(req.params.eventId), req.userId!);
      if (!acc) throw err.notFound("일정을 찾을 수 없거나 권한이 없습니다.");
      const [full] = await enrich([acc.ev]);
      res.json({ event: full, can_edit: acc.canEdit });
    }),
  );

  // 수정 — whitelist: title/description/starts_at/ends_at/all_day/attendee_ids (project_id 제외, strict)
  r.patch(
    "/:eventId",
    ah(async (req, res) => {
      const uid = req.userId!;
      const acc = await loadEventForUser(Number(req.params.eventId), uid);
      if (!acc) throw err.notFound("일정을 찾을 수 없거나 권한이 없습니다.");
      if (!acc.canEdit) throw err.forbidden("생성자 또는 프로젝트 매니저만 수정할 수 있습니다.");
      const patch = z
        .object({
          title: z.string().min(1).max(300).optional(),
          description: z.string().nullable().optional(),
          starts_at: z.coerce.date().optional(),
          ends_at: z.coerce.date().nullable().optional(),
          all_day: z.boolean().optional(),
          attendee_ids: z.array(z.number().int()).optional(),
          include_creator: z.boolean().optional(), // POST와 대칭 — 수정 한 번에 생성자가 되살아나던 비대칭 제거 (C9)
        })
        .strict()
        .parse(req.body);
      const starts = patch.starts_at ?? acc.ev.starts_at;
      const ends = patch.ends_at === undefined ? acc.ev.ends_at : patch.ends_at;
      if (ends && ends.getTime() < starts.getTime()) throw err.badRequest("종료 시각이 시작 시각보다 빠릅니다.");
      // 병합 후 최종 상태 기준 검증 — all_day:true 토글만 보내고 기존 시각지정 starts_at이 남는 경우 차단
      assertAllDayConvention(patch.all_day ?? acc.ev.all_day, starts, ends);
      // 반대 방향도 차단: 종일 해제(all_day:false)만 보내면 UTC 자정이 "09:00 KST 시작" 유령 시각이 됨.
      // ends_at도 동일 — 기존 종일 종료(UTC 자정)가 남으면 같은 유령 시각이 종료에 잔존.
      if (patch.all_day === false && acc.ev.all_day) {
        if (patch.starts_at === undefined)
          throw err.badRequest("종일 해제 시 시작 시각(starts_at)을 함께 지정하세요.");
        if (acc.ev.ends_at != null && patch.ends_at === undefined)
          throw err.badRequest("종일 해제 시 종료 시각(ends_at)도 함께 지정하세요(제거하려면 null).");
      }

      const { attendee_ids, include_creator, ...fields } = patch;
      const [updated] = await db
        .update(events)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(events.id, acc.ev.id))
        .returning();
      if (attendee_ids) {
        // C9: POST와 동일 규칙 — include_creator:false면 생성자도 제외 가능(대리 등록 유지), 빈 집합은 [생성자] 정규화
        const keepList = await resolveAttendees({
          creatorId: acc.ev.created_by,
          projectId: acc.ev.project_id,
          attendeeIds: attendee_ids,
          includeCreator: include_creator,
        });
        const keep = new Set(keepList);
        const current = await attendeeUserIds(acc.ev.id);
        const toRemove = current.filter((id) => !keep.has(id));
        if (toRemove.length)
          await db
            .delete(eventAttendees)
            .where(and(eq(eventAttendees.event_id, acc.ev.id), inArray(eventAttendees.user_id, toRemove)));
        await syncAttendees(updated, [...keep], uid);
      }
      if (acc.ev.project_id != null)
        await logActivity({ project_id: acc.ev.project_id, user_id: uid, action: "event.updated", meta: { event_id: acc.ev.id, fields: Object.keys(patch) } });
      const [full] = await enrich([updated]);
      res.json({ event: full });
    }),
  );

  r.delete(
    "/:eventId",
    ah(async (req, res) => {
      const uid = req.userId!;
      const acc = await loadEventForUser(Number(req.params.eventId), uid);
      if (!acc) throw err.notFound("일정을 찾을 수 없거나 권한이 없습니다.");
      if (!acc.canEdit) throw err.forbidden("생성자 또는 프로젝트 매니저만 삭제할 수 있습니다.");
      await db.delete(events).where(eq(events.id, acc.ev.id));
      if (acc.ev.project_id != null)
        await logActivity({ project_id: acc.ev.project_id, user_id: uid, action: "event.deleted", meta: { event_id: acc.ev.id, title: acc.ev.title } });
      res.json({ ok: true });
    }),
  );

  return r;
}
