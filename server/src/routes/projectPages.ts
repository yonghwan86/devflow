import type { Router } from "express";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { pages, tasks, checklistItems } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireMember } from "../middleware/auth.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { createTaskWithKey } from "../lib/taskService.ts";
import { decomposePage } from "../lib/pageDecompose.ts";
import { isMockLlm } from "../lib/llm.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

// F4: 프로젝트 문서 페이지 (트리 + 마크다운 + 태스크 파생의 출처).
// 전 라우트 requireMember(서버측 멤버십). pageId는 반드시 해당 projectId 소속인지 검증.
const canManage = (role: string) => role === "owner" || role === "manager";

async function loadPage(pageId: number, projectId: number) {
  if (!Number.isInteger(pageId)) throw err.badRequest("pageId가 필요합니다.");
  const [p] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.project_id, projectId)))
    .limit(1);
  if (!p) throw err.notFound("문서를 찾을 수 없습니다.");
  return p;
}

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
        })
        .from(pages)
        .where(eq(pages.project_id, pid))
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
      res.json({ page: { ...p, content_html: renderMarkdown(p.content) }, my_role: req.membership!.role });
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
      const [updated] = await db
        .update(pages)
        .set({ ...body, updated_by: req.userId!, updated_at: new Date() })
        .where(eq(pages.id, p.id))
        .returning();
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.updated", meta: { page_id: p.id, fields: Object.keys(body) } });
      const { content_html: _skip, ...rest } = updated as any;
      res.json({ page: rest });
    }),
  );

  // 삭제 — 작성자 본인 또는 owner/manager만 (전원 삭제 허용은 문서 트리 증발 위험).
  // 하위 페이지는 parent_id set null로 루트 승격, 파생 태스크는 source_page_id set null로 생존.
  r.delete(
    "/:projectId/pages/:pageId",
    requireMember(),
    ah(async (req, res) => {
      const pid = req.membership!.project_id;
      const p = await loadPage(Number(req.params.pageId), pid);
      if (!canManage(req.membership!.role) && p.created_by !== req.userId)
        throw err.forbidden("작성자 또는 매니저만 삭제할 수 있습니다.");
      await db.delete(pages).where(eq(pages.id, p.id));
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.deleted", meta: { page_id: p.id, title: p.title } });
      res.json({ ok: true });
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
      // 이미 이 페이지에서 파생된 태스크 제목 (클라 중복 표시용 — 느슨한 판정)
      const derived = await db
        .select({ title: tasks.title })
        .from(tasks)
        .where(and(eq(tasks.project_id, pid), eq(tasks.source_page_id, p.id)));
      res.json({ tasks: suggestions.tasks, derived_titles: derived.map((d) => d.title), llm_mode: isMockLlm() ? "mock" : "live" });
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
              }),
            )
            .min(1)
            .max(30),
        })
        .strict()
        .parse(req.body);
      const created: Array<{ id: number; item_key: string; title: string }> = [];
      for (const t of body.tasks) {
        const task = await createTaskWithKey({
          project_id: pid,
          title: t.title,
          description: t.description ?? null,
          source_page_id: p.id,
          created_by: req.userId!,
        });
        if (t.checklist?.length)
          await db.insert(checklistItems).values(t.checklist.filter(Boolean).map((c) => ({ task_id: task.id, content: c })));
        created.push({ id: task.id, item_key: task.item_key, title: task.title });
      }
      await logActivity({ project_id: pid, user_id: req.userId, action: "page.decomposed", meta: { page_id: p.id, count: created.length } });
      res.status(201).json({ tasks: created });
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
