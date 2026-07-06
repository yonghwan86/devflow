# DevFlow

개발팀이 **프로젝트별로 팀원을 배정**하고, 팀원마다 **매일 할 일**을 지정·완료 체크하며,
할 일 밑에 **가이드/조언 댓글(+파일 첨부)**을 달아 **팀원별 가이드 수행 여부**를 추적하고,
프로젝트 종료 시 **재사용 가능한 SKILL.md 노하우**를 추출하는 모바일-퍼스트 PWA.

> 빌드 스펙 `devflow-build-prompt.md`의 **P0~P10 전 단계 + 후속 로드맵 상당 부분**을 구현했습니다.
> 라이브: **https://devfloww.replit.app** (Replit 배포)

## 구현 현황

### MVP (P0~P5) ✅
| Phase | 내용 |
|-------|------|
| P0 | 모노레포·Vite·Express·Drizzle·docker-compose(app+pgvector+MinIO)·세션·모바일 하단탭바 셸·pgvector 활성화 |
| P1 | 초대 토큰 인증·프로젝트/멤버십(프로젝트별 역할)·api_tokens 발급/폐기·계정잠금·열거방지 |
| P2 | tasks(item_key 원자 생성)·복수 담당·상태/완료·체크리스트·서브태스크 롤업·My Work·List/Kanban/Calendar |
| P3 | Updates 패널(스레드 댓글·마크다운 sanitize)·is_guide → guide_assignees(팀원별)·진행률 배지·미수행 가이드 집계 |
| P4 | S3호환 스토리지 어댑터·magic-number 검증·sharp 썸네일·인가 후 presigned/스트리밍·web-push·알림 멱등성·cron |
| P5 | 프로젝트 완료 → applied 가이드·해결 blocker·skipped(안티패턴) 수집 → SKILL.md 초안 → 검수 후 게시·내보내기 |

### 후속 (P6~P10) ✅
| Phase | 내용 |
|-------|------|
| P6 | Timeline(Gantt-lite) + task_dependencies(사이클 방지). 보드 "타임라인" 뷰 + 태스크 상세 선행 태스크 관리 |
| P7 | AI RAG — 인제스트(embedding_jobs)→검색→Q&A→가이드 제안(사람 검토). 프로바이더 mock/openai 교체형 |
| P8 | GitHub 웹훅(X-Hub-Signature-256 검증·webhook_events 멱등·저장소↔프로젝트 바인딩·item_key 파싱)·PR머지 자동완료 가드레일 |
| P9 | 라이브 프리뷰 — sandbox iframe(same-origin 금지)+CSP·멀티파일 스니펫·JSX는 esbuild-wasm |
| P10 | MCP 서버 — `/api/mcp` JSON-RPC, api_tokens Bearer+스코프(설정 페이지에서 토큰 발급), create_task/add_guide/mark_guide_done/list_my_tasks/get_task/devflow_search |

### 로드맵 반영분 ✅
- **관리자 설정**: LLM 프로바이더/키를 UI에서 관리(AES-256 암호화 저장·마스킹, 재시작 없이 반영). 사이트 관리자(최초 계정) 전용.
- **회의록 → AI 구조화 파이프라인**: 회의 텍스트 업로드 → 결정/실행/가이드/블로커/질문 추출(제안) → 사람 검토 후 태스크·가이드로 반영.
- **P11 검증 갤러리 + 공개 가입**: 완료 프로젝트 제출 → 로그인 회원 리뷰·평점 → 게이트 충족 시 검증 완료 승격. (§10.2 개정: 가입은 공개, 프로젝트 접근은 초대만)

