// DB 없이 UI 확인용 로컬 런처 — Docker/PG 없이 PGlite 인메모리로 서버 기동 (재시작 시 초기화).
// 시드: 10명 팀 + 30개 태스크(상태 분산) — 긴 리스트·칩 접기·모달 등 UI 검증에 충분한 규모.
// 실행: npx tsx scripts/dev-pglite.ts (API 5000) + npm run dev:client (vite 5173)
import { createApp } from "../server/src/app.ts";
import { createTestDb, db } from "../server/src/lib/db.ts";
import { users, projects, projectMembers, projectAreas, tasks } from "../shared/schema.ts";
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
      // 첫 계정은 사이트 관리자 — /admin(AI 설정·사용자 관리·재설정 링크 발급)을 로컬에서 확인하려면 필요.
      // dev:ui 전용 시드라 배포에는 포함되지 않는다.
      is_admin: i === 0,
    }).returning();
    ids.push(u.id);
  }
  const [proj] = await db.insert(projects).values({
    key: "PRJ", name: "꿈틀", owner_id: ids[0], daily_report_enabled: true,
    report_cutoff_hour: 21, report_meeting_time: "09:30",
  }).returning();
  await db.insert(projectMembers).values(ids.map((uid, i) => ({
    project_id: proj.id, user_id: uid, role: i === 0 ? ("owner" as const) : ("member" as const),
    operational_role: i === 0 ? ("pm" as const) : i <= 3 ? ("pl" as const) : ("worker" as const),
  })));
  const areaNames = ["결제", "검색", "대시보드"];
  const areaRows = [];
  for (let i = 0; i < areaNames.length; i++) {
    const [area] = await db.insert(projectAreas).values({ project_id: proj.id, name: areaNames[i], lead_user_id: ids[i + 1], created_by: ids[0], sort_order: i }).returning();
    areaRows.push(area);
  }
  const statuses = [
    ...Array(20).fill("todo"), ...Array(4).fill("in_progress"), ...Array(2).fill("blocked"), ...Array(4).fill("done"),
  ];
  for (let i = 0; i < statuses.length; i++) {
    const t = await createTaskWithKey({
      project_id: proj.id, title: `재현용 태스크 ${i + 1}`, created_by: ids[0],
      assignee_ids: [ids[i % ids.length]],
      area_id: i % 11 === 10 ? null : areaRows[i % areaRows.length].id,
    });
    if (statuses[i] !== "todo") await db.update(tasks).set({
      status: statuses[i],
      completed_at: statuses[i] === "done" ? new Date() : null,
      updated_at: new Date(),
    }).where(eq(tasks.id, t.id));
  }
  const app = createApp({});
  const port = Number(process.env.DEVFLOW_API_PORT ?? 5000);
  app.listen(port, "0.0.0.0", () => console.log(`[dev-pglite] http://localhost:${port} — owner@devflow.local / password123`));
}
main().catch((e) => { console.error(e); process.exit(1); });
