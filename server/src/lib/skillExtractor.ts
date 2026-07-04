import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { tasks, comments, guideAssignees, activityLog, skills, projects } from "../../../shared/schema.ts";
import { getLlm, isMockLlm } from "./llm.ts";
import { logActivity } from "./activity.ts";

interface Material {
  completedTasks: { id: number; item_key: string; title: string; label: string | null }[];
  appliedGuides: { comment_id: number; task_id: number; item_key: string; body: string; notes: string[] }[];
  skipped: { comment_id: number; item_key: string; body: string; notes: string[] }[];
  resolvedBlockers: { task_id: number; item_key: string; title: string }[];
}

// Collect pros (applied guides + resolved blockers) and cons (skipped/failed) for a project.
export async function collectMaterial(projectId: number): Promise<Material> {
  const done = await db
    .select({ id: tasks.id, item_key: tasks.item_key, title: tasks.title, label: tasks.label })
    .from(tasks)
    .where(and(eq(tasks.project_id, projectId), eq(tasks.status, "done")));

  const guideRows = await db
    .select({ comment_id: comments.id, task_id: comments.task_id, body: comments.body, item_key: tasks.item_key, state: guideAssignees.state, note: guideAssignees.note })
    .from(guideAssignees)
    .innerJoin(comments, eq(comments.id, guideAssignees.comment_id))
    .innerJoin(tasks, eq(tasks.id, comments.task_id))
    .where(eq(tasks.project_id, projectId));

  const appliedMap = new Map<number, Material["appliedGuides"][number]>();
  const skippedMap = new Map<number, Material["skipped"][number]>();
  for (const g of guideRows) {
    if (g.state === "applied") {
      const e = appliedMap.get(g.comment_id) ?? { comment_id: g.comment_id, task_id: g.task_id, item_key: g.item_key, body: g.body, notes: [] };
      if (g.note) e.notes.push(g.note);
      appliedMap.set(g.comment_id, e);
    } else if (g.state === "skipped") {
      const e = skippedMap.get(g.comment_id) ?? { comment_id: g.comment_id, item_key: g.item_key, body: g.body, notes: [] };
      if (g.note) e.notes.push(g.note);
      skippedMap.set(g.comment_id, e);
    }
  }

  // Resolved blockers = tasks that were 'blocked' at some point and are now done (a hard-won lesson).
  const blockedTaskIds = new Set<number>();
  const blockedMeta = await db.select().from(activityLog).where(and(eq(activityLog.project_id, projectId), eq(activityLog.action, "task.status_changed")));
  for (const ev of blockedMeta) {
    if ((ev.meta as any)?.status === "blocked" && ev.task_id) blockedTaskIds.add(ev.task_id);
  }
  const resolvedBlockers = done.filter((d) => blockedTaskIds.has(d.id)).map((d) => ({ task_id: d.id, item_key: d.item_key, title: d.title }));

  return {
    completedTasks: done,
    appliedGuides: [...appliedMap.values()],
    skipped: [...skippedMap.values()],
    resolvedBlockers,
  };
}

interface DraftSkill {
  title: string;
  category: string;
  name: string;
  description: string;
  body: string;
  antipatterns: string;
  source_refs: Array<Record<string, unknown>>;
  tags: string[];
}

// Cluster material into SKILL.md drafts. Uses LLM unless provider is 'mock' (deterministic fallback).
export async function clusterToSkills(projectName: string, m: Material): Promise<DraftSkill[]> {
  if (!isMockLlm()) {
    const llm = getLlm();
    const prompt = buildPrompt(projectName, m);
    try {
      const out = await llm.complete([
        { role: "system", content: "You extract reusable engineering SKILL.md docs from project retrospective data. Respond ONLY with JSON: {\"skills\":[{title,category,name,description,body,antipatterns,tags[]}]}. `description` states WHEN to use the skill (a trigger). `body` is markdown of recommended patterns. `antipatterns` lists pitfalls." },
        { role: "user", content: prompt },
      ]);
      const parsed = JSON.parse(out);
      if (Array.isArray(parsed.skills) && parsed.skills.length) {
        return parsed.skills.map((s: any) => ({
          title: s.title ?? "Untitled",
          category: s.category ?? "general",
          name: s.name ?? "skill",
          description: s.description ?? "",
          body: s.body ?? "",
          antipatterns: s.antipatterns ?? "",
          source_refs: refsFrom(m),
          tags: Array.isArray(s.tags) ? s.tags : [],
        }));
      }
    } catch (e) {
      console.error("[skill-extract] LLM failed, falling back to deterministic:", e);
    }
  }
  return [deterministicSkill(projectName, m)];
}

