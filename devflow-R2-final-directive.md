# DevFlow R2 통합 개발 지시서 (최종본 — 실사용 피드백 2차 + 코드 검증 완료)

## G1 역할 개편 · G2 관리자 전체 가시성 · G3 태스크 상세 개편 · G4 보드/캘린더 UX · G5 회의록 v2 · G6 문서 분해(핵심)

> 이 문서의 파일 경로·줄 번호·기존 동작 설명은 현재 main 소스 대조 검증을 거친 사실이다. 코드가 문서와 다르면 코드를 다시 읽고 문서의 의도에 맞게 판단하라.

---

# 0. 목적과 순서

팀 실사용 2주차 피드백 반영. 권한 모델을 단순화하고(오너 폐지), 관리자를 "시스템의 오너"로 만들고, 태스크 상세를 수행 중심으로 재배치하고, 회의록을 완성하고, **설계 문서 → 태스크+체크리스트 분해(G6)** 를 도입한다.

**개발 순서 (변경 금지)**: G1 → G2 → G3 → G4 → G5 → G6 → 문서 갱신 → 최종 검증 → commit/push.
(G2·G3가 G1의 역할 규칙을 전제하고, G5·G6가 LLM 유틸을 공유하므로 이 순서다.)
각 그룹 완료 시 `npm run check` + 해당 테스트 통과 후 다음으로.

---

# 1. 작업 전 필독 + 유지해야 할 기존 규약

1. `devflow-build-prompt.md`, 2. `devflow/HANDOFF.md`(**§4 제약** + 9-4·9-5 세션 업데이트), 3. `devflow/README.md`

**현재 상태**: P0~P11 + R1 + 운영 역병합 완료, 테스트 54개, Replit dev 모드 배포(devfloww.replit.app).

**R1/9-5에서 확립된 규약 — R2 전체에서 위반 금지:**
- 클라이언트 mutating 요청은 반드시 `client/src/lib/api.ts` 래퍼(post/patch/del/upload) 사용 — 생 fetch는 CSRF 헤더가 없어 403
- 날짜 규약은 `format.ts` 상단 주석이 원문: 오늘=localDayKey, 서버 날짜→키=`slice(0,10)`(Date 왕복 금지), 키→서버=dayKeyToServer
- requested/rejected 상태 전이는 승인/반려 API로만(TASK_PATCH_STATUS 유지)
- 확인 다이얼로그는 브라우저 `confirm()` 금지, `ui.tsx`의 `useConfirm` 사용(9-5)
- 마이그레이션: `migrations/0000_init.sql` 뒤쪽에 멱등 DDL(IF NOT EXISTS 계열만, `DO $$`·CHECK 금지) + `shared/schema.ts` 동시 갱신
- 의존성 추가 금지, Tactile Soft/인디고 디자인 시스템 재사용, 서버측 멤버십 필터·strict zod·activity_log·sanitize 유지
- 테스트: `node --experimental-strip-types --test`(PGlite), 서버 테스트 앱은 harness의 makeTestApp(자동 CSRF 헤더)

**운영 리마인드(코드 외 — 사용자에게 안내만)**: ①LLM 키 미등록 상태 — Admin > LLM 설정에서 등록해야 회의록 추출·G6 LLM 보강이 실동작(코드는 mock으로도 동작해야 함) ②시크릿 로테이션(9-4)·prod 빌드 전환(9-5) 미완이면 재안내.

---

# 2. G1. 역할 개편 — owner 폐지, 매니저 = 프로젝트 최고 책임자

**확정 모델**: 프로젝트 역할은 **manager / member 2단**. 프로젝트 생성은 로그인 사용자 누구나 가능(현행 유지), **생성자는 그 프로젝트의 manager**가 된다. 사이트 축은 is_admin 그대로(G2에서 확장). site_role 도입은 하지 않는다(의도적 보류 — HANDOFF에 기록).

## G1-1. 스키마·마이그레이션

