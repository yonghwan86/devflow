import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  embeddings,
  embeddingJobs,
  tasks,
  comments,
  skills,
  EMBEDDING_DIM,
  type EmbeddingJob,
} from "../../../shared/schema.ts";
import { env } from "./env.ts";

// ---------- 프로바이더 추상화 (env 교체, §3) ----------
// openai: text-embedding API / 그 외: 오프라인 결정론적 mock(토큰 백 해시) — 테스트·오프라인 동작 보장.
export function embeddingModelName(): string {
  return env.LLM_PROVIDER === "openai" && env.LLM_API_KEY ? env.EMBEDDING_MODEL : "mock-hash-v1";
}

function mockEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const tok of tokens) {
    const h = createHash("sha1").update(tok).digest();
    const idx = h.readUInt32BE(0) % EMBEDDING_DIM;
    const sign = h[4] % 2 === 0 ? 1 : -1;
    v[idx] += sign;
    const idx2 = h.readUInt32BE(5) % EMBEDDING_DIM;
    v[idx2] += sign * 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const base = env.LLM_BASE_URL || "https://api.openai.com/v1";
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embedding error ${res.status}`);
  const data: any = await res.json();
  return data.data.map((d: any) => d.embedding as number[]);
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (embeddingModelName() !== "mock-hash-v1") return openaiEmbed(texts);
  return texts.map(mockEmbed);
}

const toVectorLiteral = (v: number[]) => `[${v.map((x) => Number(x.toFixed(6))).join(",")}]`;
export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- 인제스트(잡 큐) ----------
export type EmbedSource = "task" | "comment" | "skill";

export async function enqueueEmbedding(source_type: EmbedSource, source_id: number): Promise<void> {
  await db
    .insert(embeddingJobs)
    .values({ source_type, source_id, status: "pending", attempts: 0 })
    .onConflictDoUpdate({
      target: [embeddingJobs.source_type, embeddingJobs.source_id],
      set: { status: "pending", error: null, updated_at: new Date() },
    });
}

// 프로젝트 전체 소스 재색인 큐잉 (스킬은 전사 published 포함)
export async function enqueueProject(projectId: number): Promise<number> {
  let n = 0;
  const ts = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.project_id, projectId));
  for (const t of ts) { await enqueueEmbedding("task", t.id); n++; }
  if (ts.length) {
    const cs = await db.select({ id: comments.id }).from(comments).where(inArray(comments.task_id, ts.map((t) => t.id)));
    for (const c of cs) { await enqueueEmbedding("comment", c.id); n++; }
  }
  const sk = await db.select({ id: skills.id }).from(skills);
  for (const s of sk) { await enqueueEmbedding("skill", s.id); n++; }
  return n;
}

async function loadSource(job: EmbeddingJob): Promise<{ content: string; project_id: number | null; updated: Date | null } | null> {
  if (job.source_type === "task") {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, job.source_id)).limit(1);
    if (!t) return null;
    return { content: `[${t.item_key}] ${t.title}\n${t.description ?? ""}`.trim(), project_id: t.project_id, updated: t.updated_at };
  }
  if (job.source_type === "comment") {
    const [c] = await db.select().from(comments).where(eq(comments.id, job.source_id)).limit(1);
    if (!c) return null;
    const [t] = await db.select().from(tasks).where(eq(tasks.id, c.task_id)).limit(1);
    return { content: c.body, project_id: t?.project_id ?? null, updated: c.updated_at };
  }
  const [s] = await db.select().from(skills).where(eq(skills.id, job.source_id)).limit(1);
  if (!s) return null;
  return { content: `${s.title}\n${s.description ?? ""}\n${s.body}`.trim(), project_id: s.project_id, updated: s.updated_at };
}

// pending 잡 처리 (cron + reindex에서 직접 호출 — 테스트 결정론 보장)
export async function processEmbeddingJobs(limit = 200): Promise<{ done: number; failed: number }> {
  const jobs = await db.select().from(embeddingJobs).where(eq(embeddingJobs.status, "pending")).limit(limit);
  let done = 0, failed = 0;
  for (const job of jobs) {
    try {
      const src = await loadSource(job);
      if (!src || !src.content) {
        // 원본 삭제됨 → 임베딩도 제거하고 잡 완료
        await db.delete(embeddings).where(and(eq(embeddings.source_type, job.source_type), eq(embeddings.source_id, job.source_id)));
        await db.update(embeddingJobs).set({ status: "done", updated_at: new Date() }).where(eq(embeddingJobs.id, job.id));
        done++;
        continue;
      }
      const hash = contentHash(src.content);
      const model = embeddingModelName();
      const [existing] = await db
        .select({ content_hash: embeddings.content_hash, embedding_model: embeddings.embedding_model })
        .from(embeddings)
        .where(and(eq(embeddings.source_type, job.source_type), eq(embeddings.source_id, job.source_id)))
        .limit(1);
      // 내용이 바뀌었거나, 임베딩 모델이 교체됐으면 재임베딩.
      // (모델 교체 후 content 미변경 문서가 옛 벡터로 남아 이종 벡터 간 검색이 붕괴하는 것 방지 — 스펙 274행)
      if (existing?.content_hash !== hash || existing?.embedding_model !== model) {
        const [vec] = await embed([src.content]);
        await db
          .insert(embeddings)
          .values({
            project_id: src.project_id,
            source_type: job.source_type,
            source_id: job.source_id,
            content: src.content.slice(0, 4000),
            embedding: vec,
            embedding_model: embeddingModelName(),
            content_hash: hash,
            source_updated_at: src.updated,
          })
          .onConflictDoUpdate({
            target: [embeddings.source_type, embeddings.source_id],
            set: {
              content: src.content.slice(0, 4000),
              embedding: vec,
              embedding_model: embeddingModelName(),
              content_hash: hash,
              source_updated_at: src.updated,
              project_id: src.project_id,
            },
          });
      }
      await db.update(embeddingJobs).set({ status: "done", updated_at: new Date() }).where(eq(embeddingJobs.id, job.id));
      done++;
    } catch (e: any) {
      failed++;
      await db
        .update(embeddingJobs)
        .set({ status: "failed", attempts: job.attempts + 1, error: String(e?.message ?? e).slice(0, 500), updated_at: new Date() })
        .where(eq(embeddingJobs.id, job.id));
    }
  }
  return { done, failed };
}

// ---------- 검색 (권한·프로젝트 필터는 호출부에서 project_ids로 강제) ----------
export interface SearchHit {
  source_type: EmbedSource;
  source_id: number;
  project_id: number | null;
  content: string;
  score: number;
}

export async function searchEmbeddings(query: string, projectIds: number[], k = 8): Promise<SearchHit[]> {
  if (projectIds.length === 0) return [];
  const [qvec] = await embed([query]);
  const lit = toVectorLiteral(qvec);
  const res: any = await db.execute(sql`
    SELECT source_type, source_id, project_id, content,
           1 - (embedding <=> ${lit}::vector) AS score
    FROM embeddings
    WHERE embedding IS NOT NULL
      AND (project_id IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)}) OR project_id IS NULL)
    ORDER BY embedding <=> ${lit}::vector
    LIMIT ${k}
  `);
  return res.rows.map((r: any) => ({
    source_type: r.source_type,
    source_id: Number(r.source_id),
    project_id: r.project_id == null ? null : Number(r.project_id),
    content: r.content,
    score: Number(r.score),
  }));
}
