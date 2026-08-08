// Z: 프로젝트 보관 / 휴지통(30일) / 복원 / 영구삭제 — 권한 · 이름 확인 · 노하우 보존 · 감사
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, isNull } from "drizzle-orm";
import { makeTestApp } from "./harness.ts";
import { db } from "../lib/db.ts";
import { projectDeletions, projects, skills, tasks } from "../../../shared/schema.ts";
import { purgeExpiredProjects, TRASH_RETENTION_DAYS } from "../lib/projectLifecycle.ts";

async function setup(ctx: { app: any }) {
  const admin = request.agent(ctx.app);
  const owner = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  await admin.post("/api/auth/bootstrap").send({ email: "admin@x.com", password: "password123", full_name: "관리자" });
  await owner.post("/api/auth/signup").send({ email: "o@x.com", password: "password123", full_name: "소유자" });
  await member.post("/api/auth/signup").send({ email: "m@x.com", password: "password123", full_name: "멤버" });
  const proj = (await owner.post("/api/projects").send({ name: "삭제대상" })).body.project;
  const memberId = (await member.get("/api/auth/me")).body.user.id;
  await owner.post(`/api/projects/${proj.id}/members`).send({ user_id: memberId, role: "member" });
  return { admin, owner, member, proj };
}

test("Z: 휴지통 이동 → 목록에서 사라지고 복원하면 돌아온다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, proj } = await setup(ctx);

  // 이름 확인이 틀리면 거부 — 서버도 강제한다(클라 다이얼로그만 믿지 않는다)
  let r = await owner.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "엉뚱한이름" });
  assert.equal(r.status, 400, "이름 불일치 거부");

  r = await owner.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // 목록에서 제외
  assert.equal((await owner.get("/api/projects")).body.projects.length, 0, "휴지통은 목록에서 빠짐");
  // 휴지통에는 보이고 남은 일수가 붙는다
  const trash = (await owner.get("/api/projects/trash")).body;
  assert.equal(trash.projects.length, 1);
  assert.equal(trash.retention_days, TRASH_RETENTION_DAYS);
  assert.ok(trash.projects[0].days_left > 0 && trash.projects[0].days_left <= TRASH_RETENTION_DAYS);

  // 중복 삭제 방지
  assert.equal((await owner.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" })).status, 400);

  // 복원
  assert.equal((await owner.post(`/api/projects/${proj.id}/restore`).send({})).status, 200);
  assert.equal((await owner.get("/api/projects")).body.projects.length, 1, "복원 후 목록 복귀");
  assert.equal((await owner.get("/api/projects/trash")).body.projects.length, 0);
});

