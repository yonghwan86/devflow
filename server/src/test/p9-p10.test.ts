// P9: 스니펫 CRUD/크기 제한/권한 · P10: MCP JSON-RPC + 토큰 스코프
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("P9 snippets + P10 MCP", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "P9" })).body.project.id;

  /* ---------- P9 ---------- */
  let r = await owner.post("/api/snippets").send({
    project_id: pid,
    title: "버튼 데모",
    files: [
      { name: "index.html", content: "<button id=b>클릭</button><script src=\"app.js\"></script>" },
      { name: "app.js", content: "document.getElementById('b').onclick=()=>alert('hi')" },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sid = r.body.snippet.id;

  // 크기 제한 (200KB 초과 거부)
  r = await owner.post("/api/snippets").send({
    project_id: pid, title: "big", files: [{ name: "a.js", content: "x".repeat(210 * 1024) }],
  });
  assert.equal(r.status, 400, "크기 제한");

  // 수정 + 목록
  r = await owner.patch(`/api/snippets/${sid}`).send({ title: "버튼 데모 v2" });
  assert.equal(r.body.snippet.title, "버튼 데모 v2");
  r = await owner.get(`/api/snippets?project_id=${pid}`);
  assert.equal(r.body.snippets.length, 1);

  // 비멤버 접근 차단
  const outsider = request.agent(ctx.app);
  const p2 = (await owner.post("/api/projects").send({ name: "타" })).body.project;
  const inv = await owner.post(`/api/projects/${p2.id}/invites`).send({ email: "s@x.com", role: "member" });
  await outsider.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "외부" });
  await outsider.post("/api/auth/login").send({ email: "s@x.com", password: "password123" });
  r = await outsider.get(`/api/snippets?project_id=${pid}`);
  assert.equal(r.status, 404, "비멤버 차단");

  /* ---------- P10 MCP ---------- */
  // 토큰 발급 (스코프 제한)
  const issued = await owner.post("/api/tokens").send({ name: "mcp", scopes: ["task:read", "task:write", "guide:write", "project:read"] });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const token = issued.body.token;
  const mcp = (msg: any) => request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${token}`).send(msg);

  // 무인증 거부
  r = await request(ctx.app).post("/api/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(r.status, 401);

  // initialize / tools/list
  r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(r.body.result.serverInfo.name, "devflow-mcp");
  r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.body.result.tools.map((x: any) => x.name);
  for (const n of ["list_my_tasks", "get_task", "create_task", "add_guide", "mark_guide_done", "devflow_search"]) {
    assert.ok(names.includes(n), n);
  }

  // create_task 도구 (스코프 있음)
  r = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_task", arguments: { project_id: pid, title: "MCP로 만든 태스크" } } });
  assert.equal(r.body.result.isError, false, JSON.stringify(r.body));
  const created = JSON.parse(r.body.result.content[0].text);
  assert.ok(created.task.item_key);

  // get_task
  r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_task", arguments: { item_key: created.task.item_key } } });
  const detail = JSON.parse(r.body.result.content[0].text);
  assert.equal(detail.task.title, "MCP로 만든 태스크");

  // 스코프 거부: comment:write 없는 토큰이라 add_guide는 guide:write로 통과하지만, devflow_search 후 skill:read 불필요 —
  // 스코프 부족 케이스: project:read 없는 토큰으로 검색 시도
  const limited = await owner.post("/api/tokens").send({ name: "limited", scopes: ["task:read"] });
  r = await request(ctx.app)
    .post("/api/mcp")
    .set("Authorization", `Bearer ${limited.body.token}`)
    .send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "devflow_search", arguments: { q: "테스트" } } });
  assert.ok(r.body.error, "스코프 부족 → JSON-RPC 에러: " + JSON.stringify(r.body));
});
