import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { projectMembers, tasks } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser } from "../lib/taskService.ts";
import { enqueueProject, processEmbeddingJobs, searchEmbeddings, type SearchHit } from "../lib/embeddings.ts";
import { searchEntries } from "../lib/journalService.ts";
import { getLlm, isMockLlm } from "../lib/llm.ts";
import { logActivity } from "../lib/activity.ts";
import { err } from "../lib/errors.ts";

const canManage = (role: string) => role === "owner" || role === "manager";

async function myProjectIds(userId: number): Promise<number[]> {
  return (
    await db.select({ id: projectMembers.project_id }).from(projectMembers).where(eq(projectMembers.user_id, userId))
  ).map((m) => m.id);
}

async function requireMembership(userId: number, projectId: number): Promise<void> {
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  if (!m) throw err.notFound("프로젝트를 찾을 수 없거나 권한이 없습니다.");
}

const excerpt = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

// v1.5: AI 검색에 "내 기록" 포함 — 임베딩에 편입하지 않고(프라이버시 불변식 유지) 요청자 본인 저널만 ILIKE로 병합.
// 프로젝트를 특정해 검색할 때는 제외 — 저널은 프로젝트 소속이 아니므로.
async function journalHits(userId: number, q: string, limit: number) {
  const rows = await searchEntries(userId, q, limit);
  return rows.map((r) => ({
    source_type: "journal" as const,
    source_id: 0,
    project_id: null as number | null,
    content: r.snippet,
    score: null as number | null,
    entry_date: r.entry_date,
  }));
}

function mockAnswer(q: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `"${q}"와 관련된 자료를 찾지 못했습니다. 먼저 재색인을 실행하거나 관련 태스크·가이드를 작성해보세요.`;
  const lines = hits.slice(0, 5).map((h, i) => `${i + 1}. (${h.source_type}) ${excerpt(h.content, 160)}`);
  return `"${q}" 관련 자료 ${hits.length}건을 찾았습니다. 요약:\n\n${lines.join("\n")}\n\n자세한 내용은 아래 출처를 확인하세요.`;
}

async function llmAnswer(question: string, hits: SearchHit[], instruction: string): Promise<string> {
  if (isMockLlm()) return mockAnswer(question, hits);
  const context = hits.map((h, i) => `[${i + 1}] (${h.source_type}#${h.source_id}) ${h.content}`).join("\n\n");
  const raw = await getLlm().complete([
    { role: "system", content: `${instruction} 반드시 JSON {"answer": "..."} 형태로만 응답하세요. 근거가 없으면 모른다고 답하세요.` },
    { role: "user", content: `질문: ${question}\n\n컨텍스트:\n${context}` },
  ]);
  try {
    return JSON.parse(raw).answer ?? raw;
  } catch {
    return raw || mockAnswer(question, hits);
  }
}

// LLM 호출·재색인은 비용/부하 유발 → 사용자별 rate limit (보안 리뷰 M-2)
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req as any).userId ?? req.ip),
  message: { error: { code: "rate_limited", message: "AI 요청이 너무 많습니다. 잠시 후 다시 시도하세요." } },
});