test("Z: 권한 — 일반 멤버는 보관·삭제 불가, 관리자는 남의 프로젝트도 가능", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, member, proj } = await setup(ctx);

  // 멤버(member 역할)는 매니저 미만이라 전부 거부
  assert.equal((await member.post(`/api/projects/${proj.id}/archive`).send({ archived: true })).status, 403);
  assert.equal((await member.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" })).status, 403);
  assert.equal((await member.get(`/api/projects/${proj.id}/deletion-impact`)).status, 403);

  // 관리자는 멤버가 아닌데도 가능해야 한다 — 정리하려고 참여하면 팀원 목록에 이름이 남는다
  assert.equal((await admin.post(`/api/projects/${proj.id}/archive`).send({ archived: true })).status, 200);
  const [archived] = await db.select().from(projects).where(eq(projects.id, proj.id));
  assert.equal(archived.status, "archived");
  assert.equal((await admin.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" })).status, 200);
});

test("Z: 영구 삭제 — 휴지통 경유 필수, 노하우는 살아남고 감사 기록이 남는다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, owner, proj } = await setup(ctx);
  await owner.post(`/api/projects/${proj.id}/tasks`).send({ title: "할일" });

  // 이 프로젝트의 노하우 2건 — 게시본과 검수 전 초안
  await db.insert(skills).values([
    { project_id: proj.id, title: "게시된 교훈", name: "pub", body: "본문", status: "published" },
    { project_id: proj.id, title: "검수 전 초안", name: "dft", body: "본문", status: "draft" },
  ]);

  // 활성 프로젝트를 바로 영구삭제할 수 없다 — 2단계 강제
  let r = await admin.post(`/api/projects/${proj.id}/purge`).send({ confirm_name: "삭제대상" });
  assert.equal(r.status, 400, "휴지통 경유 없이는 영구삭제 불가");

  // 삭제 영향 요약이 다이얼로그 재료를 준다
  const impact = (await admin.get(`/api/projects/${proj.id}/deletion-impact`)).body.impact;
  assert.equal(impact.tasks, 1);
  assert.equal(impact.skills_published, 1);
  assert.equal(impact.skills_draft, 1, "검수 전 초안 수를 경고에 쓴다");

  await admin.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });
  assert.equal((await admin.post(`/api/projects/${proj.id}/purge`).send({ confirm_name: "틀림" })).status, 400, "이름 확인 강제");
  r = await admin.post(`/api/projects/${proj.id}/purge`).send({ confirm_name: "삭제대상" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // 프로젝트와 태스크는 사라진다
  assert.equal((await db.select().from(projects).where(eq(projects.id, proj.id))).length, 0);
  assert.equal((await db.select().from(tasks).where(eq(tasks.project_id, proj.id))).length, 0);

  // ★ 노하우는 살아남는다 — 프로젝트는 끝나도 배움은 남는다(ON DELETE SET NULL)
  const survived = await db.select().from(skills).where(isNull(skills.project_id));
  assert.equal(survived.length, 2, "게시본·초안 모두 보존, project_id만 해제");

  // ★ 감사 기록 — activity_log는 프로젝트와 함께 지워지므로 별도 표에 남아야 한다
  const [audit] = await db.select().from(projectDeletions);
  assert.ok(audit, "영구 삭제 감사 기록 존재");
  assert.equal(audit.project_name, "삭제대상");
  assert.ok(audit.deleted_by, "누가 지웠는지 기록");
  assert.ok(audit.trashed_at, "언제 휴지통에 갔는지 기록");
});

test("Z: 고아 노하우는 작성자·관리자에게 계속 보인다 (경고 후 삭제해도 유실 아님)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, owner, member, proj } = await setup(ctx);
  const ownerId = (await owner.get("/api/auth/me")).body.user.id;
  await db.insert(skills).values({ project_id: proj.id, title: "떠도는 초안", name: "orph", body: "본문", status: "draft", created_by: ownerId });

  await admin.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });
  await admin.post(`/api/projects/${proj.id}/purge`).send({ confirm_name: "삭제대상" });

  const titles = (list: any[]) => list.map((s) => s.title);
  // 작성자 본인 — 보인다
  assert.ok(titles((await owner.get("/api/skills")).body.skills).includes("떠도는 초안"), "작성자에게 보임");
  // 사이트 관리자 — 보인다(정리 담당)
  assert.ok(titles((await admin.get("/api/skills")).body.skills).includes("떠도는 초안"), "관리자에게 보임");
  // 무관한 사용자 — 안 보인다(원래 프로젝트 멤버에게만 보이던 초안이라 조직 전체 공개는 아님)
  assert.ok(!titles((await member.get("/api/skills")).body.skills).includes("떠도는 초안"), "제3자에게는 비공개 유지");
});

// ── 멀티에이전트 검증에서 확정된 결함들의 회귀 테스트 ──

test("Z: 보관·삭제는 세션 전용 — Bearer 토큰으로는 못 한다(C5 규약)", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, proj } = await setup(ctx);

  // MCP·시리 단축어용으로 흔히 쓰는 최소 스코프 토큰
  const tok = (await owner.post("/api/tokens").send({ name: "mcp", scopes: ["task:write"] })).body.token;
  assert.ok(tok);
  const bearer = (p: string) => request(ctx.app).post(p).set("Authorization", `Bearer ${tok}`);

  // 이게 뚫리면 토큰 1개 유출 = 프로젝트 통째 영구삭제(11개 테이블 cascade)
  assert.equal((await bearer(`/api/projects/${proj.id}/archive`).send({ archived: true })).status, 403);
  assert.equal((await bearer(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" })).status, 403);
  assert.equal((await bearer(`/api/projects/${proj.id}/purge`).send({ confirm_name: "삭제대상" })).status, 403);
  assert.equal((await bearer(`/api/projects/${proj.id}/restore`).send({})).status, 403);
  assert.equal(
    (await request(ctx.app).get(`/api/projects/${proj.id}/deletion-impact`).set("Authorization", `Bearer ${tok}`)).status,
    403,
  );
  // 프로젝트는 멀쩡해야 한다
  assert.equal((await db.select().from(projects).where(eq(projects.id, proj.id))).length, 1);
  // 세션으로는 정상 동작
  assert.equal((await owner.post(`/api/projects/${proj.id}/archive`).send({ archived: true })).status, 200);
});

test("Z: 휴지통에 넣으면 그 프로젝트는 열 수도 쓸 수도 없다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, member, proj } = await setup(ctx);
  await owner.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });

  // 멤버가 계속 쓸 수 있으면 30일 뒤 그 작업이 통째로 증발한다 — 읽기·쓰기 모두 막혀야 한다
  assert.equal((await member.get(`/api/projects/${proj.id}`)).status, 403, "상세 조회 차단");
  assert.equal((await member.get(`/api/projects/${proj.id}/tasks`)).status, 403, "태스크 목록 차단");
  assert.equal((await member.post(`/api/projects/${proj.id}/tasks`).send({ title: "새 할일" })).status, 403, "쓰기 차단");
  assert.equal((await member.get(`/api/projects/${proj.id}/pages`)).status, 403, "문서 차단");

  // 복원하면 다시 열린다 (복원 경로는 requireMember를 쓰지 않으므로 막히면 안 된다)
  assert.equal((await owner.post(`/api/projects/${proj.id}/restore`).send({})).status, 200);
  assert.equal((await member.get(`/api/projects/${proj.id}/tasks`)).status, 200, "복원 후 정상");
});

