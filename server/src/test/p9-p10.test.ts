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

  // 수정 게이트 = 삭제와 동일(작성자 또는 매니저) — 같은 프로젝트 member가 남의 스니펫 수정 403
  const peer = request.agent(ctx.app);
  const invPeer = await owner.post(`/api/projects/${pid}/invites`).send({ email: "peer@x.com", role: "member" });
  await peer.post("/api/auth/accept-invite").send({ token: invPeer.body.token, password: "password123", full_name: "동료" });
  await peer.post("/api/auth/login").send({ email: "peer@x.com", password: "password123" });
  r = await peer.patch(`/api/snippets/${sid}`).send({ title: "몰래 교체" });
  assert.equal(r.status, 403, "타인 스니펫 member 수정 차단");

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
  for (const n of ["list_my_tasks", "get_task", "create_task", "add_guide", "mark_guide_done", "devflow_search", "update_project_dates"]) {
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

  // create_task 기간 입력: due_date 수용 + 예정일 역전 거부 (REST와 동일 규칙 — 아래 REST 테스트와 쌍)
  const tDated = parse(await call(50, "create_task", { project_id: pid, title: "기간 태스크", scheduled_date: "2026-07-14", due_date: "2026-07-18" }));
  r = await owner.get(`/api/tasks/${tDated.task.id}`);
  assert.equal(String(r.body.task.scheduled_date).slice(0, 10), "2026-07-14", "MCP scheduled_date 저장");
  assert.equal(String(r.body.task.due_date).slice(0, 10), "2026-07-18", "MCP due_date 저장");
  r = await call(51, "create_task", { project_id: pid, title: "역전 기간", scheduled_date: "2026-07-18", due_date: "2026-07-14" });
  assert.ok(r.body.error, "MCP 마감일 < 예정일 거부");

  // T: update_project_dates — 설정 / 부분 갱신(기존값과 병합 검증) / 역전 거부 / member 권한 거부 / null 해제
  let pd = parse(await call(52, "update_project_dates", { project_id: pid, start_date: "2026-07-01", end_date: "2026-09-30" }));
  assert.equal(String(pd.project.start_date).slice(0, 10), "2026-07-01", "MCP 기간 설정");
  assert.equal(String(pd.project.end_date).slice(0, 10), "2026-09-30");
  pd = parse(await call(53, "update_project_dates", { project_id: pid, end_date: "2026-10-15" }));
  assert.equal(String(pd.project.start_date).slice(0, 10), "2026-07-01", "부분 갱신 시 시작일 유지");
  assert.equal(String(pd.project.end_date).slice(0, 10), "2026-10-15", "부분 갱신 반영");
  r = await call(54, "update_project_dates", { project_id: pid, end_date: "2026-06-01" });
  assert.ok(r.body.error, "MCP 종료<시작(기존 시작일과 병합) 거부");
  r = await call(55, "update_project_dates", { project_id: pid, start_date: "2026-08-01" }, bobTok);
  assert.ok(r.body.error, "member 기간 변경 차단 (owner/manager 전용)");
  pd = parse(await call(56, "update_project_dates", { project_id: pid, start_date: null, end_date: null }));
  assert.equal(pd.project.start_date, null, "null → 기간 해제");
  assert.equal(pd.project.end_date, null);
  // list_projects가 기간을 노출 (Claude가 현재 기간을 읽는 경로)
  const lp = parse(await call(57, "list_projects", {}));
  assert.ok(Object.prototype.hasOwnProperty.call(lp.projects.find((p: any) => p.id === pid) ?? {}, "start_date"), "list_projects에 기간 필드 포함");
  // 에러 경로: 없는 프로젝트 / 비정규 형식 / 롤오버 날짜 / 날짜 필드 전부 생략
  r = await call(58, "update_project_dates", { project_id: 99999, start_date: "2026-07-01" });
  assert.ok(r.body.error, "없는 프로젝트 거부");
  r = await call(59, "update_project_dates", { project_id: pid, start_date: "2026-7-1" });
  assert.ok(r.body.error, "비정규 형식(YYYY-MM-DD 아님) 거부 — 하루 밀림 저장 방지");
  r = await call(60, "update_project_dates", { project_id: pid, start_date: "2026-02-30" });
  assert.ok(r.body.error, "존재하지 않는 날짜(롤오버) 거부");
  r = await call(61, "update_project_dates", { project_id: pid });
  assert.ok(r.body.error, "날짜 필드 전부 생략 거부");
  // 한쪽만 해제 — start=null, end 유지
  parse(await call(62, "update_project_dates", { project_id: pid, start_date: "2026-07-01", end_date: "2026-09-30" }));
  pd = parse(await call(63, "update_project_dates", { project_id: pid, start_date: null }));
  assert.equal(pd.project.start_date, null, "한쪽만 해제 — start=null");
  assert.equal(String(pd.project.end_date).slice(0, 10), "2026-09-30", "해제 안 한 end는 유지");
  parse(await call(64, "update_project_dates", { project_id: pid, end_date: null }));

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

  /* ---------- R4: 일정·할일 감사 픽스 검증 ---------- */
  // done 재전송(칸반 같은 컬럼 재드롭·pill 재클릭)에 completed_at 미변경
  r = await owner.get(`/api/tasks/${t2.task.id}`);
  const doneAt = r.body.task.completed_at;
  assert.ok(doneAt, "선행: done 상태");
  r = await owner.patch(`/api/tasks/${t2.task.id}`).send({ status: "done" });
  assert.equal(r.status, 200, "no-op status는 200 (400 아님)");
  r = await owner.get(`/api/tasks/${t2.task.id}`);
  assert.equal(r.body.task.completed_at, doneAt, "done→done 재전송에 completed_at 보존");

  // 마감일 < 예정일 거부 — 생성·부분 PATCH(병합 상태 기준) 모두
  r = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "역순 날짜", scheduled_date: "2026-07-20T00:00:00.000Z", due_date: "2026-07-10T00:00:00.000Z" });
  assert.equal(r.status, 400, "생성: due<scheduled 거부");
  const okT = (await owner.post(`/api/projects/${pid}/tasks`).send({ title: "정순 날짜", scheduled_date: "2026-07-10T00:00:00.000Z", due_date: "2026-07-20T00:00:00.000Z" })).body.task;
  r = await owner.patch(`/api/tasks/${okT.id}`).send({ due_date: "2026-07-05T00:00:00.000Z" });
  assert.equal(r.status, 400, "PATCH: 병합 후 due<scheduled 거부");

  // T: 프로젝트 기간(start/end_date)도 같은 규칙 — POST(생성)·PATCH(부분 갱신 병합) 역전 거부
  r = await owner.post("/api/projects").send({ name: "역전기간", start_date: "2026-08-01T00:00:00.000Z", end_date: "2026-07-01T00:00:00.000Z" });
  assert.equal(r.status, 400, "프로젝트 생성: 종료<시작 거부");
  // POST null = 해제(미설정) — .nullable() 없으면 zod coerce가 1970-01-01로 오변환하는 회귀 방지
  r = await owner.post("/api/projects").send({ name: "널기간", start_date: null, end_date: "2026-09-30T00:00:00.000Z" });
  assert.equal(r.status, 201, "POST null 수용");
  assert.equal(r.body.project.start_date, null, "POST null → null 저장(1970 금지)");
  r = await owner.patch(`/api/projects/${pid}`).send({ start_date: "2026-07-01T00:00:00.000Z", end_date: "2026-09-30T00:00:00.000Z" });
  assert.equal(r.status, 200, "정상 기간 PATCH 허용");
  r = await owner.patch(`/api/projects/${pid}`).send({ end_date: "2026-06-01T00:00:00.000Z" });
  assert.equal(r.status, 400, "프로젝트 PATCH: 기존 시작일과 병합 후 역전 거부");
  r = await owner.patch(`/api/projects/${pid}`).send({ start_date: null, end_date: null });
  assert.equal(r.status, 200, "기간 해제(null) 허용");
  r = await owner.get(`/api/projects/${pid}`);
  assert.equal(r.body.project.start_date, null, "PATCH null → 저장값도 null(1970 금지)");
  assert.equal(r.body.project.end_date, null);

  // 종일 일정은 UTC 자정 규약 강제 (REST) — "+09:00 자정"은 하루 밀려 보이므로 거부
  r = await owner.post("/api/events").send({ title: "비정규 종일", starts_at: "2026-07-14T00:00:00+09:00", all_day: true });
  assert.equal(r.status, 400, "REST: all_day 비 UTC 자정 거부");

  // MCP create_event: 날짜만(YYYY-MM-DD) 입력 → UTC 자정 정규화 / all_day + 시각 입력은 거부
  const evD = parse(await call(50, "create_event", { title: "종일 데이", starts_at: "2026-07-20", all_day: true, project_id: pid }));
  assert.ok(String(evD.event.starts_at).startsWith("2026-07-20T00:00:00"), "date-only → UTC 자정 정규화");
  assert.equal(evD.event.all_day, true);
  r = await call(51, "create_event", { title: "밀림", starts_at: "2026-07-20T00:00:00+09:00", all_day: true });
  assert.ok(r.body.error, "MCP: all_day 비정규 시각 거부");

  /* ---------- C4: REST 스코프 게이트 — 제한 토큰이 REST 전체 접근하던 구멍 ---------- */
  const roIssued = await owner.post("/api/tokens").send({ name: "read-only", scopes: ["task:read"] });
  const roTok = roIssued.body.token;
  r = await request(ctx.app).get(`/api/tasks/${okT.id}`).set("Authorization", `Bearer ${roTok}`);
  assert.equal(r.status, 200, "read 스코프 → REST GET 허용");
  r = await request(ctx.app).patch(`/api/tasks/${okT.id}`).set("Authorization", `Bearer ${roTok}`).send({ title: "탈취 시도" });
  assert.equal(r.status, 403, "read 전용 토큰의 REST 쓰기 차단");
  r = await request(ctx.app).post(`/api/tasks/${okT.id}/assignees`).set("Authorization", `Bearer ${roTok}`).send({ user_id: bobId });
  assert.equal(r.status, 403, "read 전용 토큰의 담당자 배정 차단");

  /* ---------- C4: 티켓 승인 시 착수일 지정 ---------- */
  const ticket2 = (await bob.post(`/api/projects/${pid}/tasks`).send({ title: "날짜 있는 승인" })).body.task;
  r = await owner.post(`/api/tasks/${ticket2.id}/approve`).send({ assignee_ids: [bobId], scheduled_date: "2026-07-21T00:00:00.000Z" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await owner.get(`/api/tasks/${ticket2.id}`);
  assert.ok(String(r.body.task.scheduled_date).startsWith("2026-07-21"), "승인과 동시에 착수일 세팅");

  /* ---------- C5: 최종 회귀 검토 픽스 검증 ---------- */
  // 빈 스코프 토큰 발급 차단 (게이트에서 전부 403이 되는 무용 토큰 방지)
  r = await owner.post("/api/tokens").send({ name: "빈스코프", scopes: [] });
  assert.equal(r.status, 400, "scopes 최소 1개");
  // write→read 함의: task:write 토큰으로 GET 가능 (read-modify-write 흐름)
  const wIssued = await owner.post("/api/tokens").send({ name: "write-only", scopes: ["task:write"] });
  const wTok = wIssued.body.token;
  r = await request(ctx.app).get(`/api/tasks/${okT.id}`).set("Authorization", `Bearer ${wTok}`);
  assert.equal(r.status, 200, "write 스코프의 GET 허용");
  // 토큰으로 토큰 발급(자기 권한 상승) 차단 — 토큰 관리는 세션 전용
  r = await request(ctx.app).post("/api/tokens").set("Authorization", `Bearer ${wTok}`)
    .send({ name: "승격 시도", scopes: ["task:read", "task:write", "guide:write", "project:read"] });
  assert.equal(r.status, 403, "Bearer 토큰의 토큰 재발급 차단");
  // 승인 착수일 > 희망 마감일 → 400 (이후 모든 PATCH가 막히는 상태 방지)
  const dueTicket = (await bob.post(`/api/projects/${pid}/tasks`).send({ title: "마감 있는 티켓", due_date: "2026-07-15T00:00:00.000Z" })).body.task;
  r = await owner.post(`/api/tasks/${dueTicket.id}/approve`).send({ scheduled_date: "2026-07-20T00:00:00.000Z" });
  assert.equal(r.status, 400, "착수일>마감일 승인 거부");
  // MCP done→done 재호출에 completed_at 보존 (REST와 동일 불변식)
  r = await call(60, "update_task_status", { task_id: t2.task.id, status: "done" });
  assert.equal(parse(r).ok, true);
  r = await owner.get(`/api/tasks/${t2.task.id}`);
  assert.equal(r.body.task.completed_at, doneAt, "MCP done 재호출에도 completed_at 보존");
  // 종일 일정의 all_day:false 단독 토글 차단 (UTC 자정이 유령 시각으로 남는 것 방지)
  r = await owner.patch(`/api/events/${evD.event.id}`).send({ all_day: false });
  assert.equal(r.status, 400, "종일 해제는 starts_at 동반 필수");
  r = await owner.patch(`/api/events/${evD.event.id}`).send({ all_day: false, starts_at: "2026-07-20T10:00:00+09:00" });
  assert.equal(r.status, 200, "starts_at 동반 시 종일 해제 허용");
  // MCP create_event: 오프셋 없는 로컬 시각 거부 (서버 TZ 의존 방지)
  r = await call(61, "create_event", { title: "오프셋 없음", starts_at: "2026-07-22T10:00" });
  assert.ok(r.body.error, "오프셋 없는 시각 거부");

  /* ---------- C9: 참석자 규약 — attendee_ids(생성자 외) + include_creator ---------- */
  // 대리 등록: 생성자 불참, 참석자 = 밥만 → "밥의 일정"
  r = await owner.post("/api/events").send({ title: "밥 멘토링", starts_at: "2026-09-01T00:00:00.000Z", all_day: true, project_id: pid, attendee_ids: [bobId], include_creator: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const proxyEv = r.body.event;
  r = await owner.get(`/api/events/${proxyEv.id}`);
  assert.deepEqual(r.body.event.attendees.map((a: any) => a.id), [bobId], "대리 등록: 참석자=밥만(생성자 제외)");
  // C13: 대리 등록 일정도 "누가 등록했는지"가 응답에 — attendees엔 생성자가 없으니 creator_name이 유일한 단서
  assert.ok(r.body.event.creator_name, "enrich에 creator_name 포함: " + JSON.stringify(r.body.event.creator_name));
  // PATCH 대칭: 제목만 고쳐도(참석자 목록 동반) 생성자가 되살아나지 않음
  r = await owner.patch(`/api/events/${proxyEv.id}`).send({ title: "밥 멘토링(수정)", attendee_ids: [bobId], include_creator: false });
  assert.equal(r.status, 200);
  r = await owner.get(`/api/events/${proxyEv.id}`);
  assert.deepEqual(r.body.event.attendees.map((a: any) => a.id), [bobId], "PATCH 후에도 생성자 미부활");
  // 빈 집합 정규화: include_creator:false + 참석자 0명 → [생성자]로 폴백 (알림 공백 방지)
  r = await owner.post("/api/events").send({ title: "빈 참석", starts_at: "2026-09-02T00:00:00.000Z", all_day: true, project_id: pid, attendee_ids: [], include_creator: false });
  assert.equal(r.status, 201);
  r = await owner.get(`/api/events/${r.body.event.id}`);
  assert.equal(r.body.event.attendees.length, 1, "빈 집합 → [생성자] 정규화");
  // 기존 계약 불변: include_creator 미전송(구 클라이언트) → 생성자 자동 포함
  r = await owner.post("/api/events").send({ title: "레거시 계약", starts_at: "2026-09-03T00:00:00.000Z", all_day: true, project_id: pid, attendee_ids: [bobId] });
  r = await owner.get(`/api/events/${r.body.event.id}`);
  assert.equal(r.body.event.attendees.length, 2, "미전송 시 생성자+밥 (기존 동작 유지)");
  // MCP: 참석자 지정 + 대리 등록 + 비멤버 거부, 응답에 참석자 포함
  r = await call(70, "create_event", { title: "MCP 대리", starts_at: "2026-09-04", all_day: true, project_id: pid, attendee_ids: [bobId], include_creator: false });
  const mcpEv = parse(r);
  assert.deepEqual(mcpEv.event.attendees.map((a: any) => a.id), [bobId], "MCP 대리 등록 참석자");
  r = await call(71, "create_event", { title: "비멤버", starts_at: "2026-09-05", all_day: true, project_id: pid, attendee_ids: [99999] });
  assert.equal(r.body.result?.isError, true, "MCP 비멤버 참석자 거부");
  // 개인 일정은 항상 [생성자]
  r = await owner.post("/api/events").send({ title: "개인", starts_at: "2026-09-06T00:00:00.000Z", all_day: true, attendee_ids: [], include_creator: false });
  r = await owner.get(`/api/events/${r.body.event.id}`);
  assert.equal(r.body.event.attendees.length, 1, "개인 일정 참석자=본인 강제");
  // 태스크 상세에 만든 사람 포함 (C9-D)
  r = await owner.get(`/api/tasks/${okT.id}`);
  assert.ok(r.body.creator?.id, "getTaskDetail creator 포함");

  /* ---------- C6: 재검증 2라운드 픽스 ---------- */
  // 소문자 z(RFC3339) 허용 · 공백 구분 무오프셋 거부
  r = await call(62, "create_event", { title: "소문자 z", starts_at: "2026-07-23T10:00:00z" });
  assert.equal(r.body.result?.isError, false, "소문자 z 오프셋 허용");
  r = await call(63, "create_event", { title: "공백 구분", starts_at: "2026-07-23 10:00" });
  assert.ok(r.body.error, "공백 구분 무오프셋 거부");
  // 종일 해제 시 기존 ends_at도 유령 시각으로 남지 않게 — ends_at 동반 요구
  const evM = parse(await call(64, "create_event", { title: "멀티데이 종일", starts_at: "2026-08-01", ends_at: "2026-08-03", all_day: true, project_id: pid }));
  r = await owner.patch(`/api/events/${evM.event.id}`).send({ all_day: false, starts_at: "2026-08-01T10:00:00+09:00" });
  assert.equal(r.status, 400, "종일 해제 시 ends_at 미동반 거부");
  r = await owner.patch(`/api/events/${evM.event.id}`).send({ all_day: false, starts_at: "2026-08-01T10:00:00+09:00", ends_at: "2026-08-01T11:00:00+09:00" });
  assert.equal(r.status, 200, "starts+ends 동반 시 허용");
  // AI POST 화이트리스트 — read 토큰으로 reindex(쓰기·비용)는 403, search(조회)는 게이트 통과
  r = await request(ctx.app).post("/api/ai/reindex").set("Authorization", `Bearer ${roTok}`).send({ project_id: pid });
  assert.equal(r.status, 403, "read 토큰의 reindex 차단");
  r = await request(ctx.app).post("/api/ai/search").set("Authorization", `Bearer ${roTok}`).send({ q: "테스트", project_id: pid });
  assert.notEqual(r.status, 403, "read 토큰의 search 허용(게이트)");
});
