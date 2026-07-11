import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { NotebookPen, Lock, Clock, ImagePlus, Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import { get, put, upload, del } from "../lib/api";
import { Card, Button, Spinner, toast, useConfirm } from "../components/ui";
import { queryClient } from "../lib/queryClient";
import { localDayKey } from "../lib/format";

// N3: 내 기록 — 완전 개인 저널. 하루 = 한 페이지(열면 오늘 장), 안 쓴 날은 저장 안 함(lazy),
// "+ 지금" 시각 스탬프, #태그 추출, 이미지 붙여넣기/버튼(원본 첨부 보존), 1.5초 자동저장.
// 시리 단축어·MCP(journal_append)도 같은 데이터에 쌓인다.

const TAG_RE = /#[^\s#.,!?()[\]{}<>"']+/g;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const prettyDay = (key: string) => {
  const d = new Date(`${key}T00:00:00`);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
};
const shiftMonth = (ym: string, diff: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

interface DayRow { entry_date: string; updated_at: string; preview: string }
interface Att { id: number; file_name: string; download_url: string; thumb_url: string | null }

export default function Journal() {
  const today = localDayKey(new Date());
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [content, setContent] = useState("");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const loadedFor = useRef<string | null>(null); // 지금 에디터가 어느 날짜의 내용인지 (자동저장 대상)
  const savedContent = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const { confirm, dialog } = useConfirm();

  const daysQ = useQuery<{ today: string; days: DayRow[] }>({
    queryKey: ["journal", "month", month],
    queryFn: () => get(`/journal?month=${month}`),
  });
  const entryQ = useQuery<{ entry: { content: string } | null; attachments: Att[] }>({
    queryKey: ["journal", "day", date],
    queryFn: () => get(`/journal/${date}`),
  });
  const searchQ = useQuery<{ results: { entry_date: string; snippet: string }[] }>({
    queryKey: ["journal", "search", submittedQ],
    queryFn: () => get(`/journal/search?q=${encodeURIComponent(submittedQ)}`),
    enabled: !!submittedQ.trim(),
  });

  // 날짜의 내용이 도착하면 에디터에 반영 — 같은 날짜의 리페치가 편집 중 내용을 덮지 않게 1회만
  useEffect(() => {
    if (!entryQ.data || loadedFor.current === date) return;
    const c = entryQ.data.entry?.content ?? "";
    setContent(c);
    savedContent.current = c;
    loadedFor.current = date;
  }, [entryQ.data, date]);

  const saveNow = async (forDate: string, c: string) => {
    if (c === savedContent.current) return;
    try {
      const res = await put<{ entry: any }>(`/journal/${forDate}`, { content: c });
      savedContent.current = c;
      setSavedAt(new Date());
      // 날짜 캐시도 즉시 갱신 — 다른 날 갔다 돌아올 때(A→B→A) 낡은 캐시가 방금 저장분을 덮지 않게
      queryClient.setQueryData(["journal", "day", forDate], (old: any) =>
        old ? { ...old, entry: res.entry } : { entry: res.entry, attachments: [] });
      void queryClient.invalidateQueries({ queryKey: ["journal", "month"] });
    } catch (e: any) {
      toast(`저장 실패: ${e.message}`, "error");
    }
  };

  // 자동저장 — 1.5초 디바운스. 날짜 전환·이탈 시엔 즉시 저장(flush)
  useEffect(() => {
    if (loadedFor.current !== date || content === savedContent.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(date, content), 1500);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const switchDate = (d: string) => {
    if (d === date) return;
    if (timer.current) clearTimeout(timer.current);
    if (loadedFor.current) void saveNow(loadedFor.current, content);
    loadedFor.current = null;
    setDate(d);
    if (d.slice(0, 7) !== month) setMonth(d.slice(0, 7));
  };

  const insertNow = () => {
    const hm = new Date().toTimeString().slice(0, 5);
    const stamp = `**${hm}** `;
    setContent((c) => (c.trim() ? `${c.replace(/\s+$/, "")}\n\n${stamp}` : stamp));
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.scrollTop = el.scrollHeight; }
    });
  };

  const uploadMut = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("file", file); return upload(`/journal/${date}/attachments`, fd); },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["journal", "day", date] }),
    onError: (e: any) => toast(`이미지 업로드 실패: ${e.message}`, "error"),
  });
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => { for (const f of Array.from(input.files ?? [])) uploadMut.mutate(f); };
    input.click();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) { e.preventDefault(); files.forEach((f) => uploadMut.mutate(f)); }
  };
  const removeAtt = async (a: Att) => {
    if (!(await confirm({ title: "이미지 삭제", message: `"${a.file_name}"을(를) 삭제할까요? 복구할 수 없어요.`, confirmLabel: "삭제", tone: "danger" }))) return;
    try {
      await del(`/journal/attachments/${a.id}`);
      void queryClient.invalidateQueries({ queryKey: ["journal", "day", date] });
    } catch (e: any) { toast(`삭제 실패: ${e.message}`, "error"); }
  };

  const tags = useMemo(() => [...new Set(content.match(TAG_RE) ?? [])].slice(0, 12), [content]);
  const days = daysQ.data?.days ?? [];
  const atts = entryQ.data?.attachments ?? [];
  const dirty = loadedFor.current === date && content !== savedContent.current;

  return (
    <div className="flex flex-col gap-3">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
          <NotebookPen className="text-brand" size={22} /> 내 기록
        </h1>
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-500">
          <Lock size={11} /> 나만 볼 수 있어요 — 관리자 포함 누구에게도 안 보임
        </span>
        <div className="ml-auto">
          {date !== today && <Button size="sm" variant="outline" onClick={() => switchDate(today)}>오늘로</Button>}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_17rem]">
        {/* 에디터 — 모바일에서 맨 위: 열면 바로 쓰는 게 이 기능의 핵심 */}
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">{prettyDay(date)}{date === today && " · 오늘"}</span>
            <span className="text-xs text-slate-400">
              {dirty || uploadMut.isPending ? "저장 중…" : savedAt ? `저장됨 ${savedAt.toTimeString().slice(0, 5)}` : ""}
            </span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="outline" onClick={insertNow} title="지금 시각을 찍고 이어쓰기"><Clock size={13} /> 지금</Button>
              <Button size="sm" variant="outline" onClick={pickImage} disabled={uploadMut.isPending}><ImagePlus size={13} /> 이미지</Button>
            </div>
          </div>
          {entryQ.isError ? (
            // 로드 실패 시 에디터를 숨김 — 이전 날짜 내용이 남아 보이면 그 위에 쓴 글이 저장되지 않는 함정
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-sm text-slate-400">
              기록을 불러오지 못했어요.
              <Button size="sm" variant="outline" onClick={() => void entryQ.refetch()}>다시 시도</Button>
            </div>
          ) : entryQ.isLoading && loadedFor.current !== date ? (
            <div className="flex min-h-[50vh] items-center justify-center"><Spinner /></div>
          ) : (
            <textarea
              ref={areaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={onPaste}
              onBlur={() => { if (timer.current) clearTimeout(timer.current); void saveNow(date, content); }}
              placeholder={"오늘 한 일 / 막힌 것 / 아이디어 — 자유롭게 적으세요.\n#태그 로 분류하고, 이미지는 붙여넣기(Ctrl+V)나 [이미지] 버튼으로.\n음성은 키보드의 마이크(받아쓰기)를 쓰면 돼요."}
              className="min-h-[50vh] w-full resize-y rounded-xl border border-slate-200 p-3 font-mono text-sm leading-relaxed outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button key={t} onClick={() => { setQ(t); setSubmittedQ(t); }}
                  className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand transition hover:bg-brand-100" title={`${t} 검색`}>
                  {t}
                </button>
              ))}
            </div>
          )}
          {atts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {atts.map((a) => (
                <div key={a.id} className="group relative">
                  <a href={a.download_url} target="_blank" rel="noreferrer" title={a.file_name}>
                    <img src={a.thumb_url ?? a.download_url} alt={a.file_name} className="h-20 w-20 rounded-lg border border-slate-200 object-cover" />
                  </a>
                  <button onClick={() => void removeAtt(a)} aria-label={`${a.file_name} 삭제`}
                    className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-white group-hover:flex">
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 날짜 목록 + 검색 */}
        <Card className="flex flex-col gap-2 p-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setSubmittedQ(q); }}
              placeholder="기록 검색 (#태그 포함)"
              className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-7 text-sm outline-none transition focus:border-brand"
            />
            {submittedQ && (
              <button onClick={() => { setQ(""); setSubmittedQ(""); }} aria-label="검색 지우기"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"><X size={13} /></button>
            )}
          </div>
          {submittedQ ? (
            <div className="flex flex-col gap-1 overflow-y-auto">
              {searchQ.isLoading ? <Spinner /> : (searchQ.data?.results ?? []).length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">"{submittedQ}" 결과가 없어요.</div>
              ) : (
                (searchQ.data?.results ?? []).map((r) => (
                  <button key={r.entry_date} onClick={() => switchDate(r.entry_date)}
                    className="rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50">
                    <div className="text-xs font-semibold text-slate-600">{prettyDay(r.entry_date)}</div>
                    <div className="line-clamp-2 text-xs text-slate-400">{r.snippet}</div>
                  </button>
                ))
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="이전 달" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><ChevronLeft size={15} /></button>
                <span className="text-sm font-semibold text-slate-700">{month.replace("-", "년 ")}월</span>
                <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="다음 달" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><ChevronRight size={15} /></button>
              </div>
              <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
                {daysQ.isLoading ? <Spinner /> : days.length === 0 && month !== today.slice(0, 7) ? (
                  <div className="py-4 text-center text-xs text-slate-400">이 달에는 기록이 없어요.</div>
                ) : (
                  <>
                    {/* 오늘은 아직 안 썼어도 항상 목록 맨 위 */}
                    {month === today.slice(0, 7) && !days.some((d) => d.entry_date === today) && (
                      <button onClick={() => switchDate(today)}
                        className={`rounded-lg px-2 py-1.5 text-left transition ${date === today ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                        <div className="text-xs font-semibold text-slate-600">{prettyDay(today)} · 오늘</div>
                        <div className="text-xs text-slate-300">아직 기록 없음</div>
                      </button>
                    )}
                    {days.map((d) => (
                      <button key={d.entry_date} onClick={() => switchDate(d.entry_date)}
                        className={`rounded-lg px-2 py-1.5 text-left transition ${date === d.entry_date ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand" />
                          {prettyDay(d.entry_date)}{d.entry_date === today && " · 오늘"}
                        </div>
                        <div className="line-clamp-1 pl-3 text-xs text-slate-400">{d.preview.replace(/[#*`]/g, "")}</div>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