### R1 팀 워크플로우 확장 ✅
| 기능 | 내용 |
|------|------|
| 티켓 시스템 | member가 "티켓 요청"(requested) → 매니저 승인(담당자 배정·가이드 백필)/반려(사유 필수·댓글 이력). 일반 PATCH로 requested/rejected 전이 불가 |
| 문서 페이지 | 프로젝트별 마크다운 문서 트리(자동저장·서버 sanitize 렌더). 미리보기에서 텍스트 선택 → 태스크/티켓 파생(출처 역추적) |
| My Work 칸반 | 리스트/칸반 토글 + 내 요청 티켓 포함 + 상태·마감·주간 완료 시각화(순수 CSS) |
| 캘린더 UX | 오늘 행/셀 강조 + 자동 스크롤, "이번 주/오늘부터 7일" 토글, 날짜 규약 통일(client/src/lib/format.ts) |
| 일정 이벤트 | 개인/프로젝트 일정 + 참석자 + 30분 전 리마인더(멱등) + 캘린더 병렬 표시 + My Work 오늘 일정 |
| 보안 강화(R0) | 초대 링크 계정 탈취 차단(409),
| 역할 계층 | 프로젝트 역할 **소유자 > 매니저 > 멤버**(owner=창립자 1명, 매니저 권한 상속). 소유자는 다른 매니저가 강등·제거 불가, **소유권 양도**로만 이동. 사이트 관리자(is_admin)는 별개 전역 축 — 전체 프로젝트 열람·원클릭 참여·사용자 관리 |
| R2 태스크 개편 | 상세 탭 재배치(체크리스트 기본·설정 탭)+설명 상시 노출·편집·삭제, 빠른 추가에서 담당자·설명·우선순위 즉시 지정 |
| R2 회의록 v2 | 원문 표시·수정/삭제 + 일정/체크리스트로도 반영(자동 등록 금지, 사람 승인) |
| R2 문서 분해 | 설계 문서 → 태스크+체크리스트 분해 제안(구조 기반, LLM 보강) → 검토 후 일괄 반영(WBS) |
| R2 MCP·설정 | 개인 API 토큰 발급/폐기 UI + MCP 연결 안내 페이지(`/settings`). 도구 14종: 프로젝트/팀원/태스크/문서 목록·상세·생성·상태 변경·**담당자 배정**·**문서 생성(분해 연동)**·댓글/가이드 조회·가이드 등록/수행·의미 검색 — Claude가 설계 문서 등록→분해→배정→보고까지 수행 |
| UX·접근성 | 사이드바 미니달력 날짜 클릭 → 해당 날짜 일(day) 뷰로 이동(보드 체류 중에도 반응). 텍스트 밀림/잘림·흐린 대비 정리, 모바일 터치 타깃 확대, 문서트리·첨부 삭제 버튼을 터치 기기에서 상시 노출 |
| MCP OAuth 2.1 | Claude "커스텀 커넥터"가 URL만으로 연결 — 보호리소스/AS 메타데이터(RFC 9728/8414) + 동적 클라이언트 등록(RFC 7591) + PKCE(S256) + 서버렌더 로그인·동의 + 리프레시 로테이션. 액세스 토큰은 api_tokens 재사용(Bearer 미들웨어 호환). 개인 토큰(Bearer) 방식도 병행 |
| PWA 설치·배지·푸시 | 홈 화면 설치(manifest+아이콘+iOS 메타), **앱 아이콘 배지 = 오늘 내 할 일 수**(포커스 시 갱신 + 푸시 페이로드 badge 자동 첨부), 설정 페이지에서 알림 켜기/테스트. 발송은 VAPID 키(Secrets) 필요 — `npx tsx scripts/gen-icons.ts`로 아이콘 재생성 |

통합 테스트 **65개**(각 Phase happy path + 권한 거부 케이스 포함) 통과, 타입체크·빌드 클린.

## UI/UX
- 인디고 brand 팔레트 + 마이크로 애니메이션/스켈레톤 로딩(운영 리디자인 반영), Plus Jakarta Sans + Pretendard
- 태스크 상세는 탭 구조(체크리스트/활동/파일/설정 + 설명 상시 노출), 팀원은 초대 링크 또는 기존 회원 선택 추가
- 태스크 빠른 추가에서 제목·담당자·설명·우선순위를 한 곳에서 지정(설명·우선순위는 접기식)
- 캘린더 기본 = **주간 팀원별 워크로드 그리드**(행=요일, 열=팀원), 월/일 뷰 + 팀원 필터 + 할 일/일정 범례
- 로그인 첫 화면 = 활성(마지막) 프로젝트 보드, 사이드바 미니 달력·설정(API 토큰), 토스트 알림
- 로그인 화면은 "로그인/가입" 2탭(최초 설정은 유저 0명일 때만). 초대는 `/invite?token=` 링크로 처리

## 기술 스택
- **프론트**: React 18 + TS + Vite, Tailwind, TanStack Query, wouter, react-hook-form (mobile-first)
- **백엔드**: Express + TS(Drizzle ORM), express-session + connect-pg-simple, bcryptjs(cost 12)
- **DB**: PostgreSQL + pgvector (RAG 임베딩 검색)
- **파일**: multer + S3 호환 어댑터(로컬=MinIO, 배포=S3/R2/Supabase 무엇이든) + sharp
- **알림**: web-push(VAPID) + 서비스워커 + node-cron(Asia/Seoul)
- **AI**: LLM 프로바이더 env/관리자설정 교체(mock/openai/anthropic); 오프라인 시 결정론적 fallback

## 실행 방법

### 1) Docker (권장 — 로컬이 프로덕션 복제본)
```bash
cp .env.example .env        # ★ 필수 — compose가 시크릿을 .env에서 읽습니다 (실값은 커밋 금지)
docker compose up --build   # app + Postgres/pgvector + MinIO(+버킷 생성)
# http://localhost:5000
```
`app` 컨테이너는 기동 시 `db:push`(멱등 마이그레이션)를 먼저 실행합니다.

