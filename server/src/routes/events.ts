import { Router } from "express";
import { z } from "zod";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { events, eventAttendees, projects, projectMembers, users, roleAtLeast } from "../../../shared/schema.ts";
import type { EventRow } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { sendOnce, sendPushToUser } from "../lib/push.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

// F5: 일정 이벤트.
// 조회 권한 — 프로젝트 일정: 프로젝트 멤버 / 개인 일정(project_id null): 생성자 OR 참석자.
// 수정·삭제 — 생성자 본인, 또는 프로젝트 일정이면 해당 프로젝트 owner/manager. 참석자-only는 불가.
// PATCH whitelist에서 project_id 제외(개인↔프로젝트 이동 미지원 — 삭제 후 재생성. HANDOFF 기록).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 종일 일정 저장 규약: 로컬 day key의 UTC 자정(F5). 웹 클라이언트는 준수하지만
// MCP 등 다른 작성자가 "T00:00:00+09:00" 같은 값을 보내면 하루 밀려 표시되므로 서버에서 거부.
const isUtcMidnight = (d: Date) => d.getTime() % 86400_000 === 0;
function assertAllDayConvention(allDay: boolean, starts: Date, ends: Date | null): void {
  if (!allDay) return;
  if (!isUtcMidnight(starts) || (ends && !isUtcMidnight(ends)))
    throw err.badRequest("종일 일정의 시각은 UTC 자정(YYYY-MM-DDT00:00:00.000Z)이어야 합니다.");
}

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

// 참석자 검증: 프로젝트 일정 → 그 프로젝트 멤버만 / 개인 일정 → 본인 외 지정 불가(R1 단순화)
async function validateAttendees(ids: number[], projectId: number | null, uid: number): Promise<number[]> {
  const uniq = [...new Set(ids)];
  if (projectId == null) {
    if (uniq.some((id) => id !== uid)) throw err.badRequest("개인 일정에는 본인 외 참석자를 지정할 수 없습니다.");
    return uniq;
  }
  if (uniq.length === 0) return uniq;
  const members = await db
    .select({ user_id: projectMembers.user_id })
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), inArray(projectMembers.user_id, uniq)));
  if (members.length !== uniq.length) throw err.badRequest("참석자는 해당 프로젝트 멤버만 지정할 수 있습니다.");
  return uniq;
}

// 참석자 저장 + 초대 push(sendOnce — PATCH 재저장에도 event-invite 키로 중복 방지)
async function syncAttendees(ev: EventRow, ids: number[], notifyExcept: number): Promise<void> {
  for (const uid of ids) {
    await db.insert(eventAttendees).values({ event_id: ev.id, user_id: uid }).onConflictDoNothing();
    if (uid !== notifyExcept) {
      await sendOnce(`event-invite:${ev.id}:user:${uid}`, async () => {
        // 종일 일정은 UTC 자정 저장이라 시각을 포맷하면 "09:00"(KST) 같은 가짜 시각이 표기됨 — 날짜만
        const when = ev.all_day
          ? `${String(ev.starts_at instanceof Date ? ev.starts_at.toISOString() : ev.starts_at).slice(5, 10).replace("-", "월 ")}일 (종일)`
          : new Date(ev.starts_at).toLocaleString("ko-KR", { timeZone: process.env.TZ ?? "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        await sendPushToUser(uid, {
          title: "일정에 초대되었어요",
          body: `${ev.title} — ${when}`,
          url: "/my-work",
        });
      });
    }
  }
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
  attendee_ids: z.array(z.number().int()).optional(),
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
      const attendeeIds = await validateAttendees(body.attendee_ids ?? [], projectId, uid);

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
      // 생성자를 자동으로 attendees에 포함
      await syncAttendees(ev, [...new Set([uid, ...attendeeIds])], uid);
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
        })
        .strict()
        .parse(req.body);
      const starts = patch.starts_at ?? acc.ev.starts_at;
      const ends = patch.ends_at === undefined ? acc.ev.ends_at : patch.ends_at;
      if (ends && ends.getTime() < starts.getTime()) throw err.badRequest("종료 시각이 시작 시각보다 빠릅니다.");
      // 병합 후 최종 상태 기준 검증 — all_day:true 토글만 보내고 기존 시각지정 starts_at이 남는 경우 차단
      assertAllDayConvention(patch.all_day ?? acc.ev.all_day, starts, ends);

      const { attendee_ids, ...fields } = patch;
      const [updated] = await db
        .update(events)
        .set({ ...fields, updated_at: new Date() })
        .where(eq(events.id, acc.ev.id))
        .returning();
      if (attendee_ids) {
        const valid = await validateAttendees(attendee_ids, acc.ev.project_id, acc.ev.created_by);
        const keep = new Set([acc.ev.created_by, ...valid]); // 생성자는 항상 유지
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
