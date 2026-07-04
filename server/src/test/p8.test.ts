// P8: GitHub 웹훅 — 서명 검증, 멱등, item_key 파싱, PR머지 가드레일 자동완료
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

const SECRET = "test-webhook-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;

function signed(app: any, event: string, payload: unknown, opts: { badSig?: boolean; deliveryId?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", opts.badSig ? "wrong" : SECRET).update(body).digest("hex");
  return request(app)
    .post("/api/webhooks/github")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", sig)
    .set("X-GitHub-Event", event)
    .set("X-GitHub-Delivery", opts.deliveryId ?? randomUUID())
    .send(body);
}

test("P8 GitHub webhook", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const proj = (await owner.post("/api/projects").send({ name: "P8" })).body.project;
  const pid = proj.id;
  // ★ 저장소 → 프로젝트 바인딩 (C-1): github_repo가 일치하는 프로젝트만 웹훅 처리
  await owner.patch(`/api/projects/${pid}`).send({ github_repo: "acme/repo" });
  const task = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "결제 버그 수정" })).body.task;
  const key = task.item_key; // 예: P8-1
  const REPO = { full_name: "acme/repo", html_url: "https://github.com/acme/repo" };

  // 서명 불량 → 401
  let r = await signed(ctx.app, "push", { ref: "refs/heads/x", commits: [] }, { badSig: true });
  assert.equal(r.status, 401);

  // push: 커밋 메시지·브랜치에서 item_key 파싱 → 링크 생성
  r = await signed(ctx.app, "push", {
    ref: `refs/heads/feature/${key}-fix`,
    repository: REPO,
    commits: [{ id: "abc123", message: `${key} 결제 재시도 수정`, url: "https://github.com/acme/repo/commit/abc123" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.linked >= 2, "commit+branch 링크: " + JSON.stringify(r.body));

  // ★ 바인딩 안 된 저장소의 이벤트는 무시 (크로스 프로젝트 차단)
  r = await signed(ctx.app, "push", {
    ref: "refs/heads/main",
    repository: { full_name: "evil/other-repo", html_url: "https://github.com/evil/other-repo" },
    commits: [{ id: "bad999", message: `${key} 탈취 시도`, url: "" }],
  });
  assert.equal(r.body.linked, 0, "미등록 저장소 무시: " + JSON.stringify(r.body));

  // 멱등: 같은 delivery_id 재전송 → duplicate
  const did = randomUUID();
  const payload = { ref: "refs/heads/main", repository: REPO, commits: [{ id: "def456", message: `${key} 두번째`, url: "" }] };
  r = await signed(ctx.app, "push", payload, { deliveryId: did });
  assert.equal(r.body.duplicate, undefined);
  r = await signed(ctx.app, "push", payload, { deliveryId: did });
  assert.equal(r.body.duplicate, true, "replay 방지");

  // 태스크 상세에 github_links 노출
  r = await owner.get(`/api/projects/${pid}/tasks/by-key/${key}`);
  assert.ok(r.body.github_links.length >= 2, JSON.stringify(r.body.github_links));

  // PR merged — 플래그 꺼짐 → 완료 안 됨
  r = await signed(ctx.app, "pull_request", {
    action: "closed",
    repository: REPO,
    pull_request: { number: 7, title: `${key} 수정 PR`, body: "", html_url: "", merged: true, state: "closed", head: { ref: "feature/x" } },
  });
  assert.equal(r.body.completed, 0, "가드레일: 플래그 off");

  // 플래그 켜고 + 체크리스트 미완료 → 여전히 완료 안 됨
  await owner.patch(`/api/projects/${pid}`).send({ auto_complete_on_pr_merge: true, require_checklist_done_before_auto_complete: true });
  const item = (await owner.post(`/api/tasks/${task.id}/checklist`).send({ content: "테스트 통과" })).body.item;
  r = await signed(ctx.app, "pull_request", {
    action: "closed",
    repository: REPO,
    pull_request: { number: 8, title: `${key} 수정 PR2`, body: "", html_url: "", merged: true, state: "closed", head: { ref: "y" } },
  });
  assert.equal(r.body.completed, 0, "체크리스트 미완료 가드레일");

  // 체크리스트 완료 후 merged → 자동 완료 + activity 기록
  await owner.patch(`/api/tasks/${task.id}/checklist/${item.id}`).send({ done: true });
  r = await signed(ctx.app, "pull_request", {
    action: "closed",
    repository: REPO,
    pull_request: { number: 9, title: `${key} 최종 PR`, body: "", html_url: "", merged: true, state: "merged", head: { ref: "z" } },
  });
  assert.equal(r.body.completed, 1, JSON.stringify(r.body));
  r = await owner.get(`/api/projects/${pid}/tasks/by-key/${key}`);
  assert.equal(r.body.task.status, "done", "PR merge 자동 완료");
});
