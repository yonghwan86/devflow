// G1: 역할 개편 — owner 폐지, 매니저=최고 책임자, 마지막 매니저 가드
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { makeTestApp } from "./harness.ts";
import { db } from "../lib/db.ts";
import { projectMembers } from "../../../shared/schema.ts";

async function signup(app: any, email: string, name: string) {
  const a = request.agent(app);
  await a.post("/api/auth/signup").send({ email, password: "password123", full_name: name });
  await a.post("/api/auth/login").send({ email, password: "password123" });
  return a;
}

test("G1 역할: 생성자=매니저, 역할변경/제거, 마지막 매니저 가드, owner 입력 거부", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const mgr = request.agent(ctx.app);
  await mgr.post("/api/auth/bootstrap").send({ email: "m@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });

  // ⑧ 생성자 my_role=manager
  const proj = (await mgr.post("/api/projects").send({ name: "역할" })).body.project;
  assert.equal(proj.my_role, "manager");
  const pid = proj.id;

  // 팀원 bob, carol 가입 + 추가
  const bob = await signup(ctx.app, "bob@x.com", "밥");
  const carol = await signup(ctx.app, "carol@x.com", "캐롤");
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  const carolId = (await carol.get("/api/auth/me")).body.user.id;
  const bobM = (await mgr.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" })).body.member;
  await mgr.post(`/api/projects/${pid}/members`).send({ user_id: carolId, role: "member" });

  // ⑦ role="owner" 입력 → 400 (zod enum)
  let r = await mgr.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "owner" });
  assert.equal(r.status, 400, "owner 역할 입력 거부");

  // ① 매니저가 멤버 역할 변경(member→manager) 성공
  r = await mgr.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "manager" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.member.role, "manager");

  // ③ member 권한(carol)이 역할 변경/제거 시도 → 403
  r = await carol.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "member" });
  assert.equal(r.status, 403);
  r = await carol.delete(`/api/projects/${pid}/members/${bobM.id}`);
  assert.equal(r.status, 403);

  // ⑥ 매니저 2명(mgr, bob)일 때 한 명(bob) 강등 성공
  r = await mgr.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "member" });
  assert.equal(r.status, 200, "매니저 2명 중 1명 강등 허용");

  // ④ 유일 매니저(mgr 본인) 강등 → 400
  const myM = (await mgr.get(`/api/projects/${pid}/members`)).body.members.find((m: any) => m.user.email === "m@x.com");
  r = await mgr.patch(`/api/projects/${pid}/members/${myM.id}`).send({ role: "member" });
  assert.equal(r.status, 400, "마지막 매니저 강등 차단");

  // ⑤ 유일 매니저 제거 → 400
  r = await mgr.delete(`/api/projects/${pid}/members/${myM.id}`);
  assert.equal(r.status, 400, "마지막 매니저 제거 차단");

  // ② 매니저가 멤버(bob) 제거 성공
  r = await mgr.delete(`/api/projects/${pid}/members/${bobM.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

// 회귀: db:push 이전 DB에 남아있는 legacy 'owner' 행은 매니저와 동일하게 취급돼야 한다.
// (배포 DB에서 owner→manager UPDATE 미실행 시 매니저가 팀원 관리 UI/권한을 잃던 버그)
test("G1 회귀: legacy owner 행도 매니저로 정규화된다", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const boss = request.agent(ctx.app);
  await boss.post("/api/auth/bootstrap").send({ email: "boss@x.com", password: "password123", full_name: "보스" });
  await boss.post("/api/auth/login").send({ email: "boss@x.com", password: "password123" });
  const bossId = (await boss.get("/api/auth/me")).body.user.id;

  const proj = (await boss.post("/api/projects").send({ name: "레거시" })).body.project;
  const pid = proj.id;
  const bob = await signup(ctx.app, "bob2@x.com", "밥");
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  const bobM = (await boss.post(`/api/projects/${pid}/members`).send({ user_id: bobId, role: "member" })).body.member;

  // 마이그레이션 전 상태 재현: boss 행을 직접 'owner'로 되돌린다.
  await db.update(projectMembers).set({ role: "owner" as any })
    .where(and(eq(projectMembers.project_id, pid), eq(projectMembers.user_id, bossId)));

  // ① 멤버 목록 응답은 owner를 "manager"로 정규화해 내려준다 → 프론트 canManage 동작
  let r = await boss.get(`/api/projects/${pid}/members`);
  const bossRow = r.body.members.find((m: any) => m.user.id === bossId);
  assert.equal(bossRow.role, "manager", "owner 행이 members 응답에서 manager로 정규화");

  // ② owner 행 사용자가 여전히 매니저 권한(역할 변경)을 행사할 수 있다 → requireRole 통과
  r = await boss.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "manager" });
  assert.equal(r.status, 200, `owner=매니저 권한 유지: ${JSON.stringify(r.body)}`);

  // ③ owner 행을 유일 최상위 권한자로 되돌린 뒤 본인 강등 시도 → 마지막 매니저 가드가 owner도 계산해 400
  await boss.patch(`/api/projects/${pid}/members/${bobM.id}`).send({ role: "member" });
  const bossM = (await boss.get(`/api/projects/${pid}/members`)).body.members.find((m: any) => m.user.id === bossId);
  r = await boss.patch(`/api/projects/${pid}/members/${bossM.id}`).send({ role: "member" });
  assert.equal(r.status, 400, "legacy owner도 마지막 매니저로 계산되어 강등 차단");
});
