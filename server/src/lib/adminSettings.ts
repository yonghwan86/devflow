import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { systemSettings } from "../../../shared/schema.ts";
import { encryptField, decryptField } from "./crypto.ts";

// 관리자 설정: LLM/임베딩 구성을 DB(system_settings)에 저장, env 폴백.
// 키는 AES-256-GCM 암호화 저장(§10.12), UI에는 마스킹만 반환.
const KEYS = {
  provider: "ai.llm_provider",
  apiKey: "ai.llm_api_key_enc",
  model: "ai.llm_model",
  baseUrl: "ai.llm_base_url",
  embeddingModel: "ai.embedding_model",
  updatedBy: "ai.updated_by",
} as const;

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return row?.value ?? null;
}

async function setSetting(key: string, value: string | null): Promise<void> {
  if (value == null) {
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  await db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

export interface AiSettingsInput {
  llm_provider?: "mock" | "openai" | "anthropic";
  llm_api_key?: string | null; // null → 삭제, undefined → 유지
  llm_model?: string;
  llm_base_url?: string;
  embedding_model?: string;
}

// DB 설정을 process.env에 반영 → env.ts의 게터를 통해 전 모듈에 즉시 적용 (재시작 불필요)
function applyToEnv(vals: { provider?: string | null; apiKey?: string | null; model?: string | null; baseUrl?: string | null; embeddingModel?: string | null }): void {
  if (vals.provider) process.env.LLM_PROVIDER = vals.provider;
  if (vals.apiKey != null) process.env.LLM_API_KEY = vals.apiKey;
  if (vals.model) process.env.LLM_MODEL = vals.model;
  if (vals.baseUrl != null) process.env.LLM_BASE_URL = vals.baseUrl;
  if (vals.embeddingModel) process.env.EMBEDDING_MODEL = vals.embeddingModel;
}

// 서버 부팅 시 호출: DB에 저장된 설정이 있으면 env보다 우선
export async function loadAiSettingsFromDb(): Promise<void> {
  try {
    const [provider, enc, model, baseUrl, embeddingModel] = await Promise.all([
      getSetting(KEYS.provider),
      getSetting(KEYS.apiKey),
      getSetting(KEYS.model),
      getSetting(KEYS.baseUrl),
      getSetting(KEYS.embeddingModel),
    ]);
    applyToEnv({ provider, apiKey: enc ? decryptField(enc) : undefined, model, baseUrl, embeddingModel });
  } catch (e) {
    console.error("[admin-settings] load failed:", e);
  }
}

export async function saveAiSettings(input: AiSettingsInput, updatedBy: number): Promise<void> {
  if (input.llm_provider !== undefined) await setSetting(KEYS.provider, input.llm_provider);
  if (input.llm_api_key !== undefined)
    await setSetting(KEYS.apiKey, input.llm_api_key ? encryptField(input.llm_api_key) : null);
  if (input.llm_model !== undefined) await setSetting(KEYS.model, input.llm_model);
  if (input.llm_base_url !== undefined) await setSetting(KEYS.baseUrl, input.llm_base_url || null);
  if (input.embedding_model !== undefined) await setSetting(KEYS.embeddingModel, input.embedding_model);
  await setSetting(KEYS.updatedBy, String(updatedBy));
  applyToEnv({
    provider: input.llm_provider,
    apiKey: input.llm_api_key === undefined ? undefined : input.llm_api_key ?? "",
    model: input.llm_model,
    baseUrl: input.llm_base_url,
    embeddingModel: input.embedding_model,
  });
}

// UI 표시용: 원문 절대 반환 금지 — 마스킹만
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export async function getAiSettingsMasked() {
  const [provider, enc, model, baseUrl, embeddingModel] = await Promise.all([
    getSetting(KEYS.provider),
    getSetting(KEYS.apiKey),
    getSetting(KEYS.model),
    getSetting(KEYS.baseUrl),
    getSetting(KEYS.embeddingModel),
  ]);
  const currentKey = enc ? decryptField(enc) : process.env.LLM_API_KEY || null;
  return {
    llm_provider: provider ?? process.env.LLM_PROVIDER ?? "mock",
    llm_api_key_masked: maskKey(currentKey),
    llm_api_key_set: !!currentKey,
    llm_model: model ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
    llm_base_url: baseUrl ?? process.env.LLM_BASE_URL ?? "",
    embedding_model: embeddingModel ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    source: provider ? "db" : "env",
  };
}
