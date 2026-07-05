# 새 세션에 붙여넣을 킥오프 프롬프트

아래 "---" 아래 내용을 새 세션 첫 메시지로 그대로 붙여넣으세요.
(작업 폴더에 devflow 프로젝트가 이미 있는 상태라고 가정)

---

이 폴더의 문서 3개를 먼저 순서대로 읽어:
1. `devflow-build-prompt.md` — 전체 스펙 + 구현 현황(✅ 표시) + P11~P13 후속 로드맵 + **로드맵 검토 노트(중요)**
2. `devflow/HANDOFF.md` — 개발 환경 제약(§4)과 구현 세부 (특히 "9-1 ~ 9-4 세션 업데이트")
3. `devflow/README.md` — 실행 방법

**현재 상태 요약**: DevFlow는 개발팀용 프로젝트·할일·가이드·SKILL.md 추출 웹앱. **P0~P11 + R1 + 운영 역병합(9-5) + R2(9-6: 역할 개편·관리자 가시성·태스크 상세·회의록 v2·문서 분해 + 감사 픽스) 완료**(테스트 62개 통과, 타입체크·vite build 클린).
- 배포: **https://devfloww.replit.app** (Replit), GitHub `yonghwan86/devflow` main에 연동. push하면 재배포.
- 기능: MVP(P0~P5) + P6~P10 + 관리자 설정 + 회의록 + P11 갤러리 + R1(티켓·문서·My Work 칸반·캘린더·일정·보안) + **R2: owner 폐지(매니저/멤버 2단·마지막 매니저 가드), 관리자 전체 프로젝트 열람·원클릭 참여·사용자 관리, 태스크 상세 개편(설명 편집·탭 재배치·삭제), 회의록 v2(원문·수정/삭제·일정/체크리스트 반영), 문서 분해(설계문서→태스크+체크리스트)**.
- UI: 인디고 테마. 주간 팀원별 워크로드 그리드가 캘린더 기본(오늘 행 자동 스크롤·범례), 활성 프로젝트 보드가 첫 화면.

**⚠ 먼저 확인할 것**:
- `git log --oneline -8` + `git status`로 미push 로컬 변경 확인. R2는 `feature/r2-roles-docs-meetings` 브랜치에 그룹별 커밋됨 — main 머지 + push 필요.
- **R0-0 시크릿 로테이션 여부**: 과거 커밋 유출 실값 4종(SESSION/INVITE_TOKEN/API_TOKEN/GITHUB_WEBHOOK)을 Replit Secrets에서 신규 발급 교체했는지 확인. FIELD_ENCRYPTION_KEY는 교체 금지.
- **LLM 키 미등록**: Admin > LLM 설정에서 등록해야 회의록 추출·G6 분해·AI 검색이 실동작(코드는 mock으로도 동작). Replit Postgres **pgvector 확장** 여부도 미확인.
- **운영(Replit)은 dev 모드로 서비스 중**(.replit: PORT=3001 + vite 5000). 프로덕션 `npm run build`+`start` 배포 전환 검토 권장.

**미착수 / 다음 후보**:
- **감사 잔여(R2 미포함)**: `requireScope` REST 미적용(제한 스코프 Bearer가 전체 접근 — MCP만 스코프가 원래 설계였는지 확인), admin llm_base_url 무검증(SSRF/키유출), 갤러리 demo_url 스킴 미검증, 세션 고정(regenerate 없음). 메모리 `devflow-audit-findings` 참고.
- F5-5 ICS 캘린더 피드(`calendar:read` 스코프), P13 Obsidian export, P12 GraphRAG 1단계(백링크).
- ProjectPages 생성/이름변경 prompt()→PromptDialog, PageTree 행 액션 모바일 터치 대응.
- 배포 안정화: pgvector 확인, 실제 LLM 키 연결, prod 빌드 전환, 목록 API 페이지네이션, 소프트삭제.

작업 규칙(중요):
- HANDOFF.md "§4 개발 환경 제약" 준수: 서버/공용 코드에서 TS enum·파라미터 프로퍼티 금지, 상대 임포트 `.ts` 확장자, 테스트는 `node --experimental-strip-types --test server/src/test/*.test.ts`(vitest 아님, PGlite+pgvector).
- **R1 이후 추가 규칙(HANDOFF 9-4)**: 날짜는 format.ts 규약(localDayKey/toDayKey slice/dayKeyToServer)만 사용, 클라 mutating 요청은 api.ts 래퍼 필수(CSRF 헤더), requested/rejected 전이는 승인/반려 API로만, 칸반은 공용 KanbanBoard.tsx 재사용.
- 수정 후 `npm run check` + 테스트(파일별 분할 실행 권장) 둘 다 통과. 의존성 추가 시 `npm install`로 lock 갱신.
- 마이그레이션은 `migrations/0000_init.sql`에 멱등 DDL(IF NOT EXISTS 계열만, DO $$·CHECK 금지).
- 서버측 멤버십 필터·activity_log·PATCH 화이트리스트 유지. AI 응답 자동 등록 금지(§13).
- **마운트 캐시 주의**: bash로 mnt 경로의 기존 파일을 읽으면 종종 truncate됨(신규 파일은 대체로 정상). 샌드박스 검증은 `git clone`한 사본에 변경 재적용(python 치환 스크립트) 방식이 안전. 호스트 파일 편집은 Read/Write/Edit 도구 사용.
- 각 단계마다 happy path + 권한 거부 테스트 추가, 완료 시 HANDOFF.md 기록.
- 작업 끝나면 사용자에게 `git add . && git commit && git push` 안내(배포 반영).

지금 내가 원하는 작업: <여기에 원하는 것을 적기>

먼저 계획을 세우고, 순차로 개발하면서 각 단계마다 타입체크+테스트로 검증해줘. 물어보지 말고 자동으로 진행하고 결과만 보여줘.
