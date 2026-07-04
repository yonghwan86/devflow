import { db } from "./db.ts";
import { projects } from "../../../shared/schema.ts";
import { eq } from "drizzle-orm";

// Derive a unique uppercase project key (e.g. 'DEVFLOW' -> 'DEV').
export async function generateProjectKey(name: string, provided?: string): Promise<string> {
  let base = (provided ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  if (!base) {
    const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    base = (letters.slice(0, 4) || "PRJ").padEnd(3, "X").slice(0, 4);
  }
  let candidate = base;
  let n = 1;
  // ensure uniqueness
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [hit] = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, candidate)).limit(1);
    if (!hit) return candidate;
    candidate = `${base}${n++}`;
  }
}
