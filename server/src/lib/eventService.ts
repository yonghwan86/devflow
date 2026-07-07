import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { eventAttendees, projectMembers } from "../../../shared/schema.ts";
import type { EventRow } from "../../../shared/schema.ts";
import { sendOnce, sendPushToUser } from "./push.ts";
import { err } from "./errors.ts";

// C9: 일정 참석자 규칙 — REST(POST/PATCH)·MCP create_event·회의록 승인, 4개 쓰기 경로가 공유하는 단일 구현.
// (경로별 손코딩 중복이 의미 불일치의 근원이었음 — 규칙 변경은 반드시 이 파일에서만)
//
// 의미 규약:
//  - attendee_ids = "생성자 외 추가 참석자 목록" (생략·빈 배열 = 미지정)
//  - include_creator(기본 true) = 생성자 본인 참석 여부 — false면 대리 등록(생성자는 수정 권한만 보유)
//  - 불변식: 최종 참석자 집합은 비지 않는다 (비면 [생성자]로 정규화 — 리마인더·배치 공백 방지)
//  - 개인 일정(project_id null)은 항상 참석자 = [생성자]
//  - 참석자 = 알림(초대 push·30분 전 리마인더·다이제스트) 수신자

// 종일 일정 저장 규약: 로컬 day key의 UTC 자정(F5) — 위반 값은 하루 밀려 보이므로 서버에서 거부
export const isUtcMidnight = (d: Date) => d.getTime() % 86400_000 === 0;
export function assertAllDayConvention(allDay: boolean, starts: Date, ends: Date | null): void {
  if (!allDay) return;
  if (!isUtcMidnight(starts) || (ends && !isUtcMidnight(ends)))
    throw err.badRequest("종일 일정의 시각은 UTC 자정(YYYY-MM-DDT00:00:00.000Z)이어야 합니다.");
}

// 참석자 검증: 프로젝트 일정 → 그 프로젝트 멤버만 / 개인 일정 → 본인 외 지정 불가(R1 단순화)
export async function validateAttendees(ids: number[], projectId: number | null, uid: number): Promise<number[]> {
  const uniq = [...new Set(ids)];
  if (projectId == null) {
    if (uniq.some((id) => id !== uid)) throw err.badRequest("개인 일정에는 본인 외 참석자를 지정할 수 없습니다.");
    return uniq;
  }
  if (uniq.length === 0) return uniq;
  const members = await db
    .select({ user_id: projectMembers.user_id })
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), inArray(projectMembers.user_id, uniq)));
  if (members.length !== uniq.length) throw err.badRequest("참석자는 해당 프로젝트 멤버만 지정할 수 있습니다.");
  return uniq;
}

// 최종 참석자 집합 계산 — 위 의미 규약을 구현하는 유일한 곳
export async function resolveAttendees(v: {
  creatorId: number;
  projectId: number | null;
  attendeeIds?: number[];
  includeCreator?: boolean;
}): Promise<number[]> {
  if (v.projectId == null) {
    await validateAttendees(v.attendeeIds ?? [], null, v.creatorId); // 타인 지정 거부만 수행
    return [v.creatorId];
  }
  const valid = await validateAttendees(v.attendeeIds ?? [], v.projectId, v.creatorId);
  const final = v.includeCreator === false ? [...new Set(valid)] : [...new Set([v.creatorId, ...valid])];
  return final.length ? final : [v.creatorId]; // 빈 집합 정규화 (include_creator:false + 참석자 0명)
}

// 참석자 저장 + 초대 push(sendOnce — 재저장에도 event-invite 키로 중복 방지)
export async function syncAttendees(ev: EventRow, ids: number[], notifyExcept: number): Promise<void> {
  for (const uid of ids) {
    await db.insert(eventAttendees).values({ event_id: ev.id, user_id: uid }).onConflictDoNothing();
    // 생성자 본인에게 "초대되었어요"는 부자연 — 남이 수정하며 재추가할 때 오발송되던 버그 포함 차단
    if (uid !== notifyExcept && uid !== ev.created_by) {
      await sendOnce(`event-invite:${ev.id}:user:${uid}`, async () => {
        const when = ev.all_day
          ? `${String(ev.starts_at instanceof Date ? ev.starts_at.toISOString() : ev.starts_at).slice(5, 10).replace("-", "월 ")}일 (종일)`
          : new Date(ev.starts_at).toLocaleString("ko-KR", { timeZone: process.env.TZ ?? "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        await sendPushToUser(uid, {
          title: "일정에 초대되었어요",
          body: `${ev.title} — ${when}`,
          url: "/my-work",
        });
      });
    }
  }
}
