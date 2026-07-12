import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Info, Wand2, GitMerge, EyeOff } from "lucide-react";
import { post } from "../lib/api";
import { Modal, Button, Input, Badge, Spinner, toast } from "./ui";

// G6+P3: 설계 문서 → 태스크+체크리스트 분해 → 기존 파생 태스크와 3단 매칭(앵커→유사도→LLM) diff →
// [신규 생성] [기존에 체크리스트 병합] [문서에서 사라진 태스크 안내] 를 사람이 검토·선택 후 일괄 반영.
// 제안은 DB에 저장하지 않는 휘발성. 자동 등록·자동 삭제 금지(§13) — 사라진 항목은 안내만 한다.
interface Match { task_id: number; item_key: string; title: string; status: string; via: string }
interface Item {
  title: string;
  anchor: string;          // 원본 분해 제목 — 모달에서 제목을 고쳐도 앵커는 문서 쪽 제목 유지
  description?: string;
  checklist: string[];
  match: Match | null;
  new_checklist: string[];
  checkedTask: boolean;    // 신규: 태스크 생성 / 매칭됨: 체크리스트 병합
  checkedItems: boolean[]; // 신규: checklist 선택 / 매칭됨: new_checklist 선택
}
interface Removed { id: number; item_key: string; title: string; status: string }

