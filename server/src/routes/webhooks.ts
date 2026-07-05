import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { tasks, projects, githubLinks, webhookEvents } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { env } from "../lib/env.ts";
import { parseItemKeys, verifyGithubSignature } from "../lib/github.ts";
import { applyRollup, checklistProgress, guideProgressForTask } from "../lib/taskService.ts";
import { logActivity } from "../lib/activity.ts";

// ★ 보안(C-1): 저장소 → 프로젝트 바인딩. payload의 repository.full_name이
// projects.github_repo와 일치하는 프로젝트 범위에서만 item_key 해석 — 크로스 프로젝트 조작 차단.
async function projectIdsForRepo(repoFullName: string): Promise<number[]> {
  if (!repoFullName) return [];
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.github_repo, repoFullName));
  return rows.map((r) => r.id);
}

async function findTaskByKey(itemKey: string, projectIds: number[]) {
  if (projectIds.length === 0) return null;
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.item_key, itemKey), inArray(tasks.project_id, projectIds)))
    .limit(1);
  return t ?? null;
}

async function upsertLink(taskId: number, kind: "commit" | "pr" | "branch" | "issue", data: {
  external_id: string; url?: string | null; title?: string | null; state?: string | null; meta?: Record<string, unknown>;
}): Promise<boolean> {
  const inserted = await db
    .insert(githubLinks)
    .values({ task_id: taskId, kind, external_id: data.external_id, url: data.url ?? null, title: data.title ?? null, state: data.state ?? null, meta: data.meta })
    .onConflictDoNothing()
    .returning({ id: githubLinks.id });
  if (inserted.length === 0 && data.state) {
    // 같은 링크 재수신 → 상태만 갱신 (PR open→merged 등)
    await db
      .update(githubLinks)
      .set({ state: data.state, title: data.title ?? undefined })
      .where(and(eq(githubLinks.task_id, taskId), eq(githubLinks.kind, kind), eq(githubLinks.external_id, data.external_id)));
  }
  return inserted.length > 0;
}

// PR merged → 가드레일 통과 시에만 자동 완료 (§7.8)
async function tryAutoComplete(taskId: number, prNumber: number): Promise<boolean> {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  // 이미 완료된 태스크는 물론, 미승인 티켓(requested)·반려(rejected)는 자동완료 대상에서 제외.
  // requested/rejected 전이는 승인/반려 API로만 — PR 머지가 이 불변식을 우회하면 안 됨(F1).
  if (!t || t.status === "done" || t.status === "requested" || t.status === "rejected") return false;
  const [p] = await db.select().from(projects).where(eq(projects.id, t.project_id)).limit(1);
  if (!p?.auto_complete_on_pr_merge) return false;
  if (p.require_checklist_done_before_auto_complete) {
    const cl = await checklistProgress(taskId);
    if (cl.total > 0 && cl.done < cl.total) return false;
  }
  if (p.require_guide_applied_before_done) {
    const g = await guideProgressForTask(taskId);
    if (g.total > 0 && g.applied < g.total) return false;
  }
  await db.update(tasks).set({ status: "done", completed_at: new Date(), updated_at: new Date() }).where(eq(tasks.id, taskId));
  await applyRollup(taskId);
  // 자동 변경도 감사 로그에 기록 (§7.8)
  await logActivity({ project_id: t.project_id, task_id: taskId, user_id: null, action: "task.auto_completed", meta: { pr: prNumber, reason: "pr_merged" } });
  return true;
}

export function webhooksRouter(): Router {
  const r = Router();

  // GitHub webhook — 인증은 세션이 아니라 서명(§10.9). raw body는 app.ts의 json verify 훅에서 보존.
  r.post(
    "/github",
    ah(async (req, res) => {
      const raw: Buffer | undefined = (req as any).rawBody;
      const sig = req.header("x-hub-signature-256");
      if (!verifyGithubSignature(raw, sig, env.GITHUB_WEBHOOK_SECRET)) {
        return res.status(401).json({ error: { code: "invalid_signature", message: "서명 검증에 실패했습니다." } });
      }
      const deliveryId = req.header("x-github-delivery") ?? "";
      const eventType = req.header("x-github-event") ?? "unknown";
      if (!deliveryId) return res.status(400).json({ error: { code: "bad_request", message: "delivery id가 없습니다." } });

      // 멱등: delivery_id 유니크 — 이미 처리된 이벤트는 재처리하지 않음 (replay 방지)
      const inserted = await db
        .insert(webhookEvents)
        .values({ delivery_id: deliveryId, event_type: eventType, payload: req.body })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (inserted.length === 0) return res.json({ ok: true, duplicate: true });

      let linked = 0;
      let completed = 0;
      const body: any = req.body ?? {};
      // 프로젝트 설정(github_repo)에 등록된 저장소의 이벤트만 처리
      const boundProjects = await projectIdsForRepo(String(body.repository?.full_name ?? ""));

      if (eventType === "push") {
        const branch = typeof body.ref === "string" ? body.ref.replace(/^refs\/heads\//, "") : "";
        for (const commit of body.commits ?? []) {
          const keys = parseItemKeys(commit.message, branch);
          for (const key of keys) {
            const t = await findTaskByKey(key, boundProjects);
            if (!t) continue;
            if (await upsertLink(t.id, "commit", { external_id: String(commit.id), url: commit.url, title: String(commit.message ?? "").split("\n")[0] })) linked++;
            if (branch && (await upsertLink(t.id, "branch", { external_id: branch, url: body.repository?.html_url ? `${body.repository.html_url}/tree/${branch}` : null, title: branch }))) linked++;
          }
        }
      } else if (eventType === "pull_request") {
        const pr = body.pull_request ?? {};
        const keys = parseItemKeys(pr.title, pr.body, pr.head?.ref);
        const merged = body.action === "closed" && pr.merged === true;
        const state = merged ? "merged" : pr.state ?? "open";
        for (const key of keys) {
          const t = await findTaskByKey(key, boundProjects);
          if (!t) continue;
          if (await upsertLink(t.id, "pr", { external_id: String(pr.number), url: pr.html_url, title: pr.title, state, meta: { action: body.action } })) linked++;
          if (merged && (await tryAutoComplete(t.id, Number(pr.number)))) completed++;
        }
      }

      await db.update(webhookEvents).set({ processed_at: new Date() }).where(eq(webhookEvents.delivery_id, deliveryId));
      res.json({ ok: true, linked, completed });
    }),
  );

  return r;
}
