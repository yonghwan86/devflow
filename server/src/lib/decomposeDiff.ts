import { getLlm, isMockLlm } from "./llm.ts";
import type { DecomposedTask } from "./pageDecompose.ts";

// P3: 재분해 diff — 분해 제안을 기존 파생 태스크와 3단 매칭(앵커/제목 정확 → 유사도 → LLM)해
// 신규 / 이미 연결됨(체크리스트 병합 제안) / 문서에서 사라짐 으로 분류한다.
// 규칙 기반이 본체(키 없이 동작), LLM은 애매한 잔여쌍 판정에만 보조로 쓴다(실패 시 조용히 생략).

export interface DerivedForDiff {
  id: number;
  item_key: string;
  title: string;
  status: string;
  source_anchor: string | null;
  checklist: string[];
}

export interface DiffMatch {
  task_id: number;
  item_key: string;
  title: string;
  status: string;
  via: "anchor" | "similar" | "llm";
}

export interface DiffItem extends DecomposedTask {
  match: DiffMatch | null;
  new_checklist: string[]; // 매칭된 태스크에 아직 없는 체크 항목 (병합 제안)
}

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");

// 유사도 = max(바이그램 다이스, 단어 토큰 자카드).
// 다이스는 붙여쓰기·오타 변형에, 토큰 자카드는 단어 추가형 개정("로그인 구현"→"로그인/회원가입 구현")에 강하다.
export function titleSimilarity(a: string, b: string): number {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  let dice = 0;
  if (A.length >= 2 && B.length >= 2) {
    const grams = (s: string) => {
      const m = new Map<string, number>();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) ?? 0) + 1);
      }
      return m;
    };
    const ga = grams(A);
    const gb = grams(B);
    let inter = 0;
    for (const [g, v] of ga) inter += Math.min(v, gb.get(g) ?? 0);
    dice = (2 * inter) / (A.length - 1 + (B.length - 1));
  }
  const tok = (s: string) => new Set(s.toLowerCase().normalize("NFKC").split(/[\s\p{P}\p{S}]+/u).filter((w) => w.length >= 2));
  const ta = tok(a);
  const tb = tok(b);
  let jac = 0;
  if (ta.size && tb.size) {
    let inter = 0;
    for (const w of ta) if (tb.has(w)) inter++;
    jac = inter / (ta.size + tb.size - inter);
  }
  return Math.max(dice, jac);
}

const SIMILAR_THRESHOLD = 0.6;

async function llmPairs(
  rest: Array<{ i: number; title: string }>,
  restDerived: Array<{ id: number; title: string }>,
): Promise<Array<{ s: number; d: number }>> {
  try {
    const raw = await getLlm().complete([
      {
        role: "system",
        content:
          '문서 분해 항목(suggestions)과 기존 태스크(tasks) 중 "같은 작업"을 가리키는 쌍만 JSON으로 답하세요. ' +
          '형식: {"pairs":[{"s":<suggestion i>,"d":<task id>}]}. 확실한 쌍만 — 애매하면 제외. 없으면 빈 배열.',
      },
      { role: "user", content: JSON.stringify({ suggestions: rest, tasks: restDerived }).slice(0, 8000) },
    ]);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.pairs)
      ? parsed.pairs
          .map((p: any) => ({ s: Number(p.s), d: Number(p.d) }))
          .filter((p: any) => Number.isInteger(p.s) && Number.isInteger(p.d))
      : [];
  } catch {
    return []; // LLM 실패는 매칭 축소일 뿐 — diff 자체는 규칙 기반 결과로 진행
  }
}

export async function buildDecomposeDiff(
  suggestions: DecomposedTask[],
  derived: DerivedForDiff[],
): Promise<{ items: DiffItem[]; removed: DerivedForDiff[] }> {
  const items: DiffItem[] = suggestions.map((s) => ({ ...s, match: null, new_checklist: [] }));
  const taken = new Set<number>();
  const byId = new Map(derived.map((d) => [d.id, d]));
  const claim = (it: DiffItem, d: DerivedForDiff, via: DiffMatch["via"]) => {
    it.match = { task_id: d.id, item_key: d.item_key, title: d.title, status: d.status, via };
    taken.add(d.id);
  };

  // 1단: 앵커/현재 제목 정확 일치 (정규화 비교)
  for (const it of items) {
    const key = norm(it.title);
    if (!key) continue;
    const d = derived.find((d) => !taken.has(d.id) && (norm(d.source_anchor ?? "") === key || norm(d.title) === key));
    if (d) claim(it, d, "anchor");
  }

  // 2단: 유사도 — 잔여쌍 전수 계산 후 점수 높은 순 탐욕 매칭
  const restItems = () => items.filter((it) => !it.match);
  const restDerived = () => derived.filter((d) => !taken.has(d.id));
  const cand: Array<{ it: DiffItem; d: DerivedForDiff; score: number }> = [];
  for (const it of restItems())
    for (const d of restDerived()) {
      const score = Math.max(titleSimilarity(it.title, d.title), titleSimilarity(it.title, d.source_anchor ?? ""));
      if (score >= SIMILAR_THRESHOLD) cand.push({ it, d, score });
    }
  cand.sort((x, y) => y.score - x.score);
  for (const c of cand) if (!c.it.match && !taken.has(c.d.id)) claim(c.it, c.d, "similar");

  // 3단: LLM — 양쪽 잔여가 있을 때만 1회 (mock이면 생략)
  if (!isMockLlm()) {
    const ri = restItems();
    const rd = restDerived();
    if (ri.length && rd.length) {
      const pairs = await llmPairs(
        ri.map((it) => ({ i: items.indexOf(it), title: it.title })),
        rd.map((d) => ({ id: d.id, title: d.title })),
      );
      for (const p of pairs) {
        const it = items[p.s];
        const d = byId.get(p.d);
        if (it && !it.match && d && !taken.has(d.id)) claim(it, d, "llm");
      }
    }
  }

  // 병합 제안 — 매칭된 태스크에 없는 체크 항목만
  for (const it of items) {
    if (!it.match) continue;
    const existing = new Set((byId.get(it.match.task_id)?.checklist ?? []).map(norm));
    it.new_checklist = it.checklist.filter((c) => c.trim() && !existing.has(norm(c)));
  }

  const removed = derived.filter((d) => !taken.has(d.id));
  return { items, removed };
}

export const normalizeForDedup = norm;
