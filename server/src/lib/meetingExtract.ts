import { getLlm, isMockLlm } from "./llm.ts";

// 회의 텍스트 → 구조화 추출 (decision/action/guide/blocker/question/event + speaker)
// mock: 결정론적 규칙 기반(오프라인·테스트) / LLM: JSON 추출. 자동 등록은 하지 않는다(제안만).
export interface ExtractedItem {
  kind: "decision" | "action" | "guide" | "blocker" | "question" | "event";
  content: string;
  speaker: string | null;
  source_excerpt: string;
  when_suggested?: string | null; // event 후보의 제안 일시 문자열(확정은 사람이 승인 단계에서)
}

const SPEAKER_RE = /^\s*([\p{L}\p{N}_.\- ]{1,20}?)\s*[:：]\s*(.+)$/u;
// G5-4: 일정 후보 — 날짜 패턴 + 일정 키워드가 함께 있으면 event
const DATE_RE = /(\d{1,2}\s*[\/.월]\s*\d{1,2}\s*일?|내일|모레|다음\s*주)/;
const EVENT_KW = /(회의|미팅|발표|리뷰|마감|데모)/;
function detectEventWhen(text: string): string | null {
  const dm = text.match(DATE_RE);
  return dm && EVENT_KW.test(text) ? dm[1].trim() : null;
}

function classify(text: string): Exclude<ExtractedItem["kind"], "event"> | null {
  if (/\?\s*$/.test(text)) return "question";
  if (/(결정|하기로 (했|함|합)|확정|채택)/.test(text)) return "decision";
  if (/(블로커|막혔|막힘|문제가|이슈가|장애|안 되(는|고))/.test(text)) return "blocker";
  if (/(가이드|주의|권장|팁|하지 마|조심)/.test(text)) return "guide";
  if (/(해야|하자|할 것|할것|진행하|담당|맡(아|기)|TODO|todo|액션)/.test(text)) return "action";
  return null;
}

export function mockExtract(source: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const rawLine of source.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line || line.length < 4) continue;
    const m = line.match(SPEAKER_RE);
    const speaker = m ? m[1].trim() : null;
    const text = (m ? m[2] : line).trim();
    // event를 기존 규칙보다 먼저 평가
    const when = detectEventWhen(text);
    const kind = when ? "event" : classify(text);
    if (!kind) continue;
    items.push({ kind, content: text.slice(0, 500), speaker, source_excerpt: line.slice(0, 300), when_suggested: when });
    if (items.length >= 50) break;
  }
  return items;
}

async function llmExtract(source: string): Promise<ExtractedItem[]> {
  const raw = await getLlm().complete([
    {
      role: "system",
      content:
        '회의록에서 항목을 추출해 JSON으로만 응답하세요. 형식: {"items":[{"kind":"decision|action|guide|blocker|question|event","content":"...","speaker":"이름 또는 null","source_excerpt":"원문 문장","when":"YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm 또는 null"}]}. ' +
        "decision=결정사항, action=실행할 일, guide=주의/권장사항, blocker=장애물, question=미해결 질문, event=일정(회의/발표/마감 등 날짜가 있는 것, when에 일시). 최대 50개, 한국어 유지.",
    },
    { role: "user", content: source.slice(0, 24000) },
  ]);
  try {
    const parsed = JSON.parse(raw);
    const valid = new Set(["decision", "action", "guide", "blocker", "question", "event"]);
    return (parsed.items ?? [])
      .filter((x: any) => valid.has(x?.kind) && typeof x?.content === "string" && x.content.trim())
      .slice(0, 50)
      .map((x: any) => ({
        kind: x.kind,
        content: String(x.content).slice(0, 500),
        speaker: x.speaker ? String(x.speaker).slice(0, 50) : null,
        source_excerpt: String(x.source_excerpt ?? "").slice(0, 300),
        when_suggested: x.when ? String(x.when).slice(0, 40) : null,
      }));
  } catch {
    return mockExtract(source); // LLM 응답 파싱 실패 → 규칙 기반 폴백
  }
}

export async function extractFromMeeting(source: string): Promise<ExtractedItem[]> {
  return isMockLlm() ? mockExtract(source) : llmExtract(source);
}
