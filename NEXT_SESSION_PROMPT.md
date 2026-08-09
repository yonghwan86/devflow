# 새 세션에 붙여넣을 킥오프 프롬프트

아래 "---" 아래 내용을 새 세션 첫 메시지로 그대로 붙여넣으세요.
(작업 폴더: `C:\Users\user\Desktop\devflow`)

---

이 폴더의 문서를 먼저 순서대로 읽어:

1. `HANDOFF.md` — **§4 개발 환경 제약**(반드시)과 최근 세션 기록 `9-X` `9-Y` `9-Z`
2. `CLAUDE.md` — 작업 워크플로 (문서 갱신 위치는 CHANGELOG 기준)
3. `CHANGELOG.md` — 기능 변경 이력 (README에는 이력을 쌓지 않는다)
4. `devflow-build-prompt.md` — 전체 스펙과 후속 로드맵

## 현재 상태

DevFlow = 개발팀용 프로젝트·할일·가이드·노하우(SKILL.md) 웹앱. 배포는 **https://devfloww.replit.app**, GitHub `yonghwan86/devflow` main.

- **최신 커밋**: `5886da0` — Password reset via email (Y) + project archive/trash/purge (Z)
- **검증 상태**: `npm run check` · `npm test` **97개 전부 통과** · `npm run build` 클린
- 로컬 실행: `npm run dev:ui` (PGlite 인메모리, DB·Docker 불필요) → http://localhost:5173, `owner@devflow.local` / `password123`

### 이 머신 환경 (Windows 11)

- Node **24.18.0**. 이 저장소에 dotenv가 없어 npm 스크립트가 `--env-file-if-exists=.env`로 `.env`를 읽는다(Node 20.12+ 필요, `engines.node` = `>=20.12`).
- `.env`는 gitignore 대상이고 로컬 SMTP 값이 들어 있다. **절대 커밋 금지**, `.env.example`에는 값을 넣지 않는다(추적 파일).
- 테스트는 `node --experimental-strip-types --test` — vitest 아님. 타입은 지워지기만 하므로 TS enum·생성자 파라미터 프로퍼티 금지, 상대 임포트에 `.ts` 확장자 필수.

## ⚠ 먼저 확인할 것 — 배포가 아직 안 끝났다

`5886da0`은 push됐고 Replit에서 `git pull` → `npm install` → `npm run db:push`까지 마쳤다. **남은 단계**:

1. **Replit Secrets 정리** — `APP_BASE_URL`이 **Secrets와 Configurations 양쪽에 중복**돼 있다. 어느 쪽이 적용되는지 보장되지 않으므로 **Secrets 쪽을 삭제**하고 Configurations(`https://devfloww.replit.app`)만 남긴다. 이 값이 비밀번호 재설정 링크의 도메인을 정한다 — 틀리면 "메일은 오는데 링크가 안 열린다"로만 드러나 원인 추적이 어렵다.
2. **Republish 미실행**
3. **배포 후 검증**: `curl -s https://devfloww.replit.app/api/auth/bootstrap-status` → `"mail_enabled":true` 확인 → 로그인 화면 "비밀번호를 잊으셨나요?"로 **실제 메일 수신·재설정까지** 확인
   - SMTP 4종(`SMTP_HOST/PORT/USER/PASS`)은 이미 Secrets에 등록됨. 발신 계정은 알림 전용 `kito86.noti@gmail.com`(앱 비밀번호 사용)

### Replit 워크스페이스 주의 (재발함)

Republish를 누를 때마다 Replit이 **`Published your App`이라는 빈 마커 커밋**(파일 변경 0건, `Replit-Commit-Author: Deployment`)을 로컬 main에 만든다. 그래서 **다음 `git pull`이 `Not possible to fast-forward`로 실패**한다.

- 정리: `git reset --hard origin/main` — 빈 커밋이라 잃는 것이 없다
- 다만 **버리기 전에 `git log --oneline origin/main..HEAD`와 `git show --stat <sha>`로 정말 빈 커밋인지 확인**할 것. 소스 파일이 섞여 있으면 Replit 에디터에서 직접 고친 작업이므로 살려야 한다
- 자동화하려면 Replit 워크스페이스에서 한 번만 `git config pull.rebase true`
- pull이 실패한 줄 모르고 다음 명령을 이어 돌리면 `npm install`이 "up to date", `db:push`가 옛 스크립트로 도는데 **둘 다 성공처럼 보인다**. `npm run db:push` 출력 2행이 `> node --env-file-if-exists=.env --import tsx scripts/migrate.ts`인지로 판별한다

## 미해결 과제

- **`devflow-verify-push` 스킬 4-1 단계가 낡음** — 아직 "README `🆕 최근 업데이트` + `📜 개발 일지`에 행 추가"로 적혀 있는데 이력은 X배치에서 `CHANGELOG.md`로 옮겼다. 정본 `github.com/yonghwan86/skills`에서 고친 뒤 `claude plugin update yh-harness`. (로컬 설치본 직접 수정 금지)
- **관리자 라우터 Bearer 노출** — `PATCH /admin/users/:id`, `PATCH /admin/settings`가 Bearer 토큰으로도 호출된다. Y·Z 배치에서 적용한 C5 규약(파괴적·민감 작업은 세션 전용)과 어긋나지만 **기존 코드라 배치 범위 밖**으로 두었다. 사용자 결정 대기.
- **`project_deletions` 조회 경로 없음** — 프로젝트 영구 삭제 감사표를 읽는 코드가 테스트뿐이라 사실상 write-only다. 관리자 화면 신설은 별건.
- Z배치 검증에서 미착수로 남긴 low 2건은 위 두 항목이 전부다(나머지 7건은 수정 완료).

## 작업 규칙

- **§4 개발 환경 제약 준수** (HANDOFF.md) — 위 "이 머신 환경" 참고
- 스키마 변경은 `shared/schema.ts`와 `migrations/0000_init.sql`을 **동시에** 고친다. DDL은 파일 끝에 `IF NOT EXISTS` 계열로 추가(`DO $$`·`CHECK` 금지). 인덱스는 schema.ts에도 선언한다(정본 일치)
- Express 라우트는 **리터럴 경로를 파라메트릭보다 먼저** 등록 (`/trash`가 `/:projectId`보다 위)
- **C5 규약**: 파괴적·민감 작업(프로젝트 보관·삭제, 재설정 링크 발급, 관리자 승격 열람)은 **세션 전용**. 라우트 앞에서 `if (req.tokenScopes) throw err.forbidden(...)`. `csrf.ts`가 Bearer를 면제하므로 토큰 경로는 CSRF로도 막히지 않는다
- 날짜는 `format.ts` 규약(localDayKey/toDayKey/dayKeyToServer)만 사용, 클라 mutating 요청은 `api.ts` 래퍼 필수(CSRF 헤더)
- 검증 규모 비례: 문구·스타일 = typecheck+빌드 / 로직 = 테스트 추가 / **스키마·권한·삭제·서버 API = 멀티에이전트 반박검증**
- 한 곳에 도입한 규약은 앱 전체 규약이다 — grep으로 같은 부류를 전수 확인해 같은 커밋에서 채운다
- 완료 시 `CHANGELOG.md`(최근 업데이트 + R표)와 `HANDOFF.md` 세션 기록 갱신. README는 **큰 기능일 때만** 기능 표에 행 추가
- 다음 배치 코드는 **`AA`** (X·Y·Z 사용 완료)

지금 내가 원하는 작업: <여기에 적기>
