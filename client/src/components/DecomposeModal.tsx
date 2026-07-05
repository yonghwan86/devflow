import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Info, Wand2 } from "lucide-react";
import { post } from "../lib/api";
import { Modal, Button, Input, Badge, Spinner, toast } from "./ui";

// G6: 설계 문서 → 태스크+체크리스트 분해 제안 → 검토(선택/제목수정) → 일괄 반영.
// 제안은 DB에 저장하지 않고 휘발성으로 다룬다(검토 즉시 반영이 기본 흐름). 자동 등록 금지(§13).
interface Item {
  title: string;
  description?: string;
  checklist: string[];
  checkedTask: boolean;
  checkedItems: boolean[];
}

export function DecomposeModal({ pid, pageId, open, onClose, onApplied }: {
  pid: number; pageId: number; open: boolean; onClose: () => void; onApplied: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [derived, setDerived] = useState<Set<string>>(new Set());
  const [llmMode, setLlmMode] = useState("mock");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setItems([]);
    post<{ tasks: any[]; derived_titles: string[]; llm_mode: string }>(`/projects/${pid}/pages/${pageId}/decompose`, {})
      .then((d) => {
        const dset = new Set(d.derived_titles ?? []);
        setDerived(dset);
        setLlmMode(d.llm_mode);
        setItems((d.tasks ?? []).map((t: any) => ({
          title: t.title,
          description: t.description,
          checklist: t.checklist ?? [],
          checkedTask: !dset.has(t.title), // 이미 반영된 제목은 기본 해제(재분해 중복 방지 — 느슨한 판정)
          checkedItems: (t.checklist ?? []).map(() => true),
        })));
      })
      .catch((e: any) => toast(`분해 실패: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [open, pid, pageId]);

  const patchItem = (i: number, up: Partial<Item>) => setItems((arr) => arr.map((it, j) => (j === i ? { ...it, ...up } : it)));
  const toggleCheckItem = (i: number, j: number) =>
    setItems((arr) => arr.map((it, k) => (k === i ? { ...it, checkedItems: it.checkedItems.map((v, m) => (m === j ? !v : v)) } : it)));

  const apply = useMutation({
    mutationFn: () => {
      const tasks = items
        .filter((i) => i.checkedTask && i.title.trim())
        .map((i) => ({
          title: i.title.trim(),
          description: i.description,
          checklist: i.checklist.filter((_, j) => i.checkedItems[j]),
        }));
      return post<{ tasks: any[] }>(`/projects/${pid}/pages/${pageId}/apply-decomposition`, { tasks });
    },
    onSuccess: (d) => {
      toast(`${d.tasks.length}개 태스크를 만들었어요: ${d.tasks.map((t: any) => t.item_key).join(", ")}`, "success");
      onApplied();
      onClose();
    },
    onError: (e: any) => toast(`반영 실패: ${e.message}`, "error"),
  });

  const selectedCount = items.filter((i) => i.checkedTask && i.title.trim()).length;

  return (
    <Modal open={open} onClose={onClose} title="태스크로 분해">
      <div className="flex flex-col gap-3">
        {llmMode === "mock" && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
            <Info size={14} /> LLM 미연결 — 규칙 기반 분해(정확도 제한). 제목·항목을 검토·수정 후 반영하세요.
          </div>
        )}
        {loading ? (
          <div className="py-10"><Spinner /></div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">문서에서 분해할 작업을 찾지 못했어요. 제목(##)과 불릿(-)으로 구조를 잡아보세요.</div>
        ) : (
          <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
            {items.map((it, i) => {
              const already = derived.has(it.title);
              return (
                <div key={i} className={`rounded-xl border p-2.5 ${it.checkedTask ? "border-brand-200 bg-brand-50/30" : "border-slate-200 bg-slate-50/50"}`}>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={it.checkedTask} onChange={(e) => patchItem(i, { checkedTask: e.target.checked })}
                      className="h-4 w-4 rounded accent-indigo-600" />
                    <Input value={it.title} onChange={(e) => patchItem(i, { title: e.target.value })} className="h-8 min-h-0 flex-1 text-sm" />
                    {already && <Badge className="bg-slate-200 text-slate-500">반영됨</Badge>}
                  </div>
                  {it.checklist.length > 0 && (
                    <div className="ml-6 mt-1.5 flex flex-col gap-1">
                      {it.checklist.map((c, j) => (
                        <label key={j} className="flex items-center gap-2 text-xs text-slate-600">
                          <input type="checkbox" checked={it.checkedItems[j]} onChange={() => toggleCheckItem(i, j)} disabled={!it.checkedTask}
                            className="h-3.5 w-3.5 rounded accent-indigo-600" />
                          <span className={it.checkedTask ? "" : "text-slate-400"}>{c}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-slate-100 pt-2">
          <span className="text-xs text-slate-400">체크한 항목만 태스크·체크리스트로 만들어져요.</span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>취소</Button>
            <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || selectedCount === 0}>
              <Wand2 size={14} /> 선택 반영 ({selectedCount}개 태스크)
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
