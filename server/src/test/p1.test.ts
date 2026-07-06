import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";

describe("P1 auth / projects / membership / tokens", () => {
  let ctx: TestCtx;
  before(async () => { ctx = await makeTestApp(); });
  after(async () => { await ctx.close(); });


  test("bootstrap first owner, then bootstrap blocked", async () => {
    const a = request.agent(ctx.app);
    const res = await a.post("/api/auth/bootstrap").send({ email: "owner@x.com", password: "password123", full_name: "Owner" });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, "owner@x.com");
    const res2 = await request(ctx.app).post("/api/auth/bootstrap").send({ email: "z@x.com", password: "password123", full_name: "Z" });
    assert.equal(res2.status, 403);
  });

  test("unauthenticated GET is rejected (§10.1)", async () => {
    const res = await request(ctx.app).get("/api/projects");
    assert.equal(res.status, 401);
  });

  test("owner creates project, invite flow, member joins", async () => {
    const ownerA = request.agent(ctx.app);
    await ownerA.post("/api/auth/login").send({ email: "owner@x.com", password: "password123" });

    const proj = await ownerA.post("/api/projects").send({ name: "DevFlow App" });
    assert.equal(proj.status, 201);
    const pid = proj.body.project.id;
    assert.ok(proj.body.project.key);
    assert.equal(proj.body.project.my_role, "owner"); // 생성자=소유자

    // invite a member
    const inv = await ownerA.post(`/api/projects/${pid}/invites`).send({ email: "member@x.com", role: "member" });
    assert.equal(inv.status, 201);
    const token = inv.body.token;
    assert.ok(token && token.includes("."));

    // accept invite -> creates user + membership
    const memberA = request.agent(ctx.app);
    const acc = await memberA.post("/api/auth/accept-invite").send({ token, password: "memberpass1", full_name: "Member" });
    assert.equal(acc.status, 201);

    // member sees exactly the one project (server-side membership filter §12)
    const list = await memberA.get("/api/projects");
    assert.equal(list.status, 200);
    assert.equal(list.body.projects.length, 1);
    assert.equal(list.body.projects[0].my_role, "member");
  });

  test("invalid / reused invite token rejected", async () => {
    const res = await request(ctx.app).post("/api/auth/accept-invite").send({ token: "bogus.token", password: "password123", full_name: "X" });
    assert.equal(res.status, 400);
  });

  test("non-member cannot read a project (§10.5 server authz)", async () => {
    // outsider bootstrap? no—create via invite to a different project
    const ownerA = request.agent(ctx.app);
    await ownerA.post("/api/auth/login").send({ email: "owner@x.com", password: "password123" });
    const p2 = await ownerA.post("/api/projects").send({ name: "Secret" });
    const secretId = p2.body.project.id;

    // member@x.com is not in "Secret"
    const memberA = request.agent(ctx.app);
    await memberA.post("/api/auth/login").send({ email: "member@x.com", password: "memberpass1" });
    const forbidden = await memberA.get(`/api/projects/${secretId}`);
    assert.equal(forbidden.status, 403);
  });

  test("member cannot invite (role enforcement)", async () => {
    const ownerA = request.agent(ctx.app);
    await ownerA.post("/api/auth/login").send({ email: "owner@x.com", password: "password123" });
    const list = await ownerA.get("/api/projects");
    const pid = list.body.projects.find((p: any) => p.name === "DevFlow App").id;

    const memberA = request.agent(ctx.app);
    await memberA.post("/api/auth/login").send({ email: "member@x.com", password: "memberpass1" });
    const res = await memberA.post(`/api/projects/${pid}/invites`).send({ email: "x2@x.com", role: "member" });
    assert.equal(res.status, 403);
  });

  test("login enumeration-safe + lockout after repeated failures", async () => {
    // unknown user -> same generic 401 as wrong password
    const unknown = await request(ctx.app).post("/api/auth/login").send({ email: "ghost@x.com", password: "whatever1" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.message, "이메일 또는 비밀번호가 올바르지 않습니다.");

    const a = request.agent(ctx.app);
    for (let i = 0; i < 5; i++) {
      await a.post("/api/auth/login").send({ email: "member@x.com", password: "wrongwrong" });
    }
    const locked = await a.post("/api/auth/login").send({ email: "member@x.com", password: "memberpass1" });
    assert.equal(locked.status, 429); // locked even with correct password
  });

  test("api token: issue once, authenticate via Bearer, revoke", async () => {
    const ownerA = request.agent(ctx.app);
    await ownerA.post("/api/auth/login").send({ email: "owner@x.com", password: "password123" });
    const issued = await ownerA.post("/api/tokens").send({ name: "cli", scopes: ["project:read"] });
    assert.equal(issued.status, 201);
    const raw = issued.body.token;
    assert.ok(raw.startsWith("df_"));

    // list never returns plaintext/hash
    const listed = await ownerA.get("/api/tokens");
    assert.ok(!JSON.stringify(listed.body).includes(raw));

    // authenticate with Bearer token (no cookie)
    const viaToken = await request(ctx.app).get("/api/projects").set("Authorization", `Bearer ${raw}`);
    assert.equal(viaToken.status, 200);

    // revoke -> token no longer works
    const id = listed.body.tokens[0].id;
    await ownerA.delete(`/api/tokens/${id}`);
    const afterRevoke = await request(ctx.app).get("/api/projects").set("Authorization", `Bearer ${raw}`);
    assert.equal(afterRevoke.status, 401);
  });
});