export function aiRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.use(aiLimiter);

  // ① 인제스트: 프로젝트 재색인 (멤버) — 큐잉 후 즉시 처리
  r.post(
    "/reindex",
    ah(async (req, res) => {
      const body = z.object({ project_id: z.number().int() }).strict().parse(req.body);
      await requireMembership(req.userId!, body.project_id);
      const queued = await enqueueProject(body.project_id);
      const result = await processEmbeddingJobs();
      await logActivity({ project_id: body.project_id, user_id: req.userId, action: "ai.reindexed", meta: { queued, ...result } });
      res.json({ queued, ...result });
    }),
  );

  // ② 검색: 내가 속한 프로젝트(+전사 스킬)만 (§10.5 서버측 필터)
  r.post(
    "/search",
    ah(async (req, res) => {
      const body = z
        .object({ q: z.string().min(1), project_id: z.number().int().optional(), k: z.number().int().min(1).max(20).optional() })
        .strict()
        .parse(req.body);
      let pids = await myProjectIds(req.userId!);
      if (body.project_id != null) {
        await requireMembership(req.userId!, body.project_id);
        pids = [body.project_id];
      }
      const [hits, jhits] = await Promise.all([
        searchEmbeddings(body.q, pids, body.k ?? 8),
        // 저널 병합은 세션 로그인(앱)에서만 — API 토큰은 스코프와 무관하게 개인 기록에 닿지 못하게(불변식 1)
        body.project_id == null && !req.tokenScopes ? journalHits(req.userId!, body.q, 5) : Promise.resolve([]),
      ]);
      // task 소스는 item_key를 붙여 UI에서 바로 이동 가능하게
      const taskIds = hits.filter((h) => h.source_type === "task").map((h) => h.source_id);
      const taskRows = taskIds.length
        ? await db.select({ id: tasks.id, item_key: tasks.item_key, project_id: tasks.project_id }).from(tasks).where(inArray(tasks.id, taskIds))
        : [];
      const keyById = new Map(taskRows.map((t) => [t.id, t]));
      res.json({
        results: [
          ...hits.map((h) => ({
            ...h,
            content: excerpt(h.content),
            item_key: h.source_type === "task" ? keyById.get(h.source_id)?.item_key ?? null : null,
          })),
          ...jhits.map((h) => ({ ...h, content: excerpt(h.content), item_key: null })),
        ],
      });
    }),
  );

  // ③ Q&A: 검색 컨텍스트 기반 답변 (mock=결정론적 요약 / LLM=생성형)
  r.post(
    "/ask",
    ah(async (req, res) => {
      const body = z
        .object({ q: z.string().min(1), project_id: z.number().int().optional() })
        .strict()
        .parse(req.body);
      let pids = await myProjectIds(req.userId!);
      if (body.project_id != null) {
        await requireMembership(req.userId!, body.project_id);
        pids = [body.project_id];
      }
      const [hits, jhits] = await Promise.all([
        searchEmbeddings(body.q, pids, 5),
        body.project_id == null && !req.tokenScopes ? journalHits(req.userId!, body.q, 3) : Promise.resolve([]),
      ]);
      const ctx = [...hits, ...(jhits as unknown as SearchHit[])];
      const answer = await llmAnswer(body.q, ctx, "당신은 개발팀 지식베이스 도우미입니다. 컨텍스트에 근거해 한국어로 간결히 답하세요. 컨텍스트의 journal 소스는 질문한 사람의 개인 기록입니다.");
      res.json({ answer, sources: ctx.map((h) => ({ ...h, content: excerpt(h.content, 160) })) });
    }),
  );

  // ④ AI 가이드 제안 (owner/manager) — 자동 등록 금지(§13): 초안만 반환, 사람이 검토 후 댓글로 등록
  r.post(
    "/suggest-guide",
    ah(async (req, res) => {
      const body = z.object({ task_id: z.number().int() }).strict().parse(req.body);
      const acc = await loadTaskForUser(body.task_id, req.userId!);
      if (!acc) throw err.notFound("태스크를 찾을 수 없거나 권한이 없습니다.");
      if (!canManage(acc.role)) throw err.forbidden("가이드 제안은 owner/manager만 사용할 수 있습니다.");

      const queryText = `${acc.task.title} ${acc.task.description ?? ""}`.trim();
      const hits = (await searchEmbeddings(queryText, [acc.task.project_id], 6)).filter(
        (h) => !(h.source_type === "task" && h.source_id === acc.task.id),
      );
      let suggestion: string;
      if (isMockLlm()) {
        const refs = hits.slice(0, 3).map((h, i) => `- 참고 ${i + 1}: ${excerpt(h.content, 120)}`);
        suggestion =
          `**[AI 제안 초안] ${acc.task.title} 수행 가이드**\n\n` +
          `과거 유사 작업 기록 ${hits.length}건을 참고했습니다.\n\n` +
          (refs.length ? `${refs.join("\n")}\n\n` : "") +
          `체크포인트:\n1. 착수 전 요구사항과 완료 조건을 확인하세요.\n2. 유사 사례의 해결 방식을 검토하고 적용 여부를 판단하세요.\n3. 완료 후 결과를 댓글로 공유하세요.`;
      } else {
        suggestion = await llmAnswer(
          `태스크 "${acc.task.title}"의 담당자를 위한 실행 가이드를 작성해줘.`,
          hits,
          "당신은 시니어 개발 리드입니다. 과거 기록을 근거로 구체적인 실행 가이드를 한국어 마크다운으로 작성하세요.",
        );
      }
      res.json({ suggestion, sources: hits.map((h) => ({ ...h, content: excerpt(h.content, 160) })) });
    }),
  );

  return r;
}
