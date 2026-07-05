# DevFlow — 개발팀 프로젝트·할일·가이드 관리 시스템 개발 프롬프트 (v3 · MVP 개발판)

> AI 코딩 에이전트(Claude Code / Replit / Lovable)에 그대로 투입하는 빌드 스펙.
> **핵심 원칙: §1 MVP(P0~P5)를 먼저 완성한다.** GitHub·MCP·라이브 프리뷰·고급 AI(P6~P10)는 MVP가 동작한 뒤 붙인다.
> 프로세스: 빌드 순서를 반드시 순차 진행, 각 Phase 종료 시 §12 품질 기준 통과 + 커밋 + 확인.
> 언어 규칙: 사용자 노출 문구·주석은 한국어, 코드 식별자·로그·DB 컬럼은 영어(snake_case).
> 환경: **외부 인터넷망**, **모바일 반응형 PWA**, **배포 벤더 독립**(로컬 Docker → 어느 서버든).
>
> **✅ 구현 현황(2026-07-02): P0~P10 전 단계 구현 완료** (테스트 37개 통과). 스펙과 다르게 구현했거나 추가된 사항은 §15 참고. P11~P13·회의록 파이프라인은 미착수. 세부 인수인계: `devflow/HANDOFF.md`.

---

## 0. 제품 한 줄 정의
개발팀이 **프로젝트별로 팀원을 배정**하고, 팀원마다 **매일 할 일을 지정**하며, **완료 체크**하고, 할 일 밑에 **가이드/조언 댓글(+파일 첨부)**을 달아 **팀원별 가이드 수행 여부까지 추적**한다. 프로젝트 종료 시 **applied된 가이드·노하우를 재사용 가능한 SKILL.md로 추출**한다.

## 1. MVP 정의 ★ (이것부터 — 성공 기준)
초기 MVP는 다음 5개 플로우가 **모바일에서** 완결되면 성공으로 본다.
1. owner가 프로젝트를 만들고 **초대 토큰**으로 팀원을 추가한다.
2. manager가 팀원에게 **`scheduled_date`(오늘 할 일)**를 배정한다.
3. 팀원이 **My Work**에서 오늘 할 일을 보고 태스크를 **완료 처리**한다.
4. manager가 태스크에 **가이드 댓글**을 남기고, 팀원이 **applied/skipped + guide_note**를 남긴다(팀원별 추적).
5. 프로젝트 종료 시 **applied 가이드 + guide_note + 해결 blocker**를 모아 **SKILL.md 초안**을 생성한다.

이 흐름이 DevFlow의 진짜 차별점이다. **GitHub·MCP·라이브 프리뷰·고급 AI 블록은 MVP 이후로 둔다.**

## 2. 벤치마킹 기준선 (차용할 패턴만)
- **monday.com Updates 패널**: 태스크 안에 댓글·멘션·**파일 첨부**·활동 로그 통합.
- **monday My Work / Asana My Tasks**: 전 프로젝트 통합 "오늘 할 일" 데일리 뷰.
- **GitHub PR 리뷰**: conversation resolve + 체크리스트 done = "가이드 주고 → 수행 체크"의 원형.
- **monday dev(후속)**: item_key로 커밋·PR 연결, PR 머지→태스크 완료.
- **Linear**: 이슈=원자 단위, 커스텀 상태, 키보드 속도.
차별점: 기성 앱은 **가이드 수행 추적 + SKILL.md 노하우 추출**을 커스터마이즈 못 한다. 우리는 이걸 1급 기능으로 내장한다.

## 3. 기술 스택 (배포 벤더 독립)
- **프론트**: React 19 + TS + Vite, shadcn/ui(Radix) + Tailwind, TanStack Query, wouter, react-hook-form + zod. **mobile-first**.
- **백엔드**: Express + TS, Drizzle ORM.
- **DB**: PostgreSQL + **pgvector**(AI는 후속이지만 확장은 P0에서 활성화).
- **인증**: 이메일/비밀번호 + express-session + connect-pg-simple + bcryptjs(cost 12) + **초대 토큰**.
- **알림/PWA**: web-push(VAPID) + 서비스워커, 설치형 PWA. node-cron(Asia/Seoul).
- **파일**: multer + **S3 호환 스토리지 어댑터**(로컬=MinIO, 배포=S3/R2/Supabase Storage 중 무엇이든). sharp 썸네일.
- **AI(후속)**: LLM API + pgvector RAG. 프로바이더는 env로 교체 가능하게 추상화.

