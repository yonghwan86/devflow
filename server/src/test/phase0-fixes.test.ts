// Phase 0 회귀 방지: 감사에서 확인된 버그·보안 픽스 검증
// [2] 첨부 comment_id 교차 프로젝트 주입, [3] parent_task_id 무검증(크로스 프로젝트·순환),
// [10] 웹훅 자동완료가 requested/rejected 티켓을 우회 완료하지 않음.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("[2] 첨부: 다른 프로젝트 comment_id에 교차 주입 차단", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const a = request.agent(ctx.app);
  const b = request.agent(ctx.app);

  await a.post("/api/auth/bootstrap").send({ email: "a@x.com", password: "password123", full_name: "A" });
  await a.post("/api/auth/login").send({ email: "a@x.com", password: "password123" });
  const pa = (await a.post("/api/projects").send({ name: "PA" })).body.project;
  const ta = (await a.post(`/api/projects/${pa.id}/tasks`).send({ title: "A 태스크" })).body.task;

  // B는 공개 가입으로 독립 계정 → 자기 프로젝트 PB 생성 (A는 PB 멤버가 아님)
  await b.post("/api/auth/signup").send({ email: "b@x.com", password: "password123", full_name: "B" });
  await b.post("/api/auth/login").send({ email: "b@x.com", password: "password123" });
  const pb = (await b.post("/api/projects").send({ name: "PB" })).body.project;
  const tb = (await b.post(`/api/projects/${pb.id}/tasks`).send({ title: "B 태스크" })).body.task;
  const cb = (await b.post("/api/comments").send({ task_id: tb.id, body: "B 댓글" })).body.comment;

  // A는 PB의 멤버가 아니다. 자기 태스크(ta) + PB의 comment_id(cb)를 함께 보내 교차 주입 시도.
  const r = await a
    .post("/api/attachments")
    .field("task_id", String(ta.id))
    .field("comment_id", String(cb.id))
    .attach("file", PNG, "x.png");
  assert.equal(r.status, 403, "comment_id가 권위값 → PB 멤버 아님 403: " + JSON.stringify(r.body));

  // 대조군: B가 자기 댓글에 첨부 → 201
  const ok = await b
    .post("/api/attachments")
    .field("comment_id", String(cb.id))
    .attach("file", PNG, "ok.png");
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("[3] parent_task_id: 크로스 프로젝트·순환 방지", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const a = request.agent(ctx.app);
  await a.post("/api/auth/bootstrap").send({ email: "a@x.com", password: "password123", full_name: "A" });
  await a.post("/api/auth/login").send({ email: "a@x.com", password: "password123" });

  const p1 = (await a.post("/api/projects").send({ name: "P1" })).body.project;
  const p2 = (await a.post("/api/projects").send({ name: "P2" })).body.project;
  const t1 = (await a.post(`/api/projects/${p1.id}/tasks`).send({ title: "P1-A" })).body.task;
  const t2 = (await a.post(`/api/projects/${p1.id}/tasks`).send({ title: "P1-B" })).body.task;
  const tOther = (await a.post(`/api/projects/${p2.id}/tasks`).send({ title: "P2-X" })).body.task;

  // 크로스 프로젝트 부모 지정 (PATCH) → 400
  let r = await a.patch(`/api/tasks/${t1.id}`).send({ parent_task_id: tOther.id });
  assert.equal(r.status, 400, "다른 프로젝트 태스크를 부모로 금지");

  // 생성 시 크로스 프로젝트 부모 → 400
  r = await a.post(`/api/projects/${p1.id}/tasks`).send({ title: "child", parent_task_id: tOther.id });
  assert.equal(r.status, 400, "생성 시에도 크로스 프로젝트 부모 금지");

  // 정상: t1의 부모 = t2
  r = await a.patch(`/api/tasks/${t1.id}`).send({ parent_task_id: t2.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 순환: t2의 부모 = t1 → 400
  r = await a.patch(`/api/tasks/${t2.id}`).send({ parent_task_id: t1.id });
  assert.equal(r.status, 400, "순환 참조 금지");
  // 자기참조 → 400
  r = await a.patch(`/api/tasks/${t2.id}`).send({ parent_task_id: t2.id });
  assert.equal(r.status, 400, "자기참조 금지");
});

test("[10] 웹훅 자동완료가 requested 티켓을 우회 완료하지 않음", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const SECRET = "test-webhook-secret";
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const manager = request.agent(ctx.app);
  const member = request.agent(ctx.app);

  await manager.post("/api/auth/bootstrap").send({ email: "m@x.com", password: "password123", full_name: "매니저" });
  await manager.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });
  const proj = (await manager.post("/api/projects").send({ name: "TK" })).body.project;
  const pid = proj.id;
  await manager.patch(`/api/projects/${pid}`).send({ github_repo: "acme/tk", auto_complete_on_pr_merge: true });
  const inv = await manager.post(`/api/projects/${pid}/invites`).send({ email: "u@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await member.post("/api/auth/login").send({ email: "u@x.com", password: "password123" });

  // member가 티켓 요청 (status=requested)
  const ticket = (await member.post(`/api/projects/${pid}/tasks`).send({ title: "요청 티켓" })).body.task;
  assert.equal(ticket.status, "requested");
  const key = ticket.item_key;

  const REPO = { full_name: "acme/tk", html_url: "https://github.com/acme/tk" };
  const body = JSON.stringify({
    action: "closed",
    repository: REPO,
    pull_request: { number: 1, title: `${key} PR`, body: "", html_url: "", merged: true, state: "merged", head: { ref: "x" } },
  });
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const r = await request(ctx.app)
    .post("/api/webhooks/github")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", sig)
    .set("X-GitHub-Event", "pull_request")
    .set("X-GitHub-Delivery", randomUUID())
    .send(body);
  assert.equal(r.body.completed, 0, "requested 티켓은 PR 머지로 자동완료되지 않음");
  const after = (await manager.get(`/api/projects/${pid}/tasks/by-key/${key}`)).body.task;
  assert.equal(after.status, "requested", "상태 유지 (승인 API로만 전이)");
});
