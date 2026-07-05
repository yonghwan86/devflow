# 새 세션에 붙여넣을 킥오프 프롬프트

아래 "---" 아래 내용을 새 세션 첫 메시지로 그대로 붙여넣으세요.
(작업 폴더에 devflow 프로젝트가 이미 있는 상태라고 가정)

---

이 폴더의 문서 3개를 먼저 순서대로 읽어:
1. `devflow-build-prompt.md` — 전체 스펙 + 구현 현황(✅ 표시) + P11~P13 후속 로드맵 + **로드맵 검토 노트(중요)**
2. `devflow/HANDOFF.md` — 개발 환경 제약(§4)과 구현 세부 (특히 "9-1 ~ 9-3 세션 업데이트")
3. `devflow/README.md` — 실행 방법

**현재 상태 요약**: DevFlow는 개발팀용 프로젝트·할일·가이드·SKILL.md 추출 웹앱. **P0~P10 + 로드맵 상당 부분 구현 완료, 실서버 배포까지 됨**(테스트 41개 통과, 타입체크·빌드 클린).
- 배포: **https://devfloww.replit.app** (Replit), GitHub `yonghwan86/devflow` main에 연동. push하면 재배포.
- 기능: MVP(P0~P5) + P6 타임라인/의존성 + P7 AI RAG(mock/openai 교체형) + P8 GitHub 웹훅(서명·멱등·PR머지 가드레일·저장소 바인딩) + P9 라이브 프리뷰 + P10 MCP 서버 + 관리자 설정(LLM 키 UI 암호화) + 회의록→AI 구조화 파이프라인 + P11 검증 갤러리 + 공개 가입.
- UI: "Tactile Soft" 테마(웜 그레이지+딥민트, Plus Jakarta Sans), 주간 팀원별 워크로드 그리드가 캘린더 기본, 활성 프로젝트 보드가 로그인 첫 화면, 토스트 알림, 사이드바 미니 달력.
- 인증 UX: 로그인 화면은 "로그인/가입" 2탭(초대 탭 제거, 최초설정은 유저 0명일 때만). 초대는 `/invite?token=` 링크로 처리 — 신규는 가입 화면, 이미 로그인한 사람은 "합류하기" 화면.

**⚠ 먼저 확인할 것**:
- HANDOFF "9-3"에 **아직 GitHub에 push 안 된 마지막 변경**이 있으면(로그인 화면 개편·초대 수락 등) 사용자에게 push 여부를 확인. `git log --oneline -5`로 대조.
- Replit 기본 Postgres에 **pgvector 확장**이 되는지 미확인 — AI 검색/회의록 추출(P7)이 실제로 도는지 배포 환경에서 점검 필요.

**미착수 / 다음 후보**:
- P13 Obsidian export(권장 — 작업량 작음): 스킬 → `[[위키링크]]` 볼트 + 인덱스(MOC) 노트, 단방향부터.
- P12 GraphRAG(1단계 명시적 백링크 테이블부터. Apache AGE는 PGlite 테스트 미지원이라 신중히).
- MCP OAuth 2.1/PKCE, P11 정적 드래그드롭 호스팅(별도 오리진·zip-slip 방어), 목록 API 페이지네이션, 소프트삭제(휴지통).
- 배포 안정화: pgvector 확인, 실제 LLM 키 연결로 AI 기능 활성화, 웹훅 시크릿을 Replit Secrets에 등록해 GitHub 연동 완성.

작업 규칙(중요):
- HANDOFF.md "§4 개발 환경 제약" 준수: 서버/공용 코드에서 TS enum·파라미터 프로퍼티 금지, 상대 임포트 `.ts` 확장자, 테스트는 `node --experimental-strip-types --test server/src/test/*.test.ts`(vitest 아님, PGlite+pgvector).
- 수정 후 `npm run check` + 테스트(파일별로 나눠 실행 권장) 둘 다 통과. 의존성 추가 시 `npm install`로 lock 갱신.
- 마이그레이션은 `migrations/0000_init.sql`에 멱등 DDL로 추가.
- 서버측 멤버십 필터·activity_log·PATCH 화이트리스트 유지. AI 응답 자동 등록 금지(§13).
- **마운트 캐시 주의**: bash로 mnt 경로 파일을 읽으면 종종 truncate됨. 샌드박스 검증은 `git clone`한 사본에 변경 재적용해 확인하는 방식이 안전. 호스트 파일 편집은 Read/Write/Edit 도구 사용.
- 각 단계마다 happy path + 권한 거부 테스트 추가, 완료 시 HANDOFF.md 기록. 큰 작업은 서브에이전트로 보안 리뷰+QA 검증.
- 작업 끝나면 사용자에게 `git add . && git commit && git push` 안내(배포 반영).

지금 내가 원하는 작업: <여기에 원하는 것을 적기>

먼저 계획을 세우고, 순차로 개발하면서 각 단계마다 타입체크+테스트로 검증해줘. 물어보지 말고 자동으로 진행하고 결과만 보여줘.
