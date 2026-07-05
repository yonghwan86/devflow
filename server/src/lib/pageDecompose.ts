import { getLlm, isMockLlm } from "./llm.ts";

// G6: 설계 문서(markdown) → 태스크 + 체크리스트 분해 제안.
// 구조 기반이 본체(LLM 키 없이도 동작), LLM은 정제 보강. 자동 등록 금지 — 제안만 반환한다(§13).
export interface DecomposedTask {
  title: string;
  description?: string;
  checklist: string[];
}
export interface Decomposition {
  tasks: DecomposedTask[];
}

// 비작업 섹션 제외 — 키워드가 단독 단어일 때만(뒤에 공백/끝/콜론). \b는 한글에서 동작 안 해 사용 금지.
const SKIP_HEADING = /^(개요|배경|참고|목적|부록|용어|references?)(\s|$|[:：])/i;
const MAX_TASKS = 30;
const MAX_CHECK = 20;
const TITLE_MAX = 200;
const CHECK_MAX = 300;

function heading(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}
function bullet(line: string): { indent: number; text: string } | null {
  const m = line.match(/^([ \t]*)(?:[-*]|◦|·)\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, "  ").length, text: m[2].trim() };
}

// 구조 기반 분해 — LLM 없이 동작(필수)
export function structDecompose(markdown: string): Decomposition {
  const lines = markdown.split(/\r?\n/);
  const hasHeading = lines.some((l) => { const h = heading(l); return !!h && (h.level === 2 || h.level === 3); });
  const tasks: DecomposedTask[] = [];

  if (hasHeading) {
    let cur: DecomposedTask | null = null;
    let skip = false;
    for (const line of lines) {
      const h = heading(line);
      if (h && (h.level === 2 || h.level === 3)) {
        skip = SKIP_HEADING.test(h.text);
        if (skip || tasks.length >= MAX_TASKS) { cur = null; continue; }
        cur = { title: h.text.slice(0, TITLE_MAX), checklist: [] };
        tasks.push(cur);
        continue;
      }
      if (skip || !cur) continue;
      const b = bullet(line);
      if (b && b.indent === 0 && b.text && cur.checklist.length < MAX_CHECK) cur.checklist.push(b.text.slice(0, CHECK_MAX));
    }
  } else {
    // heading이 없으면 최상위 불릿 → 태스크, 들여쓴 하위 불릿 → 체크리스트
    let cur: DecomposedTask | null = null;
    for (const line of lines) {
      const b = bullet(line);
      if (!b || !b.text) continue;
      if (b.indent === 0) {
        if (tasks.length >= MAX_TASKS) break;
        cur = { title: b.text.slice(0, TITLE_MAX), checklist: [] };
        tasks.push(cur);
      } else if (cur && cur.checklist.length < MAX_CHECK) {
        cur.checklist.push(b.text.slice(0, CHECK_MAX));
      }
    }
  }
  return { tasks: tasks.filter((t) => t.title) };
}

async function llmRefine(base: Decomposition): Promise<Decomposition> {
  try {
    const raw = await getLlm().complete([
      {
        role: "system",
        content:
          '설계 문서 분해 결과를 다듬어 JSON으로만 응답하세요. 형식: {"tasks":[{"title":"동사형 작업 제목","description":"선택","checklist":["항목",...]}]}. ' +
          "작업이 아닌 항목은 제거하고, 제목은 실행 가능한 동사형으로 다듬으세요. 태스크 최대 30개, 태스크당 체크 20개. 한국어 유지.",
      },
      { role: "user", content: JSON.stringify(base).slice(0, 20000) },
    ]);
    const parsed = JSON.parse(raw);
    const tasks: DecomposedTask[] = (parsed.tasks ?? [])
      .slice(0, MAX_TASKS)
      .map((t: any) => ({
        title: String(t.title ?? "").slice(0, TITLE_MAX),
        description: t.description ? String(t.description).slice(0, 4000) : undefined,
        checklist: Array.isArray(t.checklist)
          ? t.checklist.slice(0, MAX_CHECK).map((c: any) => String(c).slice(0, CHECK_MAX)).filter(Boolean)
          : [],
      }))
      .filter((t: DecomposedTask) => t.title);
    return tasks.length ? { tasks } : base;
  } catch {
    return base; // LLM 실패/파싱 오류 → 구조 기반 결과로 폴백(throw 금지)
  }
}

export async function decomposePage(markdown: string): Promise<Decomposition> {
  const base = structDecompose(markdown);
  if (isMockLlm() || base.tasks.length === 0) return base;
  return llmRefine(base);
}
