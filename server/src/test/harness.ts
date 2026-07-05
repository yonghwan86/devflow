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
  // testAutoCsrfHeader: 기존 테스트들이 CSRF 헤더 없이 작성돼 있어 자동 주입(R0-3).
  // CSRF 동작 자체는 csrf.test.ts가 옵션 없이 createApp({})으로 검증한다.
  const app = createApp({ testAutoCsrfHeader: true }); // MemoryStore session
  return { app, close };
}
