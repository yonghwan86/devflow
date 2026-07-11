// Central env access. All config via env (§3 vendor independence).
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseInt(process.env.PORT ?? "5000", 10),
  APP_BASE_URL: process.env.APP_BASE_URL ?? "http://localhost:5000",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://devflow:devflow@localhost:5432/devflow",
  SESSION_SECRET: process.env.SESSION_SECRET ?? "dev-session-secret",
  INVITE_TOKEN_SECRET: process.env.INVITE_TOKEN_SECRET ?? "dev-invite-secret",
  API_TOKEN_SECRET: process.env.API_TOKEN_SECRET ?? "dev-api-token-secret",
  FIELD_ENCRYPTION_KEY:
    process.env.FIELD_ENCRYPTION_KEY ??
    "0000000000000000000000000000000000000000000000000000000000000000",
  STORAGE_DRIVER: (process.env.STORAGE_DRIVER ?? "local") as "s3" | "local",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: process.env.S3_BUCKET ?? "devflow",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "devflow",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "devflow-secret",
  S3_FORCE_PATH_STYLE: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR ?? "./.storage",
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "mailto:admin@devflow.local",
  // LLM/임베딩: 게터 — 관리자 설정(DB)이 process.env에 주입되면 재시작 없이 즉시 반영
  get LLM_PROVIDER() {
    return (process.env.LLM_PROVIDER ?? "mock") as "mock" | "openai" | "anthropic";
  },
  get LLM_API_KEY() {
    return process.env.LLM_API_KEY ?? "";
  },
  get LLM_MODEL() {
    return process.env.LLM_MODEL ?? "gpt-4o-mini";
  },
  get LLM_BASE_URL() {
    return process.env.LLM_BASE_URL ?? "";
  },
  get EMBEDDING_MODEL() {
    return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  },
  // 게터: 테스트/런타임에서 동적으로 주입 가능해야 함
  get GITHUB_WEBHOOK_SECRET() {
    return process.env.GITHUB_WEBHOOK_SECRET ?? "";
  },
  TZ: process.env.TZ ?? "Asia/Seoul",
  isProd: (process.env.NODE_ENV ?? "development") === "production",
  // NODE_TEST_CONTEXT: node --test가 테스트 프로세스에 자동 설정 — 테스트 스크립트가 NODE_ENV를
  // 안 세팅해도 tick 같은 백그라운드 잡이 테스트 DB를 오염시키지 않게 (N6 검증단 발견)
  isTest: process.env.NODE_ENV === "test" || !!process.env.NODE_TEST_CONTEXT,
};
export { req };

// §10.12 fail-closed: refuse to boot in production with dev-default secrets.
export function assertProdSecrets(): void {
  if (!env.isProd) return;
  const bad: string[] = [];
  if (env.SESSION_SECRET.startsWith("dev-") || env.SESSION_SECRET === "change-me-session-secret") bad.push("SESSION_SECRET");
  if (env.INVITE_TOKEN_SECRET.startsWith("dev-") || env.INVITE_TOKEN_SECRET === "change-me-invite-secret") bad.push("INVITE_TOKEN_SECRET");
  if (env.API_TOKEN_SECRET.startsWith("dev-") || env.API_TOKEN_SECRET === "change-me-api-token-secret") bad.push("API_TOKEN_SECRET");
  if (/^0+$/.test(env.FIELD_ENCRYPTION_KEY)) bad.push("FIELD_ENCRYPTION_KEY");
  if (bad.length) throw new Error(`[env] Production requires non-default secrets: ${bad.join(", ")}`);
}
