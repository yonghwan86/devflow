import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { submissions, reviewFeedback, users, FEEDBACK_CATEGORY } from "../../../shared/schema.ts";
import { ah, publicUser } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

// P11 검증 갤러리 (링크/설명형 1차): 로그인 회원 누구나 열람·리뷰.
// 가시성 원칙: 제출물(제목/요약/데모URL)만 공개 — 내부 태스크·소스·회의록은 절대 비노출.
// 공개(전 회원) 노출 필드 화이트리스트 — 내부 식별자·향후 컬럼 우발 노출 방지 (보안 리뷰 M-3)
function publicSubmission(s: any) {
  return {
    id: s.id,
    title: s.title,
    summary: s.summary,
    demo_url: s.demo_url,
    status: s.status,
    min_reviews: s.min_reviews,
    min_avg_rating: s.min_avg_rating,
    submitted_by: s.submitted_by,
    created_at: s.created_at,
  };
}

async function stats(submissionId: number): Promise<{ count: number; avg: number }> {
  const [row]: any = (
    await db.execute(
      sql`SELECT count(*)::int AS count, coalesce(avg(rating), 0)::float AS avg FROM review_feedback WHERE submission_id = ${submissionId}`,
    )
  ).rows;
  return { count: Number(row?.count ?? 0), avg: Number(row?.avg ?? 0) };
}

// 게이트: 리뷰 수·평점 충족 시 validated 승격 (자동, 기록 남김)
async function applyGate(submissionId: number): Promise<void> {
  const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!s || s.status !== "open") return;
  const { count, avg } = await stats(submissionId);
  if (count >= s.min_reviews && avg >= s.min_avg_rating) {
    await db.update(submissions).set({ status: "validated", updated_at: new Date() }).where(eq(submissions.id, submissionId));
    if (s.project_id)
      await logActivity({ project_id: s.project_id, user_id: null, action: "submission.validated", meta: { submission_id: submissionId, reviews: count, avg } });
  }
}

export function galleryRouter(): Router {
  const r = Router();
  r.use(requireAuth); // 익명 없음 — 로그인 회원만 (피드백 작성자 추적 가능)

  // 갤러리 목록 (전 회원)
  r.get(
    "/",
    ah(async (_req, res) => {
      const rows = await db
        .select({ s: submissions, submitter: users })
        .from(submissions)
        .innerJoin(users, eq(users.id, submissions.submitted_by))
        .orderBy(desc(submissions.created_at));
      const result = [];
      for (const { s, submitter } of rows) {
        const st = await stats(s.id);
        result.push({ ...publicSubmission(s), submitter: publicUser(submitter), review_count: st.count, avg_rating: Math.round(st.avg * 10) / 10 });
      }
      res.json({ submissions: result });
    }),
  );

  // 제출 (완료 프로젝트 연결은 선택 — 외부 프로젝트도 가능)
  r.post(
    "/",
    ah(async (req, res) => {
      const body = z
        .object({
          project_id: z.number().int().optional(),
          title: z.string().min(1).max(200),
          summary: z.string().min(1).max(4000),
          demo_url: z.string().url().max(500).optional(),
        })
        .strict()
        .parse(req.body);
      const [s] = await db
        .insert(submissions)
        .values({
          project_id: body.project_id ?? null,
          title: body.title,
          summary: body.summary,
          demo_url: body.demo_url ?? null,
          submitted_by: req.userId!,
        })
        .returning();
      res.status(201).json({ submission: s });
    }),
  );

  // 상세 + 피드백 목록
  r.get(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(submissions).where(eq(submissions.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      const fb = await db
        .select({ f: reviewFeedback, reviewer: users })
        .from(reviewFeedback)
        .innerJoin(users, eq(users.id, reviewFeedback.reviewer_id))
        .where(eq(reviewFeedback.submission_id, s.id))
        .orderBy(desc(reviewFeedback.created_at));
      const st = await stats(s.id);
      res.json({
        submission: { ...publicSubmission(s), review_count: st.count, avg_rating: Math.round(st.avg * 10) / 10 },
        feedback: fb.map(({ f, reviewer }) => ({ ...f, reviewer: publicUser(reviewer) })),
        my_review: fb.find(({ f }) => f.reviewer_id === req.userId)?.f ?? null,
      });
    }),
  );

  // 피드백 등록 — 본인 제출물 리뷰 금지, 1인 1리뷰(유니크)
  r.post(
    "/:id/feedback",
    ah(async (req, res) => {
      const body = z
        .object({
          rating: z.number().int().min(1).max(5),
          body: z.string().min(1).max(4000),
          category: z.enum(FEEDBACK_CATEGORY).optional(),
        })
        .strict()
        .parse(req.body);
      const [s] = await db.select().from(submissions).where(eq(submissions.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      if (s.submitted_by === req.userId!) throw err.forbidden("본인 제출물에는 리뷰할 수 없습니다.");
      const inserted = await db
        .insert(reviewFeedback)
        .values({ submission_id: s.id, reviewer_id: req.userId!, rating: body.rating, body: body.body, category: body.category ?? "other" })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) throw err.badRequest("이미 리뷰를 남겼습니다.");
      await applyGate(s.id);
      res.status(201).json({ feedback: inserted[0] });
    }),
  );

  // 제출자 본인 또는 관리자만 삭제
  r.delete(
    "/:id",
    ah(async (req, res) => {
      const [s] = await db.select().from(submissions).where(eq(submissions.id, Number(req.params.id))).limit(1);
      if (!s) throw err.notFound();
      const [me] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
      if (s.submitted_by !== req.userId! && !me?.is_admin) throw err.forbidden();
      await db.delete(submissions).where(eq(submissions.id, s.id));
      res.json({ ok: true });
    }),
  );

  return r;
}