`shared/schema.ts:18`의 `MEMBER_ROLE = ["owner","manager","member"]` → `["manager","member"]`로 변경. `migrations/0000_init.sql` 뒤쪽에:

```sql
UPDATE project_members SET role = 'manager' WHERE role = 'owner';
```

(status/role에 DB CHECK 없음을 확인했으므로 이 한 줄이 전부다. 멱등: 재실행해도 무해.)

## G1-2. 서버 변경 (검증된 위치)

- `projects.ts:62·64` 프로젝트 생성 시 `role: "owner"` → `"manager"` (my_role 응답 포함)
- `projects.ts:82`(프로젝트 설정 PATCH), `:154`(역할 변경), `:173`(멤버 제거): `requireRole("owner")` → `requireRole("manager")`
- `projects.ts:182`의 "owner는 제거할 수 없습니다" 방어를 **마지막 매니저 가드**로 교체(아래)
- 역할 입력 zod: 역할 변경(:156)·멤버 추가·초대의 role 파라미터를 `z.enum(MEMBER_ROLE)`(=manager/member)로 통일 — "owner" 입력은 400
- **canManage류(`"owner" || "manager"` — tasks/ai/mcp/dependencies/comments/projectPages/skills/snippets/events/push.ts 등 10여 곳)는 그대로 둔다.** 마이그레이션 후 owner 행이 없으므로 무해하고, 혹시 남은 행에도 방어가 된다. 일괄 치환하지 말 것(불필요한 diff).

**가드레일 (신규, 서버 필수):**
1. **마지막 매니저 보호**: 역할 변경으로 manager→member 강등 시, 그리고 멤버 제거 시 — 대상이 그 프로젝트의 **유일한 manager면 400** "프로젝트에는 매니저가 1명 이상 필요합니다." (count 쿼리 후 판단)
2. **자기 자신 강등**: 서버는 허용(1번에 안 걸리면), 프론트에서 useConfirm으로 "본인을 멤버로 강등하면 이 프로젝트를 관리할 수 없게 됩니다" 확인
3. 역할 변경·제거는 기존대로 activity_log 기록(member.role_changed / member.removed) — 매니저 간 동급 조작의 감사 추적

## G1-3. 프론트

- `ProjectMembers.tsx:8·68`, `Projects.tsx:10`: ROLE_LABEL에서 "소유자" 제거, Select 옵션 manager/member만. ROLE_LABEL에 `owner: "매니저"` 폴백은 남겨둠(혹시 모를 잔존 행 표시용)
- ProjectMembers에 역할 변경·제거 버튼이 이제 매니저에게 노출(기존 owner 조건 → canManage)
- 마지막 매니저 대상 강등/제거 버튼은 비활성 + 툴팁(서버 400과 이중 방어)

## G1-4. 테스트 (신규 `server/src/test/roles.test.ts`)

①매니저가 다른 멤버 역할 변경 성공 ②매니저가 멤버 제거 성공 ③member의 역할 변경/제거 403 ④유일 매니저 강등 400 ⑤유일 매니저 제거 400 ⑥매니저 2명일 때 한 명 강등 성공 ⑦role="owner" 입력 400 ⑧생성자 my_role=manager ⑨(마이그레이션 검증) role='owner' 행 시드 후 마이그레이션 SQL 적용 시 manager로 전환 — harness가 마이그레이션을 이미 태우면 시드 자체가 불가하므로 이 항목은 스킵 가능(판단).

## G1-5. 기존 회원 추가 — 이메일 타이핑 → 선택 방식 (실사용 피드백)

**현행(검증됨)**: `POST /:projectId/members`가 이메일 **정확 일치**로만 사용자를 찾는다(projects.ts:196~ — 오타 시 404). 가입자 목록을 조회할 API는 어디에도 없다.

