import type { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { pages, pageRevisions, tasks, checklistItems, users } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireMember } from "../middleware/auth.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { createTaskWithKey } from "../lib/taskService.ts";
import { decomposePage } from "../lib/pageDecompose.ts";
import { buildDecomposeDiff, normalizeForDedup } from "../lib/decomposeDiff.ts";
import { isMockLlm } from "../lib/llm.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

// F4: 프로젝트 문서 페이지 (트리 + 마크다운 + 태스크 파생의 출처).
// 전 라우트 requireMember(서버측 멤버십). pageId는 반드시 해당 projectId 소속인지 검증.
const canManage = (role: string) => role === "owner" || role === "manager";

// 휴지통(soft delete) 문서는 기본적으로 없는 것으로 취급 — 복원·영구삭제 경로만 includeDeleted
async function loadPage(pageId: number, projectId: number, opts?: { includeDeleted?: boolean }) {
  if (!Number.isInteger(pageId)) throw err.badRequest("pageId가 필요합니다.");
  const [p] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.project_id, projectId), ...(opts?.includeDeleted ? [] : [isNull(pages.deleted_at)])))
    .limit(1);
  if (!p) throw err.notFound("문서를 찾을 수 없습니다.");
  return p;
}

const REVISION_KEEP = 20; // 문서당 보관할 버전 수

// parent_id 사이클 방지: 새 parent에서 parent 체인을 따라 올라가 자기 자신에 도달하면 사이클.
// (dependencies.ts의 순회 패턴 차용 — 페이지 트리는 단일 parent라 체인 순회로 충분)
async function createsPageCycle(pageId: number, newParentId: number): Promise<boolean> {
  let cur: number | null = newParentId;
  const seen = new Set<number>();
  while (cur != null) {
    if (cur === pageId) return true;
    if (seen.has(cur)) return true; // 이미 깨진 데이터 방어
    seen.add(cur);
    const [p] = await db.select({ parent_id: pages.parent_id }).from(pages).where(eq(pages.id, cur)).limit(1);
    if (!p) return false;
    cur = p.parent_id;
  }
  return false;
}

