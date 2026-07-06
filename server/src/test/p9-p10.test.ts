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

  /* ---------- R2-R: list_project_tasks / update_task_status / get_task_comments ---------- */
  const call = (id: number, name: string, argsObj: any, tok = token) =>
    request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${tok}`)
      .send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argsObj } });
  const parse = (resp: any) => JSON.parse(resp.body.result.content[0].text);

  // 멤버 bob 합류 + 태스크에 배정
  const inv2 = await owner.post(`/api/projects/${pid}/invites`).send({ email: "bob@x.com", role: "member" });
  const bob = request.agent(ctx.app);
  await bob.post("/api/auth/accept-invite").send({ token: inv2.body.token, password: "password123", full_name: "밥" });
  await bob.post("/api/auth/login").send({ email: "bob@x.com", password: "password123" });
  const bobId = (await bob.get("/api/auth/me")).body.user.id;
  await owner.post(`/api/tasks/${created.task.id}/assignees`).send({ user_id: bobId });
  const bobTok = (await bob.post("/api/tokens").send({ name: "bob", scopes: ["task:read", "task:write"] })).body.token;

  // list_project_tasks: 태스크+담당자 표시, status 필터, 비멤버(외부인) 차단
  r = await call(10, "list_project_tasks", { project_id: pid });
  const listed = parse(r);
  const row = listed.tasks.find((t: any) => t.id === created.task.id);
  assert.ok(row, "프로젝트 태스크 목록에 포함");
  assert.ok(row.assignees.some((a: any) => a.id === bobId), "담당자(밥) 표시");
  r = await call(11, "list_project_tasks", { project_id: pid, status: "done" });
  assert.equal(parse(r).tasks.length, 0, "done 필터 → 0건");
  const outTok = (await outsider.post("/api/tokens").send({ name: "out", scopes: ["task:read"] })).body.token;
  r = await call(12, "list_project_tasks", { project_id: pid }, outTok);
  assert.ok(r.body.error, "비멤버 목록 차단");

  // update_task_status: 담당자 본인(밥) 변경 허용 → in_progress
  r = await call(13, "update_task_status", { task_id: created.task.id, status: "in_progress" }, bobTok);
  assert.equal(parse(r).task.status, "in_progress", JSON.stringify(r.body));
  // 잘못된 상태값(review) 거부
  r = await call(14, "update_task_status", { task_id: created.task.id, status: "review" });
  assert.ok(r.body.error, "존재하지 않는 상태값 거부");
  // 미배정 멤버는 거부: 새 태스크(무배정) → 밥이 상태 변경 시도
  const t2 = parse(await call(15, "create_task", { project_id: pid, title: "무배정" }));
  r = await call(16, "update_task_status", { task_id: t2.task.id, status: "done" }, bobTok);
  assert.ok(r.body.error, "미배정 멤버 상태 변경 차단");
  // 매니저는 가능 + done 시 completed_at 세팅 확인(REST 상세로 검증)
  r = await call(17, "update_task_status", { task_id: t2.task.id, status: "done" });
  assert.equal(parse(r).ok, true);
  r = await owner.get(`/api/tasks/${t2.task.id}`);
  assert.ok(r.body.task.completed_at, "done → completed_at 세팅");
  // requested 티켓은 MCP로 상태 변경 불가(승인/반려 전용)
  const ticket = (await bob.post(`/api/projects/${pid}/tasks`).send({ title: "티켓 요청" })).body.task;
  assert.equal(ticket.status, "requested");
  r = await call(18, "update_task_status", { task_id: ticket.id, status: "todo" });
  assert.ok(r.body.error, "requested 전이 차단(승인/반려 API 전용)");

  // get_task_comments: 가이드 등록(add_guide) → 밥 수행완료 → 상태 포함 조회, body_html 미포함
  const g = parse(await call(19, "add_guide", { task_id: created.task.id, body: "**가이드**: 리뷰 반영하기" }));
  r = await request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${bobTok}`)
    .send({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "mark_guide_done", arguments: { comment_id: g.comment_id, state: "applied" } } });
  // bob 토큰엔 guide:write가 없어 스코프 에러 → 세션 REST로 수행 표시
  assert.ok(r.body.error, "guide:write 없는 토큰 거부");
  await bob.patch(`/api/comments/${g.comment_id}/guide`).send({ state: "applied" });
  r = await call(21, "get_task_comments", { task_id: created.task.id });
  const cmts = parse(r).comments;
  const guide = cmts.find((c: any) => c.id === g.comment_id);
  assert.ok(guide?.is_guide, "가이드 댓글 포함");
  assert.equal(guide.guide_assignees.find((a: any) => a.user.id === bobId)?.state, "applied", "담당자 수행 상태 반영");
  assert.equal(guide.body_html, undefined, "body_html 미포함(토큰 절약)");
  assert.equal(guide.guide_progress.applied, 1);

  /* ---------- R2-R: list_project_members / assign_task / create_page / list_pages ---------- */
  // 팀원 목록: 이름→user_id 매핑용
  r = await call(30, "list_project_members", { project_id: pid });
  const members = parse(r).members;
  assert.ok(members.some((m: any) => m.user_id === bobId && m.role === "member"), "밥 포함");
  assert.ok(members.some((m: any) => m.role === "owner"), "소유자 포함");

  // 담당자 배정: 매니저(owner) 가능, member(밥)는 거부
  const t3 = parse(await call(31, "create_task", { project_id: pid, title: "배정 대상" }));
  r = await call(32, "assign_task", { task_id: t3.task.id, user_id: bobId });
  assert.ok(parse(r).assignees.some((a: any) => a.id === bobId), "MCP 배정 성공");
  r = await call(33, "assign_task", { task_id: t3.task.id, user_id: bobId }, bobTok);
  assert.ok(r.body.error, "member 배정 거부");

  // 문서 생성(부모-자식) + 목록 + 분해 규격 확인 (## 섹션 → REST decompose로 태스크 제안)
  const root = parse(await call(34, "create_page", { project_id: pid, title: "설계 개요", content: "# 개요\n\n설명." }));
  const child = parse(await call(35, "create_page", {
    project_id: pid, title: "앱 작업", parent_id: root.page.id,
    content: "## 로그인 실연동\n\n- SDK 연동\n- 세션 유지\n\n## 업로드 연동\n\n- 진행률 표시\n",
  }));
  assert.equal(child.page.parent_id, root.page.id, "부모-자식 트리");
  r = await call(36, "list_pages", { project_id: pid });
  assert.ok(parse(r).pages.some((p: any) => p.id === child.page.id), "문서 목록 포함");
  r = await owner.post(`/api/projects/${pid}/pages/${child.page.id}/decompose`).send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks.length, 2, "## 2개 → 태스크 2개 제안");
  assert.deepEqual(r.body.tasks[0].checklist, ["SDK 연동", "세션 유지"], "불릿 → 체크리스트");
  // 존재하지 않는 부모 거부
  r = await call(37, "create_page", { project_id: pid, title: "고아", parent_id: 99999 });
  assert.ok(r.body.error, "타 프로젝트/없는 부모 거부");

  /* ---------- R3: create_event / list_events (일정은 태스크가 아니라 이벤트로) ---------- */
  // 프로젝트 일정(시간 지정) — 팀 전체 공개
  const ev1 = parse(await call(40, "create_event", {
    title: "주간 회의", starts_at: "2026-07-14T10:00:00+09:00", ends_at: "2026-07-14T11:00:00+09:00", project_id: pid,
  }));
  assert.equal(ev1.event.project_id, pid, "프로젝트 일정 생성");
  // 개인 종일 일정 — project_id 생략
  const ev2 = parse(await call(41, "create_event", { title: "개인 종일", starts_at: "2026-07-15T00:00:00.000Z", all_day: true }));
  assert.equal(ev2.event.project_id, null, "개인 일정");
  assert.equal(ev2.event.all_day, true, "종일 플래그");
  // 종료 < 시작 거부
  r = await call(42, "create_event", { title: "역순", starts_at: "2026-07-14T10:00:00+09:00", ends_at: "2026-07-14T09:00:00+09:00" });
  assert.ok(r.body.error, "종료<시작 거부");
  // 비멤버 프로젝트 일정 거부 (밥은 p2 멤버 아님)
  r = await call(43, "create_event", { title: "남의 프로젝트", starts_at: "2026-07-14T10:00:00Z", project_id: p2.id }, bobTok);
  assert.ok(r.body.error, "비멤버 프로젝트 일정 거부");
  // list_events: 프로젝트 + 개인 일정 모두 조회
  const evs = parse(await call(44, "list_events", { from: "2026-07-13", to: "2026-07-16" }));
  assert.ok(evs.events.some((e: any) => e.id === ev1.event.id), "프로젝트 일정 포함");
  assert.ok(evs.events.some((e: any) => e.id === ev2.event.id), "개인 일정 포함");
  // project_id 필터 시 개인 일정 제외
  const evsP = parse(await call(45, "list_events", { from: "2026-07-13", to: "2026-07-16", project_id: pid }));
  assert.ok(evsP.events.some((e: any) => e.id === ev1.event.id), "필터: 프로젝트 일정 포함");
  assert.ok(!evsP.events.some((e: any) => e.id === ev2.event.id), "필터: 개인 일정 제외");
  // REST 캘린더(GET /api/events)에서도 동일하게 보임 — 웹 화면 일치 검증
  r = await owner.get("/api/events?from=2026-07-13&to=2026-07-16");
  assert.ok(r.body.events.some((e: any) => e.id === ev1.event.id), "REST 캘린더 표시");
  // 날짜 형식 검증
  r = await call(46, "list_events", { from: "2026-7-1", to: "2026-07-16" });
  assert.ok(r.body.error, "from/to 형식 검증");
});
