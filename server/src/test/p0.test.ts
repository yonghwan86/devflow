import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp, type TestCtx } from "./harness.ts";
import { db } from "../lib/db.ts";
import { sql } from "drizzle-orm";

describe("P0 scaffold", () => {
  let ctx: TestCtx;
  before(async () => { ctx = await makeTestApp(); });
  after(async () => { await ctx.close(); });

  test("health check responds ok", async () => {
    const res = await request(ctx.app).get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test("pgvector extension enabled + all core tables exist", async () => {
    const ext = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname='vector'`);
    assert.ok((ext.rows as any[]).length === 1, "vector extension present");
    const tbls = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const names = (tbls.rows as any[]).map((r) => r.table_name);
    for (const t of ["users","projects","project_members","tasks","comments","guide_assignees","skills","activity_log"]) {
      assert.ok(names.includes(t), `table ${t} exists`);
    }
  });

  test("unknown api route returns structured 404", async () => {
    const res = await request(ctx.app).get("/api/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "not_found");
  });
});
