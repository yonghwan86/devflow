// Dev seed: owner + project + member + a few tasks/guides. Idempotent-ish (skips if owner exists).
import { initProdDb, db } from "../server/src/lib/db.ts";
import { users, projects, projectMembers } from "../shared/schema.ts";
import { hashPassword } from "../server/src/lib/password.ts";
import { createTaskWithKey } from "../server/src/lib/taskService.ts";
import { eq } from "drizzle-orm";

async function main() {
  await initProdDb();
  const email = "owner@devflow.local";
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) { console.log("[seed] owner already exists, skipping."); process.exit(0); }
  const [owner] = await db.insert(users).values({ email, password_hash: await hashPassword("password123"), full_name: "데모 오너" }).returning();
  const [member] = await db.insert(users).values({ email: "member@devflow.local", password_hash: await hashPassword("password123"), full_name: "데모 팀원" }).returning();
  const [proj] = await db.insert(projects).values({ key: "DEMO", name: "데모 프로젝트", owner_id: owner.id }).returning();
  await db.insert(projectMembers).values([
    { project_id: proj.id, user_id: owner.id, role: "manager" },
    { project_id: proj.id, user_id: member.id, role: "member" },
  ]);
  await createTaskWithKey({ project_id: proj.id, title: "온보딩 문서 작성", created_by: owner.id, scheduled_date: new Date(), assignee_ids: [member.id] });
  await createTaskWithKey({ project_id: proj.id, title: "CI 파이프라인 구성", created_by: owner.id, assignee_ids: [member.id] });
  console.log("[seed] done. login: owner@devflow.local / member@devflow.local (pw: password123)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