- 신규 `GET /api/projects/:projectId/addable-users` — requireMember + 매니저 전용. **이 프로젝트에 아직 없는** 활성 사용자 목록 반환(id, full_name, email — publicUser 재사용, 민감 필드 금지). 전역 `/users` 목록을 만들지 말고 이렇게 프로젝트 스코프로 좁힐 것(아무나 전 회원 열람하는 API 방지)
- `POST /:projectId/members`의 body를 `{ user_id: z.number().int(), role }`로 교체(이메일 방식 제거). is_active·중복 멤버십 검증은 기존 로직 유지, activity meta는 email 대신 user_id
- `ProjectMembers.tsx` "이미 가입한 팀원 추가" 탭: 이메일 입력 → **선택 목록**(이름+이메일 표시)으로 교체. 목록 위에 필터 입력(클라이언트 필터링 — 목록이 이미 스코프돼 있어 서버 검색 불필요) + 역할 Select + 추가 버튼. 추가 성공 시 목록 refetch
- **의도적 결정(HANDOFF 기록)**: 프로젝트 매니저는 전체 가입자의 이름·이메일을 보게 됨 — 사내 도구 전제. 외부 공개 운영으로 바뀌면 재검토 항목
- 테스트(member-add.test.ts 갱신): ①addable-users가 기존 멤버 제외 ②member 호출 403 ③user_id로 추가 성공 ④비활성 사용자 목록 제외·추가 400 ⑤중복 409 유지



원칙: **멤버십 필터는 절대 우회하지 않는다.** 관리자는 "전체를 보고, 원클릭으로 정식 멤버가 되어" 들어간다.

## G2-1. 전체 프로젝트 열람

- 신규 `GET /api/projects/all` (requireAuth + is_admin 검사 — admin.ts:11의 requireAdmin 패턴 재사용하되 admin.ts 라우터에 넣지 말고 projects.ts에 두어 응답 형태 통일): 전체 프로젝트 + 각각의 `my_role`(멤버면 역할, 아니면 null)·멤버 수 반환
- **★ 라우트 등록 순서 함정**: `/all`은 반드시 `/:projectId` 계열 라우트보다 **먼저** 등록할 것 — 뒤에 두면 "all"이 projectId 파라미터로 매칭돼 404가 난다. join-as-admin(`/:projectId/join-as-admin`)은 파라미터 라우트라 순서 무관
- `Projects.tsx`: is_admin(useAuth의 me에 is_admin 포함 여부 확인 — 없으면 /auth/me 응답에 추가)일 때 "내 프로젝트 / 전체" 탭 노출. 전체 탭에서 미참여 프로젝트는 흐리게 + "매니저로 참여" 버튼

## G2-2. 원클릭 참여

- 신규 `POST /api/projects/:projectId/join-as-admin` (requireAuth + is_admin — requireMember를 쓰면 안 됨: 아직 멤버가 아니다): projectMembers에 `role='manager'` insert(onConflictDoNothing — 이미 멤버면 409 대신 기존 멤버십 반환해도 무방, 하나로 정해 테스트와 일치시킬 것), activity_log `member.admin_joined`
- 참여 후 클라는 해당 프로젝트 보드로 이동

## G2-3. Admin > 사용자 관리 (신규)

- `server/src/routes/admin.ts`에 추가: `GET /admin/users`(id, email, full_name, is_admin, created_at — password_hash 등 민감 필드 절대 미포함), `PATCH /admin/users/:id` body `{ is_admin: boolean }` strict
- **마지막 관리자 가드**: is_admin=false로 바꿀 때 관리자 수가 1이면 400 "관리자는 1명 이상 필요합니다."(본인 해제 포함)
- `Admin.tsx`에 "사용자 관리" 섹션: 목록 + 관리자 토글(useConfirm). 이것이 "두 번째 관리자 지정 방법 부재" 공백을 메운다

## G2-4. 테스트 (신규 `server/src/test/admin-access.test.ts`)

