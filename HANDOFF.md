# DevFlow — 작업 인수인계 문서 (Handoff)

> 목적: 새 세션(fable 5.0 등)에서 **로스 없이 이어서** 작업하기 위한 현재 상태·구조·제약·다음 할 일 정리.
> 최종 갱신: MVP(P0~P5) 완료 + UI/UX 전면 재디자인 완료, 로컬 Docker 구동 검증까지.

---

## 0. 한 줄 요약
개발팀용 프로젝트·할일·가이드 관리 + SKILL.md 노하우 추출 웹앱(모바일 퍼스트 PWA).
스펙 문서 `devflow-build-prompt.md`의 **MVP(P0~P5)를 전부 구현**했고, 그 위에 Linear 스타일 UI로 전면 재작업까지 마친 상태.

## 1. 현재 상태 (무엇이 되어 있나)
- **P0~P5 전부 구현 완료.** §1의 5개 MVP 플로우(프로젝트 생성·초대→오늘 할 일 배정→My Work 완료→가이드 댓글+팀원별 수행 추적→프로젝트 종료 시 SKILL.md 추출) 모두 동작.
- **통합 테스트 31개 통과**(각 Phase happy path + 권한 거부 케이스 포함), 타입체크 클린.
- **로컬 Docker 구동 성공** (`docker compose up --build` → http://localhost:5000).
- **UI/UX 전면 재디자인 완료**: 사이드바/하단탭바, 아이콘(lucide), 아바타, 진행바, 상태·우선순위 색상, 빈 화면 온보딩 안내.
- **캘린더**: 월 그리드 뷰 + 팀원별 일 뷰(그 날짜에 멤버 수만큼 컬럼). **칸반 드래그앤드롭**으로 상태 변경.
- 마지막 클라이언트 재디자인 반영을 보려면 **재빌드 필요**: `docker compose up --build`.

## 2. 기술 스택
- 프론트: React 18 + TS + Vite, Tailwind, TanStack Query, wouter, react-hook-form, lucide-react
- 백엔드: Express + TS(런타임 tsx), Drizzle ORM, express-session + connect-pg-simple, bcryptjs(cost 12)
- DB: PostgreSQL + pgvector (확장은 P0에서 활성화, RAG는 후속 P7)
- 파일: multer + S3 호환 어댑터(로컬 파일/MinIO/S3 교체 가능) + sharp 썸네일, magic-number 검증
- 알림: web-push(VAPID) + 서비스워커 + node-cron(Asia/Seoul)
- AI(P5): LLM 프로바이더 env 교체(mock/openai/anthropic), 오프라인 시 결정론적 추출

## 3. 실행 / 개발 / 테스트
```bash
# 도커 (로컬이 프로덕션 복제본)
docker compose up --build        # app + Postgres/pgvector + MinIO, http://localhost:5000
docker compose down -v           # 데이터까지 초기화

# 로컬 개발
npm install
npm run db:push                  # 멱등 마이그레이션
npm run db:seed                  # (선택) 데모 데이터: owner@devflow.local / member@devflow.local (pw password123)
npm run dev                      # server(5000) + vite(5173)

npm run check                    # tsc 전체 타입체크
npm test                         # 통합 테스트
```
첫 접속: 로그인 화면 → **"최초 설정"** 탭에서 관리자(owner) 생성 → 프로젝트/초대/태스크/가이드/스킬 순.

## 4. ★ 개발 환경 제약 (이전 세션이 겪은 함정 — 반드시 숙지)
이 프로젝트는 특정 샌드박스에서 개발됐고, 아래 제약을 우회하는 방식으로 구성돼 있음. **로컬 코드/구조는 표준**이며 아래는 "테스트/실행" 관련 주의사항.

1. **esbuild 네이티브 바이너리가 일부 샌드박스(seccomp)에서 segfault** → 그런 환경에선 `vite`/`tsx`/`vitest`가 안 돎.
   - 그래서 **테스트는 vitest가 아니라 Node 내장 러너**를 씀: `node --experimental-strip-types --test server/src/test/*.test.ts` (package.json의 `npm test`가 이걸 실행).
   - **실제 사용자 머신/Docker에서는 esbuild 정상** → `npm run dev`, `docker build`(vite build) 문제없음.
2. **Node의 `--experimental-strip-types`는 타입만 제거**(변환 안 함) → 서버/공용 코드에서 금지사항:
   - TS **enum 금지**(대신 `as const` 배열 사용 — 이미 그렇게 함),
   - **파라미터 프로퍼티 금지**(`constructor(private x)` → 명시적 필드 할당으로),
   - 서버/공용 상대 임포트는 **반드시 `.ts` 확장자**로(클라이언트는 vite가 처리하므로 확장자 없이 OK).
3. **테스트 DB는 PGlite(인메모리 Postgres + pgvector)** — 외부 DB 불필요. 단 PGlite는 단일 커넥션이라 **진짜 병렬 트랜잭션 테스트는 불가**(원자성은 SQL/유니크 인덱스로 보장, 순차 테스트로 검증).
4. npm 설치 중 esbuild postinstall이 죽으면 `npm install --ignore-scripts`로 우회(락파일은 정상 생성됨).

## 5. 로컬 구동 중 잡은 이슈 4건 (이미 수정됨 — 참고용)
1. `package-lock.json` ↔ `package.json` 불일치로 `npm ci` 실패 → 락파일 재생성. (의존성 추가 시 반드시 `npm install`로 락파일 갱신)
2. `docker-compose.yml`이 `NODE_ENV=production` + 기본 시크릿 → 부팅 거부(보안 가드). → compose에 실제 랜덤 시크릿 주입 완료.
3. 공용 `Input`/`Textarea`가 ref 미전달 → react-hook-form이 값 못 읽음 → `forwardRef`로 수정.
4. 세션 쿠키 `secure:true` + http://localhost → 쿠키 저장 안 됨(로그인 유지 실패) → `secure:"auto"`로 수정(http 로컬 OK, HTTPS/터널에서 자동 활성).

## 6. 파일 맵 (핵심만)
```
devflow-build-prompt.md      원본 스펙 (진실의 원천)
docker-compose.yml           app + pgvector + MinIO(+버킷). 시크릿 실값 주입됨
Dockerfile                   node:22-slim, npm ci, vite build, tsx로 start
migrations/0000_init.sql     멱등 DDL + pgvector 확장
shared/schema.ts             Drizzle 스키마 + 타입 (client/server 공용)
server/src/
  app.ts, index.ts           Express 앱/부트(0.0.0.0), 세션(secure auto)
  middleware/                auth(세션+Bearer 토큰), 보안헤더, 에러핸들러
  routes/                    auth, tokens, projects(+projectTasks), tasks, comments, mywork, attachments, push, skills
  lib/                       db(pg/PGlite), crypto(AES-GCM+HMAC), password, storage(S3/local),
                             fileType(magic number), markdown(sanitize), taskService(item_key 원자생성/롤업),
                             llm(프로바이더 추상화), skillExtractor, push, env(prod 시크릿 가드), activity, errors, http
  jobs/                      scheduler(cron), notifications(digest/reminder, 멱등)
  test/                      p0~p5.test.ts + harness.ts (PGlite 기반)
client/src/
  pages/                     Login, MyWork, Projects, ProjectMembers, ProjectBoard(List/Kanban/Calendar), TaskDetail, Skills
  components/                Layout(사이드바+하단탭바), ui(디자인시스템), TaskCard, UpdatesPanel(댓글/가이드), Attachments
  lib/                       api, queryClient, format, hooks/(useAuth, usePush)
  public/                    manifest.webmanifest, sw.js(오프라인+웹푸시)
README.md                    실행/구조/보안 요약
```

## 7. 데이터 모델 요점
- `projects.next_task_seq`: 태스크 생성 시 `UPDATE ... next_task_seq+1 RETURNING`로 **원자적 item_key**(예: PRJ-1).
- `guide_assignees`(comment_id, user_id, state[pending|applied|skipped], note): 가이드 댓글(is_guide) 생성 시 **태스크 담당자마다 pending 행** 생성. 진행률 배지 = applied/전체. (늦게 배정된 담당자도 기존 가이드에 백필됨)
- `tasks.scheduled_date` = "오늘 할 일" 날짜. `task_assignees` 복수 담당. 캘린더 일 뷰는 (scheduled_date, assignee)로 그룹.
- `skills`: 프로젝트 완료 시 draft로 추출(자동 게시 안 함, 사람이 published). `antipatterns` 컬럼에 단점 별도 태깅. SKILL.md 내보내기 지원.

## 8. 보안(§10) 준수 요약
무인증 GET 금지(멤버십 검사), 초대 토큰 전용 가입, PATCH 화이트리스트(strict zod), 로그인 열거 방지(일반화 메시지+타이밍 균등화)+rate limit+계정잠금, 서버측 인가, 업로드 magic-number 검증(클라 mime 불신)·private 버킷·인가 후 다운로드·attachment 헤더·HTML/SVG 차단, 마크다운 sanitize(DOMPurify), API 토큰 해시 저장(1회 노출), bcrypt(12)·쿠키 httpOnly+sameSite=lax(+secure auto), activity_log 감사.

## 9. 남은 일 / 스코프 경계
- **후속 미구현(P6~P10)**: P6 Timeline/Gantt+task_dependencies · P7 AI RAG(embedding_jobs→검색→Q&A→가이드제안→블록) · P8 GitHub App(웹훅 서명+멱등, item_key 파싱, PR머지 가드레일, Git UI) · P9 라이브 프리뷰(iframe srcdoc→esbuild-wasm) · P10 MCP 서버(boilerplate→도구→토큰→OAuth). **P10은 반드시 P8 API 안정화 후.**
- **선언만 되고 미구현인 플래그(스코프상 P8)**: `auto_complete_on_pr_merge`, `require_checklist_done_before_auto_complete`, `require_guide_applied_before_done`. 스키마·PATCH엔 있으나 게이팅 로직 없음.
- **다듬을 여지(UI)**: 색감/간격 취향 조정, 태스크 설명 편집 UI, @멘션, 반응/알림 원장(notification_deliveries) 등은 선택.
- **아직 실기기/실브라우저 픽셀 검증은 사용자 몫**(개발은 tsc 타입체크 + Node 테스트로 검증됨).

## 9-1. ★ 2차 세션 업데이트 (P6~P10 구현 완료)
- **P6 타임라인**: `task_dependencies`(사이클 방지 BFS) + 보드 "타임라인" 뷰(간트 바, 오늘선, ←선행표시) + 태스크 상세 "선행 태스크" 관리. Redmine precedes/follows 패턴 차용.
- **P7 AI RAG**: `embeddings(vector 1536)`+`embedding_jobs`(유니크 업서트 큐, cron 5분+재색인 즉시 처리). 프로바이더 추상화(mock=결정론적 해시 임베딩/오프라인 동작, openai=text-embedding-3-small). `/api/ai/reindex·search·ask·suggest-guide` — 전부 멤버십 필터. UI: /ai 페이지 + 태스크 상세 "AI 가이드 제안"(사람 검토 후 등록, 자동저장 금지 §13).
- **P8 GitHub**: `/api/webhooks/github` — X-Hub-Signature-256(타이밍 안전) + `webhook_events` delivery_id 멱등 + item_key 정규식 파싱(브랜치/커밋/PR) → `github_links`. PR merged → 가드레일(auto_complete_on_pr_merge + require_checklist/require_guide) 통과 시 자동 done + activity_log. rawBody는 app.ts json verify 훅으로 보존. projects PATCH에 require_checklist_done_before_auto_complete 추가됨.
- **P9 프리뷰**: `snippets`(멀티파일 jsonb, 10파일/200KB 제한) + /projects/:id/preview 에디터. iframe sandbox="allow-scripts"(same-origin 금지) + CSP(default-src 'none', 외부 네트워크 차단). JSX는 esbuild-wasm CDN 지연 로드.
- **P10 MCP**: `/api/mcp` Streamable HTTP JSON-RPC(2025-03-26). Bearer api_token+스코프(task:read/write, guide:write, project:read). 도구: list_my_tasks/get_task/create_task/add_guide/mark_guide_done/devflow_search.
- **추가 스키마**: task_dependencies, embeddings, embedding_jobs, github_links, webhook_events, snippets + comments.checklist_item_id (전부 멱등 DDL, 0000_init.sql 뒤쪽).
- **env 추가**: GITHUB_WEBHOOK_SECRET(게터-동적), EMBEDDING_MODEL. compose에 주입됨.
- **UI 개편(1~2차)**: Pretendard 폰트+전역 스케일업, 주간 워크로드 그리드(행=요일, 열=팀원, 카드형)가 캘린더 기본, 팀원 칩 필터, 활성 프로젝트=메인 화면(localStorage), My Work team_today, 체크리스트 항목별 피드백 스레드.
- **테스트 37개 통과** (p0~p8, p9-p10, mywork-team, checklist-feedback). 의존성 추가 없음(락파일 그대로). esbuild-wasm은 npm 의존성이 아니라 CDN 런타임 로드.

## 9-2. ★ 3차 세션 업데이트 (로드맵 + 보안 감사 반영, 테스트 40개)
- **관리자 설정**: users.is_admin(bootstrap 계정=관리자, 기존 DB는 마이그레이션이 최초 계정 승격). `/api/admin/settings` GET(마스킹)/PATCH(strict)/test. LLM 키는 AES-256-GCM으로 system_settings에 저장, 부팅 시 `loadAiSettingsFromDb()`가 process.env 주입(env.ts LLM_*는 게터 — 재시작 없이 반영). UI: /admin (관리자에게만 탭 노출).
- **회의록 파이프라인**: meeting_notes/note_extractions. POST /meetings → /:id/process(추출: mock=규칙기반 결정론, LLM=JSON) → PATCH /extractions/:id 검토(action→태스크 생성, guide→task_id 지정+manager만 가이드 댓글 팬아웃, decision/blocker/question=기록). 자동 등록 금지(§13). UI: /projects/:id/meetings (보드 "회의록" 버튼).
- **P11 갤러리(링크형) + §10.2 개정**: POST /auth/signup 공개 가입(전용 limiter 10/15분, 프로젝트 접근은 여전히 초대만). submissions/review_feedback(1인 1리뷰 유니크, 본인 리뷰 금지), 게이트(min_reviews/min_avg_rating 충족 시 validated 자동 승격). UI: /gallery.
- **디자인**: alert() 전면 제거 → 토스트 시스템(ui.tsx toast()/ToastHost, 실패 문구 자동 error 스타일). 스크롤바/selection 폴리시. Login 4탭(로그인/가입/초대/최초설정).
- **보안 감사(서브에이전트) 반영**: ①C-1 웹훅 저장소→프로젝트 바인딩(projects.github_repo=repository.full_name 일치 시에만 처리 — 크로스 프로젝트 조작 차단, p8 테스트에 검증 포함) ②프리뷰 CSP에 connect-src/form-action/frame-ancestors 'none' 추가 ③signup 전용 강화 limiter ④AI 라우터 사용자별 rate limit(60/5분) ⑤갤러리 응답 필드 화이트리스트 ⑥스니펫 파일당 100KB 상한 ⑦mywork-team 테스트 타임존 플레이크 수정.
- **알려진 잔여 리스크(수용)**: 웹훅 시크릿이 전역 1개(단일 팀 서버 전제 — 멀티 조직 시 저장소별 시크릿 필요), signup 이메일 열거는 limiter로 완화(완전 차단은 이메일 인증 도입 필요), 마이그레이션 관리자 승격 UPDATE는 관리자 전원 삭제 후 재실행 시 MIN(id) 재승격 엣지.

## 9-3. ★ 4차 세션 업데이트 (배포 + 로그인/초대 UX)
- **배포**: Replit 프로덕션 배포됨 → `https://devfloww.replit.app`. GitHub `yonghwan86/devflow`(main)에 연동. Secrets에 SESSION_SECRET/INVITE_TOKEN_SECRET/API_TOKEN_SECRET/FIELD_ENCRYPTION_KEY/APP_BASE_URL(=배포도메인) + DATABASE_URL 설정.
- **디자인 테마 적용**: "Tactile Soft" — tailwind.config.js에서 slate/indigo/white 팔레트를 웜 그레이지·딥민트(#2E8C74)로 재매핑(페이지 코드 무수정), Plus Jakarta Sans+Pretendard, 카드 radius 20px+소프트 그림자. (커밋됨)
- **초대 링크 도메인 자동화**: `server/src/lib/http.ts`에 `baseUrl(req)` 추가 — APP_BASE_URL이 non-localhost면 그걸, 아니면 실제 접속 호스트(x-forwarded-*)에서 유도. projects.ts 초대 생성이 이걸 사용 → 로컬/배포 어디서든 접속 도메인으로 링크 생성. (커밋됨)
- **로그인 상태 초대 수락**: `POST /auth/accept-invite-session`(requireAuth, 이메일 일치 검증, 비번 재설정 없이 프로젝트 합류) + 클라 `/invite` 라우트 + `pages/InviteAccept.tsx`. 이미 로그인한 사람이 초대 링크 열면 404 대신 "합류하기" 화면. 신규 테스트 `invite-session.test.ts`.
- **로그인 화면 정리**: `pages/Login.tsx` — 탭을 "로그인/가입" 2개로 축소(초대 탭 제거). 초대는 `/invite?token=` 링크로만 처리(전용 안내 화면). "최초 설정"은 `GET /auth/bootstrap-status`(유저 0명일 때 true)일 때만 노출.
- **⚠ 아직 커밋 안 된 변경(이 세션 마지막)**: accept-invite-session(auth.ts), InviteAccept.tsx, App.tsx /invite 라우트, bootstrap-status(auth.ts), Login.tsx 개편, invite-session.test.ts. → 사용자가 `git add . && commit && push` 해야 배포 반영.
- **테스트 41개**(invite-session 포함). 모두 통과, 타입체크·빌드 클린.
- **⚠ 마운트 캐시 주의**: 이 세션에서 mnt(/sessions/.../mnt/) 읽기가 파일을 종종 truncate함. 샌드박스 검증은 `git clone`한 사본에 변경을 재적용하는 방식으로 우회했음. 호스트 파일(Read/Write/Edit 도구)은 정상.
- **배포 잔여 확인 필요**: Replit 기본 Postgres에 **pgvector 확장** 되는지(AI 검색 P7). 안 되면 AI 검색/회의록 추출은 mock로만 동작하거나 재색인 실패 가능.

## 9-4. ★ 5차 세션 업데이트 (R1: R0 안정화 + F1~F5 팀 워크플로우 확장, 테스트 53개)

**R0 보안/운영 안정화**
- **R0-0 시크릿**: docker-compose.yml 하드코딩 시크릿 4종 → `${VAR:?required}` env 참조로 교체(.env에서 주입). **⚠ 기존 실값은 public 레포에 이미 유출 — Replit Secrets에서 신규 발급 로테이션 필요**(SESSION/INVITE_TOKEN/API_TOKEN/GITHUB_WEBHOOK). FIELD_ENCRYPTION_KEY는 로테이션 금지(암호화 데이터 보존). 부작용: 전원 로그아웃·미수락 초대 무효·API 토큰 무효.
- **R0-1**: accept-invite가 기존 계정 발견 시 409 `account_exists`(필드 덮어쓰기 제거 — 계정 탈취 차단), invites.accepted_at 미소모 → 로그인 후 같은 토큰으로 accept-invite-session. Login.tsx가 409 수신 시 로그인 폼 전환 후 자동 합류.
- **R0-2**: `/api/mcp` Bearer 전용(세션 401 — tokenScopes 없으면 차단, 스코프 우회 봉쇄).
- **R0-3 CSRF**: `middleware/csrf.ts` — 세션 인증된 mutating 요청에만 `X-DevFlow-CSRF: 1` 요구(웹훅·로그인·Bearer는 조건상 자연 제외). api.ts/upload에 헤더 추가, TaskDetail raw fetch 2건 → del() 래퍼 교체. **테스트 하위호환: createApp({ testAutoCsrfHeader }) 옵션(harness 전용) — csrf.test.ts는 옵션 없이 실동작 검증.** ★ 새 클라이언트 코드는 반드시 api.ts 래퍼 사용(생 fetch 금지).
- **R0-4**: .env.example에 GITHUB_WEBHOOK_SECRET·EMBEDDING_MODEL 추가. **R0-5**: 체크리스트 POST/PATCH/DELETE는 담당자 또는 owner/manager만.
- 잠재 버그 수정: 태스크 DELETE 후 activity_log가 삭제된 task_id를 FK 참조 → task_id null + meta 기록으로 변경.

**F1 티켓 시스템**
- TASK_STATUS에 requested/rejected 추가, TASK_PATCH_STATUS(일반 PATCH 화이트리스트 — requested/rejected 전이 양방향 금지), tasks.kind('task'|'ticket')/requested_by 컬럼.
- 생성: member → 서버가 kind=ticket/status=requested/requested_by 강제(kind·status·assignee_ids 등 비허용 입력은 무시), owner/manager → 기존대로. member 철회(DELETE) = 본인 requested 티켓만(activity `ticket.withdrawn`).
- PATCH: requested/rejected 상태는 status 변경 불가(매니저 포함 409 — 승인/반려 API로만). 요청자는 자기 requested 티켓의 title/description/priority만 수정.
- `POST /tasks/:id/approve`(status 기본 todo + assignee_ids — **addAssignee 헬퍼로 가이드 pending 백필 포함**), `POST /tasks/:id/reject`(reason 필수, 사유 댓글 생성, **completed_at 미설정**). 롤업: rejected 하위는 모수 제외.
- push: notifyProjectManagers(티켓 생성→매니저), 승인/반려→요청자. UI: 칸반 requested 컬럼(0건 숨김)+rejected 토글, 드래그 잠금, TicketRequestModal/TicketTriageActions, TaskDetail 트리아지 배너.

**F4 문서 페이지 + 태스크 파생**
- pages 테이블(트리, parent set null=루트 승격) + tasks.source_page_id(set null). `/api/projects/:pid/pages` CRUD + derived-tasks. 수정은 멤버 전원, 삭제는 작성자/manager. parent 사이클 방지(체인 순회). content_html은 GET에서만 서버 렌더(PATCH 응답 미포함 — 자동저장 렌더 낭비 방지).
- 파생은 기존 태스크 생성 라우트에 source_page_id만 추가(같은 프로젝트 검증) — role별 kind 강제 자동 적용. UI: /projects/:id/pages (PageTree/PageEditor — 2초 debounce 자동저장, 미리보기 선택→태스크로 만들기, 모바일은 트리↔에디터 전환).

**F2 My Work 칸반**: /my-work 응답에 board_tasks(담당 미완료 + **내가 요청한 requested/rejected 티켓**(requested_by 별도 쿼리) + 7일 내 완료)·summary(status_counts/today_due/overdue/completed_this_week 월~일) 추가(기존 필드 유지). 공용 `components/KanbanBoard.tsx`를 ProjectBoard·MyWork 둘 다 사용(중복 구현 금지). 리스트/칸반 토글 localStorage. SummaryStrip은 순수 CSS.

**F3 날짜 규약(★ format.ts 상단 주석이 규약 원문)**: localDayKey를 format.ts로 승격(ProjectBoard·MiniCalendar가 import), toDayKey는 `slice(0,10)`(Date 왕복 금지 — 음수 TZ 하루 밀림), 쓰기는 dayKeyToServer(`${key}T00:00:00.000Z`). 캘린더: 오늘 행/셀 강조+오늘 라벨, 주간 그리드 진입 시 오늘 행 자동 스크롤, "이번 주/오늘부터 7일" 토글(localStorage), 오늘 0건 문구.

**F5 일정 이벤트**: events(project_id null=개인)/event_attendees. `/api/events` from/to 필수(±1일 패딩 후 클라 배치 필터), 개인 일정 가시성 = 생성자 OR 참석자, 수정·삭제 = 생성자/프로젝트 manager(참석자-only 불가), **PATCH에 project_id 없음(개인↔프로젝트 이동 미지원 — 삭제 후 재생성, 의도적 스코프 컷)**. 생성자 자동 참석. 초대 push `event-invite:{id}:user:{uid}` sendOnce(재저장 중복 방지), 리마인더 `runEventReminders`(30분 전, all_day 제외, 매분 cron), all_day는 오전 9시 digest "오늘 일정" 합산. UI: EventModal/EventStrip(My Work 오늘 일정), 캘린더 월/주/일에 이벤트 칩 병렬 표시(+ 일정 버튼 — 셀 클릭은 기존 일 뷰 이동 유지, 셀 클릭→모달은 미채택).

**테스트 53개 통과**(신규: csrf, r0-hardening, tickets, pages, mywork-board, events + p2 티켓 규칙 갱신). 타입체크 클린. 의존성 추가 0.

**의도적 스코프 컷 / 미착수**: F5-5 ICS 피드(calendar:read 스코프) 미구현 — 후속 후보. 이벤트 project_id 이동 미지원. 승인 UI 담당자 단일 선택(서버는 배열 지원). 티켓 생성 시 member의 비허용 필드는 400이 아니라 무시(테스트 ①과의 정합 우선).

**다음 세션 주의**: ① 새 날짜 규약(format.ts 주석) 준수 — toDayKey에 Date 왕복 재도입 금지 ② 클라 mutating 요청은 api.ts 래퍼 필수(CSRF 헤더) ③ 서버 테스트 앱은 makeTestApp(자동 CSRF 헤더) 사용, CSRF 자체 검증은 createApp({}) ④ requested/rejected 전이는 승인/반려 API 외 금지 유지.

## 9-5. ★ 6차 세션 업데이트 (운영서버 소스 역병합, 테스트 54개)

**배경**: Replit 운영 서버는 GitHub 연동이 아니라 **Replit 내부 git으로 별도 진화**해 있었다(분기점: 697b33b Tactile Soft 테마 직후). Replit 에이전트가 운영에서 추가한 변경을 R1 코드베이스에 역병합했다.

**운영에서 가져온 것**:
- **UI 전면 리디자인**: Tactile Soft(민트) → **인디고 brand 스케일 + 애니메이션/그림자 시스템**(tailwind.config 재작성: brand-50~900, animate-fade-in/scale-in/check-pop/shimmer, shadow-card/floating/brand-glow). ui.tsx에 ConfirmDialog/PromptDialog/useConfirm/Skeleton/SkeletonList/SkeletonCard/PageHeader 추가. **이후 confirm()류는 useConfirm 사용 권장.**
- **TaskDetail 탭 구조**(개요/체크리스트/활동/파일) — 운영본 베이스에 R1 기능(티켓 트리아지 배너·del() 래퍼·F3 날짜 규약·출처 문서 링크) 재이식.
- **기존 회원 직접 추가**: `POST /projects/:pid/members`(owner/manager, 미가입 404·중복 409) + ProjectMembers UI. 신규 테스트 member-add.test.ts.
- **Replit dev 모드 배포 설정**: `.replit`(PORT=3001 express + vite 5000 서빙, `npm run dev`) 레포에 포함. vite.config는 **REPL_ID 감지 분기**(Replit: 5000/allowedHosts/3001 프록시, 로컬: 기존 5173/5000 유지).
- 운영본 채택 파일: ui.tsx, index.css, Layout, UpdatesPanel, Admin, Ai, Gallery, Meetings, Preview, ProjectMembers, Projects, Skills, tailwind.config.js. 병합 파일: TaskCard, MiniCalendar, ProjectBoard, MyWork, Login, TaskDetail, projects.ts, vite.config.ts, index.html(theme-color 인디고 유지).
- 운영 TaskDetail의 생 fetch 2건(rmAssignee/rmDep)은 병합 시 del() 래퍼로 교체(R0-3 CSRF 필수 — 안 하면 운영 코드가 CSRF에 깨짐).

**주의**: 운영(Replit)은 프로덕션 빌드가 아니라 **dev 모드로 서비스 중**(.replit workflow). 성능·보안상 `npm run build` + `npm run start` 배포로 전환 검토 권장(후속 후보).

**테스트 54개 통과**(member-add 추가), 타입체크·vite build 클린. 의존성 추가 0.

## 10. 새 세션에서 이어갈 때 체크리스트
1. `devflow-build-prompt.md`(스펙)와 이 `HANDOFF.md`를 먼저 읽게 할 것.
2. §4 환경 제약을 반드시 지킬 것(enum/파라미터프로퍼티 금지, 서버 임포트 .ts, 테스트는 node --test).
3. 변경 후: `npm run check`(타입) + `npm test`(통합) 통과 확인 → Docker 재빌드로 육안 확인.
4. 의존성 추가 시 `npm install`로 **package-lock.json 갱신**(안 하면 Docker `npm ci` 실패).
5. 각 Phase/기능은 **실데이터로 동작**해야 함(mock UI 금지), activity_log 기록, 서버측 멤버십 필터 유지.