**배포 독립성(필수)**:
- 모든 설정은 **env**(`DATABASE_URL`, 스토리지 키, LLM 키 등). 코드에 벤더 하드코딩 0.
- **docker-compose**로 전체 스택(app + Postgres/pgvector + MinIO)을 정의 → `docker compose up` 하나로 로컬이 프로덕션 복제본.
- 표준 Node+Express+Postgres만 사용(서버리스 전용 API 금지) → Replit Reserved VM·VPS·Render·Railway·Fly 어디든 그대로 배포.
- 스토리지는 **어댑터 인터페이스 하나**(put/get/delete/presign)로 추상화 → 구현체만 교체.

## 4. 모바일 반응형 + 로컬 모바일 테스트
- **mobile-first**: 데스크톱 사이드바 = 모바일 하단 탭바. 태스크 상세·댓글·가이드 수행 체크·첨부 업로드가 **모바일에서 완결**. 터치 타깃 ≥44px. 리스트/보드는 모바일에서 카드 스택.
- 파일 첨부: 모바일 카메라/갤러리 직접 업로드.
- **로컬 모바일 테스트(배포 없이)**:
  - 서버를 `0.0.0.0` 바인딩(Vite는 `server.host: true`).
  - *빠른 화면 확인*: 같은 와이파이 → 폰에서 `http://<PC-IP>:5000`.
  - *PWA 전체 테스트*: **`cloudflared tunnel --url http://localhost:5000`** 또는 `ngrok http 5000` → 공개 HTTPS 주소. **웹푸시·홈화면 설치·카메라는 HTTPS(보안 컨텍스트)에서만 동작**하므로 터널 필수.

---

## 5. 데이터 모델 (Drizzle 기준)
공통: 주요 테이블에 `created_at`, **`updated_at`** 포함. (소프트삭제 `deleted_at`은 기본 미채택 — 필요 시에만.)

```
users            id, email(unique), username(AES-256-GCM), full_name,
                 password_hash(nullable), avatar_url, is_active, created_at, updated_at
sessions         (connect-pg-simple)
invites          id, email, project_id(nullable), role, token_hash(서명·해시), 
                 expires_at, accepted_at, created_by, created_at
                 -- 초대 링크로만 가입/비번설정 (선착순 탈취 방지)
api_tokens       id, user_id, token_hash, name, scopes(text[]),
                 expires_at, last_used_at, revoked_at, created_at
                 -- 원문 저장 금지. 발급 시 1회만 원문 노출, DB엔 해시. MCP MVP·개인 API용.

projects         id, key(unique, 'PRJ'), name, description,
                 status['active'|'archived'|'completed'], owner_id,
                 next_task_seq int NOT NULL DEFAULT 1,   -- ★ item_key 동시성 방지 카운터
                 github_repo(nullable), start_date, end_date, created_at, updated_at
project_members  id, project_id, user_id, role['owner'|'manager'|'member'],
                 joined_at   UNIQUE(project_id, user_id)   -- 역할은 프로젝트마다 독립

tasks            id, project_id, item_key('PRJ-123'), title, description(markdown),
                 status['todo'|'in_progress'|'blocked'|'done'], priority(0-3),
                 label, due_date, scheduled_date, parent_task_id(nullable),
                 created_by, sort_order, created_at, updated_at, completed_at
task_assignees   task_id, user_id   UNIQUE(task_id, user_id)   -- 복수 담당
checklist_items  id, task_id, content, done, done_by, done_at, sort_order

comments         id, task_id, author_id, body(markdown), parent_id(스레드),
                 checklist_item_id(nullable),  -- ✅추가: 체크리스트 항목별 리뷰/피드백 스레드
                 is_guide(bool), created_at, updated_at
                 -- 가이드 수행 상태는 comments가 아니라 guide_assignees에 있음(팀원별 추적)
                 -- checklist_item_id는 같은 태스크의 항목만 허용(서버 검증, 교차참조 차단)
guide_assignees  id, comment_id, user_id,               -- ★ 리뷰 반영: 팀원별 가이드 추적
                 state['pending'|'applied'|'skipped'] DEFAULT 'pending',
                 note, done_at   UNIQUE(comment_id, user_id)
                 -- 가이드 생성 시 태스크 담당자(task_assignees)마다 pending 행 생성.
                 -- 진행률 배지 = applied / 전체.

attachments      id, comment_id(nullable), task_id(nullable),
                 file_name, mime_type, detected_type, size_bytes, storage_key,
                 thumb_key(nullable), uploaded_by, created_at
                 -- detected_type = 서버 magic-number 판별값(§10). mime_type(클라값)은 신뢰 안 함.

activity_log     id, project_id, task_id(nullable), user_id, action, meta(jsonb), created_at
                 -- 생성/수정/상태변경/가이드수행/파일업로드 기록. 상태 이력도 여기서 커버(별도 테이블 불필요).
push_subscriptions id, user_id, endpoint, p256dh, auth, created_at
system_settings  key(pk), value   -- 스케줄러 멱등성 키

skills           id, project_id(nullable), title, category, name, description,
                 body(markdown, SKILL.md 형식), antipatterns(text),
                 source_refs(jsonb), tags(text[]), status['draft'|'published'],
                 extracted_at, created_by, created_at, updated_at
```