①일반 유저 /projects/all 403 ②admin 전체 목록에 미참여 프로젝트 포함(my_role null) ③admin join-as-admin 후 그 프로젝트 태스크 접근 가능 ④일반 유저 join-as-admin 403 ⑤admin users 목록에 민감 필드 없음 ⑥관리자 지정/해제 동작 ⑦마지막 관리자 해제 400.

---

# 4. G3. 태스크 상세 개편 — 설명 완성 + 탭 재배치 + 삭제

## G3-1. 설명 기능 완성 (현재: 표시 코드만 있고 입력 UI가 없음 — 검증됨)

- 서버는 PATCH whitelist에 description이 이미 있으므로 변경 불필요
- `TaskDetail.tsx`: 설명을 **탭 밖, 제목 바로 아래 상시 노출**. 매니저에겐 "편집"(설명 있을 때)/"+ 설명 추가"(없을 때) → textarea + 저장/취소. 멤버는 읽기 전용. 기존 요청 티켓 수정 폼(editTicket 경로)은 그대로 유지
- 빠른 추가(ProjectBoard:135)는 제목만 — 현행 유지

## G3-2. 탭 재배치 + 개명

- 탭 순서/라벨: `[체크리스트(기본 선택), 활동, 파일, 설정]` — "개요"를 "설정"으로 개명해 맨 뒤로
- **설정 탭 내용** = 우선순위 / 예정일·마감 / 담당자 / 선행 태스크 (기존 개요에서 설명 제외한 관리 항목)
- **서브태스크 섹션은 체크리스트 탭 하단으로 이동**(수행 성격), **출처 문서 배지는 제목·설명 아래로 이동**(정보 성격) — 개요 해체 시 누락 금지
- 기본 탭이 체크리스트가 되므로: 체크리스트 0건일 때 EmptyState("아직 체크리스트가 없어요" + 매니저면 추가 입력 바로 노출) 확인
- requested 티켓의 트리아지/철회 배너는 탭 위(헤더 영역) 유지 — R1 요소 보존

## G3-3. 삭제

- **태스크 삭제 버튼**: TaskDetail 헤더 우측(매니저만, 서버 DELETE는 이미 매니저 허용 — UI만 부재였음). useConfirm("이 태스크와 체크리스트·댓글이 함께 삭제됩니다") → 성공 시 보드로 이동. 리스트/칸반 카드에는 넣지 않는다(오삭제 방지 — 의도적 결정)
- **체크리스트 삭제 규칙 변경**: 현재 "담당자 또는 매니저"가 추가/수정/삭제 전부 가능 → **추가·수정(체크 토글 포함)은 담당자+매니저 유지, DELETE만 매니저 전용**으로 좁힘(`tasks.ts` 체크리스트 DELETE 라우트). UI에서 삭제 버튼은 매니저에게만 노출
- 기존 checklist 관련 테스트(r0-hardening 등)에서 "담당자 삭제 성공" 케이스가 있으면 매니저 전용으로 갱신

## G3-4. 테스트

기존 태스크 테스트 보강: ①매니저 설명 PATCH 성공(이미 있으면 스킵) ②담당 member 체크리스트 추가/토글 성공 + DELETE 403 ③매니저 체크리스트 DELETE 성공. UI 재배치는 수동 확인 항목.

---

# 5. G4. 보드/캘린더 UX (작은 패치 2건)

## G4-1. 팀원 선택 음영 강화

- `ProjectBoard.tsx:103` chip 함수: active를 `border-brand bg-brand font-semibold text-white`로(연한 인디고 → 꽉 찬 인디고 반전). 카운트 스팬 색 대비 확인(text-white/80)
- 주간 그리드 팀원 헤더(~:408)의 선택 상태 `bg-indigo-50/70` → `bg-brand-100 ring-2 ring-inset ring-brand` + 이름 font-bold. 선택된 팀원의 **본문 셀 열에도** 옅은 배경(bg-brand-50/50)을 줘서 열 전체가 선택돼 보이게

## G4-2. 할일/일정 시각 구분 + 범례

