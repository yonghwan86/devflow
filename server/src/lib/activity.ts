import { db } from "./db.ts";
import { activityLog } from "../../../shared/schema.ts";

// §10.13 audit log: create/update/status/guide/upload all recorded.
export async function logActivity(input: {
  project_id: number;
  task_id?: number | null;
  user_id?: number | null;
  action: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(activityLog).values({
    project_id: input.project_id,
    task_id: input.task_id ?? null,
    user_id: input.user_id ?? null,
    action: input.action,
    meta: input.meta ?? null,
  });
}
