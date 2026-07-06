import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  meetingNotes,
  noteExtractions,
  projectMembers,
  comments,
  taskAssignees,
  guideAssignees,
  tasks,
  checklistItems,
  events,
  eventAttendees,
  normalizeRole,
} from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { extractFromMeeting } from "../lib/meetingExtract.ts";
import { createTaskWithKey, loadTaskForUser } from "../lib/taskService.ts";
import { enqueueEmbedding } from "../lib/embeddings.ts";
import { isMockLlm } from "../lib/llm.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const MAX_SOURCE = 100 * 1024; // 100KB

async function requireMembership(userId: number, projectId: number) {
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  if (!m) throw err.notFound("프로젝트를 찾을 수 없거나 권한이 없습니다.");
  return m;
}

export function meetingsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // 회의록 업로드 (텍스트 붙여넣기 — STT는 범위 밖)
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          project_id: z.number().int(),
          title: z.string().min(1).max(200),
          note_date: z.coerce.date().optional(),
          source_text: z.string().min(1),
        })
        .strict()
        .parse(req.body);
      if (Buffer.byteLength(body.source_text, "utf8") > MAX_SOURCE) throw err.badRequest("회의록은 100KB 이하여야 합니다.");
      await requireMembership(req.userId!, body.project_id);
      const [note] = await db
        .insert(meetingNotes)
        .values({
          project_id: body.project_id,
          title: body.title,
          note_date: body.note_date ?? null,
          source_text: body.source_text,
          uploaded_by: req.userId!,
        })
        .returning();
      await logActivity({ project_id: body.project_id, user_id: req.userId, action: "meeting.uploaded", meta: { note_id: note.id } });
      res.status(201).json({ note });
    }),
  );

  // 목록 (멤버) — source_text 제외한 경량 목록
  r.get(
    "/",
    ah(async (req, res) => {
      const projectId = Number(req.query.project_id);
      if (!Number.isInteger(projectId)) throw err.badRequest("project_id가 필요합니다.");
      await requireMembership(req.userId!, projectId);
      const rows = await db
        .select({
          id: meetingNotes.id,
          title: meetingNotes.title,
          note_date: meetingNotes.note_date,
          status: meetingNotes.status,
          created_at: meetingNotes.created_at,
        })
        .from(meetingNotes)
        .where(eq(meetingNotes.project_id, projectId))
        .orderBy(desc(meetingNotes.created_at));
      res.json({ notes: rows });
    }),
  );

  // 상세 + 추출 결과 (+ LLM 모드 배지용)
  r.get(
    "/:id",
    ah(async (req, res) => {
      const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, Number(req.params.id))).limit(1);
      if (!note) throw err.notFound();
      await requireMembership(req.userId!, note.project_id);
      const extractions = await db.select().from(noteExtractions).where(eq(noteExtractions.note_id, note.id));
      res.json({ note, extractions, llm_mode: isMockLlm() ? "mock" : "live" });
    }),
  );

  // G5-2: 회의록 수정 (제목/원문) — uploaded_by 본인 또는 매니저.
  // 원문 변경 시 재추출을 권장(process가 suggested-only 삭제라 반영분은 자동 보존 — 별도 로직 불필요).
  r.patch(
    "/:id",
    ah(async (req, res) => {
      const body = z.object({ title: z.string().min(1).max(200).optional(), source_text: z.string().min(1).optional() }).strict().parse(req.body);
      const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, Number(req.params.id))).limit(1);
      if (!note) throw err.notFound();
      const m = await requireMembership(req.userId!, note.project_id);
      if (note.uploaded_by !== req.userId! && normalizeRole(m.role) !== "manager") throw err.forbidden("작성자 또는 매니저만 수정할 수 있습니다.");
      if (body.source_text !== undefined && Buffer.byteLength(body.source_text, "utf8") > MAX_SOURCE)
        throw err.badRequest("회의록은 100KB 이하여야 합니다.");
      const sourceChanged = body.source_text !== undefined && body.source_text !== note.source_text;
      const [updated] = await db
        .update(meetingNotes)
        .set({ title: body.title ?? note.title, source_text: body.source_text ?? note.source_text })
        .where(eq(meetingNotes.id, note.id))
        .returning();
      res.json({ note: updated, source_changed: sourceChanged });
    }),
  );

  // G5-2: 회의록 삭제 — uploaded_by 본인 또는 매니저. extractions는 FK cascade,
  // 이미 생성된 태스크/가이드/일정은 FK가 extraction→대상 방향이라 살아남는다.
  r.delete(
    "/:id",
    ah(async (req, res) => {
      const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, Number(req.params.id))).limit(1);
      if (!note) throw err.notFound();
      const m = await requireMembership(req.userId!, note.project_id);
      if (note.uploaded_by !== req.userId! && normalizeRole(m.role) !== "manager") throw err.forbidden("작성자 또는 매니저만 삭제할 수 있습니다.");
      await db.delete(meetingNotes).where(eq(meetingNotes.id, note.id));
      await logActivity({ project_id: note.project_id, user_id: req.userId, action: "meeting.deleted", meta: { note_id: note.id } });
      res.json({ ok: true });
    }),
  );

  // AI 구조화 실행 — 제안(suggested)만 생성, 자동 등록 금지(§13). 재실행 시 미검토 제안만 교체.
  r.post(
    "/:id/process",
    ah(async (req, res) => {
      const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, Number(req.params.id))).limit(1);
      if (!note) throw err.notFound();
      await requireMembership(req.userId!, note.project_id);

      const items = await extractFromMeeting(note.source_text);
      await db
        .delete(noteExtractions)
        .where(and(eq(noteExtractions.note_id, note.id), eq(noteExtractions.status, "suggested")));
      if (items.length) {
        await db.insert(noteExtractions).values(items.map((x) => ({ note_id: note.id, ...x })));
      }
      await db.update(meetingNotes).set({ status: "processed" }).where(eq(meetingNotes.id, note.id));
      await logActivity({ project_id: note.project_id, user_id: req.userId, action: "meeting.processed", meta: { note_id: note.id, extracted: items.length } });
      const extractions = await db.select().from(noteExtractions).where(eq(noteExtractions.note_id, note.id));
      res.json({ note: { ...note, status: "processed" }, extractions });
    }),
  );

  // 추출 항목 검토: 승인(→태스크/가이드 생성)·거절. 사람 검토가 유일한 반영 경로.
  r.patch(
    "/extractions/:id",
    ah(async (req, res) => {
      const body = z
        .object({
          status: z.enum(["accepted", "rejected"]),
          content: z.string().min(1).max(500).optional(), // 검토 중 수정 허용
          task_id: z.number().int().optional(), // guide/checklist 승인 시 대상 태스크
          apply_as: z.enum(["task", "checklist"]).optional(), // action 반영 방식(기본 task)
          starts_at: z.string().optional(), // event 승인 시 시작 시각(ISO)
          all_day: z.boolean().optional(), // event 종일 여부(기본 true)
        })
        .strict()
        .parse(req.body);
      const [ex] = await db.select().from(noteExtractions).where(eq(noteExtractions.id, Number(req.params.id))).limit(1);
      if (!ex) throw err.notFound();
      const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, ex.note_id)).limit(1);
      if (!note) throw err.notFound();
      await requireMembership(req.userId!, note.project_id);
      if (ex.status !== "suggested") throw err.badRequest("이미 검토된 항목입니다.");

      const content = body.content ?? ex.content;
      let linked_task_id: number | null = null;
      let linked_comment_id: number | null = null;
      let linked_event_id: number | null = null;
      let linked_checklist_item_id: number | null = null;

      if (body.status === "accepted") {
        if (ex.kind === "action" && body.apply_as === "checklist") {
          // 실행 항목 → 기존 태스크의 체크리스트 항목으로 반영 (가이드와 동일: 같은 프로젝트 검증)
          if (!body.task_id) throw err.badRequest("체크리스트로 반영할 태스크(task_id)를 지정하세요.");
          const acc = await loadTaskForUser(body.task_id, req.userId!);
          if (!acc || acc.task.project_id !== note.project_id) throw err.badRequest("같은 프로젝트의 태스크만 지정할 수 있습니다.");
          const [item] = await db.insert(checklistItems).values({ task_id: body.task_id, content: content.slice(0, 300) }).returning();
          linked_task_id = body.task_id;
          linked_checklist_item_id = item.id;
          await logActivity({ project_id: note.project_id, task_id: body.task_id, user_id: req.userId, action: "checklist.added", meta: { item_id: item.id, via: "meeting", note_id: note.id } });
        } else if (ex.kind === "event") {
          // 일정 → events 생성 (project_id=note.project_id, 생성자 자동 참석)
          if (!body.starts_at) throw err.badRequest("일정 시작 시각(starts_at)을 지정하세요.");
          const startsAt = new Date(body.starts_at);
          if (isNaN(startsAt.getTime())) throw err.badRequest("시작 시각 형식이 올바르지 않습니다.");
          const [ev] = await db
            .insert(events)
            .values({
              project_id: note.project_id,
              title: content.slice(0, 120),
              starts_at: startsAt,
              all_day: body.all_day ?? true,
              created_by: req.userId!,
            })
            .returning();
          await db.insert(eventAttendees).values({ event_id: ev.id, user_id: req.userId! }).onConflictDoNothing();
          linked_event_id = ev.id;
          await logActivity({ project_id: note.project_id, user_id: req.userId, action: "event.created", meta: { event_id: ev.id, via: "meeting", note_id: note.id } });
        } else if (ex.kind === "action") {
          // 실행 항목 → 태스크 생성
          const t = await createTaskWithKey({
            project_id: note.project_id,
            title: content.slice(0, 200),
            description: `회의록 "${note.title}"에서 추출\n> ${ex.source_excerpt ?? ""}`,
            created_by: req.userId!,
          });
          linked_task_id = t.id;
          await enqueueEmbedding("task", t.id);
          await logActivity({ project_id: note.project_id, task_id: t.id, user_id: req.userId, action: "task.created", meta: { item_key: t.item_key, via: "meeting", note_id: note.id } });
        } else if (ex.kind === "guide") {
          // 가이드 → 지정한 태스크에 가이드 댓글 (담당자별 추적 팬아웃)
          if (!body.task_id) throw err.badRequest("가이드를 붙일 태스크(task_id)를 지정하세요.");
          const acc = await loadTaskForUser(body.task_id, req.userId!);
          if (!acc || acc.task.project_id !== note.project_id) throw err.badRequest("같은 프로젝트의 태스크만 지정할 수 있습니다.");
          if (!["owner", "manager"].includes(acc.role)) throw err.forbidden("가이드는 owner/manager만 등록할 수 있습니다.");
          const [c] = await db
            .insert(comments)
            .values({ task_id: body.task_id, author_id: req.userId!, body: `${content}\n\n> 출처: 회의록 "${note.title}"`, is_guide: true })
            .returning();
          const assignees = await db.select({ user_id: taskAssignees.user_id }).from(taskAssignees).where(eq(taskAssignees.task_id, body.task_id));
          if (assignees.length) {
            await db
              .insert(guideAssignees)
              .values(assignees.map((a) => ({ comment_id: c.id, user_id: a.user_id, state: "pending" as const })))
              .onConflictDoNothing();
          }
          linked_comment_id = c.id;
          await enqueueEmbedding("comment", c.id);
          await logActivity({ project_id: note.project_id, task_id: body.task_id, user_id: req.userId, action: "guide.created", meta: { comment_id: c.id, via: "meeting", note_id: note.id } });
        }
        // decision/blocker/question은 기록으로 보존 (SKILL.md·RAG 재료)
      }

      const finalStatus = body.status === "accepted" && body.content && body.content !== ex.content ? "edited" : body.status;
      const [updated] = await db
        .update(noteExtractions)
        .set({ status: finalStatus, content, linked_task_id, linked_comment_id, linked_event_id, linked_checklist_item_id, reviewed_by: req.userId! })
        .where(eq(noteExtractions.id, ex.id))
        .returning();

      // 모든 제안이 검토되면 노트 상태 reviewed
      const remaining = await db
        .select({ id: noteExtractions.id })
        .from(noteExtractions)
        .where(and(eq(noteExtractions.note_id, note.id), eq(noteExtractions.status, "suggested")));
      if (remaining.length === 0) {
        await db.update(meetingNotes).set({ status: "reviewed" }).where(eq(meetingNotes.id, note.id));
      }
      res.json({ extraction: updated });
    }),
  );

  return r;
}