**후속 Phase 테이블** (✅ 전부 구현되어 본 스키마에 포함됨 — sprints만 미채택):
```
task_dependencies  task_id, depends_on_task_id  PK(둘 다)              -- ✅P6(Gantt, 사이클 방지 BFS)
sprints            id, project_id, name, goal, start_date, end_date, active  -- P6(선택, 미채택)
embeddings         id, project_id, source_type['task'|'comment'|'skill'], source_id, content,
                   embedding(vector 1536), embedding_model, embedding_version,
                   content_hash, source_updated_at, created_at
                   UNIQUE(source_type, source_id)                      -- ✅P7
embedding_jobs     id, source_type, source_id, status['pending'|'done'|'failed'],
                   attempts, error, created_at, updated_at
                   UNIQUE(source_type, source_id) — 업서트 큐          -- ✅P7 (재색인·재시도, cron 5분)
github_links       id, task_id, kind['commit'|'pr'|'branch'|'issue'],
                   external_id, url, title, state, ci_status, meta, created_at
                   UNIQUE(task_id, kind, external_id)                  -- ✅P8
webhook_events     id, delivery_id(unique), event_type, payload(jsonb),
                   processed_at, created_at                            -- ✅P8 (서명검증+멱등)
snippets           id, project_id, task_id(nullable), title, files(jsonb 멀티파일),
                   created_by, created_at, updated_at                  -- ✅P9 (스펙에 없던 테이블, 추가)
```
> 선택(요구 발생 시): `notification_deliveries`(푸시/이메일 발송 원장, 재시도 추적), `mentions`, `comment_reactions`. MVP는 활동 로그 + 멱등성 키로 충분.

**item_key 생성 규칙(동시성)**: 태스크 생성은 트랜잭션 내에서 `UPDATE projects SET next_task_seq = next_task_seq + 1 WHERE id=? RETURNING next_task_seq` 로 원자 증가 → `key || '-' || seq`. 동시 생성 시 번호 충돌 방지.

**롤업**: 서브태스크(parent_task_id) 전부 done → 부모 자동 done. 진척률 = done/total.

---

## 6. 화면·라우트
| 경로 | 화면 | Phase |
|------|------|------|
| `/login` | 로그인 / 초대 링크로 가입·비번설정 | ✅P1 |
| `/` | ✅변경: **활성(마지막) 프로젝트 보드로 자동 진입** (없으면 목록) | ✅ |
| `/my-work` | ✅이동: **My Work** — 오늘 내 할 일 + **팀원 오늘 할 일(추가)** + 마감 임박 + 미수행 가이드 | ✅P2 |
| `/projects` · `/projects/:id/members` | 프로젝트 목록 / 팀원 배정 | ✅P1 |
| `/projects/:id` | 프로젝트 보드 — **Calendar(주간 팀원별 그리드=기본/월/일) / Timeline / List / Kanban** + 팀원 칩 필터 | ✅P2+P6 |
| `/projects/:id/tasks/:key` | 태스크 상세 — 설명·체크리스트(항목별 피드백)·선행 태스크·GitHub 링크·AI 가이드 제안·Updates | ✅P2~P8 |
| `/projects/:id/skills` · `/skills` | 프로젝트 스킬 / 전사 스킬 라이브러리 | ✅P5 |
| `/ai` | AI 검색·Q&A·재색인 | ✅P7 |
| `/projects/:id/preview` | 라이브 프리뷰 (스니펫 에디터+sandbox 실행) | ✅P9 |
| `/api/webhooks/github` · `/api/mcp` | GitHub 웹훅 / MCP 서버 (UI 없음) | ✅P8·P10 |

---

## 7. 핵심 기능 명세

### 7.1 프로젝트 & 팀원 [P1]
생성자=owner. owner/manager가 **초대 토큰**(서명·해시·만료)으로 초대 → 프로젝트마다 role 부여. 역할은 프로젝트마다 독립. 권한: owner=전체 / manager=태스크·멤버·가이드 / member=배정 태스크 수행+댓글.

### 7.2 태스크 & "오늘 할 일" [P2]
태스크: 제목·설명·상태·우선순위·라벨·마감·**scheduled_date**·복수 담당·체크리스트·서브태스크(롤업). item_key는 §5 규칙으로 원자 생성.
- **데일리 배정**: manager가 팀원별 `scheduled_date=오늘` 지정 → My Work에 담당자별 노출.
- **완료**: 상태 done 토글 → completed_at + 진척률. 서브태스크 전부 done → 부모 자동 done.
- **뷰**: List / Kanban / Calendar(같은 데이터, 뷰 전환 시 동기화). **Timeline(Gantt)·의존성은 P6.**

