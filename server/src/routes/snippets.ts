import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { snippets, projectMembers, users } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

// §10.10 실행 시간·저장 크기 제한: 파일 수/총량 제한 (실행 제한은 클라이언트 iframe sandbox+CSP)
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 200 * 1024;
const MAX_FILE_BYTES = 100 * 1024; // 파일당 상한 (보안 리뷰 M-4)

const fileSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[\w.\-]+$/, "파일명은 영문/숫자/._-만 허용"),
  content: z.string(),
});

function validateFiles(files: z.infer<typeof fileSchema>[]): void {
  if (files.length === 0 || files.length > MAX_FILES) throw err.badRequest(`파일은 1~${MAX_FILES}개까지 가능합니다.`);
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  if (total > MAX_TOTAL_BYTES) throw err.badRequest(`전체 크기는 ${MAX_TOTAL_BYTES / 1024}KB 이하여야 합니다.`);
  for (const f of files) {
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES)
      throw err.badRequest(`파일 하나는 ${MAX_FILE_BYTES / 1024}KB 이하여야 합니다.`);
  }
  const names = new Set(files.map((f) => f.name));
  if (names.size !== files.length) throw err.badRequest("파일명이 중복됩니다.");
}

async function requireMembership(userId: number, projectId: number) {
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  if (!m) throw err.notFound("프로젝트를 찾을 수 없거나 권한이 없습니다.");
  return m;
}

export function snippetsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // 목록 (멤버)
  r.get(
    "/",
    ah(async (req, res) => {
      const projectId = Number(req.query.project_id);
      if (!Number.isInteger(projectId)) throw err.badRequest("project_id가 필요합니다.");
      await requireMembership(req.userId!, projectId);
      // C13: 만든 사람 이름 동봉 (칩 툴팁 표시용)
      const rows = await db
        .select({ s: snippets, creator_name: sql<string | null>`coalesce(${users.full_name}, ${users.email})` })
        .from(snippets)
        .leftJoin(users, eq(users.id, snippets.created_by))
        .where(eq(snippets.project_id, projectId))
        .orderBy(desc(snippets.updated_at));
      res.json({ snippets: rows.map((r) => ({ ...r.s, creator_name: r.creator_name })) });
    }),
  );

  r.get(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(snippets).where(eq(snippets.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      await requireMembership(req.userId!, s.project_id);
      res.json({ snippet: s });
    }),
  );

  // 저장 (멤버)
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          project_id: z.number().int(),
          task_id: z.number().int().optional(),
          title: z.string().min(1).max(200),
          files: z.array(fileSchema),
        })
        .strict()
        .parse(req.body);
      await requireMembership(req.userId!, body.project_id);
      validateFiles(body.files);
      const [s] = await db
        .insert(snippets)
        .values({ project_id: body.project_id, task_id: body.task_id ?? null, title: body.title, files: body.files, created_by: req.userId! })
        .returning();
      await logActivity({ project_id: body.project_id, task_id: body.task_id ?? null, user_id: req.userId, action: "snippet.created", meta: { snippet_id: s.id } });
      res.status(201).json({ snippet: s });
    }),
  );

  // 수정 — PATCH 화이트리스트 (§10.3)
  r.patch(
    "/:id",
    ah(async (req, res) => {
      const body = z
        .object({ title: z.string().min(1).max(200).optional(), files: z.array(fileSchema).optional() })
        .strict()
        .parse(req.body);
      const [s] = await db.select().from(snippets).where(eq(snippets.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      await requireMembership(req.userId!, s.project_id);
      if (body.files) validateFiles(body.files);
      const [updated] = await db
        .update(snippets)
        .set({ ...body, updated_at: new Date() })
        .where(eq(snippets.id, s.id))
        .returning();
      res.json({ snippet: updated });
    }),
  );

  r.delete(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(snippets).where(eq(snippets.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      const m = await requireMembership(req.userId!, s.project_id);
      if (s.created_by !== req.userId! && !["owner", "manager"].includes(m.role)) throw err.forbidden();
      await db.delete(snippets).where(eq(snippets.id, s.id));
      res.json({ ok: true });
    }),
  );

  return r;
}
