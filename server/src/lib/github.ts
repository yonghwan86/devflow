import { createHmac, timingSafeEqual } from "node:crypto";

// item_key 파싱 규칙 (§7.8): 브랜치명·커밋 메시지·PR 제목/본문에서 PRJ-123 패턴 감지, 중복 제거
export const ITEM_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

export function parseItemKeys(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of (t ?? "").matchAll(ITEM_KEY_RE)) found.add(m[0]);
  }
  return [...found];
}

// §10.9: X-Hub-Signature-256 HMAC 검증 (타이밍 안전 비교)
export function verifyGithubSignature(rawBody: Buffer | undefined, signature: string | undefined, secret: string): boolean {
  if (!rawBody || !signature || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
