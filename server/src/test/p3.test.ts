import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

async function scenario() {
  const ctx = await makeTestApp();
  const app = ctx.app;
  const owner = request.agent(app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "Owner" });
  const proj = await owner.post("/api/projects").send({ name: "Beta" });
  const pid = proj.body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  const member = request.agent(app);
  const acc = await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "memberpass1", full_name: "Mem" });
  const memberId = acc.body.user.id;
  const t = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Task", assignee_ids: [memberId] });
  return { app, owner, member, memberId, pid, taskId: t.body.task.id };
}

describe("P3 comments / guides / per-member tracking", () => {
  test("guide comment fans out pending rows to each assignee; progress tracked", async () => {
    const { owner, member, taskId } = await scenario();
    const g = await owner.post("/api/comments").send({ task_id: taskId, body: "## Do it this way", is_guide: true });
    assert.equal(g.status, 201);
    assert.equal(g.body.comment.is_guide, true);
    assert.equal(g.body.comment.guide_progress.total, 1); // one assignee
    assert.equal(g.body.comment.guide_progress.applied, 0);

    // member sees it in My Work pending guides
    const mw1 = await member.get("/api/my-work");
    assert.equal(mw1.body.pending_guides.length, 1);

    // member marks applied with note -> only their row changes
    const commentId = g.body.comment.id;
    const done = await member.patch(`/api/comments/${commentId}/guide`).send({ state: "applied", note: "적용 완료" });
    assert.equal(done.status, 200);
    assert.equal(done.body.comment.guide_progress.applied, 1);
    assert.equal(done.body.comment.guide_assignees[0].note, "적용 완료");

    // pending guide disappears from My Work
    const mw2 = await member.get("/api/my-work");
    assert.equal(mw2.body.pending_guides.length, 0);
  });

  test("member cannot create a guide (role), but can comment", async () => {
    const { member, taskId } = await scenario();
    const guide = await member.post("/api/comments").send({ task_id: taskId, body: "x", is_guide: true });
    assert.equal(guide.status, 403);
    const comment = await member.post("/api/comments").send({ task_id: taskId, body: "질문 있습니다" });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.comment.is_guide, false);
  });

  test("non-assignee cannot mark a guide's state", async () => {
    const { owner, taskId } = await scenario();
    const g = await owner.post("/api/comments").send({ task_id: taskId, body: "guide", is_guide: true });
    // owner is not an assignee of the task -> no guide_assignee row for owner
    const res = await owner.patch(`/api/comments/${g.body.comment.id}/guide`).send({ state: "applied" });
    assert.equal(res.status, 403);
  });

  test("markdown body is sanitized in body_html (§10.7 XSS)", async () => {
    const { member, taskId } = await scenario();
    const c = await member.post("/api/comments").send({ task_id: taskId, body: "**hi** <img src=x onerror=alert(1)><script>alert(2)</script>" });
    const html = c.body.comment.body_html as string;
    assert.ok(html.includes("<strong>hi</strong>"));
    assert.ok(!html.includes("onerror"));
    assert.ok(!html.toLowerCase().includes("<script"));
  });

  test("threaded replies via parent_id, and unauthenticated blocked", async () => {
    const { owner, taskId, app } = await scenario();
    const root = await owner.post("/api/comments").send({ task_id: taskId, body: "root" });
    const reply = await owner.post("/api/comments").send({ task_id: taskId, body: "reply", parent_id: root.body.comment.id });
    assert.equal(reply.body.comment.parent_id, root.body.comment.id);
    const anon = await request(app).get(`/api/comments?task_id=${taskId}`);
    assert.equal(anon.status, 401);
  });

  test("late assignee is backfilled onto existing guides (M1)", async () => {
    const { app, owner, taskId } = await scenario();
    // guide created while only original member is assigned
    const g = await owner.post("/api/comments").send({ task_id: taskId, body: "가이드", is_guide: true });
    // add a brand-new member to the project + task AFTER the guide exists
    const proj = (await owner.get("/api/projects")).body.projects[0];
    const inv = await owner.post(`/api/projects/${proj.id}/invites`).send({ email: "late@x.com", role: "member" });
    const late = request.agent(app);
    const acc = await late.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "latepass12", full_name: "Late" });
    await owner.post(`/api/tasks/${taskId}/assignees`).send({ user_id: acc.body.user.id });
    // late member now sees the pre-existing guide as pending
    const mw = await late.get("/api/my-work");
    assert.equal(mw.body.pending_guides.length, 1);
    // and can mark it
    const done = await late.patch(`/api/comments/${g.body.comment.id}/guide`).send({ state: "applied" });
    assert.equal(done.status, 200);
  });

});
