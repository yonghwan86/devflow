// AA: MCP 도구 확장 — list_events scope · update_task · bulk_create/update_tasks · create_task parent
//     + loadTaskForUser 휴지통 게이트 (task_id 직통 경로의 소프트 삭제 우회 봉쇄)
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("AA: MCP scope/update/bulk/parent + 휴지통 게이트", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pidA = (await owner.post("/api/projects").send({ name: "본진" })).body.project.id;
  const pidB = (await owner.post("/api/projects").send({ name: "이웃" })).body.project.id;

  // member bob — 본진(A)에만 합류
  const inv = await owner.post(`/api/projects/${pidA}/invites`).send({ email: "bob@x.com", role: "member" });
  const bob = request.agent(ctx.app);
  await bob.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "밥" });
  await bob.post("/api/auth/login").send({ email: "bob@x.com", password: "password123" });

  const ownerTok = (await owner.post("/api/tokens").send({ name: "o", scopes: ["task:read", "task:write", "project:read"] })).body.token;
  const bobTok = (await bob.post("/api/tokens").send({ name: "b", scopes: ["task:read", "task:write", "project:read"] })).body.token;
  let seq = 0;
  const call = (name: string, argsObj: any, tok = ownerTok) =>
    request(ctx.app).post("/api/mcp").set("Authorization", `Bearer ${tok}`)
      .send({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: argsObj } });
  const parse = (resp: any) => JSON.parse(resp.body.result.content[0].text);

  /* ---------- ① list_events scope ---------- */
  await owner.post("/api/events").send({ title: "A 회의", starts_at: "2026-08-10T01:00:00.000Z", project_id: pidA });
  await owner.post("/api/events").send({ title: "B 회의", starts_at: "2026-08-10T02:00:00.000Z", project_id: pidB });
  await owner.post("/api/events").send({ title: "개인 약속", starts_at: "2026-08-10T03:00:00.000Z" });

  // 기본 scope=project + project_id 지정(기존 호출 패턴 하위호환) → 그 프로젝트만
  let r = await call("list_events", { from: "2026-08-09", to: "2026-08-11", project_id: pidA });
  let ev = parse(r);
  assert.deepEqual(ev.events.map((e: any) => e.title), ["A 회의"], "scope 기본값=project는 해당 프로젝트만");

  // 기본 scope=project인데 project_id 미지정 → 명확한 에러 (구 동작인 '전부 반환' 금지)
  r = await call("list_events", { from: "2026-08-09", to: "2026-08-11" });
  assert.ok(r.body.error, "project_id 없는 기본 호출은 에러");
  assert.match(r.body.error.message, /scope/, "에러 메시지가 scope 안내를 포함");

  // scope=personal → 개인 일정만
  r = await call("list_events", { from: "2026-08-09", to: "2026-08-11", scope: "personal" });
  ev = parse(r);
  assert.deepEqual(ev.events.map((e: any) => e.title), ["개인 약속"]);

  // scope=all → 내가 볼 수 있는 전부 (구 기본 동작은 명시 요청 시에만)
  r = await call("list_events", { from: "2026-08-09", to: "2026-08-11", scope: "all" });
  ev = parse(r);
  assert.equal(ev.total, 3, "all은 내 프로젝트 전부+개인");

  // 비멤버 프로젝트 조회 차단 (bob은 B 비멤버)
  r = await call("list_events", { from: "2026-08-09", to: "2026-08-11", project_id: pidB }, bobTok);
  assert.ok(r.body.error, "비멤버 프로젝트 스코프 차단");

  /* ---------- ② update_task (null=비우기 · 검증 · 권한) ---------- */
  r = await call("create_task", { project_id: pidA, title: "수정 대상", scheduled_date: "2026-08-10", due_date: "2026-08-12" });
  const t1 = parse(r).task;

  r = await call("update_task", { task_id: t1.id, title: "수정됨", description: "설명 추가", priority: 3, due_date: "2026-08-20" });
  let ut = parse(r).task;
  assert.equal(ut.title, "수정됨");
  assert.equal(ut.description, "설명 추가");
  assert.equal(ut.priority, 3);
  assert.equal(String(ut.due_date).slice(0, 10), "2026-08-20");
  assert.equal(String(ut.scheduled_date).slice(0, 10), "2026-08-10", "안 보낸 필드는 유지");

  // null = 비우기 (요청서 ②의 핵심 — "값 미전달"과 "비우기" 구분)
  r = await call("update_task", { task_id: t1.id, scheduled_date: null });
  ut = parse(r).task;
  assert.equal(ut.scheduled_date, null, "null은 예정일 해제");
  assert.equal(String(ut.due_date).slice(0, 10), "2026-08-20", "다른 날짜는 보존");

  // 병합 역전 검증 — 기존 due(8-20)보다 늦은 예정일
  r = await call("update_task", { task_id: t1.id, scheduled_date: "2026-08-25" });
  assert.ok(r.body.error, "병합 후 due<scheduled 거부");
  // 잘못된 날짜(롤오버) 거부 — create_task 엄격화 회귀 포함
  r = await call("update_task", { task_id: t1.id, due_date: "2026-02-30" });
  assert.ok(r.body.error, "2026-02-30 롤오버 거부");
  r = await call("create_task", { project_id: pidA, title: "느슨 날짜", scheduled_date: "2026-7-1" });
  assert.ok(r.body.error, "create_task도 YYYY-MM-DD 엄격 (하루 밀림 차단)");

  // 빈 패치 거부 / member 거부
  r = await call("update_task", { task_id: t1.id });
  assert.ok(r.body.error, "수정 필드 없는 호출 거부");
  r = await call("update_task", { task_id: t1.id, title: "밥이 몰래" }, bobTok);
  assert.ok(r.body.error, "member 수정 차단");

  /* ---------- ⑤ 계층: create_task parent + update_task parent ---------- */
  r = await call("create_task", { project_id: pidA, title: "부모" });
  const parent = parse(r).task;
  r = await call("create_task", { project_id: pidA, title: "자식", parent_task_id: parent.id });
  const child = parse(r).task;
  r = await call("update_task", { task_id: child.id, title: "자식(확인)" });
  assert.equal(parse(r).task.parent_task_id, parent.id, "create_task parent_task_id 반영");

  // 순환 차단: 부모의 부모를 자식으로
  r = await call("update_task", { task_id: parent.id, parent_task_id: child.id });
  assert.ok(r.body.error, "순환 참조 거부");
  // 타 프로젝트 부모 차단
  r = await call("create_task", { project_id: pidB, title: "크로스", parent_task_id: parent.id });
  assert.ok(r.body.error, "크로스 프로젝트 부모 거부");
  // null = 최상위 승격
  r = await call("update_task", { task_id: child.id, parent_task_id: null });
  assert.equal(parse(r).task.parent_task_id, null, "parent null=최상위 승격");

  /* ---------- ④ bulk_create_tasks (parent_ref · 부분 실패) ---------- */
  r = await call("bulk_create_tasks", {
    project_id: pidA,
    tasks: [
      { ref: "wbs1", title: "1. 설계" },
      { ref: "wbs1-1", title: "1.1 요구분석", parent_ref: "wbs1", due_date: "2026-08-20" },
      { ref: "wbs1-2", title: "1.2 화면설계", parent_ref: "wbs1" },
      { title: "" }, // 실패 항목 (빈 제목)
      { title: "고아 자식", parent_ref: "없는ref" }, // 실패 항목 (미지 ref)
      { title: "독립 태스크" },
    ],
  });
  const bulk = parse(r);
  assert.equal(bulk.created, 4, JSON.stringify(bulk));
  assert.equal(bulk.failed, 2);
  assert.deepEqual(bulk.errors.map((e: any) => e.index), [3, 4], "실패 인덱스 보고");
  const wbs1 = bulk.tasks.find((x: any) => x.ref === "wbs1");
  const wbs11 = bulk.tasks.find((x: any) => x.ref === "wbs1-1");
  r = await call("update_task", { task_id: wbs11.id, priority: 1 });
  assert.equal(parse(r).task.parent_task_id, wbs1.id, "parent_ref로 계층 생성");

  // member 전체 거부 · 상한 초과 거부
  r = await call("bulk_create_tasks", { project_id: pidA, tasks: [{ title: "x" }] }, bobTok);
  assert.ok(r.body.error, "member bulk 생성 차단");
  r = await call("bulk_create_tasks", { project_id: pidA, tasks: Array.from({ length: 201 }, (_, i) => ({ title: `t${i}` })) });
  assert.ok(r.body.error, "200건 상한");
  assert.match(r.body.error.message, /200/);

  /* ---------- ④ bulk_update_tasks — "예정일 일괄 제거" 실사용 시나리오 ---------- */
  // 태스크별 병합 역전 검증: wbs1-1은 due 8-20이 있어 9-1 예정일이 건별로 거부되고 나머지만 성공
  r = await call("bulk_update_tasks", {
    task_ids: [wbs1.id, wbs11.id, bulk.tasks[2].id],
    patch: { scheduled_date: "2026-09-01" },
  });
  let buRev = parse(r);
  assert.equal(buRev.updated, 2, "역전 없는 2건만 성공");
  assert.equal(buRev.failed, 1, "due(8-20)<sched(9-1)인 태스크는 건별 실패");
  assert.equal(buRev.errors[0].task_id, wbs11.id);
  // WBS 등록 때 예정일을 잘못 일괄 입력한 상황 재현 → 전건 설정 후 null로 일괄 해제
  r = await call("bulk_update_tasks", {
    task_ids: [wbs1.id, wbs11.id, bulk.tasks[2].id],
    patch: { scheduled_date: "2026-08-15" },
  });
  assert.equal(parse(r).updated, 3, "역전 없는 날짜는 전건 성공");
  r = await call("bulk_update_tasks", {
    task_ids: [wbs1.id, wbs11.id, bulk.tasks[2].id, 999999],
    patch: { scheduled_date: null },
  });
  const bu = parse(r);
  assert.equal(bu.updated, 3, "존재하는 3건 해제");
  assert.equal(bu.failed, 1, "없는 id는 부분 실패");
  assert.equal(bu.errors[0].task_id, 999999);
  r = await call("update_task", { task_id: wbs11.id, priority: 0 });
  assert.equal(parse(r).task.scheduled_date, null, "일괄 해제 반영 확인");

  // member는 건별 권한 실패로 집계
  r = await call("bulk_update_tasks", { task_ids: [wbs1.id], patch: { priority: 2 } }, bobTok);
  const buBob = parse(r);
  assert.equal(buBob.updated, 0);
  assert.equal(buBob.failed, 1, "member는 전건 실패");
  // 빈 patch 거부
  r = await call("bulk_update_tasks", { task_ids: [wbs1.id], patch: {} });
  assert.ok(r.body.error, "빈 patch 거부");
  // 미지원 patch 키는 조용히 버리지 않고 거부 (검증단 확정 — REST .strict()와 동일 규약)
  r = await call("bulk_update_tasks", { task_ids: [wbs1.id], patch: { status: "done", priority: 1 } });
  assert.ok(r.body.error, "미지원 키(status) 섞인 patch 거부");
  assert.match(r.body.error.message, /update_task_status/, "status는 전용 도구 안내");
  r = await call("update_task", { task_id: wbs1.id, label: "몰래" });
  assert.ok(r.body.error, "update_task도 미지원 키 거부");

  // 실패한 항목의 ref를 뒤 항목이 재사용 못 함 (검증단 확정 — 자식이 엉뚱한 부모에 붙는 것 차단)
  r = await call("bulk_create_tasks", {
    project_id: pidA,
    tasks: [
      { ref: "dup", title: "먼저 실패", due_date: "2026-02-30" }, // 잘못된 날짜로 실패
      { ref: "dup", title: "재사용 시도" }, // 같은 ref — 중복으로 거부돼야 함
      { title: "자식", parent_ref: "dup" }, // 참조 불가여야 함
    ],
  });
  const dupBulk = parse(r);
  assert.equal(dupBulk.created, 0, "실패 ref 재사용·참조 전부 거부");
  assert.equal(dupBulk.failed, 3);

  /* ---------- 휴지통 게이트: task_id 직통 경로 + 집계형 읽기 경로 봉쇄 ---------- */
  const meId = (await owner.get("/api/auth/me")).body.user.id;
  const pidC = (await owner.post("/api/projects").send({ name: "버릴곳" })).body.project.id;
  r = await call("create_task", { project_id: pidC, title: "휴지통행 태스크", assignee_ids: [meId] });
  const trashedTask = parse(r).task;
  await owner.post("/api/events").send({ title: "휴지통행 일정", starts_at: "2026-08-10T05:00:00.000Z", project_id: pidC });
  let rr = await owner.post(`/api/projects/${pidC}/trash`).send({ confirm_name: "버릴곳" });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));

  r = await call("update_task", { task_id: trashedTask.id, title: "몰래 수정" });
  assert.ok(r.body.error, "휴지통 프로젝트 태스크 MCP 수정 차단");
  r = await call("update_task_status", { task_id: trashedTask.id, status: "done" });
  assert.ok(r.body.error, "기존 도구(update_task_status)도 동일 차단");
  rr = await owner.get(`/api/tasks/${trashedTask.id}`);
  assert.equal(rr.status, 404, "REST task_id 직통 경로도 차단");

  // 집계형 읽기 3경로도 휴지통 콘텐츠를 숨김 (검증단 확정 — list_my_tasks·list_events all·REST)
  r = await call("list_my_tasks", {});
  assert.ok(!parse(r).tasks.some((x: any) => x.id === trashedTask.id), "list_my_tasks에서 유령 태스크 제외");
  r = await call("list_events", { from: "2026-08-09", to: "2026-08-11", scope: "all" });
  assert.ok(!parse(r).events.some((e: any) => e.title === "휴지통행 일정"), "scope=all에서 휴지통 일정 제외");
  rr = await owner.get("/api/events?from=2026-08-09&to=2026-08-11");
  assert.ok(!rr.body.events.some((e: any) => e.title === "휴지통행 일정"), "REST 캘린더(미니 달력 소스)도 제외");
  rr = await owner.get("/api/my-work");
  assert.ok(!(rr.body.board_tasks ?? []).some((x: any) => x.id === trashedTask.id), "My Work 보드에서도 제외");

  // 존재 오라클 차단 (검증단 확정): 비멤버(bob)가 휴지통 프로젝트를 찍어도 "휴지통" 메시지가 새지 않음
  r = await call("create_task", { project_id: pidC, title: "프로빙" }, bobTok);
  assert.ok(r.body.error, "비멤버 차단");
  assert.ok(!/휴지통/.test(r.body.error.message), "비멤버에겐 휴지통 여부 미노출 (통일 메시지)");
  // 멤버(owner)에게는 복원 안내 유지
  r = await call("create_task", { project_id: pidC, title: "멤버 시도" });
  assert.match(r.body.error.message, /휴지통/, "멤버에겐 휴지통 안내 유지");

  // 복원하면 다시 접근 가능 (게이트가 소프트 삭제에만 반응하는지 — 과차단 방지)
  rr = await owner.post(`/api/projects/${pidC}/restore`).send({});
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  r = await call("update_task", { task_id: trashedTask.id, title: "복원 후 수정" });
  assert.equal(parse(r).task.title, "복원 후 수정", "복원 후엔 정상 접근");
  r = await call("list_my_tasks", {});
  assert.ok(parse(r).tasks.some((x: any) => x.id === trashedTask.id), "복원 후 목록 복귀");
});
