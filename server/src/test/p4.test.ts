import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import sharp from "sharp";
import { makeTestApp } from "./harness.ts";
import { setStorageForTest, LocalStorage } from "../lib/storage.ts";
import { runDailyDigest } from "../jobs/notifications.ts";

async function scenario() {
  const ctx = await makeTestApp();
  setStorageForTest(new LocalStorage(path.join(os.tmpdir(), `devflow-test-${Date.now()}-${Math.random()}`)));
  const app = ctx.app;
  const owner = request.agent(app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "Owner" });
  const proj = await owner.post("/api/projects").send({ name: "Gamma" });
  const pid = proj.body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  const member = request.agent(app);
  const acc = await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "memberpass1", full_name: "Mem" });
  const memberId = acc.body.user.id;
  const t = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "T", assignee_ids: [memberId], scheduled_date: new Date().toISOString() });
  return { app, owner, member, memberId, pid, taskId: t.body.task.id };
}

describe("P4 attachments / push", () => {
  test("valid PNG uploads + generates a thumbnail", async () => {
    const { owner, taskId } = await scenario();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const res = await owner.post("/api/attachments").field("task_id", String(taskId)).attach("file", png, { filename: "pic.png", contentType: "image/png" });
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.detected_type, "image/png");
    assert.ok(res.body.attachment.thumb_url, "thumbnail created");
  });

  test("mime-spoofed file is rejected by magic number (§10.6)", async () => {
    const { owner, taskId } = await scenario();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const res = await owner.post("/api/attachments").field("task_id", String(taskId)).attach("file", html, { filename: "evil.png", contentType: "image/png" });
    assert.equal(res.status, 400); // detected as non-allowed, not trusting client mime
  });

  test("download requires authorization; unauth is blocked; disposition is attachment", async () => {
    const { owner, taskId, app } = await scenario();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const up = await owner.post("/api/attachments").field("task_id", String(taskId)).attach("file", png, { filename: "a.png", contentType: "image/png" });
    const id = up.body.attachment.id;
    const anon = await request(app).get(`/api/attachments/${id}`);
    assert.equal(anon.status, 401);
    const ok = await owner.get(`/api/attachments/${id}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-disposition"], /attachment/);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
  });

  test("push subscribe works; vapid key endpoint is public", async () => {
    const { app, member } = await scenario();
    const sub = await member.post("/api/push/subscribe").send({ endpoint: "https://push.example.com/abc", keys: { p256dh: "k", auth: "a" } });
    assert.equal(sub.status, 201);
    const vapid = await request(app).get("/api/push/vapid-public-key");
    assert.equal(vapid.status, 200); // public, no auth required
  });

  test("daily digest is idempotent (§9): second run sends nothing", async () => {
    await scenario(); // sets up a task scheduled today + assignee
    const first = await runDailyDigest();
    assert.ok(first >= 1, "at least one user notified on first run");
    const second = await runDailyDigest();
    assert.equal(second, 0, "no double-send on second run");
  });
});
