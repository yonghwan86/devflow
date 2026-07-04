import { env } from "./env.ts";

// Provider-agnostic LLM (§3: swap via env). Default 'mock' works offline.
export interface LlmMessage { role: "system" | "user"; content: string; }
export interface Llm {
  complete(messages: LlmMessage[]): Promise<string>;
}

class MockLlm implements Llm {
  // Deterministic passthrough: the extractor handles clustering when provider is mock.
  async complete(): Promise<string> {
    return "";
  }
}

class OpenAiLlm implements Llm {
  async complete(messages: LlmMessage[]): Promise<string> {
    const base = env.LLM_BASE_URL || "https://api.openai.com/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model: env.LLM_MODEL, messages, temperature: 0.2, response_format: { type: "json_object" } }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}`);
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}

class AnthropicLlm implements Llm {
  async complete(messages: LlmMessage[]): Promise<string> {
    const base = env.LLM_BASE_URL || "https://api.anthropic.com/v1";
    const system = messages.find((m) => m.role === "system")?.content;
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.LLM_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.LLM_MODEL, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}`);
    const data: any = await res.json();
    return data.content?.[0]?.text ?? "";
  }
}

export function getLlm(): Llm {
  switch (env.LLM_PROVIDER) {
    case "openai": return new OpenAiLlm();
    case "anthropic": return new AnthropicLlm();
    default: return new MockLlm();
  }
}
export function isMockLlm(): boolean {
  return env.LLM_PROVIDER === "mock";
}