### 7.3 댓글 & 가이드 & 팀원별 수행 추적 ★핵심 [P3]
- 태스크 상세 **Updates 패널**: 스레드 댓글(parent_id) + @멘션 + 활동 로그. 댓글 본문 마크다운은 **sanitize 후 렌더(§10)**.
- 댓글을 **"가이드"로 표시**(is_guide) → 생성 시 태스크 담당자마다 `guide_assignees` pending 행 생성.
- 각 담당자가 **[수행완료 ✅]/[해당없음 ⏭] + note** 마킹 → 자기 `guide_assignees` 행만 갱신.
- 태스크 상단 **가이드 진행률 배지**(applied/전체). 미수행 가이드는 My Work에 집계. **모바일에서 완결.**

### 7.4 파일 첨부 [P4]
S3 호환 어댑터에 저장, DB엔 storage_key. 이미지 sharp 썸네일, 문서 아이콘+다운로드. 모바일 카메라/갤러리. **보안(§10)**: magic-number 판별, private 버킷, 인가 후 presigned/스트리밍, attachment 헤더, SVG/HTML 실행 차단.

### 7.5 PWA 푸시 & 알림 [P4]
web-push(VAPID) + 서비스워커. 오늘 할 일·미수행 가이드·공유 알림. **멱등성 키(발송 후 기록)**로 중복 방지(서버 재시작/재시도 대비).

### 7.6 SKILL.md 노하우 추출 [P5] ★최종 산출물
- 트리거: 프로젝트 `completed`.
- 수집: 완료 태스크 + **applied 가이드(guide_assignees)** + guide_note + 해결 blocker(장점) / **skipped·실패·재발(단점)**.
- LLM이 카테고리별로 클러스터링 → **SKILL.md 형식** 생성: `name`, `description`(=언제 쓰는지 트리거), 본문(권장 패턴), **`antipatterns` 섹션**(단점을 같은 파일에 별도 태깅 → 재사용 시 장점+주의 동시 전달), `source_refs`(역추적).
- 사람이 draft 검수 → `published` → 전사 라이브러리. Claude Code/Cowork 스킬 폴더 내보내기.
> P5의 추출은 직접 LLM 호출로 가능(RAG 불필요). RAG 검색은 P7.

### 7.7~7.11 후속 기능 (✅ 전부 구현 완료 — 각 항목의 구현 방식 주석 참고)
- **[P6] 뷰 확장** ✅: Timeline(Gantt-lite: 기간 바+오늘선+←선행 표시) + `task_dependencies`(사이클 방지). 스프린트는 미채택.
- **[P7] AI RAG** ✅: ①인제스트(embedding_jobs + 메타 embedding_model/version/content_hash/source_updated_at) → ②권한·프로젝트 필터 검색 API → ③Q&A → ④AI 가이드 제안(사람 검토 후 등록) 구현. ⑤AI 블록은 /ai 페이지+태스크 상세 제안으로 대체. 임베딩 프로바이더: mock(오프라인 결정론)/openai 교체형.
- **[P8] GitHub 연동** ✅(변경: GitHub App 대신 **저장소 웹훅** 방식 — 기능 동일, 설정 단순): 웹훅(**서명검증+webhook_events 멱등**) + item_key 파싱 규칙(아래) + PR머지 자동완료(가드레일) + Git UI 패널. ci_status 컬럼은 있으나 check_run 이벤트 수집은 미구현.
  - item_key 파싱: 브랜치명·커밋·PR 제목/본문에서 `/\b[A-Z][A-Z0-9]{1,9}-\d+\b/` 감지, 다중 키 모두 연결(같은 external_id 중복 저장 안 함).
  - PR merged → `auto_complete_on_pr_merge` 켜진 프로젝트에서만 done. `require_checklist_done_before_auto_complete`, `require_guide_applied_before_done` 옵션. 자동 변경도 activity_log 기록.
- **[P9] 라이브 프리뷰** ✅: A tier(iframe sandbox="allow-scripts" srcdoc + CSP default-src 'none' 외부망 차단) + 파일 여러 개 + 저장 snippet(10파일/200KB 제한) + React/JSX(esbuild-wasm CDN 지연 로드). **npm 패키지 제외 유지.** (변경: "별도 오리진" 대신 srcdoc+sandbox — same-origin 미부여로 등가 격리)
- **[P10] MCP 서버** ✅: `/api/mcp` Streamable HTTP JSON-RPC(2025-03-26) 자체 구현(외부 boilerplate 미사용, 의존성 0) → DevFlow 도구(create_task/add_guide/mark_guide_done/list_my_tasks/get_task/devflow_search) → **api_tokens Bearer 인증 + 스코프** 구현. OAuth 2.1/PKCE·공개 배포는 미착수(멀티유저 외부 공개 시). **API 안정화(P8) 후 구현 원칙 준수.** 토큰 스코프: `task:read/write`, `guide:write`, `project:read` 적용(comment:write·skill:read는 예약).