- EventChip(EventStrip.tsx)에 lucide Clock 아이콘 + 좌측 2px 에메랄드 색 바 추가 — "칩"이 아니라 "일정"으로 읽히게
- 캘린더 헤더(월/주/일 공통 위치)에 한 줄 범례: `● 할 일   ⏱ 일정` (기존 색 그대로, 작게 text-xs). 월 뷰에도 동일 칩 스타일 적용 확인

수동 확인 외 테스트 불필요.

---

# 6. G5. 회의록 v2 — 원문·수정/삭제·정직한 0건·반영 대상 확장

**검증된 현행 사실**: 상세 화면에 원문(source_text)이 전혀 표시되지 않는다. process(:103~)는 재추출 시 **suggested만 삭제하고 accepted/edited/rejected 중 accepted는 보존**... 정확히는 status='suggested'만 삭제 — 즉 "반영분 보존" 정책이 이미 있다(G5-2가 공짜로 상속). meetingNotes의 작성자 필드는 `uploaded_by`. noteExtractions에는 linked_task_id/linked_comment_id만 있다.

## G5-1. 원문 표시 + LLM 모드 배지

- `GET /meetings/:id` 응답에 `llm_mode: "mock" | "live"`(lib/llm.ts의 isMockLlm) 추가
- `Meetings.tsx` 상세: 제목 아래 **"원문" 접기/펼치기 카드**(추출 0건이면 기본 펼침, 있으면 접힘). whitespace-pre-wrap 표시
- llm_mode==="mock"이면 배지: "LLM 미연결 — 규칙 기반 추출(정확도 제한)" + admin이면 "Admin > LLM 설정에서 키 등록" 안내

## G5-2. 회의록 수정 · 삭제 (신규 라우트)

- `PATCH /api/meetings/:id` body `{ title?, source_text? }` strict — **uploaded_by 본인 또는 매니저**. source_text 변경 시 응답에 힌트 플래그(클라가 "원문이 바뀌었어요 — 다시 추출을 권장" 표시). 기존 process의 suggested-only 삭제 정책 덕에 재추출 시 반영분은 자동 보존됨 — 추가 로직 불필요, 주석으로 명시
- `DELETE /api/meetings/:id` — uploaded_by 본인 또는 매니저, useConfirm. extractions는 FK cascade로 삭제되고 **이미 생성된 태스크/가이드 댓글은 살아남는다**(FK가 extraction→task 방향이므로 자동) — 테스트로 보증
- UI: 상세 헤더에 수정(제목·원문 편집 모드)/삭제 버튼. 수정 저장은 api.patch

## G5-3. 0건일 때 정직한 안내

- 추출 후 0건이면(스크린샷의 혼란 지점) 플레이스홀더를 상태별로 분기: note.status==="processed" && 0건 → "추출된 항목이 없어요 — 원문에 결정·실행·일정 문장이 없거나, 규칙 기반 추출의 한계일 수 있어요." (+mock 배지와 연동). 미처리 상태면 기존 문구 유지

## G5-4. 반영 대상 확장 — 체크리스트·일정

**스키마** (`shared/schema.ts` + 마이그레이션 멱등 DDL):
- `EXTRACT_KIND`에 `"event"` 추가
- note_extractions에 컬럼 추가: `when_suggested text`(추출기가 제안한 일시 문자열), `linked_event_id integer REFERENCES events(id) ON DELETE SET NULL`, `linked_checklist_item_id integer REFERENCES checklist_items(id) ON DELETE SET NULL`

**추출기** (`lib/meetingExtract.ts`):
- mock classify에 event 규칙 추가(기존 규칙보다 **먼저** 평가): 텍스트에 날짜 패턴(`\d{1,2}\s*[\/.월]\s*\d{1,2}` 또는 `내일|모레|다음\s*주`)과 일정 키워드(회의|미팅|발표|리뷰|마감|데모)가 함께 있으면 kind=event, when_suggested에 매칭 문자열 저장(정확 파싱은 승인 단계에서 사람이 확정 — mock은 원문 그대로 넘겨도 됨)
- LLM 프롬프트: kind 목록에 event 추가 + `"when": "YYYY-MM-DD" 또는 "YYYY-MM-DDTHH:mm" 또는 null` 필드 요구, 파싱 시 when→when_suggested