function refsFrom(m: Material): Array<Record<string, unknown>> {
  return [
    ...m.appliedGuides.map((g) => ({ type: "guide", comment_id: g.comment_id, item_key: g.item_key })),
    ...m.resolvedBlockers.map((b) => ({ type: "resolved_blocker", task_id: b.task_id, item_key: b.item_key })),
  ];
}

function buildPrompt(projectName: string, m: Material): string {
  const lines: string[] = [`# Project: ${projectName}`, "", "## Applied guides (worked well)"];
  for (const g of m.appliedGuides) lines.push(`- [${g.item_key}] ${g.body}${g.notes.length ? ` (notes: ${g.notes.join("; ")})` : ""}`);
  lines.push("", "## Resolved blockers (hard-won lessons)");
  for (const b of m.resolvedBlockers) lines.push(`- [${b.item_key}] ${b.title}`);
  lines.push("", "## Skipped / failed guidance (antipatterns)");
  for (const s of m.skipped) lines.push(`- [${s.item_key}] ${s.body}${s.notes.length ? ` (notes: ${s.notes.join("; ")})` : ""}`);
  return lines.join("\n");
}

// Deterministic single-skill synthesis (offline/mock).
function deterministicSkill(projectName: string, m: Material): DraftSkill {
  const bodyLines: string[] = [];
  bodyLines.push("## 권장 패턴 (검증된 가이드)");
  if (m.appliedGuides.length) {
    for (const g of m.appliedGuides) bodyLines.push(`- ${g.body.replace(/\s+/g, " ").slice(0, 200)}${g.notes.length ? ` — 수행 메모: ${g.notes.join("; ")}` : ""}`);
  } else bodyLines.push("- (적용된 가이드 없음)");
  if (m.resolvedBlockers.length) {
    bodyLines.push("", "## 해결된 blocker (교훈)");
    for (const b of m.resolvedBlockers) bodyLines.push(`- [${b.item_key}] ${b.title}`);
  }
  const anti = m.skipped.length
    ? m.skipped.map((s) => `- ${s.body.replace(/\s+/g, " ").slice(0, 200)}${s.notes.length ? ` — 사유: ${s.notes.join("; ")}` : ""}`).join("\n")
    : "- (기록된 안티패턴 없음)";

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
  return {
    title: `${projectName} 개발 노하우`,
    category: "general",
    name: `${slug}-lessons`,
    description: `${projectName}와 유사한 작업을 할 때 사용. 검증된 가이드와 해결된 blocker를 재사용하고, 기록된 안티패턴을 피한다.`,
    body: bodyLines.join("\n"),
    antipatterns: anti,
    source_refs: refsFrom(m),
    tags: [slug, "retrospective"],
  };
}

// Full SKILL.md text (name/description frontmatter + body + antipatterns) for export.
export function toSkillMarkdown(s: { name: string; description: string | null; body: string; antipatterns: string | null }): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${s.description ?? ""}`,
    "---",
    "",
    s.body,
    "",
    "## Antipatterns (재사용 시 주의)",
    s.antipatterns ?? "- 없음",
    "",
  ].join("\n");
}

// P5 entrypoint: triggered on project 'completed'. Produces DRAFT skills (human publishes).
export async function runSkillExtraction(projectId: number, userId: number): Promise<number[]> {
  const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!proj) return [];
  const material = await collectMaterial(projectId);
  const drafts = await clusterToSkills(proj.name, material);
  const ids: number[] = [];
  for (const d of drafts) {
    const [row] = await db
      .insert(skills)
      .values({
        project_id: projectId,
        title: d.title,
        category: d.category,
        name: d.name,
        description: d.description,
        body: d.body,
        antipatterns: d.antipatterns,
        source_refs: d.source_refs,
        tags: d.tags,
        status: "draft", // §13: never auto-publish; human review required
        extracted_at: new Date(),
        created_by: userId,
      })
      .returning({ id: skills.id });
    ids.push(row.id);
  }
  await logActivity({ project_id: projectId, user_id: userId, action: "skill.extracted", meta: { count: ids.length } });
  return ids;
}