---

## 8. API 설계 원칙
- REST. **모든 데이터 엔드포인트(GET 포함) = requireAuth + 프로젝트 멤버십 검사** 후 응답.
- 목록은 **서버 쿼리에서** 멤버십·역할 필터(클라이언트 필터 신뢰 금지).
- 생성=full zod parse, **PATCH=`insertSchema.partial()` 화이트리스트**(매스 어사인먼트 차단).
- 객체 단위 인가: task/comment/attachment/guide 접근 시 소속 프로젝트 멤버 확인.
- **MCP 래핑 대비**: 명시적 입력 검증·일관 에러 형식·페이지네이션·안정적 필드 계약 유지. 개인 액세스 토큰(`api_tokens`) 발급 엔드포인트는 P1에 둔다(P10에서 재사용).

## 9. 알림/스케줄러
- `0 9 * * *`(KST): 담당자별 오늘 할 일 + 미수행 가이드 다이제스트.
- `* * * * *`: 마감 임박 리마인더. `0 0 * * *`: 플래그 리셋.
- 서버 재시작 catch-up + **멱등성 키(발송 완료 후 기록)**. (대량 개인알림·재시도 추적이 중요해지면 `notification_deliveries` 원장으로 승격 — 선택.)

---

## 10. 보안 요구사항 (비협상)
1. **무인증 GET 금지**: 모든 데이터 엔드포인트 requireAuth + 멤버십 검사.
2. **선착순 계정탈취 금지**: 가입/비번설정은 **서버 서명 1회용 초대 토큰**으로만.
3. **매스 어사인먼트 차단**: 모든 PATCH `partial()` 화이트리스트.
4. **사용자 열거 차단**: 로그인 실패 메시지 일반화, 이메일 존재/실명 반환 금지. 인증 엔드포인트 rate limit + 계정 잠금.
5. **서버측 인가**: 역할/멤버십 필터를 서버 쿼리에서 강제.
6. **파일 업로드**: **magic number(파일 시그니처)로 타입 검증 — 클라이언트 mime 신뢰 금지.** 용량·확장자 화이트리스트. **버킷 private**, 다운로드는 **인가 검사 후 presigned URL 또는 스트리밍**. `Content-Disposition: attachment`. SVG/HTML 인라인 실행 차단(또는 sanitize).
7. **마크다운 XSS 방어**: 댓글·설명 렌더는 **DOMPurify/sanitize-html** 계열로 sanitize.
8. **API 토큰**: 원문 저장 금지 → **해시 저장**. 발급 시 1회만 원문 노출. `last_used_at`·`expires_at`·`revoked_at`·`scopes` 기록.
9. **GitHub 웹훅(P8)**: **`X-Hub-Signature-256` 검증** + `delivery_id` 기반 멱등(`webhook_events`) + replay 방지.
10. **라이브 프리뷰(P9)**: **별도 오리진** + `sandbox="allow-scripts"`(same-origin 금지) + **CSP로 `connect-src`·`form-action`·`frame-ancestors` 제한(외부 네트워크 차단)** + **실행 시간 제한·저장 크기 제한**.
11. **비밀번호**: 최소 8자, bcrypt cost 12. 세션 쿠키 httpOnly+secure+sameSite=lax.
12. **시크릿**: 전부 env. 저장 토큰(GitHub 등) 암호화.
13. **감사 로그**: 생성/수정/상태변경/가이드수행/파일업로드 activity_log 기록.

## 11. 빌드 순서

**── MVP (P0~P5) ──**
- **P0 스캐폴드**: 모노레포(client/server/shared) + Vite + Express + Drizzle + **docker-compose(app+Postgres/pgvector+MinIO)** + env 설정 + 세션 + **mobile-first 레이아웃 셸(하단 탭바)** + 헬스체크 + pgvector 확장 활성화.
- **P1 인증·프로젝트·멤버십**: 초대 토큰 인증, 프로젝트 CRUD, project_members(프로젝트별 역할), **api_tokens 발급/폐기**(P10 대비).
- **P2 태스크·오늘 할 일**: tasks(item_key 원자 생성) + task_assignees(복수 담당) + 상태/완료 + 체크리스트/서브태스크(롤업) + **My Work** + **List/Kanban/Calendar 뷰**.
- **P3 댓글·가이드·수행 추적**: Updates 패널(스레드 댓글, sanitize), is_guide + **guide_assignees(팀원별)** + 진행률 배지 + 미수행 가이드 집계.
- **P4 첨부·PWA 푸시**: S3호환 어댑터(magic-number 검증, presigned) + 썸네일 + 웹푸시 + 알림 멱등성.
- **P5 SKILL.md 추출**: 프로젝트 종료 배치 → SKILL.md(+antipatterns) 초안 → 전사 라이브러리 + 스킬 폴더 내보내기.
→ 여기까지 §1의 5개 플로우 완성 = MVP.

