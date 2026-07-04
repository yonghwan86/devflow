import { createApp } from "../app.ts";
import { createTestDb } from "../lib/db.ts";
import type { Express } from "express";

export interface TestCtx {
  app: Express;
  close: () => Promise<void>;
}

// Fresh isolated PGlite-backed app per test file.
export async function makeTestApp(): Promise<TestCtx> {
  const { close } = await createTestDb();
  const app = createApp({}); // MemoryStore session
  return { app, close };
}
