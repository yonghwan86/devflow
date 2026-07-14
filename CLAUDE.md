# devflow

개발팀용 프로젝트·할일·가이드 관리 웹앱 (모바일 퍼스트 PWA). Claude가 MCP(`/api/mcp`, 도구 19종)로 실데이터를 조작하는 것이 핵심 차별점.
프로덕션: https://devfloww.replit.app — Replit autoscale. **배포 반영은 자동이 아니다**: GitHub push 후 Replit Shell에서 `git pull` → Republish 수동 실행 (Replit Agent 사용 금지 — 과금됨. pull.ff only 설정됨).

## 문서 읽는 순서
1. `devflow-build-prompt.md` — 스펙 원천 (정본은 이 디렉토리의 것; Team_Project 루트의 동명 파일은 중복 사본)
2. `HANDOFF.md` — 환경 제약(§4) + 세션 로그. **주의: 세션 기록은 시간순 누적이라 뒤 세션이 앞 내용을 번복한다** (예: 9-6 "owner 폐지"는 이후 재도입됨 — shared/schema.ts MEMBER_ROLE에 owner 존재). 최신 상태는 README + git log가 우선.
3. `README.md` — 현재 기능·배포 절차. 단, 개수류 수치(테스트 수 등)가 문서 간 다르면 **코드 실측이 기준**.

## 명령어
| 명령 | 용도 |
|---|---|
| `npm run dev` | server(5000, tsx watch) + vite(5173) — 실DB 필요 |
| `npm run dev:ui` | DB/Docker 없이 UI 확인 — PGlite 인메모리. 로그인 `owner@devflow.local` / `password123`. 시드 10명·30태스크(가상 데이터), 재시작 시 초기화 |
| `npm run check` | tsc --noEmit 전체 타입체크 |
| `npm test` | node 내장 러너 + PGlite. 외부 DB 불필요 (테스트 개수·소요시간은 실행 결과와 README 배지가 기준 — 계속 늘어나므로 이 문서에 고정하지 않는다) |
| `npm run build` | vite build → dist/public (서버는 tsx 런타임이라 서버 빌드 없음) |
| `npm run db:push` | **DDL 반영의 유일한 수단** — migrations/0000_init.sql 멱등 전체 재실행 |
| `npm run db:seed` | 데모 데이터. **프로덕션 실행 금지** — 고정 비밀번호 계정 생성 + '최초 설정'(첫 관리자 생성) 차단 |
| `docker compose up --build` | app+pgvector+MinIO. app 컨테이너는 **기동 시마다** db:push 자동 실행(compose command에 내장) — docker 경로에서만 자동, 그 외 배포는 수동 |

- **vitest 도입 금지** — esbuild 네이티브 바이너리가 일부 샌드박스(seccomp)에서 segfault해서 node 내장 러너+PGlite를 쓰는 것이다 (HANDOFF §4). PGlite는 단일 커넥션이라 병렬 트랜잭션 테스트 불가.
- `npm start`는 POSIX 인라인 env 문법 — Windows에선 Git Bash에서만 동작.

## 아키텍처
단일 package.json 모노레포:
- `client/src/` — React 18 + Vite SPA (pages, components, lib, hooks)
- `server/src/` — Express + Drizzle (routes/, middleware/ — auth·csrf·errorHandler·security, lib/, jobs/ 크론, test/)
- `shared/schema.ts` — client/server 공용 Drizzle 스키마
- `migrations/0000_init.sql` — 단일 멱등 DDL 파일. **새 마이그레이션 파일을 만들지 않는다.**

## 코드 규약 (어기면 런타임 사고)
서버·shared 코드 — `npm test`가 node `--experimental-strip-types`로 서버 코드를 직접 실행하며, 이 러너는 타입만 제거하고 변환하지 않는다 (tsx dev에선 돌아가도 테스트에서 터진다):
- TS `enum` 금지, 생성자 파라미터 프로퍼티 금지
- 상대 임포트에 `.ts` 확장자 필수

마이그레이션 — **스키마 변경은 두 곳 동시 수정**:
- `shared/schema.ts`(Drizzle 정의)와 `migrations/0000_init.sql`(실제 DDL)을 함께 고친다. db:push는 SQL 파일을 재실행할 뿐 schema.ts에서 DDL을 생성하지 않는다.
- 새 DDL은 `migrations/0000_init.sql` 끝에 `IF NOT EXISTS` 계열로만 추가. `DO $$` 블록·`CHECK` 제약 금지.
- drizzle-kit push/generate 사용 금지 (drizzle.config.ts는 잔재다).

