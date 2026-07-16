import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { NotebookPen, Lock, Clock, ImagePlus, Search, ChevronLeft, ChevronRight, X, Mic, CalendarRange, Copy, History } from "lucide-react";
import { get, post, put, upload, del } from "../lib/api";
import { Card, Button, Modal, Select, Input, Field, Spinner, toast, useConfirm, cx } from "../components/ui";
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

interface DayRow { entry_date: string; updated_at: string; preview: string; image_count: number }
interface Att { id: number; file_name: string; download_url: string; thumb_url: string | null; ocr_text: string | null }

export default function Journal() {
  const today = localDayKey(new Date());
  // AI 검색 결과("내 기록" 출처)에서 /journal?date=… 로 진입하면 그 날짜를 바로 연다
  const qsDate = new URLSearchParams(window.location.search).get("date");
  const initialDate = qsDate && /^\d{4}-\d{2}-\d{2}$/.test(qsDate) ? qsDate : today;
  const [date, setDate] = useState(initialDate);
  const [month, setMonth] = useState(initialDate.slice(0, 7));
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
  // 잔디 히트맵 — 최근 16주, 진할수록 그날 많이 씀 (스트릭 카운터는 의도적으로 없음: 하루 빠져도 잔디는 안 무너짐)
  const heatQ = useQuery<{ today: string; days: { entry_date: string; chars: number }[] }>({
    queryKey: ["journal", "heatmap"],
    queryFn: () => get(`/journal/heatmap?weeks=16`),
  });
  // 작년 오늘 — 있을 때만 카드 노출 (2/29 같은 없는 날짜는 행이 없어 자연히 숨음)
  const lastYear = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
  const lastYearQ = useQuery<{ entry: { content: string } | null }>({
    queryKey: ["journal", "day", lastYear],
    queryFn: () => get(`/journal/${lastYear}`),
  });

  // 날짜의 내용이 도착하면 에디터에 반영.
  // - 첫 로드(날짜 전환 포함): 무조건 반영. - 같은 날짜 리페치: 로컬 편집이 없을 때만 최신 서버본 반영.
  //   (편집 중이면 덮지 않음 / 편집이 없으면 시리·MCP로 밖에서 추가된 내용을 받아들여, 이후 한 글자 입력→
  //    옛 본문 덮어쓰기로 외부 추가분이 소실되던 문제를 막는다)
  useEffect(() => {
    if (!entryQ.data) return;
    const c = entryQ.data.entry?.content ?? "";
    if (loadedFor.current !== date) {
      setContent(c);
      savedContent.current = c;
      loadedFor.current = date;
    } else if (content === savedContent.current && c !== savedContent.current) {
      setContent(c);
      savedContent.current = c;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryQ.data, date]);

  const saveNow = async (forDate: string, c: string) => {
    if (c === savedContent.current) return;
    try {
      const res = await put<{ entry: any }>(`/journal/${forDate}`, { content: c });
      // 저장이 끝난 사이 다른 날짜로 이동했을 수 있음 — 지금 그 날짜를 편집 중일 때만 로컬 상태를 갱신
      // (안 그러면 방금 이동해 로드한 새 날짜의 savedContent가 이전 날짜 내용으로 되돌아가 '저장 중'이 고정됨)
      if (loadedFor.current === forDate) {
        savedContent.current = c;
        setSavedAt(new Date());
      }
      // 날짜 캐시는 forDate로 키가 걸려 항상 갱신 — 다른 날 갔다 돌아올 때(A→B→A) 낡은 캐시가 방금 저장분을 덮지 않게
      queryClient.setQueryData(["journal", "day", forDate], (old: any) =>
        old ? { ...old, entry: res.entry } : { entry: res.entry, attachments: [] });
      void queryClient.invalidateQueries({ queryKey: ["journal", "month"] });
      void queryClient.invalidateQueries({ queryKey: ["journal", "heatmap"] });
      void queryClient.invalidateQueries({ queryKey: ["journal", "range"] });
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
    // 딕테이션 중 날짜 전환 — stop()은 이미 캡처된 오디오의 최종 결과를 뒤늦게 흘려보내 다른 날 본문에 붙는다.
    // abort()로 보류 결과를 폐기해야 이전 날짜에서 말한 내용이 새 날짜로 새지 않는다.
    try { recRef.current?.abort?.(); } catch { /* 미시작 */ }
    if (timer.current) clearTimeout(timer.current);
    if (loadedFor.current) void saveNow(loadedFor.current, content);
    loadedFor.current = null;
    setDate(d);
    if (d.slice(0, 7) !== month) setMonth(d.slice(0, 7));
  };

  const insertNow = () => {
    if (loadedFor.current !== date) return; // 로딩 중엔 삽입 금지 — 뒤늦게 도착하는 로드가 덮어 소실됨
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
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["journal", "day", date] }); void queryClient.invalidateQueries({ queryKey: ["journal", "month"] }); void queryClient.invalidateQueries({ queryKey: ["journal", "heatmap"] }); },
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
      void queryClient.invalidateQueries({ queryKey: ["journal", "month"] });
      void queryClient.invalidateQueries({ queryKey: ["journal", "heatmap"] });
    } catch (e: any) { toast(`삭제 실패: ${e.message}`, "error"); }
  };

  // 🎤 딕테이션 — 브라우저 내장 음성 인식(Web Speech). 미지원 브라우저는 버튼 자체를 숨김.
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const stopMic = () => { try { recRef.current?.stop(); } catch { /* 이미 종료 */ } };
  useEffect(() => () => { try { recRef.current?.abort?.(); } catch { /* unmount */ } }, []);
  const toggleMic = () => {
    if (listening) { stopMic(); return; }
    if (loadedFor.current !== date) return; // 로딩 중엔 시작 금지
    const startDate = date; // 이 인식이 시작된 날짜 — 결과가 늦게 와도 다른 날에 붙지 않게
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev: any) => {
      if (loadedFor.current !== startDate) return; // 인식 도중 날짜가 바뀌었으면 이 결과는 버림
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
      text = text.trim();
      if (text) {
        setContent((c) => (c.trim() ? `${c.replace(/[ \t]+$/, "")}${c.endsWith("\n") || !c.trim() ? "" : " "}${text}` : text));
        requestAnimationFrame(() => { const el = areaRef.current; if (el) el.scrollTop = el.scrollHeight; });
      }
    };
    rec.onerror = (e: any) => {
      setListening(false);
      if (e?.error === "not-allowed") toast("마이크 권한을 허용해야 음성 입력을 쓸 수 있어요.", "error");
      else if (e?.error && e.error !== "aborted" && e.error !== "no-speech") toast(`음성 인식 오류: ${e.error}`, "error");
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { toast("음성 인식을 시작하지 못했어요.", "error"); }
  };

  // 주간 모아보기 — 선택한 날짜가 속한 주(일~토, 캘린더 주간 뷰와 동일 규약)를 한 화면에
  const [rollupOpen, setRollupOpen] = useState(false);
  const rollupRange = useMemo(() => {
    const d = new Date(`${date}T00:00:00`);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: localDayKey(start), to: localDayKey(end) };
  }, [date]);
  const rollupQ = useQuery<{ entries: { entry_date: string; content: string }[] }>({
    queryKey: ["journal", "range", rollupRange.from, rollupRange.to],
    queryFn: () => get(`/journal/range?from=${rollupRange.from}&to=${rollupRange.to}`),
    enabled: rollupOpen,
  });
  const copyRollup = async () => {
    const body = (rollupQ.data?.entries ?? []).map((e) => `## ${prettyDay(e.entry_date)}\n${e.content.trim()}`).join("\n\n");
    try { await navigator.clipboard.writeText(body); toast("이번 주 기록을 복사했어요.", "success"); }
    catch { toast("복사하지 못했어요.", "error"); }
  };

  // 오늘 요약 — 이 날 완료한 태스크·참석 일정을 본문 끝에 붙임 (자동 수집, 나는 코멘트만)
  const [summarizing, setSummarizing] = useState(false);
  const summarize = async () => {
    if (loadedFor.current !== date) return;
    const forDate = date; // await 사이 날짜가 바뀔 수 있어 캡처
    setSummarizing(true);
    try {
      const r = await get<{ tasks: { item_key: string; title: string }[]; events: { title: string; time: string | null }[] }>(
        `/journal/day-summary?date=${forDate}`);
      // 요약을 받는 사이 다른 날로 이동했으면 붙이지 않음 — 그 날 요약이 엉뚱한 날짜에 저장되던 문제 차단
      if (loadedFor.current !== forDate) { toast("날짜가 바뀌어 요약을 취소했어요."); return; }
      const lines = [
        ...r.tasks.map((t) => `- ✅ ${t.item_key} ${t.title}`),
        ...r.events.map((e) => `- 📅 ${e.title}${e.time ? ` (${e.time})` : " (종일)"}`),
      ];
      if (!lines.length) { toast("이 날 완료한 태스크·참석 일정이 없어요."); return; }
      const block = `**요약**\n${lines.join("\n")}`;
      setContent((c) => (c.trim() ? `${c.replace(/\s+$/, "")}\n\n${block}` : block));
      requestAnimationFrame(() => { const el = areaRef.current; if (el) el.scrollTop = el.scrollHeight; });
    } catch (e: any) { toast(`요약을 불러오지 못했어요: ${e.message}`, "error"); }
    finally { setSummarizing(false); }
  };

  // 조각 승격 — 선택한 텍스트를 태스크/문서로 (개인 태스크·문서 개념이 없어 프로젝트 선택 필수)
  const [sel, setSel] = useState("");
  const onSelect = () => { const el = areaRef.current; setSel(el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : ""); };
  const [promo, setPromo] = useState<null | { kind: "task" | "page"; text: string }>(null);
  const [promoTitle, setPromoTitle] = useState("");
  const [promoPid, setPromoPid] = useState("");
  const projectsQ = useQuery<{ projects: { id: number; name: string; my_role: string }[] }>({
    queryKey: ["projects"],
    queryFn: () => get("/projects"),
    enabled: !!promo,
  });
  const openPromote = (kind: "task" | "page") => {
    if (!sel) return;
    setPromoTitle(sel.split("\n")[0].replace(/^[-*#>\s]+|\*\*/g, "").slice(0, 80).trim());
    setPromo({ kind, text: sel });
  };
  const promoRole = projectsQ.data?.projects.find((p) => String(p.id) === promoPid)?.my_role;
  const promoteMut = useMutation({
    mutationFn: () => {
      const pid = Number(promoPid);
      return promo!.kind === "task"
        ? post(`/projects/${pid}/tasks`, { title: promoTitle.trim(), description: promo!.text })
        : post(`/projects/${pid}/pages`, { title: promoTitle.trim(), content: promo!.text });
    },
    onSuccess: (r: any) => {
      const label = promo!.kind === "task"
        ? (r?.task?.status === "requested" ? `티켓으로 요청했어요 (${r?.task?.item_key ?? ""} — 매니저 승인 후 진행)` : `태스크를 만들었어요 (${r?.task?.item_key ?? ""})`)
        : "문서를 만들었어요";
      toast(label, "success");
      setPromo(null);
    },
    onError: (e: any) => toast(`승격 실패: ${e.message}`, "error"),
  });

  const tags = useMemo(() => [...new Set(content.match(TAG_RE) ?? [])].slice(0, 12), [content]);
  const days = daysQ.data?.days ?? [];
  const atts = entryQ.data?.attachments ?? [];
  const dirty = loadedFor.current === date && content !== savedContent.current;
  const editorReady = loadedFor.current === date && !entryQ.isError; // 지금·음성·요약은 이 날 내용이 로드된 뒤에만

  // 히트맵 격자 — 열 = 주(일요일 시작, 캘린더와 동일), 오늘로 끝나는 최근 16주
  const heatWeeks = useMemo(() => {
    const map = new Map((heatQ.data?.days ?? []).map((d) => [d.entry_date, d.chars]));
    const end = new Date(`${today}T00:00:00`);
    const start = new Date(end);
    start.setDate(end.getDate() - (16 * 7 - 1));
    start.setDate(start.getDate() - start.getDay());
    const weeks: { key: string; chars: number | null }[][] = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0) weeks.push([]);
      const key = localDayKey(d);
      weeks[weeks.length - 1].push({ key, chars: map.has(key) ? map.get(key)! : null });
    }
    return weeks;
  }, [heatQ.data, today]);
  const heatColor = (chars: number | null) =>
    chars == null ? "bg-slate-100" : chars < 200 ? "bg-brand-200" : chars < 800 ? "bg-brand-400" : "bg-brand-600";

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
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={insertNow} disabled={!editorReady} title="지금 시각을 찍고 이어쓰기"><Clock size={13} /> 지금</Button>
              <Button size="sm" variant="outline" onClick={pickImage} disabled={uploadMut.isPending}><ImagePlus size={13} /> 이미지</Button>
              {!!SR && (
                <Button size="sm" variant={listening ? "primary" : "outline"} onClick={toggleMic} disabled={!editorReady && !listening}
                  title="말하는 대로 본문에 입력 (브라우저 음성 인식)">
                  <Mic size={13} className={listening ? "animate-pulse" : undefined} /> {listening ? "듣는 중" : "음성"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void summarize()} disabled={summarizing || !editorReady}
                title="이 날 완료한 태스크·참석 일정을 본문에 추가">요약</Button>
            </div>
          </div>
          {sel && !promo && (
            // 선택 승격 바 — 드래그한 조각을 태스크/문서로. onMouseDown preventDefault로 선택이 풀리기 전에 잡는다.
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-brand-50/70 px-2 py-1.5 text-xs text-slate-500">
              <span className="min-w-0 max-w-[14rem] truncate">“{sel.slice(0, 60)}”</span>
              <span className="text-slate-300">→</span>
              <Button size="sm" variant="outline" onMouseDown={(e) => { e.preventDefault(); openPromote("task"); }}>태스크로</Button>
              <Button size="sm" variant="outline" onMouseDown={(e) => { e.preventDefault(); openPromote("page"); }}>문서로</Button>
            </div>
          )}
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
              onSelect={onSelect}
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
                  <a href={a.download_url} target="_blank" rel="noreferrer"
                    title={a.ocr_text ? `${a.file_name}\n─ 추출된 텍스트 ─\n${a.ocr_text.slice(0, 400)}` : a.file_name}>
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
          {!!(lastYearQ.data?.entry?.content ?? "").trim() && (
            <button onClick={() => switchDate(lastYear)}
              className="flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/60 px-3 py-2 text-left text-xs text-slate-500 transition hover:bg-amber-50">
              <History size={14} className="mt-0.5 flex-shrink-0 text-amber-500" />
              <span className="min-w-0">
                <span className="font-semibold text-slate-600">작년 오늘</span>
                <span className="line-clamp-2"> {lastYearQ.data!.entry!.content.replace(/[#*`]/g, "").slice(0, 160)}</span>
              </span>
            </button>
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
                        <div className="line-clamp-1 pl-3 text-xs text-slate-400">
                          {d.preview.replace(/[#*`]/g, "").trim()
                            || (d.image_count > 0
                              ? <span className="inline-flex items-center gap-1"><ImagePlus size={11} /> 이미지 {d.image_count}장</span>
                              : null)}
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={() => setRollupOpen(true)} title="이 주의 기록을 한 화면에 모아보기">
                <CalendarRange size={13} /> 주간 모아보기
              </Button>
              {/* 잔디 히트맵 — 본인만 보는 화면이라 비교·압박 없음. 스트릭 숫자는 의도적으로 없음 */}
              <div className="flex flex-col gap-1 pt-1">
                <div className="flex gap-[3px]">
                  {heatWeeks.map((col, i) => (
                    <div key={i} className="flex flex-col gap-[3px]">
                      {col.map((c) => (
                        <button key={c.key} onClick={() => switchDate(c.key)}
                          title={`${prettyDay(c.key)}${c.chars != null ? ` · ${c.chars}자` : " · 기록 없음"}`}
                          aria-label={`${c.key} 기록 열기`}
                          className={cx("h-2.5 w-2.5 rounded-[3px] transition hover:ring-1 hover:ring-brand", heatColor(c.chars), c.key === date && "ring-1 ring-brand")} />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-slate-300">최근 16주 — 진할수록 그날 많이 기록</div>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* 주간 모아보기 */}
      <Modal open={rollupOpen} onClose={() => setRollupOpen(false)} size="lg"
        title={`주간 모아보기 (${rollupRange.from.slice(5).replace("-", ".")} ~ ${rollupRange.to.slice(5).replace("-", ".")})`}>
        {rollupQ.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (rollupQ.data?.entries ?? []).length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">이 주에는 기록이 없어요.</div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
              {(rollupQ.data?.entries ?? []).map((e) => (
                <div key={e.entry_date}>
                  <button onClick={() => { setRollupOpen(false); switchDate(e.entry_date); }}
                    className="text-xs font-bold text-slate-500 hover:text-brand">{prettyDay(e.entry_date)}</button>
                  <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 font-sans text-sm leading-relaxed text-slate-700">{e.content.trim() || "(이미지만 있는 날)"}</pre>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => void copyRollup()}><Copy size={13} /> 전체 복사</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 조각 승격 — 태스크/문서 */}
      <Modal open={!!promo} onClose={() => setPromo(null)} title={promo?.kind === "task" ? "선택한 기록을 태스크로" : "선택한 기록을 문서로"}>
        <div className="flex flex-col gap-3">
          <Field label="프로젝트">
            <Select value={promoPid} onChange={(e) => setPromoPid(e.target.value)}>
              <option value="">프로젝트 선택</option>
              {(projectsQ.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="제목">
            <Input value={promoTitle} onChange={(e) => setPromoTitle(e.target.value)} placeholder="제목" />
          </Field>
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-500">{promo?.text}</div>
          {promo?.kind === "task" && promoRole === "member" && (
            <div className="text-xs text-amber-600">이 프로젝트에서는 멤버 권한이라 <b>티켓(요청)</b>으로 등록되고, 매니저 승인 후 진행돼요.</div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPromo(null)}>취소</Button>
            <Button onClick={() => promoteMut.mutate()} disabled={!promoPid || !promoTitle.trim() || promoteMut.isPending}>
              {promoteMut.isPending ? "만드는 중…" : promo?.kind === "task" ? "태스크 만들기" : "문서 만들기"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
