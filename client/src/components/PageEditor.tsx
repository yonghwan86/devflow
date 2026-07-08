import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Eye, Pencil, ListTodo, Wand2, FileUp, History } from "lucide-react";
import { get, patch, post } from "../lib/api";
import { Badge, Button, Modal, NameChip, Select, Spinner, Textarea, toast, Field, Input, useConfirm } from "./ui";
import { useTextFileIntake } from "../lib/textFile";
import { STATUS_COLOR, STATUS_LABEL, PRIORITY_LABEL, fmtDate } from "../lib/format";
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
  // 버전 기록 — 내용이 바뀌는 저장마다 서버가 직전 본문을 남김(최근 20개). 보기·복원은 멤버 전원.
  const [revOpen, setRevOpen] = useState(false);
  const [revSel, setRevSel] = useState<number | null>(null);
  const revsQ = useQuery<{ revisions: any[] }>({
    queryKey: ["page-revs", pid, pageId],
    queryFn: () => get(`/projects/${pid}/pages/${pageId}/revisions`),
    enabled: revOpen,
  });
  const revQ = useQuery<{ revision: any }>({
    queryKey: ["page-rev", pid, pageId, revSel],
    queryFn: () => get(`/projects/${pid}/pages/${pageId}/revisions/${revSel}`),
    enabled: revOpen && revSel != null,
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
      queryClient.invalidateQueries({ queryKey: ["page-revs", pid, pageId] }); // 저장이 새 버전을 남겼을 수 있음
    },
    onError: (e: any) => { setSaveState("error"); toast(`저장 실패: ${e.message}`); },
  });

  const onChange = (v: string) => {
    setText(v);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(v), 2000); // 자동저장 debounce 2초
  };

  // 복원·파일 불러오기는 디바운스를 안 탐 — "완료" 토스트 후 2초 안에 다른 문서로 이동하면
  // pageId 전환 effect가 타이머를 취소해 저장이 조용히 무산되는 창을 없앤다
  const applyContentNow = (content: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setMode("edit");
    setText(content);
    setSaveState("saving");
    save.mutate(content);
  };

  // .txt/.md 파일 내용을 에디터에 채움 — 자동저장이 2초 뒤 서버에 반영되므로
  // 기존 내용이 있으면 반드시 confirm (덮어쓴 이전 본문은 버전 기록에서 복원 가능)
  const { confirm, dialog } = useConfirm();
  const intake = useTextFileIntake({
    maxBytes: 700 * 1024, // JSON 이스케이프 여유 포함 서버 body 한도(1MB) 안쪽
    onText: async (fileText, f) => {
      if ((text ?? "").trim() && text !== fileText) {
        const ok = await confirm({
          title: "파일 내용으로 덮어쓸까요?",
          message: `"${f.name}" 내용으로 이 문서 전체가 바뀌어요. 이전 내용은 버전 기록에서 복원할 수 있어요.`,
          confirmLabel: "덮어쓰기",
          tone: "danger",
        });
        if (!ok) return;
      }
      applyContentNow(fileText);
    },
    onError: (m) => toast(m),
  });

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

  // ★ 에러를 로딩보다 먼저 — 404(예: 문서가 휴지통) 시 text가 영원히 null이라 스피너에 갇힘
  if (q.isError) return <div className="py-8 text-center text-sm text-slate-400">문서를 불러올 수 없어요. 삭제됐거나(휴지통) 권한이 없을 수 있어요.</div>;
  if (q.isLoading || text === null) return <div className="py-16"><Spinner /></div>;
  const page = q.data!.page;
  const derived = derivedQ.data?.tasks ?? [];
  const canManage = ["owner", "manager"].includes(q.data?.my_role ?? "");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-lg font-bold text-slate-800">{page.title}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {saveState === "saving" ? "저장 중…" : saveState === "saved" ? `저장됨 ${savedAt}` : saveState === "error" ? "저장 실패" : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setRevOpen(true)} title="버전 기록 보기·복원">
            <History size={14} /> 버전
          </Button>
          {mode === "edit" && (
            <Button variant="outline" size="sm" onClick={intake.openPicker} title=".txt/.md 파일 내용을 에디터로 불러오기">
              <FileUp size={14} /> 파일에서 불러오기
            </Button>
          )}
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

      {/* C13: 만든 사람 + 등록일 (+ 다른 사람이 고쳤으면 마지막 수정자) — 태스크 상세와 같은 문법 */}
      <div className="-mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
        만든 사람 {page.creator_name ? <NameChip name={page.creator_name} /> : <span className="text-slate-300">알 수 없음</span>}
        <span>· {fmtDate(page.created_at)}</span>
        {page.updater_name && page.updated_by !== page.created_by && (
          <span className="inline-flex items-center gap-1.5">· 마지막 수정 <NameChip name={page.updater_name} /> {fmtDate(page.updated_at)}</span>
        )}
      </div>

      {mode === "edit" ? (
        <div {...intake.dropProps} className={`relative ${intake.dragging ? "rounded-lg ring-2 ring-brand" : ""}`}>
          <Textarea rows={18} value={text} onChange={(e) => onChange(e.target.value)}
            placeholder={"마크다운으로 작성하세요. 미리보기에서 텍스트를 선택하면 태스크로 만들 수 있어요.\n텍스트 파일(.txt/.md)을 끌어다 놓으면 내용을 불러와요."}
            className="min-h-[50vh] font-mono text-sm leading-relaxed" />
          {intake.dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-brand-50/85 text-sm font-semibold text-brand">
              파일을 놓으면 내용을 불러와요
            </div>
          )}
        </div>
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

      {/* 버전 기록 — 목록에서 고르면 본문 미리보기, 복원은 에디터에 채워 자동저장으로 반영 */}
      <Modal open={revOpen} onClose={() => { setRevOpen(false); setRevSel(null); }} title="버전 기록" size="lg">
        {revsQ.isLoading ? (
          <div className="py-8"><Spinner /></div>
        ) : revsQ.isError ? (
          <div className="py-8 text-center text-sm text-slate-400">버전 기록을 불러오지 못했어요. 잠시 후 다시 열어주세요.</div>
        ) : (revsQ.data?.revisions ?? []).length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">아직 버전 기록이 없어요. 내용이 바뀌는 저장부터 쌓여요.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
              {(revsQ.data?.revisions ?? []).map((r) => (
                <button key={r.id} onClick={() => setRevSel(r.id)}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${revSel === r.id ? "bg-brand-50 font-medium text-brand" : "text-slate-600 hover:bg-slate-50"}`}>
                  <span className="flex-shrink-0 text-xs text-slate-400">{new Date(r.saved_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  {r.saver_name && <NameChip name={r.saver_name} />}
                  <span className="ml-auto flex-shrink-0 text-xs text-slate-400">{r.chars.toLocaleString()}자</span>
                </button>
              ))}
            </div>
            {revSel != null && (
              <>
                <div className="max-h-[35vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-600">
                  {revQ.isError ? "이 버전을 불러오지 못했어요. 다른 버전을 선택하거나 다시 열어주세요." : revQ.data?.revision?.content ?? "불러오는 중…"}
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={revQ.data?.revision?.content == null}
                    onClick={async () => {
                      const content = revQ.data?.revision?.content;
                      if (content == null) return;
                      const ok = await confirm({
                        title: "버전 복원",
                        message: "현재 내용을 이 버전으로 되돌릴까요? 되돌리기 직전의 현재 내용도 버전 기록에 남아요.",
                        confirmLabel: "복원",
                      });
                      if (!ok) return;
                      applyContentNow(content); // 즉시 저장 — 디바운스 창에서 무산 방지
                      setRevOpen(false); setRevSel(null);
                      toast("복원했어요.");
                    }}>
                    이 버전으로 복원
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* G6: 문서 분해 모달 */}
      <DecomposeModal pid={pid} pageId={pageId} open={decomposeOpen} onClose={() => setDecomposeOpen(false)}
        onApplied={() => { derivedQ.refetch(); queryClient.invalidateQueries({ queryKey: ["tasks", pid] }); }} />
    </div>
  );
}