**승인 API** (`PATCH /meetings/extractions/:id` 확장, strict zod):
- body에 `apply_as?: "task" | "checklist"`(action 항목용, 기본 task), `starts_at?/all_day?`(event 항목용) 추가
- action + apply_as="checklist": `task_id` 필수(같은 프로젝트 검증 — 가이드와 동일 패턴), checklistItems insert, linked_task_id·linked_checklist_item_id 기록
- kind=event 승인: `starts_at` 필수(ISO). events insert(project_id=note.project_id, title=content 앞 120자, all_day 기본 true, created_by=승인자) + **생성자 자동 참석 규칙 재사용**(events.ts 생성 로직의 attendee insert 부분을 헬퍼로 추출하거나 동일하게 수행), linked_event_id 기록, activity `event.created` meta via:meeting
- 응답/UI: 승인 버튼 분기 — action은 "태스크로 반영 ▾"(태스크/체크리스트 선택, 체크리스트 선택 시 대상 태스크 Select — 가이드 UI 재사용), event는 날짜(+시간 선택)와 종일 토글 인라인 입력(기본값: when_suggested를 input에 프리필 시도, 파싱 실패 시 빈 값) 후 "일정으로 반영". 반영 후 "→ 일정으로 생성됨"/"→ 체크리스트로 추가됨" 표시

## G5-5. 테스트 (신규 `server/src/test/meetings-v2.test.ts`)

①uploaded_by 본인 PATCH 성공, 타 member 403, 매니저 성공 ②source 수정 후 재추출 시 accepted 항목 보존 + suggested 갱신(기존 정책 회귀 방지) ③DELETE 후 생성됐던 태스크 생존 ④action을 checklist로 반영 — 항목 생성 + 링크 기록, 타 프로젝트 task_id 400 ⑤event 승인 시 starts_at 없으면 400, 있으면 events 생성 + 참석자(승인자) + linked_event_id ⑥mock 추출기가 "7/10 오후 3시 전체 회의" 류 문장을 event로 분류 ⑦GET 상세에 llm_mode 포함.

---

# 7. G6. 문서 분해 — 설계 문서 → 태스크+체크리스트 (R2의 핵심)

컨셉: 전체 설계/기획 문서가 상위, 태스크·체크리스트가 그 세부 분해(WBS). **자동 등록이 아니라 "분해 제안 → 검토 → 전체 반영 2클릭"** — §13(AI는 제안, 사람이 승인) 유지. 회의록 구조화와 같은 정신, 다른 점은 제안을 DB에 저장하지 않고 휘발성으로 다룬다(검토 즉시 반영이 기본 흐름이므로).

## G6-1. 분해 엔진 (신규 `server/src/lib/pageDecompose.ts`)

`decomposePage(markdown): { tasks: [{ title, description?, checklist: string[] }] }`

- **구조 기반(LLM 키 없어도 동작 — 필수)**: `##`/`###` heading → 태스크 후보(제목=heading 텍스트), 그 섹션의 최상위 불릿(`- `·`* `·`◦` 등) → 해당 태스크의 체크리스트 항목. heading이 없는 문서는 최상위 불릿 → 태스크, 들여쓴 하위 불릿 → 체크리스트. **비작업 섹션 스킵 목록**: 제목이 `개요|배경|참고|목적|부록|용어|references?` 패턴이면 제외. 제목 200자·체크 항목 300자 절단, 태스크 최대 30개·태스크당 체크 20개 상한
- **LLM 보강(키 있으면)**: 구조 기반 결과를 두고 LLM에 JSON 정제 요청(작업 아닌 항목 제거, 제목을 동사형으로 다듬기) — meetingExtract.ts의 getLlm/isMockLlm/JSON 파싱 방어 패턴 그대로 재사용. LLM 실패 시 구조 기반 결과로 폴백(throw 금지)

