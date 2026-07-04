// My Work team_today: 같은 프로젝트 팀원의 오늘 할 일 공유 + 비멤버 차단 (§10.5)
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("My Work team_today", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const memberA = request.agent(ctx.app);
  const memberB = request.agent(ctx.app);
  const outsider = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });

  const proj = await owner.post("/api/projects").send({ name: "본프로젝트" });
  const pid = proj.body.project.id;

  const invite = async (email: string, agent: request.Agent, name: string, projectId: number) => {
    const inv = await owner.post(`/api/projects/${projectId}/invites`).send({ email, role: "member" });
    const acc = await agent.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: name });
    await agent.post("/api/auth/login").send({ email, password: "password123" });
    return acc.body.user.id;
  };
  const aId = await invite("a@x.com", memberA, "팀원A", pid);
  await invite("b@x.com", memberB, "팀원B", pid);

  // 별도 프로젝트에만 속한 외부인
  const proj2 = await owner.post("/api/projects").send({ name: "딴프로젝트" });
  await invite("out@x.com", outsider, "외부인", proj2.body.project.id);

  // 오늘 예정 태스크를 팀원A에게 배정 (현재 시각 사용 — UTC 자정 기반은 KST 새벽에 플레이크)
  const today = new Date().toISOString();
  const task = await owner
    .post(`/api/projects/${pid}/tasks`)
    .send({ title: "오늘 업무", scheduled_date: today, assignee_ids: [aId] });
  assert.equal(task.status, 201);

  // 담당자 A: 본인 today에 있고 team_today에는 없음
  let r = await memberA.get("/api/my-work");
  assert.equal(r.body.today.length, 1, "담당자 today: " + JSON.stringify(r.body.today));
  assert.equal(r.body.team_today.length, 0, "담당자 team_today 중복 금지");

  // 같은 프로젝트 팀원B: team_today로 보임 (크로스 체킹) + 담당자 정보 포함
  r = await memberB.get("/api/my-work");
  assert.equal(r.body.team_today.length, 1, "팀원 team_today: " + JSON.stringify(r.body.team_today));
  assert.equal(r.body.team_today[0].assignees[0].full_name, "팀원A");

  // 매니저/오너: 전부 보임
  r = await owner.get("/api/my-work");
  assert.equal(r.body.team_today.length, 1, "오너 team_today");

  // ★ 권한 거부: 다른 프로젝트 소속 외부인에게는 절대 노출 안 됨
  r = await outsider.get("/api/my-work");
  assert.equal(r.body.team_today.length, 0, "비멤버에게 노출 금지: " + JSON.stringify(r.body.team_today));

  // 완료된 태스크는 team_today에서 빠짐
  await owner.patch(`/api/tasks/${task.body.task.id}`).send({ status: "done" });
  r = await memberB.get("/api/my-work");
  assert.equal(r.body.team_today.length, 0, "done 태스크 제외");
});