export function registerProjectPageRoutes(r: Router): void {
  // 목록 (트리는 클라이언트에서 parent_id로 조립)
  r.get(
    "/:projectId/pages",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const rows = await db
        .select({
          id: pages.id,
          parent_id: pages.parent_id,
          title: pages.title,
          sort_order: pages.sort_order,
          created_by: pages.created_by,
          updated_at: pages.updated_at,
          // C13: 트리·에디터에 만든 사람 표시 (탈퇴자는 null)
          creator_name: sql<string | null>`coalesce(${users.full_name}, ${users.email})`,
        })
        .from(pages)
        .leftJoin(users, eq(users.id, pages.created_by))
        .where(and(eq(pages.project_id, pid), isNull(pages.deleted_at)))
        .orderBy(asc(pages.sort_order), asc(pages.id));
      res.json({ pages: rows, my_role: req.membership!.role });
    }),
  );

  // 생성 — 프로젝트 멤버 전원 가능
  r.post(
    "/:projectId/pages",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const body = z
        .object({
          title: z.string().min(1).max(300),
          content: z.string().optional(),
          parent_id: z.number().int().nullable().optional(),
          sort_order: z.number().int().optional(),
        })
        .strict()
        .parse(req.body);
      if (body.parent_id != null) await loadPage(body.parent_id, pid); // 같은 프로젝트의 부모만
      const [p] = await db
        .insert(pages)
        .values({
          project_id: pid,
          title: body.title,
          content: body.content ?? "",
          parent_id: body.parent_id ?? null,
          sort_order: body.sort_order ?? 0,
          created_by: req.userId!,
          updated_by: req.userId!,
          content_updated_by: req.userId!,
        })
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.created", meta: { page_id: p.id, title: p.title } });
      res.status(201).json({ page: p });
    }),
  );

  // 상세 — content_html은 서버에서 sanitize 렌더(comments.ts의 body_html 패턴)
  r.get(
    "/:projectId/pages/:pageId",
    requireMember(),
    ah(async (req, res) => {
      const p = await loadPage(Number(req.params.pageId), req.membership!.project_id);
      // C13: 만든 사람·마지막 수정자 이름 동봉
      const ids = [p.created_by, p.updated_by].filter((v): v is number => v != null);
      const named = ids.length
        ? await db.select({ id: users.id, full_name: users.full_name, email: users.email }).from(users).where(inArray(users.id, ids))
        : [];
      const nameOf = (id: number | null) => {
        const u = named.find((x) => x.id === id);
        return u ? (u.full_name ?? u.email) : null;
      };
      res.json({
        page: { ...p, content_html: renderMarkdown(p.content), creator_name: nameOf(p.created_by), updater_name: nameOf(p.updated_by) },
        my_role: req.membership!.role,
      });
    }),
  );

  // 수정 — strict whitelist: title/content/parent_id/sort_order.
  // ★ PATCH 응답에 content_html 미포함 — 2초 자동저장마다 jsdom 렌더 낭비 방지(미리보기 전환 시 GET).
  r.patch(
    "/:projectId/pages/:pageId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const p = await loadPage(Number(req.params.pageId), pid);
      const body = z
        .object({
          title: z.string().min(1).max(300).optional(),
          content: z.string().optional(),
          parent_id: z.number().int().nullable().optional(),
          sort_order: z.number().int().optional(),
        })
        .strict()
        .parse(req.body);
      if (body.parent_id != null) {
        if (body.parent_id === p.id) throw err.badRequest("자기 자신을 부모로 지정할 수 없습니다.");
        await loadPage(body.parent_id, pid);
        if (await createsPageCycle(p.id, body.parent_id)) throw err.badRequest("하위 문서를 부모로 지정할 수 없습니다(사이클).");
      }
      // 버전 기록: 내용이 실제로 바뀌는 저장만 직전 본문을 스냅샷 (빈 본문은 복원 가치 없음).
      // PATCH가 멤버 전원에게 열려 있어도 "내용을 다 지웠다" 사고를 복원으로 방어할 수 있게.
      // saved_by는 content_updated_by 기준 — updated_by는 제목·이동만 바꿔도 갱신돼 본문 귀속이 틀어짐
      const contentChanged = body.content !== undefined && body.content !== p.content;
      if (contentChanged && p.content !== "") {
        await db.insert(pageRevisions).values({ page_id: p.id, content: p.content, saved_by: p.content_updated_by ?? p.created_by });
        await db.execute(sql`
          DELETE FROM page_revisions
          WHERE page_id = ${p.id}
            AND id NOT IN (SELECT id FROM page_revisions WHERE page_id = ${p.id} ORDER BY id DESC LIMIT ${REVISION_KEEP})
        `);
      }
      const [updated] = await db
        .update(pages)
        .set({ ...body, updated_by: req.userId!, updated_at: new Date(), ...(contentChanged ? { content_updated_by: req.userId! } : {}) })
        .where(eq(pages.id, p.id))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.updated", meta: { page_id: p.id, fields: Object.keys(body) } });
      const { content_html: _skip, ...rest } = updated as any;
      res.json({ page: rest });
    }),
  );

  // 삭제 — 매니저 전용, 휴지통으로 이동(soft delete). 문서는 팀 자산이라 물리 삭제는
  // 휴지통에서 한 번 더(permanent)로만 가능. 하위 문서는 기존 물리 삭제와 같은 의미로 루트 승격.
  r.delete(
    "/:projectId/pages/:pageId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const p = await loadPage(Number(req.params.pageId), pid);
      if (!canManage(req.membership!.role)) throw err.forbidden("매니저만 삭제할 수 있습니다.");
      await db.update(pages).set({ deleted_at: new Date(), deleted_by: req.userId! }).where(eq(pages.id, p.id));
      await db.update(pages).set({ parent_id: null }).where(and(eq(pages.parent_id, p.id), eq(pages.project_id, pid)));
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.deleted", meta: { page_id: p.id, title: p.title } });
      res.json({ ok: true });
    }),
  );

  // 휴지통 목록 — 매니저 전용 (복원/영구삭제 UI)
  r.get(
    "/:projectId/pages-trash",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      if (!canManage(req.membership!.role)) throw err.forbidden("휴지통은 매니저만 볼 수 있습니다.");
      const rows = await db
        .select({
          id: pages.id,
          title: pages.title,
          deleted_at: pages.deleted_at,
          deleter_name: sql<string | null>`coalesce(${users.full_name}, ${users.email})`,
        })
        .from(pages)
        .leftJoin(users, eq(users.id, pages.deleted_by))
        .where(and(eq(pages.project_id, pid), isNotNull(pages.deleted_at)))
        .orderBy(desc(pages.deleted_at));
      res.json({ pages: rows });
    }),
  );

  // 복원 — 매니저 전용. parent_id를 유지하므로 부모가 살아 있으면 원래 위치로,
  // 부모가 이미 삭제됐으면 트리 조립(고아 fallback)에 의해 루트로 나타난다
  r.post(
    "/:projectId/pages/:pageId/restore",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      if (!canManage(req.membership!.role)) throw err.forbidden("매니저만 복원할 수 있습니다.");
      const p = await loadPage(Number(req.params.pageId), pid, { includeDeleted: true });
      if (!p.deleted_at) throw err.badRequest("휴지통에 있는 문서가 아닙니다.");
      const [restored] = await db.update(pages).set({ deleted_at: null, deleted_by: null }).where(eq(pages.id, p.id)).returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.restored", meta: { page_id: p.id, title: p.title } });
      res.json({ page: restored });
    }),
  );

  // 영구 삭제 — 매니저 전용, 휴지통에 있는 문서만 (실수 방지: 삭제→영구삭제 2단계)
  r.delete(
    "/:projectId/pages/:pageId/permanent",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      if (!canManage(req.membership!.role)) throw err.forbidden("매니저만 영구 삭제할 수 있습니다.");
      const p = await loadPage(Number(req.params.pageId), pid, { includeDeleted: true });
      if (!p.deleted_at) throw err.badRequest("휴지통에 있는 문서만 영구 삭제할 수 있습니다.");
      await db.delete(pages).where(eq(pages.id, p.id));
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.purged", meta: { page_id: p.id, title: p.title } });
      res.json({ ok: true });
    }),
  );

  // 버전 기록 목록 — 멤버 전원 (복원은 내용을 PATCH로 되돌리는 것 = 편집 행위라 멤버 권한과 동일)
  r.get(
    "/:projectId/pages/:pageId/revisions",
    requireMember(),
    ah(async (req, res) => {
      const p = await loadPage(Number(req.params.pageId), req.membership!.project_id);
      const rows = await db
        .select({
          id: pageRevisions.id,
          saved_at: pageRevisions.saved_at,
          chars: sql<number>`length(${pageRevisions.content})`,
          saver_name: sql<string | null>`coalesce(${users.full_name}, ${users.email})`,
        })
        .from(pageRevisions)
        .leftJoin(users, eq(users.id, pageRevisions.saved_by))
        .where(eq(pageRevisions.page_id, p.id))
        .orderBy(desc(pageRevisions.id));
      res.json({ revisions: rows });
    }),
  );

  // 버전 본문 — 미리보기·복원용
  r.get(
    "/:projectId/pages/:pageId/revisions/:revId",
    requireMember(),
    ah(async (req, res) => {
      const p = await loadPage(Number(req.params.pageId), req.membership!.project_id);
      const revId = Number(req.params.revId);
      if (!Number.isInteger(revId)) throw err.badRequest("revId가 필요합니다.");
      const [rev] = await db
        .select()
        .from(pageRevisions)
        .where(and(eq(pageRevisions.id, revId), eq(pageRevisions.page_id, p.id)))
        .limit(1);
      if (!rev) throw err.notFound("버전을 찾을 수 없습니다.");
      res.json({ revision: rev });
    }),
  );

  // G6: 문서 분해 제안 (매니저 전용 — 대량 생성은 관리 행위). 제안만 반환, DB 저장 안 함(§13).
  r.post(
    "/:projectId/pages/:pageId/decompose",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      if (!canManage(req.membership!.role)) throw err.forbidden("매니저만 문서를 분해할 수 있습니다.");
      const p = await loadPage(Number(req.params.pageId), pid);
      const suggestions = await decomposePage(p.content);
      // P3: 기존 파생 태스크(체크리스트 포함)와 3단 매칭 diff — 신규 / 이미 연결(병합 제안) / 문서에서 사라짐
      const derivedRows = await db
        .select({ id: tasks.id, item_key: tasks.item_key, title: tasks.title, status: tasks.status, source_anchor: tasks.source_anchor })
        .from(tasks)
        .where(and(eq(tasks.project_id, pid), eq(tasks.source_page_id, p.id)));
      const checkRows = derivedRows.length
        ? await db
            .select({ task_id: checklistItems.task_id, content: checklistItems.content })
            .from(checklistItems)
            .where(inArray(checklistItems.task_id, derivedRows.map((d) => d.id)))
        : [];
      const checksByTask = new Map<number, string[]>();
      for (const c of checkRows) checksByTask.set(c.task_id, [...(checksByTask.get(c.task_id) ?? []), c.content]);
      const diff = await buildDecomposeDiff(
        suggestions.tasks,
        derivedRows.map((d) => ({ ...d, checklist: checksByTask.get(d.id) ?? [] })),
      );
      res.json({
        items: diff.items,
        // 30개 상한으로 제안이 잘렸으면 "문서에서 사라짐" 판정이 오탐 — 목록을 비우고 절단 사실만 알림
        removed: suggestions.truncated ? [] : diff.removed.map((d) => ({ id: d.id, item_key: d.item_key, title: d.title, status: d.status })),
        truncated: !!suggestions.truncated,
        // 구계약 필드 유지 (기존 소비처·테스트 호환)
        tasks: suggestions.tasks,
        derived_titles: derivedRows.map((d) => d.title),
        llm_mode: isMockLlm() ? "mock" : "live",
      });
    }),
  );

  // G6: 분해 반영 — 선택한 태스크들을 createTaskWithKey로 생성 + 체크리스트 (매니저 전용).
  r.post(
    "/:projectId/pages/:pageId/apply-decomposition",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      if (!canManage(req.membership!.role)) throw err.forbidden("매니저만 반영할 수 있습니다.");
      const p = await loadPage(Number(req.params.pageId), pid);
      const body = z
        .object({
          tasks: z
            .array(
              z.object({
                title: z.string().min(1).max(200),
                description: z.string().max(4000).optional(),
                checklist: z.array(z.string().min(1).max(300)).max(20).optional(),
                // P3: 원본 분해 제목 — 모달에서 제목을 고쳐 만들어도 앵커는 문서 쪽 제목을 유지
                anchor: z.string().min(1).max(200).optional(),
              }),
            )
            .max(30)
            .optional()
            .default([]),
          // P3: 이미 연결된 태스크에 새 체크리스트 병합 + 앵커 갱신(문서 쪽 제목이 바뀐 경우 다음 재분해의 정확 매칭 유지)
          merges: z
            .array(
              z.object({
                task_id: z.number().int(),
                anchor: z.string().min(1).max(200),
                add_checklist: z.array(z.string().min(1).max(300)).max(20).optional(),
              }),
            )
            .max(30)
            .optional()
            .default([]),
        })
        .strict()
        .parse(req.body);
      if (body.tasks.length === 0 && body.merges.length === 0) throw err.badRequest("반영할 항목이 없습니다.");

      // 병합 대상 전수 선검증 — 태스크 생성(즉시 커밋)보다 먼저 실패시켜 "검증 실패 시 쓰기 0건"을 보장.
      // (모달을 열어둔 사이 다른 매니저가 태스크를 삭제한 경우, 생성분만 남고 400 나던 비원자성 차단)
      if (body.merges.length) {
        const ids = [...new Set(body.merges.map((m) => m.task_id))];
        const valid = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(inArray(tasks.id, ids), eq(tasks.project_id, pid), eq(tasks.source_page_id, p.id)));
        if (valid.length !== ids.length)
          throw err.badRequest("병합 대상 태스크가 삭제됐거나 이 문서에서 파생된 태스크가 아닙니다. 분해 창을 다시 열어주세요.");
      }

      const created: Array<{ id: number; item_key: string; title: string }> = [];
      for (const t of body.tasks) {
        const task = await createTaskWithKey({
          project_id: pid,
          title: t.title,
          description: t.description ?? null,
          source_page_id: p.id,
          source_anchor: t.anchor ?? t.title, // 원본 분해 제목이 오면 그걸 앵커로 (모달 제목 수정과 무관하게 매칭 유지)
          created_by: req.userId!,
        });
        if (t.checklist?.length)
          await db.insert(checklistItems).values(t.checklist.filter(Boolean).map((c) => ({ task_id: task.id, content: c })));
        created.push({ id: task.id, item_key: task.item_key, title: task.title });
      }

      let merged = 0;
      for (const m of body.merges) {
        const adds = (m.add_checklist ?? []).map((c) => c.trim()).filter(Boolean);
        if (adds.length) {
          // 클라 계산이 낡았을 수 있으니 서버에서 다시 중복 제거(정규화 비교)
          const existing = await db
            .select({ content: checklistItems.content })
            .from(checklistItems)
            .where(eq(checklistItems.task_id, m.task_id));
          const seen = new Set(existing.map((e) => normalizeForDedup(e.content)));
          const fresh = adds.filter((c) => !seen.has(normalizeForDedup(c)));
          if (fresh.length) {
            await db.insert(checklistItems).values(fresh.map((c) => ({ task_id: m.task_id, content: c })));
          }
        }
        await db.update(tasks).set({ source_anchor: m.anchor, updated_at: new Date() }).where(eq(tasks.id, m.task_id));
        merged++;
      }

      await logActivity({
        project_id: pid,
        user_id: req.userId,
        action: "page.decomposed",
        meta: { page_id: p.id, count: created.length, merged },
      });
      res.status(201).json({ tasks: created, merged });
    }),
  );

  // 파생 태스크 목록
  r.get(
    "/:projectId/pages/:pageId/derived-tasks",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const p = await loadPage(Number(req.params.pageId), pid);
      const rows = await db
        .select({
          id: tasks.id,
          item_key: tasks.item_key,
          title: tasks.title,
          status: tasks.status,
          kind: tasks.kind,
        })
        .from(tasks)
        .where(and(eq(tasks.project_id, pid), eq(tasks.source_page_id, p.id)))
        .orderBy(asc(tasks.id));
      res.json({ tasks: rows });
    }),
  );
}
