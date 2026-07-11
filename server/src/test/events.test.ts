// F5 일정 이벤트: 권한(개인/프로젝트), whitelist, 리마인더 멱등
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, like } from "drizzle-orm";
import { makeTestApp, type TestCtx } from "./harness.ts";
import { db } from "../lib/db.ts";
import { systemSettings } from "../../../shared/schema.ts";
import { runEventReminders } from "../jobs/notifications.ts";

async function setup(ctx: TestCtx) {
  const owner = request.agent(ctx.app);
  const member = request.agent(ctx.app);
  const outsider = request.agent(ctx.app);
  await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "오너" });
  await owner.post("/api/auth/login").send({ email: "o@x.com", password: "password123" });
  const pid = (await owner.post("/api/projects").send({ name: "일정" })).body.project.id;
  const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
  await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "password123", full_name: "멤버" });
  await outsider.post("/api/auth/signup").send({ email: "out@x.com", password: "password123", full_name: "외부" });
  const memberId = (await member.get("/api/auth/me")).body.user.id;
  const outsiderId = (await outsider.get("/api/auth/me")).body.user.id;
  return { owner, member, outsider, pid, memberId, outsiderId };
}

const day = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

test("F5: 생성·조회 권한 + 기간 필터 + 유효성", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, member, outsider, pid, memberId, outsiderId } = await setup(ctx);

  // ⑤ from/to 없으면 400
  let r = await owner.get("/api/events");
  assert.equal(r.status, 400);

  // ① 프로젝트 일정 생성 (참석자 = member)
  r = await owner.post("/api/events").send({
    title: "스프린트 회의", starts_at: new Date().toISOString(), project_id: pid, attendee_ids: [memberId],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const projEv = r.body.event;
  assert.ok(projEv.attendees.some((a: any) => a.id === memberId));
  assert.ok(projEv.attendees.length >= 2, "생성자 자동 참석 포함");

  // ① 개인 일정 생성 (owner)
  r = await owner.post("/api/events").send({ title: "개인 약속", starts_at: new Date().toISOString() });
  assert.equal(r.status, 201);
  const personal = r.body.event;
  assert.equal(personal.project_id, null);

  // ⑥ ends_at < starts_at → 400
  r = await owner.post("/api/events").send({
    title: "역행", starts_at: new Date().toISOString(), ends_at: new Date(Date.now() - 3600_000).toISOString(),
  });
  assert.equal(r.status, 400);

  // ⑧ 타 프로젝트(비멤버) 사용자를 attendee로 → 400
  r = await owner.post("/api/events").send({
    title: "외부인 초대", starts_at: new Date().toISOString(), project_id: pid, attendee_ids: [outsiderId],
  });
  assert.equal(r.status, 400, "비멤버 attendee 차단");

  // 개인 일정에 본인 외 참석자 → 400
  r = await owner.post("/api/events").send({
    title: "개인+타인", starts_at: new Date().toISOString(), attendee_ids: [memberId],
  });
  assert.equal(r.status, 400, "개인 일정 타인 참석 차단");

  // ② 비멤버(outsider)는 프로젝트 일정 조회 불가 (목록에 안 나옴 + 단건 404)
  r = await outsider.get(`/api/events?from=${day(-1)}&to=${day(1)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.events.length, 0, "비멤버에게 프로젝트 일정 비노출");
  r = await outsider.get(`/api/events/${projEv.id}`);
  assert.equal(r.status, 404);

  // ③ 개인 일정: 생성자 O / 무관자 X
  r = await owner.get(`/api/events?from=${day(-1)}&to=${day(1)}`);
  assert.ok(r.body.events.some((e: any) => e.id === personal.id), "생성자 조회 O (참석자 조인만으론 누락됨)");
  r = await member.get(`/api/events?from=${day(-1)}&to=${day(1)}`);
  assert.ok(!r.body.events.some((e: any) => e.id === personal.id), "무관자 조회 X");
  assert.ok(r.body.events.some((e: any) => e.id === projEv.id), "참석자·멤버는 프로젝트 일정 조회 O");
});

test("F5: 수정·삭제 권한 + project_id PATCH 불가 + 초대 push 멱등 기록", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, member, pid, memberId } = await setup(ctx);

  const ev = (
    await owner.post("/api/events").send({
      title: "회의", starts_at: new Date().toISOString(), project_id: pid, attendee_ids: [memberId],
    })
  ).body.event;

  // ⑨ 참석자 초대 push 멱등 키 기록 (VAPID 없어도 sendOnce가 키를 남김)
  const [inviteKey] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, `event-invite:${ev.id}:user:${memberId}`));
  assert.ok(inviteKey, "event-invite sendOnce 키 기록");

  // ④ 참석자-only(member)는 수정/삭제 불가
  let r = await member.patch(`/api/events/${ev.id}`).send({ title: "탈취" });
  assert.equal(r.status, 403, "참석자 수정 차단");
  r = await member.delete(`/api/events/${ev.id}`);
  assert.equal(r.status, 403, "참석자 삭제 차단");

  // ⑦ PATCH에 project_id 포함 → 400 (strict whitelist — 개인↔프로젝트 이동 미지원)
  r = await owner.patch(`/api/events/${ev.id}`).send({ project_id: null });
  assert.equal(r.status, 400, "project_id는 PATCH 불가");

  // 생성자 수정 성공 (attendee_ids 재저장 — 초대 push는 sendOnce로 중복 방지됨)
  r = await owner.patch(`/api/events/${ev.id}`).send({ title: "회의(변경)", attendee_ids: [memberId] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inviteKeys = await db
    .select()
    .from(systemSettings)
    .where(like(systemSettings.key, `event-invite:${ev.id}:%`));
  assert.equal(inviteKeys.length, 1, "재저장에도 초대 키 1개(중복 발송 방지)");

  // manager(owner=생성자지만, 별개 확인) 삭제 성공
  r = await owner.delete(`/api/events/${ev.id}`);
  assert.equal(r.status, 200);
});

test("N2: 리마인드 설정 — 하루 전·없음·종일 아침/전날 저녁·따라잡기·시작 후 미발송", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner } = await setup(ctx);

  // 개인 일정(참석자 = 생성자 1명)으로 발송 수를 1:1 대응시킨다. D = 이틀 뒤(시계 비의존, now 주입).
  const D = day(2);
  const Dprev = day(1);
  const at = (d: string, hm: string) => `${d}T${hm}:00.000Z`;
  const mk = (title: string, body: Record<string, unknown>) =>
    owner.post("/api/events").send({ title, ...body });

  await mk("하루 전 알림", { starts_at: at(D, "10:00"), remind_minutes: 1440 });
  const eNone = (await mk("알림 없음", { starts_at: at(D, "10:00"), remind_minutes: -1 })).body.event;
  await mk("종일 당일 아침", { starts_at: `${D}T00:00:00.000Z`, all_day: true, remind_minutes: 0 });
  await mk("종일 전날 저녁", { starts_at: `${D}T00:00:00.000Z`, all_day: true, remind_minutes: 720 });
  await mk("기본 30분", { starts_at: at(D, "10:00") });
  await mk("10분 전(놓침)", { starts_at: at(D, "11:00"), remind_minutes: 10 }); // 시각 분리 — 09:50 실행과 겹치지 않게

  // D-1 11:00Z — "하루 전"(remindAt D-1 10:00)만 창 안
  assert.equal(await runEventReminders(new Date(at(Dprev, "11:00"))), 1, "하루 전 알림 1건");
  // D-1 13:00Z — "종일 전날 저녁"(remindAt D-1 12:00) 추가 발송, 기존 건은 sendOnce로 스킵
  assert.equal(await runEventReminders(new Date(at(Dprev, "13:00"))), 1, "전날 저녁 1건");
  // D 01:00Z — "종일 당일 아침"(remindAt D 00:00, 창은 KST 자정까지)
  assert.equal(await runEventReminders(new Date(at(D, "01:00"))), 1, "당일 아침 1건");
  // D 09:50Z — 기본 30분(remindAt 09:30, 서버가 잠들어 있었어도 시작 전 깨어나면 따라잡기)
  assert.equal(await runEventReminders(new Date(at(D, "09:50"))), 1, "기본 30분 따라잡기 1건");
  // D 10:05Z — 시작이 지난 "10분 전" 이벤트는 발송하지 않음 (지난 일정 리마인더 무의미)
  assert.equal(await runEventReminders(new Date(at(D, "10:05"))), 0, "시작 후 미발송");
  // 수정으로 리마인드를 켠 경우(없음 → 10분 전)도 반영
  let r = await owner.patch(`/api/events/${eNone.id}`).send({ remind_minutes: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await runEventReminders(new Date(at(D, "09:55"))), 1, "수정된 리마인드 발송");

  // 발송 후 연기 — 멱등 키에 시각이 포함돼 새 시각의 리마인더가 다시 발송된다 (N6 검증단 발견)
  const eMove = (await mk("연기될 회의", { starts_at: at(D, "20:00") })).body.event;
  assert.equal(await runEventReminders(new Date(at(D, "19:40"))), 1, "연기 전 발송");
  r = await owner.patch(`/api/events/${eMove.id}`).send({ starts_at: at(day(3), "10:00") });
  assert.equal(r.status, 200);
  assert.equal(await runEventReminders(new Date(at(day(3), "09:40"))), 1, "연기 후 재발송");

  // 검증 경계 — 시간지정 remind 0(발송 창 공집합)과 1440 초과는 저장 자체를 거부
  r = await owner.post("/api/events").send({ title: "정각", starts_at: at(D, "10:00"), remind_minutes: 0 });
  assert.equal(r.status, 400, "시간지정 0 거부");
  r = await owner.post("/api/events").send({ title: "과대", starts_at: at(D, "10:00"), remind_minutes: 10080 });
  assert.equal(r.status, 400, "1440 초과 거부");
});

test("F5: 리마인더 — 30분 내 시작 sendOnce 멱등, all_day 제외", async (t) => {
  const ctx = await makeTestApp();
  t.after(() => ctx.close());
  const { owner, pid, memberId } = await setup(ctx);

  const in10min = new Date(Date.now() + 10 * 60_000).toISOString();
  await owner.post("/api/events").send({ title: "곧 시작", starts_at: in10min, project_id: pid, attendee_ids: [memberId] });
  // ⑪ all_day는 30분 리마인더 제외
  await owner.post("/api/events").send({ title: "종일 행사", starts_at: `${day(0)}T00:00:00.000Z`, all_day: true, project_id: pid });

  // ⑩ 1차 실행: 참석자(owner+member) 2건 발송 기록, 2차 실행: 0건(멱등)
  const first = await runEventReminders(new Date());
  assert.equal(first, 2, "곧 시작 이벤트 참석자 2명 리마인더 (all_day 제외)");
  const second = await runEventReminders(new Date());
  assert.equal(second, 0, "sendOnce 멱등 — 중복 없음");
});
