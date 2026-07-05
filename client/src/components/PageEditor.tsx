import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Eye, Pencil, ListTodo, Wand2 } from "lucide-react";
import { get, patch, post } from "../lib/api";
import { Badge, Button, Modal, Select, Spinner, Textarea, toast, Field, Input } from "./ui";
import { STATUS_COLOR, STATUS_LABEL, PRIORITY_LABEL } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { DecomposeModal } from "./DecomposeModal";

// F4: 문서 에디터 — textarea 편집 ↔ 서버 렌더 미리보기 토글, 2초 debounce 자동저장,
// 미리보기에서 텍스트 선택 → "태스크로 만들기" 파생.
export function PageEditor({ pid, pageId }: { pid: number; pageId: number }) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [text, setText] = useState<string | null>(null); // null = 아직 로드 전
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 파생 모달
  const [selText, setSelText] = useState("");
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [deriveOpen, setDeriveOpen] = useState(false);
  const [dTitle, setDTitle] = useState("");
  const [dPriority, setDPriority] = useState(0);
  const [decomposeOpen, setDecomposeOpen] = useState(false); // G6: 문서 분해
  const previewRef = useRef<HTMLDivElement>(null);

  const q = useQuery<{ page: any; my_role: string }>({
    queryKey: ["page", pid, pageId],
    queryFn: () => get(`/projects/${pid}/pages/${pageId}`),
  });
  const derivedQ = useQuery<{ tasks: any[] }>({
    queryKey: ["page-derived", pid, pageId],
    queryFn: () => get(`/projects/${pid}/pages/${pageId}/derived-tasks`),
  });

  // 페이지 전환 시 로컬 상태 초기화 — ★ 대기 중인 자동저장 타이머를 반드시 취소(안 하면
  // 이전 문서 내용이 최신 pageId로 PATCH돼 새 문서를 덮어씀: 데이터 손상). unmount 시에도 정리.
  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setText(null); setMode("edit"); setSaveState("idle"); setFloatPos(null);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [pageId]);
  useEffect(() => {
    if (q.data && text === null) setText(q.data.page.content ?? "");
  }, [q.data, text]);

  const save = useMutation({
    mutationFn: (content: string) => patch(`/projects/${pid}/pages/${pageId}`, { content }),
    onSuccess: () => {
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
    },
    onError: (e: any) => { setSaveState("error"); toast(`저장 실패: ${e.message}`); },
  });

  const onChange = (v: string) => {
    setText(v);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(v), 2000); // 자동저장 debounce 2초
  };

  const toPreview = async () => {
    // 미저장 변경이 있으면 즉시 저장 후 GET으로 최신 content_html 수신(PATCH는 html 미포함)
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (text !== null && text !== q.data?.page.content) await save.mutateAsync(text);
    await queryClient.invalidateQueries({ queryKey: ["page", pid, pageId] });
    setMode("preview");
  };

  // 미리보기 선택 → 플로팅 버튼 (selection API)
  const onMouseUp = () => {
    const sel = window.getSelection();
    const s = sel?.toString().trim() ?? "";
    if (!s || !previewRef.current || !sel?.rangeCount) { setFloatPos(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = previewRef.current.getBoundingClientRect();
    setSelText(s);
    setFloatPos({ x: rect.left - host.left + rect.width / 2, y: rect.top - host.top - 8 });
  };

  const openDerive = () => {
    setDTitle(selText.slice(0, 80));
    setDPriority(0);
    setDeriveOpen(true);
    setFloatPos(null);
  };
  const derive = useMutation({
    mutationFn: () =>
      post(`/projects/${pid}/tasks`, {
        title: dTitle.trim(),
        // 선택 전체는 인용 블록으로 설명에 보존 (80자 초과분 포함)
        description: `> ${selText.replace(/\n/g, "\n> ")}\n\n(문서에서 파생됨)`,
        priority: dPriority,
        source_page_id: pageId,
      }),
    onSuccess: (r: any) => {
      setDeriveOpen(false);
      derivedQ.refetch();
      queryClient.invalidateQueries({ queryKey: ["tasks", pid] });
      toast(r.task.status === "requested" ? "티켓으로 요청했어요 (매니저 검토 후 진행)." : "태스크를 만들었어요.");
    },
    onError: (e: any) => toast(`태스크 파생 실패: ${e.message}`),
  });

  if (q.isLoading || text === null) return <div className="py-16"><Spinner /></div>;
  if (q.isError) return <div className="py-8 text-center text-sm text-slate-400">문서를 불러올 수 없어요.</div>;
  const page = q.data!.page;
  const derived = derivedQ.data?.tasks ?? [];
  const canManage = ["owner", "manager"].includes(q.data?.my_role ?? "");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-lg font-bold text-slate-800">{page.title}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {saveState === "saving" ? "저장 중…" : saveState === "saved" ? `저장됨 ${savedAt}` : saveState === "error" ? "저장 실패" : ""}
          </span>
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setDecomposeOpen(true)}>
              <Wand2 size={14} /> 태스크로 분해
            </Button>
          )}
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            <button onClick={() => setMode("edit")}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 ${mode === "edit" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              <Pencil size={13} /> 편집
            </button>
            <button onClick={toPreview}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 ${mode === "preview" ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
              <Eye size={13} /> 미리보기
            </button>
          </div>
        </div>
      </div>

      {mode === "edit" ? (
        <Textarea rows={18} value={text} onChange={(e) => onChange(e.target.value)}
          placeholder="마크다운으로 작성하세요. 미리보기에서 텍스트를 선택하면 태스크로 만들 수 있어요."
          className="min-h-[50vh] font-mono text-sm leading-relaxed" />
      ) : (
        <div className="relative" ref={previewRef} onMouseUp={onMouseUp}>
          {floatPos && (
            <button
              className="absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-slate-700"
              style={{ left: floatPos.x, top: floatPos.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openDerive}>
              <ListTodo size={12} className="mr-1 inline" /> 태스크로 만들기
            </button>
          )}
          <div
            className="prose-sm min-h-[50vh] max-w-none rounded-xl border border-slate-200 bg-white p-5 text-[15px] leading-relaxed text-slate-700 [&_a]:text-brand [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-semibold [&_blockquote]:border-l-4 [&_blockquote]:border-slate-200 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-800 [&_pre]:p-3 [&_pre]:text-slate-100"
            // 서버에서 sanitize(renderMarkdown)된 HTML만 — dangerouslySetInnerHTML은 이 content_html에만 사용
            dangerouslySetInnerHTML={{ __html: page.content_html ?? "" }}
          />
        </div>
      )}

      {/* 파생 태스크 목록 */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <ListTodo size={13} /> 이 문서에서 파생된 태스크 {derived.length > 0 && `(${derived.length})`}
        </div>
        {derived.length === 0 ? (
          <div className="text-xs text-slate-400">아직 없어요. 미리보기에서 텍스트를 선택해 태스크로 만들어보세요.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {derived.map((t) => (
              <Link key={t.id} href={`/projects/${pid}/tasks/${t.item_key}`}
                className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-sm shadow-sm transition hover:shadow">
                <span className="font-mono text-xs text-slate-400">{t.item_key}</span>
                <span className="min-w-0 flex-1 truncate text-slate-700">{t.title}</span>
                <Badge className={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 파생 모달 */}
      <Modal open={deriveOpen} onClose={() => setDeriveOpen(false)} title="태스크로 만들기">
        <div className="flex flex-col gap-3">
          <Field label="제목">
            <Input value={dTitle} onChange={(e) => setDTitle(e.target.value)} />
          </Field>
          <div className="max-h-28 overflow-y-auto rounded-lg bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-500">
            {selText}
          </div>
          <Field label="우선순위">
            <Select value={dPriority} onChange={(e) => setDPriority(Number(e.target.value))}>
              {PRIORITY_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeriveOpen(false)}>취소</Button>
            <Button onClick={() => dTitle.trim() && derive.mutate()} disabled={derive.isPending || !dTitle.trim()}>만들기</Button>
          </div>
        </div>
      </Modal>

      {/* G6: 문서 분해 모달 */}
      <DecomposeModal pid={pid} pageId={pageId} open={decomposeOpen} onClose={() => setDecomposeOpen(false)}
        onApplied={() => { derivedQ.refetch(); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); }} />
    </div>
  );
}