### 2) 로컬 개발
```bash
npm install
cp .env.example .env
npm run db:push     # 스키마 적용 (재실행 가능)
npm run db:seed     # (선택) 데모 데이터
npm run dev         # server(5000) + vite(5173, 0.0.0.0 바인딩)
```

### 3) 배포 (Replit 등)
- Secrets에 `DATABASE_URL`, `SESSION_SECRET`, `INVITE_TOKEN_SECRET`, `API_TOKEN_SECRET`, `FIELD_ENCRYPTION_KEY`, `APP_BASE_URL`(배포 도메인) 설정
- (선택) `GITHUB_WEBHOOK_SECRET`, LLM 키(관리자 설정 UI에서도 입력 가능)
- 초대 링크는 접속 도메인 기준으로 자동 생성됨(로컬/배포 무관)

## 환경 변수
`.env.example` 참고. 모든 설정은 env로 주입되며 코드에 벤더 하드코딩이 없습니다.
**프로덕션에서는 `SESSION_SECRET`/`INVITE_TOKEN_SECRET`/`API_TOKEN_SECRET`/`FIELD_ENCRYPTION_KEY`를
기본값이 아닌 값으로 반드시 설정해야 하며, 기본값이면 부팅이 거부됩니다.**

## 테스트 / 타입체크
```bash
npm run check   # tsc 전체 타입체크
npm test        # 통합 테스트 (Node 내장 러너 + PGlite 인메모리 Postgres)
```
> 테스트는 외부 DB 없이 **PGlite(pgvector 포함)** 로 실제 SQL을 실행합니다.
> 프로덕션/개발 런타임은 `.env`의 `DATABASE_URL`로 실제 Postgres에 연결합니다.

## 보안 (§10 준수)
무인증 GET 금지(멤버십 검사), 초대 토큰 전용 프로젝트 합류, PATCH 화이트리스트(매스어사인먼트 차단),
로그인 열거 방지(일반화 메시지+타이밍 균등화)+rate limit+계정잠금, 서버측 인가,
업로드 magic-number 검증(클라 mime 불신)·private 버킷·인가 후 다운로드·attachment 헤더·HTML/SVG 차단,
마크다운 sanitize(DOMPurify), API 토큰 해시 저장(1회 노출), 비밀번호 bcrypt(12)·쿠키 httpOnly+sameSite=lax(+secure),
웹훅 서명 검증+멱등, 프리뷰 sandbox+CSP(외부 네트워크 차단), LLM 키 AES-256 암호화 저장, 감사 로그(activity_log), 시크릿 env화.

## 프로젝트 구조
```
shared/schema.ts        Drizzle 스키마 + 타입 (client/server 공용)
migrations/0000_init.sql 멱등 DDL (재실행 가능) + pgvector
server/src/
  app.ts, index.ts       Express 앱/부트스트랩 (0.0.0.0 바인딩)
  middleware/            auth(세션+Bearer 토큰), 보안헤더, 에러핸들러
  routes/                auth, tokens, projects(+projectTasks, projectPages), tasks, comments, mywork, attachments,
                         push, skills, dependencies, ai, webhooks, snippets, mcp, admin, meetings, gallery, events
  lib/                   db(pg/PGlite), crypto, password, storage, fileType, markdown, taskService,
                         llm, embeddings, github, meetingExtract, pageDecompose, adminSettings, skillExtractor, push
  jobs/                  scheduler(cron), notifications(digest/reminder, 멱등)
client/src/
  pages/                 Login, InviteAccept, MyWork, Projects, ProjectMembers, ProjectBoard, TaskDetail,
                         ProjectPages, Skills, Ai, Preview, Meetings, Gallery, Admin, Settings(API 토큰·MCP)
  components/            Layout(하단탭바·미니달력·설정), KanbanBoard, UpdatesPanel, Attachments, TaskCard,
                         MiniCalendar, EventModal/Strip, PageTree/Editor, DecomposeModal, Ticket*, ui(토스트·useConfirm)
  lib/, hooks/           api, queryClient, activeProject, format(날짜 규약), usePush, useAuth
```

## 미착수 / 다음 후보
- ICS 캘린더 피드(읽기 전용, api_tokens 스코프) — F5 잔여
- P13 Obsidian export(스킬 → 위키링크 볼트 + 인덱스 노트), P12 지식 그래프(GraphRAG)
- P11 정적 드래그드롭 호스팅, 목록 API 페이지네이션, 소프트삭제
- 배포 환경 pgvector 확장 확인, 실제 LLM 키 연결로 AI 기능 활성화

세부 진행 상황·개발 규칙은 `HANDOFF.md`, 새 세션 인수인계는 `NEXT_SESSION_PROMPT.md` 참고.