**── 후속 (P6~P10) ── ✅ 전부 구현 완료 (2026-07-02, 테스트 37개 통과)**
- **P6** ✅ 뷰 확장(Timeline/Gantt + task_dependencies) · **P7** ✅ AI RAG(embedding_jobs+메타→검색→Q&A→가이드 제안) · **P8** ✅ GitHub 저장소 웹훅(서명+멱등, item_key 파싱, PR머지 가드레일, Git UI) · **P9** ✅ 라이브 프리뷰(iframe srcdoc→esbuild-wasm) · **P10** ✅ MCP 서버(도구+토큰 스코프. OAuth·공개 배포만 잔여).

## 12. 개발 품질 기준 (각 Phase 완료 조건)
- DB migration이 **재실행 가능**(idempotent)해야 한다.
- 모든 목록 API는 **서버에서 멤버십 필터**를 적용해야 한다.
- **모바일 390px 폭**에서 핵심 플로우가 깨지지 않아야 한다(터널 HTTPS로 실기기 확인).
- e2e 테스트에 **happy path 1개 + 권한 거부 케이스 1개** 포함.
- 생성/수정/상태변경/가이드수행/파일업로드가 **activity_log**에 기록.
- 타입체크 통과 + README에 진행상황 기록.

## 13. 금지사항
- 클라이언트에서만 권한 필터링 금지 · 무인증 GET 금지.
- **mock UI만 만들고 실제 DB 연결을 미루는 것 금지**(각 Phase는 실데이터로 동작해야 함).
- 파일 URL 직접 공개 금지(인가 후 presigned/스트리밍만).
- AI 응답을 근거 없이 저장하거나 자동으로 가이드 등록 금지(사람 검토 필수).
- **MCP 서버를 본체 API(P8) 안정화 전에 구현 금지.**
- 클라이언트 mime 신뢰 금지 · API 토큰 평문 저장 금지.

## 14. 비목표(초기 제외)
동시편집 커서, 다국어, 네이티브 앱(PWA 대체), 결제, monday급 무한 컬럼 커스터마이즈(고정 스키마 + 필요한 자동화만), npm 패키지 프리뷰, 소프트삭제(요구 발생 시 도입).

## 15. ✅ 구현 보강·스펙 정정 (실제 구현 기준, 2026-07-02)

**스펙에 없었으나 사용자 피드백으로 추가된 기능**:
- **주간 워크로드 그리드**: 캘린더 기본 화면. 열=팀원(주간 잔여 개수 뱃지, 0도 표시), 행=일~토, 셀=일 뷰와 동일한 태스크 카드. 누가 일이 있고 없는지 한눈에 비교.
- **팀원 칩 필터**: 보드 상단에 팀원별 잔여 할 일 개수 + 클릭 시 리스트/칸반/캘린더/타임라인 공통 필터.
- **My Work `team_today`**: 같은 프로젝트 팀원들의 오늘 할 일 크로스 체킹 섹션 (서버측 멤버십 필터).
- **체크리스트 항목별 리뷰/피드백**: comments.checklist_item_id — 항목 옆 말풍선으로 스레드, Updates 패널에 항목 태그 표시.
- **활성 프로젝트 = 메인 화면**: 로그인 → 마지막 프로젝트 보드 자동 진입(localStorage), 사이드바에 고정, 보드에 "오늘 내 할 일 N" 배지.
- **신규 태스크 기본 예정일=오늘**, 아바타 한글 이니셜(이름 뒤 2자), Pretendard 폰트 + 데스크톱 글자 스케일업(16→18px), 본문 폭 1536px.

**스펙 정정(실제 구현과 다른 부분)**:
- 프론트: React **18.3** (19 아님) · shadcn/ui 대신 **자체 경량 컴포넌트**(client/src/components/ui.tsx) — Tailwind 직접 사용.
- 테스트: vitest 아님 — **`node --experimental-strip-types --test` + PGlite**(인메모리 Postgres+pgvector). 서버/공용 코드는 TS enum·파라미터 프로퍼티 금지, 상대 임포트 `.ts` 확장자.
- P8: GitHub **App이 아니라 저장소 웹훅** — 서명·멱등·파싱·가드레일은 스펙대로. env `GITHUB_WEBHOOK_SECRET`.
- P7: 임베딩 mock(해시 기반, 오프라인)/openai(text-embedding-3-small, 1536차원) 교체형. **모델 교체 시 전체 재색인 필요**(차원 고정).
- 마이그레이션: 파일 분할 대신 **0000_init.sql 단일 파일 + 멱등 DDL(IF NOT EXISTS/ADD COLUMN IF NOT EXISTS) 추가 방식**.

