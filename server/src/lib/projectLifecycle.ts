import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  events,
  meetingNotes,
  pages,
  projectDeletions,
  projects,
  skills,
  snippets,
  tasks,
} from "../../../shared/schema.ts";

// 휴지통 보관 기간 — 문서·회의록 휴지통과 같은 감각. 지나면 크론이 영구 삭제한다.
// 기다릴 필요는 없다: 휴지통에서 '지금 영구 삭제'를 누르면 즉시 지워진다.
export const TRASH_RETENTION_DAYS = 30;

export function purgeDueBefore(now = new Date()): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * 86400_000);
}

// 삭제 다이얼로그에 보여줄 영향 요약. "무엇이 사라지고 무엇이 남는지"를 사람이 판단할 재료.
export async function deletionImpact(projectId: number): Promise<{
  tasks: number;
  pages: number;
  meetings: number;
  events: number;
  snippets: number;
  skills_published: number;
  skills_draft: number;
}> {
  const one = async (tbl: any, extra?: any) => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tbl)
      .where(extra ? and(eq(tbl.project_id, projectId), extra) : eq(tbl.project_id, projectId));
    return r?.n ?? 0;
  };
  return {
    tasks: await one(tasks),
    // 휴지통(deleted_at)에 있는 문서·회의록도 cascade로 함께 사라진다 — 세지 않으면 규모를 과소 표시한다.
    pages: await one(pages),
    meetings: await one(meetingNotes),
    events: await one(events),
    snippets: await one(snippets),
    skills_published: await one(skills, eq(skills.status, "published")),
    // 검수 전 초안 — 프로젝트가 사라지면 project_id가 NULL이 되어 '미분류'로 이동한다.
    // (skills.ts 조회가 고아 노하우를 작성자·관리자에게 계속 보여주므로 유실은 아니다)
    skills_draft: await one(skills, eq(skills.status, "draft")),
  };
}

// 영구 삭제. cascade가 태스크·문서·회의록·활동기록을 함께 지우고,
// skills·submissions는 ON DELETE SET NULL이라 살아남는다(프로젝트 연결만 끊김).
// 삭제 사실 자체는 project_deletions에 스냅샷으로 남긴다 — activity_log는 함께 지워지므로.
export async function purgeProject(projectId: number, purgedBy: number | null): Promise<boolean> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) return false;
  const stats = await deletionImpact(projectId);
  await db.insert(projectDeletions).values({
    project_key: p.key,
    project_name: p.name,
    owner_id: p.owner_id,
    // 영구 삭제를 **실행한** 주체. 크론이면 null(=시스템)이다.
    // 여기에 p.deleted_by(휴지통에 넣은 사람)를 폴백으로 채우면 "사람이 즉시 영구삭제"와
    // "30일 뒤 시스템이 자동 삭제"가 같은 모양으로 기록돼 감사 주체가 오귀속된다.
    deleted_by: purgedBy,
    trashed_at: p.deleted_at,
    // project_key는 안정 식별자가 아니다 — 삭제로 키가 풀리면 새 프로젝트가 재사용한다
    // (projectKey.ts는 살아 있는 projects만 보고 중복을 피한다). 원래 id를 함께 남겨 대조 가능하게.
    stats: { ...stats, project_id: projectId, trashed_by: p.deleted_by ?? null, auto: purgedBy === null },
  });
  await db.delete(projects).where(eq(projects.id, projectId));
  return true;
}

// 한 번에 처리할 상한. 건당 쿼리 8회 + 다단 CASCADE라 비용이 크다 — 무제한이면 만기가 몰린 밤에
// 한 tick이 길게 늘어진다. 하루 1회 + 기동 시 따라잡기로 도는 멱등 잡이라 남은 건 다음 회차에 지워진다.
// (embeddings.ts의 processEmbeddingJobs가 쓰는 것과 같은 상한 방식)
const PURGE_BATCH = 50;

// 30일 지난 휴지통 프로젝트 자동 영구 삭제 (크론). 멱등 — 대상이 없으면 0을 반환한다.
export async function purgeExpiredProjects(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNotNull(projects.deleted_at), lt(projects.deleted_at, purgeDueBefore(now))))
    .orderBy(projects.deleted_at) // 오래 기다린 것부터 — 상한에 걸려도 순서가 정해진다
    .limit(PURGE_BATCH);
  let n = 0;
  for (const row of due) {
    if (await purgeProject(row.id, null)) n++;
  }
  // 상한에 걸렸으면 조용히 자르지 않고 남았다는 사실을 남긴다.
  if (due.length === PURGE_BATCH) console.log(`[trash] 상한 ${PURGE_BATCH}건 도달 — 남은 대상은 다음 회차에 처리`);
  return n;
}