export function DecomposeModal({ pid, pageId, open, onClose, onApplied }: {
  pid: number; pageId: number; open: boolean; onClose: () => void; onApplied: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [llmMode, setLlmMode] = useState("mock");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setItems([]);
    setRemoved([]);
    post<{ items: any[]; removed: Removed[]; truncated?: boolean; llm_mode: string }>(`/projects/${pid}/pages/${pageId}/decompose`, {})
      .then((d) => {
        setLlmMode(d.llm_mode);
        setRemoved(d.removed ?? []);
        setTruncated(!!d.truncated);
        setItems((d.items ?? []).map((t: any) => {
          const match: Match | null = t.match ?? null;
          const newChecks: string[] = t.new_checklist ?? [];
          return {
            title: t.title,
            anchor: t.title,
            description: t.description,
            checklist: t.checklist ?? [],
            match,
            new_checklist: newChecks,
            // 신규는 기본 생성 체크, 매칭된 건 병합할 새 항목이 있을 때만 기본 체크
            checkedTask: match ? newChecks.length > 0 : true,
            checkedItems: (match ? newChecks : t.checklist ?? []).map(() => true),
          };
        }));
      })
      .catch((e: any) => toast(`분해 실패: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [open, pid, pageId]);

  const patchItem = (i: number, up: Partial<Item>) => setItems((arr) => arr.map((it, j) => (j === i ? { ...it, ...up } : it)));
  const toggleCheckItem = (i: number, j: number) =>
    setItems((arr) => arr.map((it, k) => (k === i ? { ...it, checkedItems: it.checkedItems.map((v, m) => (m === j ? !v : v)) } : it)));

  const newItems = items.filter((i) => !i.match);
  const linkedItems = items.filter((i) => i.match);
  const createCount = newItems.filter((i) => i.checkedTask && i.title.trim()).length;
  const mergeCount = linkedItems.filter((i) => i.checkedTask && i.checkedItems.some(Boolean)).length;
  // 앵커만 갱신할 항목 — 유사도/LLM으로 매칭됐거나 문서 제목이 바뀐 경우, 갱신해 두지 않으면
  // 개정이 누적될수록 매칭이 끊겨 removed 오탐·중복 생성으로 번진다 (검증단 발견)
  const anchorOnly = linkedItems.filter((i) => i.match!.via !== "anchor" && !(i.checkedTask && i.checkedItems.some(Boolean)));

  const apply = useMutation({
    mutationFn: () => {
      const tasks = newItems
        .filter((i) => i.checkedTask && i.title.trim())
        .map((i) => ({
          title: i.title.trim().slice(0, 200),
          description: i.description,
          checklist: i.checklist.filter((_, j) => i.checkedItems[j]),
          anchor: i.anchor.trim().slice(0, 200) || undefined, // 원본 분해 제목 — 제목을 고쳐 만들어도 매칭 유지
        }));
      const merges = [
        ...linkedItems
          .filter((i) => i.checkedTask && i.checkedItems.some(Boolean))
          .map((i) => ({
            task_id: i.match!.task_id,
            anchor: i.title.trim().slice(0, 200),
            add_checklist: i.new_checklist.filter((_, j) => i.checkedItems[j]),
          })),
        // 앵커 전용 갱신 (체크리스트 추가 없음)
        ...anchorOnly.map((i) => ({ task_id: i.match!.task_id, anchor: i.title.trim().slice(0, 200), add_checklist: [] })),
      ];
      return post<{ tasks: any[]; merged: number }>(`/projects/${pid}/pages/${pageId}/apply-decomposition`, { tasks, merges });
    },
    onSuccess: (d) => {
      const parts = [
        d.tasks.length ? `태스크 ${d.tasks.length}개 생성 (${d.tasks.map((t: any) => t.item_key).join(", ")})` : "",
        d.merged ? `기존 태스크 ${d.merged}개에 체크리스트 병합` : "",
      ].filter(Boolean);
      toast(parts.join(" · ") || "반영했어요.", "success");
      onApplied();
      onClose();
    },
    onError: (e: any) => toast(`반영 실패: ${e.message}`, "error"),
  });

  return (
    <Modal open={open} onClose={onClose} title="태스크로 분해" size="lg">
      <div className="flex flex-col gap-3">
        {llmMode === "mock" && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
            <Info size={14} /> LLM 미연결 — 규칙 기반 분해·매칭(정확도 제한). 제목·항목을 검토·수정 후 반영하세요.
          </div>
        )}
        {loading ? (
          <div className="py-10"><Spinner /></div>
        ) : items.length === 0 && removed.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">문서에서 분해할 작업을 찾지 못했어요. 제목(##)과 불릿(-)으로 구조를 잡아보세요.</div>
        ) : (
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
            {newItems.length > 0 && (
              <section>
                <div className="mb-1.5 text-xs font-semibold text-slate-500">새 태스크로 만들기 <span className="text-slate-300">{newItems.length}</span></div>
                <div className="flex flex-col gap-2">
                  {newItems.map((it) => {
                    const i = items.indexOf(it);
                    return (
                      <div key={i} className={`rounded-xl border p-2.5 ${it.checkedTask ? "border-brand-200 bg-brand-50/30" : "border-slate-200 bg-slate-50/50"}`}>
                        <div className="flex items-center gap-2">
                          <input type="checkbox" checked={it.checkedTask} onChange={(e) => patchItem(i, { checkedTask: e.target.checked })}
                            className="h-4 w-4 rounded accent-indigo-600" />
                          <Input value={it.title} maxLength={200} onChange={(e) => patchItem(i, { title: e.target.value })} className="h-8 min-h-0 min-w-0 flex-1 text-sm" />
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
              </section>
            )}
            {linkedItems.length > 0 && (
              <section>
                <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-500">
                  <GitMerge size={13} className="text-emerald-500" /> 이미 태스크로 연결됨 <span className="text-slate-300">{linkedItems.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {linkedItems.map((it) => {
                    const i = items.indexOf(it);
                    const hasNew = it.new_checklist.length > 0;
                    return (
                      <div key={i} className={`rounded-xl border p-2.5 ${hasNew && it.checkedTask ? "border-emerald-200 bg-emerald-50/30" : "border-slate-200 bg-slate-50/50"}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          {hasNew ? (
                            <input type="checkbox" checked={it.checkedTask} onChange={(e) => patchItem(i, { checkedTask: e.target.checked })}
                              className="h-4 w-4 rounded accent-emerald-600" />
                          ) : (
                            <span className="h-4 w-4" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{it.title}</span>
                          <Badge className="bg-emerald-100 font-mono text-emerald-700">{it.match!.item_key}</Badge>
                          {it.match!.title.trim() !== it.title.trim() && (
                            <span title={`태스크 제목: ${it.match!.title}`}><Badge className="bg-slate-100 text-slate-500">제목 다름</Badge></span>
                          )}
                        </div>
                        {hasNew ? (
                          <div className="ml-6 mt-1.5 flex flex-col gap-1">
                            <div className="text-[11px] text-emerald-600">문서에 새로 생긴 체크 항목 — 체크한 것만 기존 태스크에 추가돼요</div>
                            {it.new_checklist.map((c, j) => (
                              <label key={j} className="flex items-center gap-2 text-xs text-slate-600">
                                <input type="checkbox" checked={it.checkedItems[j]} onChange={() => toggleCheckItem(i, j)} disabled={!it.checkedTask}
                                  className="h-3.5 w-3.5 rounded accent-emerald-600" />
                                <span className={it.checkedTask ? "" : "text-slate-400"}>{c}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <div className="ml-6 mt-1 text-[11px] text-slate-400">변경 없음 — 이미 반영돼 있어요</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            {truncated && (
              <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
                <Info size={14} /> 문서가 커서 앞 30개 항목만 분해했어요 — "문서에서 사라짐" 판정은 이번엔 표시하지 않아요.
              </div>
            )}
            {removed.length > 0 && (
              <section>
                <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-500">
                  <EyeOff size={13} className="text-slate-400" /> 문서에서 사라진 항목의 태스크 <span className="text-slate-300">{removed.length}</span>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-xs text-slate-500">
                  <div className="mb-1 text-[11px] text-slate-400">자동으로 삭제하지 않아요 — 진행 이력이 있을 수 있으니 필요하면 태스크에서 직접 정리하세요.</div>
                  <div className="flex flex-col gap-1">
                    {removed.map((r) => (
                      <Link key={r.id} href={`/projects/${pid}/tasks/${r.item_key}`} className="truncate text-slate-600 hover:text-brand hover:underline">
                        <span className="font-mono text-slate-400">{r.item_key}</span> {r.title}
                      </Link>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
          <span className="min-w-0 text-xs text-slate-400">{items.length > 0 ? "체크한 항목만 반영돼요." : ""}</span>
          <div className="flex flex-shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>취소</Button>
            <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || (createCount === 0 && mergeCount === 0 && anchorOnly.length === 0)}>
              <Wand2 size={14} /> 반영{createCount > 0 && ` · 생성 ${createCount}`}{mergeCount > 0 && ` · 병합 ${mergeCount}`}{createCount === 0 && mergeCount === 0 && anchorOnly.length > 0 && " · 연결 갱신"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