---

# 후속 로드맵 (P11~P13 + 회의록 파이프라인)

> 아래는 **MVP(P0~P5) 완성 후** 붙이는 확장이다. 본문 스펙·MVP 개발엔 영향을 주지 않는다.
> 순서 원칙: **AI RAG(P7) → 회의록 파이프라인 → 그래프(P12)**. 검증(P11)은 GitHub·MCP와 독립이라 병렬 가능.

> **⚠ 검토 노트 (P0~P10 구현 완료 시점의 사전 검토 — 착수 전 반드시 반영)**
> 1. **P11 모순 해소 필요**: "로그인 회원 누구나 검증"은 공개 회원가입이 전제인데 §10.2는 초대 토큰 가입만 허용. 착수 전 **"가입은 공개(봇 방지 포함), 프로젝트 접근은 초대"로 §10.2 개정 결정** 필요. 1차는 링크/설명형 제출만, 정적 드래그드롭 호스팅(별도 오리진·zip-slip 방어)은 실서버 배포 후.
> 2. **회의록 파이프라인을 최우선 권장**: P7 인프라 재사용, 원칙(자동등록 금지) 일관, 실사용 가치 즉각적. 단 **LLM 키 필수 전제**(mock으론 추출 품질 없음).
> 3. **P12 착수 조건 강화**: Apache AGE는 테스트 하네스(PGlite)에서 미지원 → 도입 시 테스트 전략 재설계 비용 발생. 팀 규모 데이터는 백링크 테이블+recursive CTE로 충분할 가능성 큼. **1단계(명시적 백링크)로 답 못 하는 실제 질의가 쌓였을 때만 2단계(AGE) 착수.**
> 4. **P13은 단방향 export부터** (양방향 동기화는 충돌 처리 복잡).
> 5. **운영 전제 먼저**: 실서버 배포(HTTPS — 푸시·PWA·웹훅·갤러리 전부 전제), LLM 키, 소프트삭제(휴지통) 검토, 목록 API 페이지네이션(§8 명시됐으나 미구현 — 데이터 증가 시).
> 6. **권장 순서**: 회의록 → P11(링크형) → P12 1단계(백링크) → P13(export) → P12 2단계(AGE) → P11 정적 호스팅.

## P11 — 제품 검증·상용화 게이트

**목적**: 프로젝트가 끝나거나 외부에서 완성된 프로젝트를 등록해, **로그인한 회원 누구나** 검증(피드백·평점)하고, 기준 충족 시 상용화 후보로 승격 → 시장 생존성 사전 판단.

**가시성 두 계층**:
- *프로젝트 워크스페이스*(태스크·소스·가이드·회의록): 그 프로젝트 **팀원만**.
- *검증 갤러리*(제출된 완료/외부 프로젝트): **로그인한 회원이면 누구나** 열람·리뷰. 검증자는 제출물(데모/설명/스크린샷/정적 배포/공개첨부 소스)만 보고 내부 태스크·소스·회의록은 못 봄.
- 익명 없음 — 가입·인증한 회원만. 피드백 작성자 추적 가능.

**제출물 체험 방식**:
- *링크/설명형*(기본): 데모 URL + 스크린샷 + 설명.
- *정적 드래그드롭 호스팅*(cdsa.site 방식): ZIP/폴더/파일 업로드 → 압축 해제 → **오브젝트 스토리지에 배포 ID별 저장** → 공개 URL 발급(무빌드, 정적 전용) → (선택)PIN 접근제어. **본체와 다른 오리진**에서 서빙 + 프리뷰 격리 규칙(§10-10) 적용.
- *동적 프로젝트*: 소스 첨부 + Docker 실행 안내(P9 실행형 확장, 후속).

**데이터 모델**:
```
submissions        id, project_id(nullable), title, summary, demo_url,
                   static_deploy_key(nullable), source_attachment_id(nullable),
                   pin_hash(nullable), submitted_by, status['open'|'validated'|'rejected'],
                   created_at, updated_at
review_feedback    id, submission_id, reviewer_id, rating(1-5),
                   body(markdown, sanitize), category['ux'|'perf'|'bug'|'market'|'other'],
                   created_at
review_criteria    id, submission_id, label, required(bool), passed(bool), checked_by
verification_gate  submission_id, min_reviews, min_avg_rating,
                   require_all_criteria(bool)  -- 충족 시 status='validated'
```

**SKILL.md 연결(중요)**: 검증에서 나온 시장 피드백(반응 좋았던 기능/안 먹힌 것)이 §7.6 추출의 **장점·antipatterns로 흡수** → "시장 생존 노하우"까지 축적.