test("Z: 고아 초안은 상세·내보내기에서도 제3자에게 안 보인다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, owner, member, proj } = await setup(ctx);
  const ownerId = (await owner.get("/api/auth/me")).body.user.id;
  const [draft] = await db
    .insert(skills)
    .values({ project_id: proj.id, title: "비공개 초안", name: "sec", body: "영업비밀", status: "draft", created_by: ownerId })
    .returning();

  await admin.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });
  await admin.post(`/api/projects/${proj.id}/purge`).send({ confirm_name: "삭제대상" });

  // project_id가 NULL이 되면서 멤버십 검사가 단락되던 자리 — 목록만 고치고 상세를 놓치면 전문이 샌다
  assert.equal((await member.get(`/api/skills/${draft.id}`)).status, 403, "제3자 상세 차단");
  assert.equal((await member.get(`/api/skills/${draft.id}/export`)).status, 403, "제3자 내보내기 차단");
  // 작성자·관리자는 계속 볼 수 있어야 한다(노하우는 유실되면 안 되므로)
  assert.equal((await owner.get(`/api/skills/${draft.id}`)).status, 200, "작성자는 열람 가능");
  assert.equal((await admin.get(`/api/skills/${draft.id}`)).status, 200, "관리자는 열람 가능");

  // ★ 관리자 승격 열람은 **세션 전용**이다. 관리자가 MCP용으로 발급한 최소 스코프 토큰 하나가
  //   전사 비공개 초안 열쇠가 되면 안 된다 — 고아 가시성을 열면서 토큰 표면까지 같이 열린 자리.
  const tok = (await admin.post("/api/tokens").send({ name: "mcp", scopes: ["skill:read"] })).body.token;
  const asToken = (p: string) => request(ctx.app).get(p).set("Authorization", `Bearer ${tok}`);
  assert.equal((await asToken(`/api/skills/${draft.id}`)).status, 403, "관리자 토큰도 고아 초안 상세 차단");
  assert.equal((await asToken(`/api/skills/${draft.id}/export`)).status, 403, "관리자 토큰도 내보내기 차단");
  const listed = (await asToken("/api/skills")).body.skills.map((s: any) => s.title);
  assert.ok(!listed.includes("비공개 초안"), "관리자 토큰 목록에도 고아 초안이 안 나온다");
});

test("Z: 30일 지난 휴지통은 크론이 자동 영구 삭제한다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { admin, proj } = await setup(ctx);
  await admin.post(`/api/projects/${proj.id}/trash`).send({ confirm_name: "삭제대상" });

  // 아직 기한 전 — 건드리지 않는다
  assert.equal(await purgeExpiredProjects(), 0, "기한 전에는 살려둔다");

  // 30일 + 1일 지난 것으로 만든다
  await db
    .update(projects)
    .set({ deleted_at: new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * 86400_000) })
    .where(eq(projects.id, proj.id));
  assert.equal(await purgeExpiredProjects(), 1, "기한 지난 1건 삭제");
  assert.equal((await db.select().from(projects).where(eq(projects.id, proj.id))).length, 0);
  // 멱등 — 다시 돌려도 0
  assert.equal(await purgeExpiredProjects(), 0);
  const [audit] = await db.select().from(projectDeletions);
  assert.ok(audit, "자동 삭제도 감사 기록을 남긴다");
  // ★ "사람이 즉시 영구삭제"와 "30일 뒤 시스템이 자동 삭제"가 같은 모양으로 기록되면 감사표가 거짓말을 한다.
  //   실행 주체는 null(=시스템)이고, 휴지통에 넣은 사람은 따로 남는다.
  assert.equal(audit.deleted_by, null, "크론 삭제는 실행 주체가 시스템(null)");
  const stats = audit.stats as Record<string, unknown>;
  assert.equal(stats.auto, true, "자동 삭제 표시");
  assert.ok(stats.trashed_by, "휴지통에 넣은 사람은 따로 기록");
  assert.equal(stats.project_id, proj.id, "project_key는 재사용되므로 원래 id를 함께 남긴다");
});