## G6-2. API (`routes/projectPages.ts`에 추가)

- `POST /pages/:pageId/decompose` — **매니저 전용**(대량 생성 권한 = 관리 행위. member는 기존 드래그 파생=티켓 경로 유지 — 의도적 결정, HANDOFF 기록). 응답: `{ suggestions, derived_titles }` — derived_titles는 이 페이지에서 이미 파생된(source_page_id) 태스크 제목 목록(클라의 중복 표시용). llm_mode도 포함
- `POST /pages/:pageId/apply-decomposition` — 매니저 전용. body: `{ tasks: [{ title(min1 max200), description?, checklist: string[](max20, 각 max300) }] }`(max 30, strict). 각 태스크를 createTaskWithKey(kind=task, status=todo, source_page_id=pageId, created_by=호출자)로 생성 + checklistItems insert. 응답: 생성된 태스크 목록(item_key 포함). activity_log `page.decomposed` meta { count }
- 페이지가 해당 프로젝트 소속인지 검증(기존 패턴)

## G6-3. UI

- `ProjectPages.tsx`/`PageEditor.tsx`: 에디터 헤더에 **"태스크로 분해"** 버튼(매니저만, lucide Wand2 — 회의록과 같은 아이콘 언어)
- 신규 `components/DecomposeModal.tsx`: 제안 트리 렌더 — 태스크 행(체크박스 + 인라인 제목 수정) / 하위 체크리스트 항목(개별 체크박스). **derived_titles와 제목이 정확히 일치하는 항목은 "반영됨" 배지 + 기본 체크 해제**(재분해 시 중복 방지 — 느슨한 판정임을 주석으로 명시, 정밀 앵커 추적은 스코프 컷). 하단 "선택 반영 (N개 태스크)" 버튼 → apply 호출 → 성공 토스트에 생성된 item_key 요약, 문서 하단 파생 태스크 패널 refetch
- mock 모드 배지(G5-1과 동일 문구) — 분해 품질 기대치 관리
- 반영 후 보드로 이동하지 않고 문서에 머무름(연속 작업 흐름)

## G6-4. 테스트 (신규 `server/src/test/decompose.test.ts`)

①heading+불릿 문서의 구조 분해 정확성(태스크 수·체크 매핑) ②"참고/배경" 섹션 제외 ③heading 없는 불릿 문서 분해 ④member decompose/apply 403 ⑤apply가 태스크+체크리스트 생성, source_page_id 연결, 파생 목록(derived-tasks)에 등장 ⑥한도 초과(31개 태스크) 400 ⑦빈 title 400 ⑧응답에 derived_titles 포함(기존 파생 태스크 시드 후).

---

# 8. 완료 기준 요약

| 그룹 | 핵심 기준 |
|---|---|
| G1 | owner 데이터·입력·UI 소멸 / 매니저가 역할변경·제거 / 마지막 매니저 가드 / canManage 미변경 / 팀원 추가가 선택 방식(addable-users) |
| G2 | admin 전체 목록·원클릭 매니저 참여(멤버십 필터 무손상) / 사용자 관리 + 마지막 관리자 가드 |
| G3 | 설명 편집 가능 + 상시 노출 / 탭 [체크리스트*·활동·파일·설정] / 서브태스크·출처문서 이동 누락 없음 / 태스크 삭제 UI / 체크리스트 DELETE 매니저 전용 |
| G4 | 선택 칩 반전·주간 그리드 열 강조 / 일정 칩 아이콘+색바 / 범례 |
| G5 | 원문 표시·수정·삭제 / 재추출 반영분 보존 회귀 방지 / 0건 정직 안내+mock 배지 / 체크리스트·일정 반영 |
| G6 | 키 없이 구조 분해 동작 / 매니저 전용 / 2클릭 일괄 반영 + 양방향 링크 / 재분해 중복 표시 / 한도 |