**보안**: 검증 갤러리 조회는 로그인 회원 전체 허용하되, 제출물 외 내부 데이터는 서버 스코프로 차단. 정적 배포물은 별도 오리진 + 강화 CSP + (선택)PIN. 남용 시 회원 정지 + rate limit.

## 회의록 → AI 구조화 파이프라인 (P7 직후)

**목적**: 외부 모델로 전사한 **회의 텍스트를 업로드**하면 AI가 구조화해 태스크·가이드·결정으로 축적 → 프로젝트 완성도·노하우 강화. (녹음·STT는 범위 밖 — 텍스트만 입력.)

**흐름**: 텍스트 붙여넣기/`.txt`·`.md` 업로드 → AI가 6종 추출(JSON) → **사람이 검토·수정 후** 실제 태스크/가이드로 반영 → 임베딩(P7)·그래프(P12) 연결 → SKILL.md(P5) 재료.

**추출 6종**: decision(결정) / action(→태스크) / guide(→가이드 댓글) / blocker·risk / open question / speaker 귀속(원문에 화자 표기 있을 때).

**데이터 모델**:
```
meeting_notes    id, project_id, title, note_date, source_text, format,
                 uploaded_by, status['uploaded'|'processed'|'reviewed'], created_at
note_extractions id, note_id, kind['decision'|'action'|'guide'|'blocker'|'question'],
                 content, speaker(nullable), source_excerpt,
                 status['suggested'|'accepted'|'rejected'|'edited'],
                 linked_task_id(nullable), linked_comment_id(nullable),
                 reviewed_by, created_at
```
`source_excerpt`로 결정이 회의록 어느 문장에서 나왔는지 역추적.

**원칙**: **자동 등록 금지** — AI는 제안(suggested)만, 태스크/가이드화는 사람 승인 후. 회의록은 **프로젝트 멤버만 접근**(§8), 검증 갤러리·외부 회원에 절대 비노출.

## P12 — 지식 그래프 + GraphRAG 인사이트 레이어

**목적**: 태스크·가이드·스킬·blocker·기술·사람·결정을 **네트워크로 엮어** 다중홉·전역 인사이트를 추출("반복되는 blocker 패턴", "이 기술 태스크들의 공통 가이드", "시장 반응 좋은 기능과 연결된 개발 패턴").

**스택(중요 — 별도 그래프 DB 불필요)**: **Apache AGE(Postgres 확장, openCypher) + pgvector를 같은 Postgres 인스턴스에.** 벡터 유사도 검색과 다중홉 Cypher 순회를 한 문장에서 JOIN — 동기화·이중쓰기 없음. 로컬은 pgvector+AGE 프리빌트 Docker 이미지 사용.

**그래프 구조**:
- 노드: project, task, guide, skill, blocker, person, tech/tag, decision, submission.
- 엣지(타입): task-has_guide→guide, guide-applied_by→person, skill-derived_from→guide, task-uses→tech, blocker-solved_by→guide, project-produced→skill, decision-led_to→task, submission-validated_by→feedback.

**GraphRAG(하이브리드)**: pgvector=의미 넓이, AGE 그래프 순회=연결 깊이. 단일홉/세부는 벡터, 다중홉/전역 이해는 그래프, 결합이 최적.

**단계적 구축(선투자 큼 — 반드시 순차)**:
1. **값싼 명시적 링크** 먼저 — task·guide·skill 간 타입 backlink. 온톨로지 없이 즉시 Obsidian식 가치.
2. **AGE 그래프 + 하이브리드 GraphRAG** — 다중홉 인사이트 쿼리.
3. **엔티티·관계 LLM 자동추출** — 손으로 온톨로지 짜지 않음. 비용은 LazyGraphRAG류로 절감.

**유의**: 벤치마크 향상은 과대평가 사례가 많음 → 자체 질의로 실측. 값어치 증명 후 착수(그래서 P12).

## P13 — Obsidian 호환 스킬 볼트 / LLM Wiki

**목적**: 추출된 SKILL.md 라이브러리를 **링크된 마크다운 볼트**로 내보내 Obsidian에서 열람·사고하고 Claude Code를 에이전트로 붙임(캡처=DevFlow, 사고=Obsidian).

**구현**: 스킬(마크다운)을 볼트로 export, P12 그래프 엣지를 `[[위키링크]]`로 변환 → Obsidian 그래프 뷰 + backlink. 마크다운 기반 양방향 동기화.

## 후속 플랫폼 성숙(필요 시)
분석 대시보드(속도·가이드 적용률·blocker 재발률), 자동화 레시피 확장, Slack/이메일 통합, SSO·세밀 감사(엔터프라이즈), 스킬 마켓플레이스(조직 간 공유), 다국어·네이티브 앱·결제.
