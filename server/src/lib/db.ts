import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../shared/schema.ts";
import { env } from "./env.ts";

export type DB = NodePgDatabase<typeof schema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.resolve(__dirname, "../../../migrations/0000_init.sql");

let _active: DB | null = null;

// Proxy so callers `import { db }` once and tests can swap the backing instance.
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    if (!_active) throw new Error("DB not initialized. Call initDb() / setActiveDb() first.");
    // @ts-expect-error dynamic delegate
    return _active[prop];
  },
}) as DB;

export function setActiveDb(instance: DB) {
  _active = instance;
}
export function getActiveDb(): DB {
  if (!_active) throw new Error("DB not initialized");
  return _active;
}

export function loadDdl(): string {
  return readFileSync(DDL_PATH, "utf8");
}

// Production/dev: node-postgres pool. Returns { db, close }.
export async function initProdDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const instance = drizzlePg(pool, { schema });
  setActiveDb(instance);
  return { db: instance, close: () => pool.end() };
}

// Apply idempotent DDL against a node-postgres pool url (used by scripts/migrate).
export async function migrateProd(): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query(loadDdl());
  } finally {
    await pool.end();
  }
}

// Test backend: in-process PGlite with pgvector. Isolated per call.
export async function createTestDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const client = new PGlite({ extensions: { vector } });
  await client.exec(loadDdl());
  const instance = drizzlePglite(client, { schema }) as unknown as DB;
  setActiveDb(instance);
  return { db: instance, close: () => client.close() };
}

export { schema };
