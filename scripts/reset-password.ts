// 관리자 자기잠금 최후 수단 — 배포 셸에서 실행해 재설정 링크를 직접 뽑는다.
// 관리자가 1명뿐인데 그 관리자가 비밀번호를 잊으면 앱 안에는 복구 경로가 없다(Gitea·GitLab도 같은 해법: CLI).
//   사용법:  npm run reset-password -- someone@example.com
import { eq } from "drizzle-orm";
import { db, initProdDb } from "../server/src/lib/db.ts";
import { users } from "../shared/schema.ts";
import { env } from "../server/src/lib/env.ts";
import { RESET_TTL_MINUTES, issueResetToken, resetUrl } from "../server/src/lib/passwordReset.ts";

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email) {
    console.error("사용법: npm run reset-password -- <email>");
    process.exit(1);
  }
  // 이 저장소는 dotenv를 쓰지 않는다 — 셸에 env가 없으면 env.ts의 dev 기본값이 조용히 적용된다.
  // 그러면 서버와 다른 INVITE_TOKEN_SECRET으로 해시가 계산돼 "만들어졌지만 절대 안 열리는 링크"가 나온다.
  // 이 경로는 다른 복구 수단이 전부 실패한 뒤에 쓰는 최후 수단이라, 무음 실패를 막는 것이 특히 중요하다.
  if (!process.env.INVITE_TOKEN_SECRET) {
    console.error("");
    console.error("  [중단] INVITE_TOKEN_SECRET이 이 셸에 없습니다.");
    console.error("  이대로 만들면 서버와 다른 시크릿으로 서명돼 링크가 열리지 않습니다(원인 표시도 안 됩니다).");
    console.error("  서버와 같은 환경에서 실행하세요 — 예: Replit Shell, 또는 docker compose exec app npm run reset-password -- <email>");
    console.error("  로컬 개발용으로 일부러 dev 기본값을 쓰려면: INVITE_TOKEN_SECRET=dev-invite-secret npm run reset-password -- <email>");
    console.error("");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("");
    console.error("  [중단] DATABASE_URL이 이 셸에 없습니다 — 기본값(localhost)의 엉뚱한 DB에 링크를 만들 수 있습니다.");
    console.error("");
    process.exit(1);
  }

  await initProdDb();
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!u) {
    console.error(`[reset] 그런 계정이 없습니다: ${email}`);
    process.exit(1);
  }
  if (!u.is_active) {
    console.error(`[reset] 비활성 계정입니다: ${email}`);
    process.exit(1);
  }
  // issued_by=null — CLI 발급은 앱 사용자로 귀속시킬 수 없다(감사 기록상 '본인 요청'과 구분은 created_at·운영 로그로).
  const token = await issueResetToken(u.id, null);
  const base = env.APP_BASE_URL;
  console.log("");
  console.log(`  대상 : ${u.email} (${u.full_name ?? "이름 없음"})`);
  console.log(`  만료 : ${RESET_TTL_MINUTES}분 · 1회만 사용 가능`);
  console.log(`  링크 : ${resetUrl(base, token)}`);
  console.log("");
  console.log("  이 링크를 본인에게 전달하세요. 비밀번호는 본인이 직접 정합니다.");
  console.log(`  (APP_BASE_URL이 실제 도메인과 다르면 앞부분을 바꿔서 전달하세요 — 현재: ${base})`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reset] 실패:", e);
    process.exit(1);
  });
