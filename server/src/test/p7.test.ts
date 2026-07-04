// P7: AI RAG — 재색인→검색(멤버십 필터)→Q&A→가이드 제안(권한)
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

test("P7 AI RAG", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const owner = request.agent(ctx.app);
  const outsider = request.agent(ctx.app);

  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "P7" })).body.project.id;

  const task = (
    await owner.post(`/api/projects/${pid}/tasks`).send({ title: "결제 모듈 리팩토링", description: "토스페이먼츠 연동 개선" })
  ).body.task;
  await owner.post("/api/comments").send({ task_id: task.id, body: "결제 실패 재시도는 지수 백오프로 처리하세요", is_guide: true });

  // ① 재색인 (큐잉 + 즉시 처리)
  let r = await owner.post("/api/ai/reindex").send({ project_id: pid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.queued >= 2, "task+comment 큐잉");
  assert.equal(r.body.failed, 0, "잡 실패 없음: " + JSON.stringify(r.body));

  // ② 검색 — 관련 문서가 상위에
  r = await owner.post("/api/ai/search").send({ q: "결제 재시도 백오프", project_id: pid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.results.length >= 1, "검색 결과 존재");
  assert.ok(r.body.results.some((x: any) => x.content.includes("백오프") || x.content.includes("결제")), JSON.stringify(r.body.results));

  // ③ Q&A (mock: 결정론적 요약 + 출처)
  r = await owner.post("/api/ai/ask").send({ q: "결제 실패는 어떻게 처리해?", project_id: pid });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.answer === "string" && r.body.answer.length > 0);
  assert.ok(Array.isArray(r.body.sources));

  // ④ 가이드 제안 (owner) — 초안만 반환, 자동 등록 없음
  r = await owner.post("/api/ai/suggest-guide").send({ task_id: task.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.suggestion.includes("가이드"), r.body.suggestion);
  const comments = await owner.get(`/api/comments?task_id=${task.id}`);
  assert.equal(comments.body.comments.length, 1, "자동 등록 금지(§13) — 기존 가이드 1개 그대로");

  // 권한 거부: 비멤버는 프로젝트 검색/재색인 불가
  const p2 = (await owner.post("/api/projects").send({ name: "다른곳" })).body.project;
  const inv = await owner.post(`/api/projects/${p2.id}/invites`).send({ email: "s@x.com", role: "member" });
  await outsider.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "외부" });
  await outsider.post("/api/auth/login").send({ email: "s@x.com", password: "password123" });
  r = await outsider.post("/api/ai/reindex").send({ project_id: pid });
  assert.equal(r.status, 404);
  r = await outsider.post("/api/ai/search").send({ q: "결제", project_id: pid });
  assert.equal(r.status, 404);
  // 전체 검색도 남의 프로젝트 내용은 안 나옴 (멤버십 필터)
  r = await outsider.post("/api/ai/search").send({ q: "결제 재시도 백오프" });
  assert.ok(r.body.results.every((x: any) => x.project_id !== pid), "타 프로젝트 노출 금지");
  // member는 가이드 제안 불가
  r = await outsider.post("/api/ai/suggest-guide").send({ task_id: task.id });
  assert.ok([403, 404].includes(r.status));
});
