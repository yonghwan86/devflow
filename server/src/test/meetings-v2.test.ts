// G5: 회의록 v2 — 원문/수정/삭제, 재추출 반영분 보존, event/checklist 반영, llm_mode
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

async function setup(app: any) {
  const mgr = request.agent(app);
  const member = request.agent(app);
  await mgr.post("/api/auth/bootstrap").send({ email: "m@x.com", password: "password123", full_name: "매니저" });
  await mgr.post("/api/auth/login").send({ email: "m@x.com", password: "password123" });
  const pid = (await mgr.post("/api/projects").send({ name: "회의" })).body.project.id;
  const inv = await mgr.post(`/api/projects/${pid}/invites`).send({ email: "u@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await member.post("/api/auth/login").send({ email: "u@x.com", password: "password123" });
  return { mgr, member, pid };
}

const SOURCE = [
  "PM: 결제 모듈은 토스로 확정했습니다.",
  "개발: 재시도는 지수 백오프로 처리하세요.",
  "7/10 오후 3시 전체 회의 진행합니다.",
  "김개발: 로그인 버그 수정해야 합니다.",
].join("\n");

test("G5 회의록: 원문·수정/삭제·재추출 보존·checklist/event 반영·llm_mode", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { mgr, member, pid } = await setup(ctx.app);

  // 업로드 + 추출
  const note = (await mgr.post("/api/meetings").send({ project_id: pid, title: "주간회의", source_text: SOURCE })).body.note;
  let r = await mgr.post(`/api/meetings/${note.id}/process`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const exs = r.body.extractions;

  // ⑦ GET 상세에 llm_mode 포함(mock)
  r = await mgr.get(`/api/meetings/${note.id}`);
  assert.equal(r.body.llm_mode, "mock");

  // ⑥ mock 추출기가 "7/10 오후 3시 전체 회의" → event로 분류 + when_suggested
  const eventEx = exs.find((x: any) => x.kind === "event");
  assert.ok(eventEx, "event 추출됨: " + JSON.stringify(exs.map((x: any) => x.kind)));
  assert.ok(eventEx.when_suggested, "when_suggested 채워짐");
  const actionEx = exs.find((x: any) => x.kind === "action");
  assert.ok(actionEx, "action 추출됨");

  // 태스크 하나 만들어서 checklist 반영 대상으로 사용
  const targetTask = (await mgr.post(`/api/projects/${pid}/tasks`).send({ title: "체크대상" })).body.task;

  // ④ action을 checklist로 반영 — 항목 생성 + 링크
  r = await mgr.patch(`/api/meetings/extractions/${actionEx.id}`).send({ status: "accepted", apply_as: "checklist", task_id: targetTask.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.extraction.linked_checklist_item_id != null, true, "체크리스트 항목 링크");
  const detail = (await mgr.get(`/api/projects/${pid}/tasks/by-key/${targetTask.item_key}`)).body;
  assert.equal(detail.checklist.length, 1, "체크리스트 항목 생성됨");

  // ④-2 타 프로젝트 task_id → 400
  const other = (await mgr.post("/api/projects").send({ name: "타프로젝트" })).body.project;
  const otherTask = (await mgr.post(`/api/projects/${other.id}/tasks`).send({ title: "남의것" })).body.task;
  // 새 action 항목이 필요 — 재추출로 suggested 복원
  await mgr.post(`/api/meetings/${note.id}/process`);
  const exs2 = (await mgr.get(`/api/meetings/${note.id}`)).body.extractions;
  const action2 = exs2.find((x: any) => x.kind === "action" && x.status === "suggested");
  r = await mgr.patch(`/api/meetings/extractions/${action2.id}`).send({ status: "accepted", apply_as: "checklist", task_id: otherTask.id });
  assert.equal(r.status, 400, "타 프로젝트 task_id 거부");

  // ⑤ event 승인: starts_at 없으면 400
  const eventEx2 = exs2.find((x: any) => x.kind === "event" && x.status === "suggested");
  r = await mgr.patch(`/api/meetings/extractions/${eventEx2.id}`).send({ status: "accepted" });
  assert.equal(r.status, 400, "starts_at 필수");
  // 있으면 events 생성 + 참석자(승인자) + linked_event_id
  r = await mgr.patch(`/api/meetings/extractions/${eventEx2.id}`).send({ status: "accepted", starts_at: "2026-07-10T06:00:00.000Z", all_day: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.extraction.linked_event_id, "event 링크");
  const evs = (await mgr.get(`/api/events?from=2026-07-09&to=2026-07-11`)).body.events;
  assert.ok(evs.some((e: any) => e.id === r.body.extraction.linked_event_id), "생성된 일정 조회됨(승인자 참석)");

  // ① 수정: uploaded_by 본인(mgr) 성공, 타 member 403
  r = await mgr.patch(`/api/meetings/${note.id}`).send({ title: "주간회의(수정)" });
  assert.equal(r.status, 200);
  r = await member.patch(`/api/meetings/${note.id}`).send({ title: "몰래수정" });
  assert.equal(r.status, 403, "작성자/매니저 아닌 멤버 수정 차단");

  // ② 원문 수정 후 재추출 — accepted 항목 보존 + suggested 갱신
  const acceptedBefore = (await mgr.get(`/api/meetings/${note.id}`)).body.extractions.filter((x: any) => x.status === "accepted" || x.status === "edited");
  r = await mgr.patch(`/api/meetings/${note.id}`).send({ source_text: SOURCE + "\n새 결정: 배포는 금요일로 확정." });
  assert.equal(r.body.source_changed, true);
  await mgr.post(`/api/meetings/${note.id}/process`);
  const afterExs = (await mgr.get(`/api/meetings/${note.id}`)).body.extractions;
  for (const a of acceptedBefore) assert.ok(afterExs.some((x: any) => x.id === a.id), "반영분 보존");

  // ③ DELETE 후 생성됐던 태스크/체크리스트 생존
  r = await mgr.delete(`/api/meetings/${note.id}`);
  assert.equal(r.status, 200);
  const survive = (await mgr.get(`/api/projects/${pid}/tasks/by-key/${targetTask.item_key}`)).body;
  assert.equal(survive.checklist.length, 1, "회의록 삭제 후에도 생성된 체크리스트 생존");
});
