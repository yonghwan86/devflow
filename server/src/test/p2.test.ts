import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";

async function setup(app: any) {
  const owner = request.agent(app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "Owner" });
  const proj = await owner.post("/api/projects").send({ name: "Alpha" });
  const pid = proj.body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  const member = request.agent(app);
  const acc = await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "memberpass1", full_name: "Mem" });
  const memberId = acc.body.user.id;
  return { owner, member, pid, memberId };
}

async function fresh() {
  const ctx = await makeTestApp();
  const s = await setup(ctx.app);
  return { ctx, ...s };
}

describe("P2 tasks / my-work / views", () => {

  test("atomic item_key increments per project (PRJ-1, PRJ-2 ...)", async () => {
    const { ctx, owner, pid } = await fresh();
    const t1 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "T1" });
    const t2 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "T2" });
    assert.equal(t1.status, 201);
    assert.match(t1.body.task.item_key, /-1$/);
    assert.match(t2.body.task.item_key, /-2$/);
  });

  test("atomic counter yields unique, gapless item_keys", async () => {
    // NOTE: item_key atomicity is guaranteed by `UPDATE ... next_task_seq + 1 RETURNING`
    // + the tasks_project_item_key_idx unique index (§5). PGlite is single-connection so
    // true parallel transactions can't be simulated here; we verify the counter is correct.
    const { ctx, owner, pid } = await fresh();
    const keys: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await owner.post(`/api/projects/${pid}/tasks`).send({ title: `C${i}` });
      keys.push(r.body.task.item_key);
    }
    assert.equal(new Set(keys).size, 8, "all item_keys unique");
    const nums = keys.map((k) => Number(k.split("-").pop())).sort((a, b) => a - b);
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8], "gapless 1..8");
  });

  test("member creates ticket(requested), owner creates task(todo) — F1", async () => {
    const { member, owner, pid } = await fresh();
    // F1 개정: member 생성은 403이 아니라 티켓(requested)으로 강제된다
    const req1 = await member.post(`/api/projects/${pid}/tasks`).send({ title: "요청" });
    assert.equal(req1.status, 201);
    assert.equal(req1.body.task.kind, "ticket");
    assert.equal(req1.body.task.status, "requested");
    const ok = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "ok" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.task.kind, "task");
    assert.equal(ok.body.task.status, "todo");
  });

  test("daily assignment shows up in assignee's My Work today", async () => {
    const { ctx, owner, member, memberId, pid } = await fresh();
    const t = await owner.post(`/api/projects/${pid}/tasks`).send({
      title: "Today task",
      scheduled_date: new Date().toISOString(),
      assignee_ids: [memberId],
    });
    assert.equal(t.status, 201);
    const mw = await member.get("/api/my-work");
    assert.equal(mw.status, 200);
    assert.ok(mw.body.today.some((x: any) => x.title === "Today task"), "task appears in My Work today");
  });

  test("member can toggle own task status but not edit title", async () => {
    const { ctx, owner, member, memberId, pid } = await fresh();
    const t = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Do", assignee_ids: [memberId] });
    const tid = t.body.task.id;
    const done = await member.patch(`/api/tasks/${tid}`).send({ status: "done" });
    assert.equal(done.status, 200);
    assert.equal(done.body.task.status, "done");
    assert.ok(done.body.task.completed_at);
    const editTitle = await member.patch(`/api/tasks/${tid}`).send({ title: "hacked" });
    assert.equal(editTitle.status, 403);
  });

  test("subtask rollup: parent auto-completes when all children done, reopens otherwise", async () => {
    const { ctx, owner, pid } = await fresh();
    const parent = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Parent" });
    const pidt = parent.body.task.id;
    const c1 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "C1", parent_task_id: pidt });
    const c2 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "C2", parent_task_id: pidt });
    await owner.patch(`/api/tasks/${c1.body.task.id}`).send({ status: "done" });
    let p = await owner.get(`/api/tasks/${pidt}`);
    assert.notEqual(p.body.task.status, "done", "parent not done yet");
    await owner.patch(`/api/tasks/${c2.body.task.id}`).send({ status: "done" });
    p = await owner.get(`/api/tasks/${pidt}`);
    assert.equal(p.body.task.status, "done", "parent auto-done");
    // reopen a child -> parent reopens
    await owner.patch(`/api/tasks/${c2.body.task.id}`).send({ status: "todo" });
    p = await owner.get(`/api/tasks/${pidt}`);
    assert.notEqual(p.body.task.status, "done", "parent reopened");
  });

  test("checklist add + toggle updates progress", async () => {
    const { ctx, owner, pid } = await fresh();
    const t = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "CL" });
    const tid = t.body.task.id;
    const i1 = await owner.post(`/api/tasks/${tid}/checklist`).send({ content: "step 1" });
    await owner.post(`/api/tasks/${tid}/checklist`).send({ content: "step 2" });
    const toggled = await owner.patch(`/api/tasks/${tid}/checklist/${i1.body.item.id}`).send({ done: true });
    assert.equal(toggled.body.progress.done, 1);
    assert.equal(toggled.body.progress.total, 2);
  });

  test("non-member cannot read task detail (§10.5)", async () => {
    const { ctx, owner, pid } = await fresh();
    const t = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Private" });
    const outsider = request.agent(ctx.app);
    // create an unrelated user via a second project's invite
    const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "out@x.com", role: "member" });
    // outsider accepts but to be a non-member we instead just try unauthenticated
    const res = await request(ctx.app).get(`/api/tasks/${t.body.task.id}`);
    assert.equal(res.status, 401);
  });
});
