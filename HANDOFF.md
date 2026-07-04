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

## 10. 새 세션에서 이어갈 때 체크리스트
1. `devflow-build-prompt.md`(스펙)와 이 `HANDOFF.md`를 먼저 읽게 할 것.
2. §4 환경 제약을 반드시 지킬 것(enum/파라미터프로퍼티 금지, 서버 임포트 .ts, 테스트는 node --test).
3. 변경 후: `npm run check`(타입) + `npm test`(통합) 통과 확인 → Docker 재빌드로 육안 확인.
4. 의존성 추가 시 `npm install`로 **package-lock.json 갱신**(안 하면 Docker `npm ci` 실패).
5. 각 Phase/기능은 **실데이터로 동작**해야 함(mock UI 금지), activity_log 기록, 서버측 멤버십 필터 유지.