# 9. 최종 검증

```bash
npm run check
node --experimental-strip-types --test server/src/test/*.test.ts   # 파일별 분할 실행 권장
npm run build
grep -rn "\"owner\"" client/src   # UI 잔존 owner 옵션 없는지
grep -rn "confirm(" client/src | grep -v useConfirm   # 브라우저 confirm 잔존 금지
```

**브라우저 수동 시나리오**: 관리자 계정 — 전체 탭 → 미참여 프로젝트에 매니저로 참여 → 사용자 관리에서 두 번째 관리자 지정 → 마지막 관리자 해제 시도(차단 확인). 매니저 — 팀원 화면에서 가입자 **선택**으로 추가(이메일 타이핑 없음), 멤버 역할 변경/제거, 유일 매니저 강등 차단, 태스크 설명 추가, 태스크 삭제, 체크리스트 삭제. 팀원 — 체크 토글 가능·삭제 버튼 없음, 설명 읽기 전용. 캘린더 — 선택 음영, 일정 칩/범례. 회의록 — 원문 펼치기, 수정 후 다시 추출(반영분 보존), "7/10 3시 회의" 문장 event 추출 → 날짜 확정 → 캘린더 표시, 회의록 삭제 후 태스크 생존. 문서 — 설계 문서 붙여넣기 → 태스크로 분해 → 일부 해제·제목 수정 → 반영 → 보드/체크리스트 확인 → 재분해 시 "반영됨" 표시.

# 10. 완료 후

1. `HANDOFF.md`에 **9-6 세션 업데이트**: 완료 목록 / 변경 파일 / 신규 API(6개+) / 신규 테스트 수 / **의도적 결정 기록**(site_role 보류, 분해 매니저 전용, 삭제 UI 상세 화면만, 중복 판정 느슨함, 이벤트 반영 all_day 기본) / 다음 세션 주의(owner는 더 이상 유효 역할 아님, 체크리스트 DELETE 규칙)
2. `NEXT_SESSION_PROMPT.md` 갱신(남은 후보: ICS 피드, 소프트삭제, prod 빌드 전환, pgvector 확인, LLM 키 등록 여부)
3. Git: `git checkout -b feature/r2-roles-docs-meetings`, 그룹별 커밋(`feat: merge owner into manager` → `feat: admin global visibility + user mgmt` → `feat: task detail rework` → `feat: board/calendar polish` → `feat: meetings v2` → `feat: page decomposition` → `docs: handoff 9-6`) → main 반영 → Replit 재배포 확인

# 11. 개발 중 절대 주의 (요약)

1. 멤버십 필터에 admin 우회 절대 금지 — 관리자 접근은 join-as-admin으로만
2. canManage의 "owner" 문자열 일괄 치환 금지 / requireRole("owner") 3곳만 manager로
3. 마지막 매니저·마지막 관리자 가드는 서버가 최종 방어(프론트 비활성은 보조)
4. 클라 신규 코드는 api.ts 래퍼 필수(생 fetch = CSRF 403), 확인창은 useConfirm
5. 재추출의 suggested-only 삭제 정책을 건드리지 말 것(반영분 보존이 여기 걸려 있음)
6. G6 분해는 LLM 키 없이도 반드시 동작(구조 기반이 본체, LLM은 보강) / LLM 실패 시 폴백
7. event 반영·분해 반영 모두 사람 승인 후 생성 — 자동 등록 금지(§13)
8. 마이그레이션은 IF NOT EXISTS 계열 + UPDATE 한 줄만, DO $$·CHECK 금지
9. 날짜는 format.ts 규약 준수(when_suggested는 자유 문자열, 확정 값만 ISO)
10. 새 라이브러리 금지, 그룹마다 check+테스트 통과 후 진행