클라이언트:
- mutating 요청은 `client/src/lib/api.ts` 래퍼만 (X-DevFlow-CSRF 헤더). 생 fetch 금지.
- 날짜는 `client/src/lib/format.ts` 규약만: `toDayKey`(slice(0,10)), Date 왕복 금지, 쓰기는 `dayKeyToServer`.
- `confirm()`/`alert()` 금지 → `ui.tsx`의 useConfirm/toast.
- 칸반은 공용 `components/KanbanBoard.tsx` 재사용 — 중복 구현 금지.

서버:
- requested/rejected 상태 전이는 승인/반려 API로만 — 일반 PATCH 금지 (shared/schema.ts).
- 리터럴 라우트를 파라미터 라우트보다 먼저 등록 (`/projects/all`이 `/:projectId`에 잡히는 사고 전례).
- 서버측 멤버십 필터·activity_log·PATCH 화이트리스트 유지. AI 응답 자동 등록 금지(사람 승인 필수).
- 기능마다 happy path + 권한 거부 테스트를 추가한다.

## 함정
- `npm start`는 부팅 시 마이그레이션을 하지 않는다 (initProdDb는 pool 생성만). **스키마 변경 배포 후 배포 셸에서 `npm run db:push` 수동 1회 필수.** "로컬은 정상인데 배포만 이상"이면 먼저 이걸 의심한다. session 테이블이 없으면 로그인 자체가 실패한다.
- **FIELD_ENCRYPTION_KEY 절대 로테이션 금지** — LLM 키 등 암호화 데이터가 복호 불능이 된다. 나머지 시크릿은 `openssl rand -hex 32`로 교체 가능.
- 프로덕션에서 dev 기본 시크릿이면 부팅 거부 (env.ts assertProdSecrets — 시크릿 4종만 검사. DATABASE_URL·APP_BASE_URL은 검사 대상이 아니라 미설정 시 localhost 기본값으로 조용히 부팅되므로 배포 시 직접 확인).
- Replit autoscale은 서버가 잠들면 크론이 멎는다 — 기회주의 tick + 외부 크론 핑(GET /api/health)으로 이미 보완돼 있다. "크론 미실행"을 버그로 오진하지 말 것.
- 의존성 추가 시 `npm install`로 package-lock.json 갱신 필수 (Docker `npm ci` 실패 방지). 락파일 재생성은 반드시 Windows 머신에서 — 리눅스 샌드박스에서 생성된 락파일이 win32 optional 바이너리(@esbuild/win32-* 등) 누락으로 `npm ci`를 깨뜨린 전례(2026-07-06)가 있다.
- REST에도 Bearer 토큰 스코프 게이트가 있다 — 메서드 단위(GET/HEAD=read, 그 외=write; 예외로 POST `/api/ai/search`·`/api/ai/ask`는 read 취급) + `/api/journal`은 journal:write 전용 격리 (server/src/middleware/auth.ts).
- vite.config.ts는 REPL_ID 감지 분기 — Replit dev(vite 5000 + API 3001)와 로컬(5173→5000)의 포트 구성이 다르다.
- esbuild-wasm은 npm 의존성이 아니라 CDN 런타임 로드다 (프리뷰 JSX용).

## 작업 워크플로 (사용자 상시 지시 — 전역 CLAUDE.md와 결합)
1. 개선 요청 → 방안만 정리·보고, 구현 보류. 명시적 "구현해"에만 쌓인 목록을 일괄 구현.
2. 구현 후 검증 등급은 전역 규칙(위험 축 우선)을 따른다. 명령 매핑: 단순 = `npm run check`+빌드 / 중간 = +`npm test` / 대형·위험(스키마·권한·삭제·서버 API·대량 배치) = 멀티에이전트 검증.
3. 검증 통과 → `npm run dev:ui`를 백그라운드 기동하고 브라우저(http://localhost:5173)를 열어 사용자 확인을 받는다. 시드는 가상 데이터임을 안내. (상세 절차: devflow-verify-push 스킬)
4. **사용자 승인 후에만** README 갱신 + 커밋 + push. 프로덕션 반영은 별도: Replit Shell `git pull` → Republish (+스키마 변경 시 `npm run db:push`).
5. README 갱신 위치: `### 🆕 최근 업데이트` 맨 위 한 줄 + `## 📜 개발 일지` details 표에 행 추가 + 큰 기능이면 `## 💡 무엇을 할 수 있나요?` 불릿. 배지·다이어그램이 실제와 어긋나면 함께 수정. 전부 같은 커밋에.
6. 세션 종료 시 HANDOFF.md에 세션 기록 추가.

## 환경변수
- 필수(프로덕션 기준): DATABASE_URL, SESSION_SECRET, INVITE_TOKEN_SECRET, API_TOKEN_SECRET, FIELD_ENCRYPTION_KEY, APP_BASE_URL — 전부 dev 기본값이 있어 로컬에선 미설정도 부팅된다.
- 선택: GITHUB_WEBHOOK_SECRET, VAPID_* 3종, LLM_* (관리자 UI /admin > AI 설정에서도 등록 가능)
