// DB 없이 UI 확인용 로컬 런처 — Docker/PG 없이 PGlite 인메모리로 서버 기동 (재시작 시 초기화).
// 시드: 10명 팀 + 30개 태스크(상태 분산) — 긴 리스트·칩 접기·모달 등 UI 검증에 충분한 규모.
// 실행: npx tsx scripts/dev-pglite.ts (API 5000) + npm run dev:client (vite 5173)
import { createApp } from "../server/src/app.ts";
import { createTestDb, db } from "../server/src/lib/db.ts";
import { users, projects, projectMembers, tasks } from "../shared/schema.ts";
import { hashPassword } from "../server/src/lib/password.ts";
import { createTaskWithKey } from "../server/src/lib/taskService.ts";
import { eq } from "drizzle-orm";

async function main() {
  await createTestDb();
  const pw = await hashPassword("password123");
  const names = ["권용환", "이제윤", "고병찬", "이유빈", "김민수", "박지현", "최수아", "정다은", "한서준", "오하늘"];
  const ids: number[] = [];
  for (let i = 0; i < names.length; i++) {
    const [u] = await db.insert(users).values({
      email: i === 0 ? "owner@devflow.local" : `m${i}@devflow.local`,
      password_hash: pw, full_name: names[i],
    }).returning();
    ids.push(u.id);
  }
  const [proj] = await db.insert(projects).values({ key: "PRJ", name: "꿈틀", owner_id: ids[0] }).returning();
  // 역할 3종 모두 시드 — 아바타 역할 테두리(소유자=금, 매니저=은) 확인용
  await db.insert(projectMembers).values(ids.map((uid, i) => ({
    project_id: proj.id, user_id: uid, role: i === 0 ? ("owner" as const) : i === 1 ? ("manager" as const) : ("member" as const),
  })));
  const statuses = [
    ...Array(20).fill("todo"), ...Array(4).fill("in_progress"), ...Array(2).fill("blocked"), ...Array(4).fill("done"),
  ];
  for (let i = 0; i < statuses.length; i++) {
    const t = await createTaskWithKey({
      project_id: proj.id, title: `재현용 태스크 ${i + 1}`, created_by: ids[0],
      assignee_ids: [ids[i % ids.length]],
    });
    if (statuses[i] !== "todo") await db.update(tasks).set({ status: statuses[i] }).where(eq(tasks.id, t.id));
  }
  const app = createApp({});
  app.listen(5000, "0.0.0.0", () => console.log("[dev-pglite] http://localhost:5000 — owner@devflow.local / password123"));
}
main().catch((e) => { console.error(e); process.exit(1); });
