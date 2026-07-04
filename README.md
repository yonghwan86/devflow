# DevFlow

개발팀이 **프로젝트별로 팀원을 배정**하고, 팀원마다 **매일 할 일**을 지정·완료 체크하며,
할 일 밑에 **가이드/조언 댓글(+파일 첨부)**을 달아 **팀원별 가이드 수행 여부**를 추적하고,
프로젝트 종료 시 **재사용 가능한 SKILL.md 노하우**를 추출하는 모바일-퍼스트 PWA.

> 이 저장소는 빌드 스펙 `devflow-build-prompt.md`의 **MVP(P0~P5)** 를 구현한 것입니다.
> 후속(P6~P10: Gantt·AI RAG·GitHub 연동·라이브 프리뷰·MCP 서버)은 아직 미구현입니다.

## 구현 현황 (MVP 완료)

| Phase | 내용 | 상태 |
|-------|------|------|
| P0 | 모노레포·Vite·Express·Drizzle·docker-compose(app+pgvector+MinIO)·세션·모바일 하단탭바 셸·pgvector 활성화 | ✅ |
| P1 | 초대 토큰 인증·프로젝트/멤버십(프로젝트별 역할)·api_tokens 발급/폐기·계정잠금·열거방지 | ✅ |
| P2 | tasks(item_key 원자 생성)·복수 담당·상태/완료·체크리스트·서브태스크 롤업·My Work·List/Kanban/Calendar | ✅ |
| P3 | Updates 패널(스레드 댓글·마크다운 sanitize)·is_guide → guide_assignees(팀원별)·진행률 배지·미수행 가이드 집계 | ✅ |
| P4 | S3호환 스토리지 어댑터·magic-number 검증·sharp 썸네일·인가 후 presigned/스트리밍·web-push·알림 멱등성·cron | ✅ |
| P5 | 프로젝트 완료 → applied 가이드·해결 blocker·skipped(안티패턴) 수집 → SKILL.md 초안 → 검수 후 게시·내보내기 | ✅ |

§1의 5개 MVP 플로우가 모두 동작하며, 통합 테스트 **30개**(각 Phase happy path + 권한 거부 케이스 포함)가 통과합니다.

## 기술 스택
- **프론트**: React 18 + TS + Vite, Tailwind, TanStack Query, wouter, react-hook-form (mobile-first)
- **백엔드**: Express + TS(Drizzle ORM), express-session + connect-pg-simple, bcryptjs(cost 12)
- **DB**: PostgreSQL + pgvector (확장은 P0에서 활성화; RAG는 후속 P7)
- **파일**: multer + S3 호환 어댑터(로컬=MinIO, 배포=S3/R2/Supabase 무엇이든) + sharp
- **알림**: web-push(VAPID) + 서비스워커 + node-cron(Asia/Seoul)
- **AI(P5)**: LLM 프로바이더 env 교체(mock/openai/anthropic); 오프라인 시 결정론적 추출

## 실행 방법

### 1) Docker (권장 — 로컬이 프로덕션 복제본)
```bash
cp .env.example .env        # 필요 시 시크릿 수정
docker compose up --build   # app + Postgres/pgvector + MinIO(+버킷 생성)
# http://localhost:5000
```
`app` 컨테이너는 기동 시 `db:push`(멱등 마이그레이션)를 먼저 실행합니다.

### 2) 로컬 개발
```bash
npm install
# Postgres(pgvector)와 MinIO는 docker compose up db minio 로 띄우거나 별도 준비
cp .env.example .env
npm run db:push     # 스키마 적용 (재실행 가능)
npm run db:seed     # (선택) 데모 데이터
npm run dev         # server(5000) + vite(5173, 0.0.0.0 바인딩)
```

### 3) 모바일 실기기 테스트 (배포 없이)
- 같은 와이파이: 폰에서 `http://<PC-IP>:5173`
- PWA 전체(웹푸시/설치/카메라, HTTPS 필요):
  ```bash
  cloudflared tunnel --url http://localhost:5000
  # 또는: ngrok http 5000
  ```
- VAPID 키 생성: `npx web-push generate-vapid-keys` → `.env`의 `VAPID_*`에 설정

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
무인증 GET 금지(멤버십 검사), 초대 토큰 전용 가입, PATCH 화이트리스트(매스어사인먼트 차단),
로그인 열거 방지(일반화 메시지+타이밍 균등화)+rate limit+계정잠금, 서버측 인가,
업로드 magic-number 검증(클라 mime 불신)·private 버킷·인가 후 다운로드·attachment 헤더·HTML/SVG 차단,
마크다운 sanitize(DOMPurify), API 토큰 해시 저장(1회 노출), 비밀번호 bcrypt(12)·쿠키 httpOnly+sameSite=lax(+secure),
감사 로그(activity_log), 시크릿 env화.

## 프로젝트 구조
```
shared/schema.ts        Drizzle 스키마 + 타입 (client/server 공용)
migrations/0000_init.sql 멱등 DDL (재실행 가능) + pgvector
server/src/
  app.ts, index.ts       Express 앱/부트스트랩 (0.0.0.0 바인딩)
  middleware/            auth(세션+Bearer 토큰), 보안헤더, 에러핸들러
  routes/                auth, tokens, projects(+projectTasks), tasks, comments, mywork, attachments, push, skills
  lib/                   db(pg/PGlite), crypto, password, storage(S3/local), fileType, markdown, taskService, llm, skillExtractor, push
  jobs/                  scheduler(cron), notifications(digest/reminder, 멱등)
client/src/
  pages/                 Login, MyWork, Projects, ProjectMembers, ProjectBoard, TaskDetail, Skills
  components/            Layout(하단탭바), UpdatesPanel, Attachments, ui
  lib/, hooks/           api, queryClient, usePush, useAuth
```

## 알려진 스코프 경계 (후속 Phase)
- `auto_complete_on_pr_merge`, `require_checklist_done_before_auto_complete`, `require_guide_applied_before_done`
  플래그는 스키마에 존재하며 PATCH로 설정 가능하지만, **실제 게이팅 로직은 P8(GitHub 연동, PR 머지 자동완료 가드레일)에서 구현**됩니다. MVP에서는 미사용입니다.
- 임베딩/RAG(embedding_jobs 등)는 P7, GitHub 링크·웹훅은 P8, 라이브 프리뷰는 P9, MCP 서버는 P10 스코프입니다.
