// 체크리스트 항목별 리뷰/피드백: 항목에 댓글 연결 + 교차 태스크 참조 차단
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("checklist item feedback", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const proj = await owner.post("/api/projects").send({ name: "피드백" });
  const pid = proj.body.project.id;

  const t1 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "개발" });
  const t2 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "다른 태스크" });
  const tid = t1.body.task.id;

  const item = await owner.post(`/api/tasks/${tid}/checklist`).send({ content: "테스트 코드 작성" });
  assert.equal(item.status, 201);
  const itemId = item.body.item.id;

  // 항목에 피드백 등록
  let r = await owner.post("/api/comments").send({ task_id: tid, body: "이 항목은 엣지 케이스도 다뤄주세요", checklist_item_id: itemId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.comment.checklist_item_id, itemId);
  assert.equal(r.body.comment.checklist_item_content, "테스트 코드 작성");

  // 목록에서도 항목 컨텍스트 포함
  r = await owner.get(`/api/comments?task_id=${tid}`);
  const fb = r.body.comments.find((c: any) => c.checklist_item_id === itemId);
  assert.ok(fb, "checklist feedback missing in list");
  assert.equal(fb.checklist_item_content, "테스트 코드 작성");

  // ★ 다른 태스크의 checklist_item_id는 거부 (교차 참조 차단)
  r = await owner.post("/api/comments").send({ task_id: t2.body.task.id, body: "잘못된 참조", checklist_item_id: itemId });
  assert.equal(r.status, 400, "cross-task checklist ref must be rejected: " + JSON.stringify(r.body));

  // 항목 삭제 시 피드백도 함께 삭제 (cascade)
  await owner.delete(`/api/tasks/${tid}/checklist/${itemId}`);
  r = await owner.get(`/api/comments?task_id=${tid}`);
  assert.equal(r.body.comments.filter((c: any) => c.checklist_item_id === itemId).length, 0, "cascade delete");
});
