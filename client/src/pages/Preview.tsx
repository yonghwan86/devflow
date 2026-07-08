import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Play, Save, Plus, X, MonitorPlay, RotateCw } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Button, Input, Spinner, toast, useConfirm, PromptDialog, cx } from "../components/ui";
import { ProjectNav } from "../components/ProjectNav";
import { useAuth } from "../hooks/useAuth";
import { queryClient } from "../lib/queryClient";

// P9: 라이브 프리뷰 — A tier: sandbox iframe srcdoc + 강화 CSP (§10.10)
// JSX(.jsx) 파일은 esbuild-wasm을 지연 로드해 브라우저에서 변환 (실패 시 안내)
// C7: 코드펜식 레이아웃 — 좌측 파일별 다크 에디터 스택 | 우측 라이브 결과, 타이핑 시 자동 실행(디바운스)

interface SFile { name: string; content: string }

const DEFAULT_FILES: SFile[] = [
  { name: "index.html", content: "<!doctype html>\n<h1>Hello DevFlow</h1>\n<button id=\"b\">클릭</button>\n" },
  { name: "style.css", content: "body{font-family:sans-serif;padding:16px}\nbutton{padding:8px 14px}\n" },
  // sandbox iframe은 alert/confirm이 차단됨(allow-modals 미부여) — DOM 조작 예제로
  { name: "app.js", content: "document.getElementById('b').onclick = () => {\n  document.body.insertAdjacentHTML('beforeend', '<p>동작!</p>');\n};\n" },
];

// CSP: 외부 네트워크 차단(connect/form/frame 금지), 인라인 실행만 허용
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'none';";

let esbuildReady: Promise<any> | null = null;
async function loadEsbuild(): Promise<any> {
  if (!esbuildReady) {
    esbuildReady = (async () => {
      const url = "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.23.1/esm/browser.min.js";
      const mod: any = await import(/* @vite-ignore */ url);
      await mod.initialize({ wasmURL: "https://cdn.jsdelivr.net/npm/esbuild-wasm@0.23.1/esbuild.wasm" });
      return mod;
    })();
  }
  return esbuildReady;
}

async function buildSrcDoc(files: SFile[]): Promise<string> {
  const html = files.find((f) => f.name.endsWith(".html"))?.content ?? "<!doctype html><body></body>";
  const css = files.filter((f) => f.name.endsWith(".css")).map((f) => f.content).join("\n");
  const js = files.filter((f) => f.name.endsWith(".js")).map((f) => f.content).join("\n;\n");
  const jsxFiles = files.filter((f) => f.name.endsWith(".jsx") || f.name.endsWith(".tsx"));
  let jsxOut = "";
  if (jsxFiles.length) {
    const esbuild = await loadEsbuild(); // React/JSX: esbuild-wasm 변환
    for (const f of jsxFiles) {
      const r = await esbuild.transform(f.content, { loader: "jsx", jsx: "automatic", jsxImportSource: "https://esm.sh/react@18" });
      jsxOut += r.code + "\n;\n";
    }
  }
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${css}</style>`;
  const scripts = `${js ? `<script>${js.replace(/<\/script>/gi, "<\\/script>")}<\/script>` : ""}${jsxOut ? `<script type="module">${jsxOut.replace(/<\/script>/gi, "<\\/script>")}<\/script>` : ""}`;
  // 사용자 HTML에 <head>가 있으면 여는 태그 "전체"(<head ...>) 뒤에 CSP/스타일을 삽입한다.
  // (구버전 정규식은 <head>를 <head>>로 만들어 head를 조기 종료 → CSP meta가 무시되는 버그가 있었음)
  if (/<head[^>]*>/i.test(html))
    return html.replace(/<head[^>]*>/i, (m) => m + head).replace(/<\/body>/i, `${scripts}</body>`) + (/<\/body>/i.test(html) ? "" : scripts);
  return `<!doctype html><html><head>${head}</head><body>${html}${scripts}</body></html>`;
}

// 코드펜식 파일 타입 컬러 (탭 아이콘)
const fileDot = (name: string) =>
  name.endsWith(".html") ? "bg-orange-500"
  : name.endsWith(".css") ? "bg-sky-400"
  : name.endsWith(".jsx") || name.endsWith(".tsx") ? "bg-cyan-400"
  : "bg-yellow-400";

export default function Preview() {
  const [, params] = useRoute("/projects/:id/preview");
  const pid = Number(params?.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState("새 스니펫");
  const [files, setFiles] = useState<SFile[]>(DEFAULT_FILES);
  const [srcDoc, setSrcDoc] = useState<string>("");
  const [building, setBuilding] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { user: me } = useAuth();

  const listQ = useQuery<{ snippets: any[] }>({ queryKey: ["snippets", pid], queryFn: () => get(`/snippets?project_id=${pid}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["snippets", pid] });
  // 서버의 수정·삭제 게이트(작성자 또는 매니저)와 버튼 노출·동작 일치 — 403 놀람 방지
  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const myRole = (membersQ.data?.members ?? []).find((m: any) => m.user?.id === me?.id)?.role ?? "member";
  const canManageProj = myRole === "owner" || myRole === "manager";
  const canTouch = (createdBy: number | null | undefined) => createdBy === me?.id || canManageProj;

  const save = useMutation({
    // asCopy: 남의 스니펫을 열어 고친 경우 — PATCH는 403이므로 새 스니펫(POST)으로 저장해 편집분을 살림
    mutationFn: (asCopy: boolean) =>
      selected == null || asCopy
        ? post<{ snippet: any }>("/snippets", { project_id: pid, title, files })
        : patch<{ snippet: any }>(`/snippets/${selected}`, { title, files }),
    onSuccess: (d: any, asCopy) => { setSelected(d.snippet.id); refresh(); toast(asCopy ? "내 사본으로 저장했어요." : "저장했어요.", "success"); },
    onError: (e: any) => toast(`저장 실패: ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/snippets/${id}`),
    onSuccess: () => { refresh(); if (selected != null) reset(); },
    onError: (e: any) => toast(e.message),
  });

  const reset = () => { setSelected(null); setTitle("새 스니펫"); setFiles(DEFAULT_FILES); setSrcDoc(""); };
  const open = (s: any) => { setSelected(s.id); setTitle(s.title); setFiles(s.files); setSrcDoc(""); };

  const run = async (fs: SFile[]) => {
    setBuilding(true);
    try {
      setSrcDoc(await buildSrcDoc(fs));
    } catch (e: any) {
      toast(`빌드 실패: ${e?.message ?? e}\n(JSX 변환은 인터넷 연결이 필요합니다)`);
    } finally {
      setBuilding(false);
    }
  };

  // 코드펜처럼 타이핑을 멈추면 자동 실행 (0.8초 디바운스) — 최초 진입·스니펫 열기 포함
  useEffect(() => {
    const t = setTimeout(() => { void run(files); }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const setContent = (i: number, v: string) => setFiles((fs) => fs.map((f, j) => (j === i ? { ...f, content: v } : f)));
  const addFile = (name: string) => {
    if (!name || !/^[\w.\-]+$/.test(name)) { toast("파일명 형식이 올바르지 않아요. 예: util.js, extra.css, App.jsx"); return; }
    setFiles((fs) => [...fs, { name, content: "" }]);
  };
  const rmFile = (i: number) => setFiles((fs) => fs.filter((_, j) => j !== i));

  const snippets = listQ.data?.snippets ?? [];
  const selSnippet = selected != null ? snippets.find((s) => s.id === selected) : null;
  const saveAsCopy = selected != null && !!selSnippet && !canTouch(selSnippet.created_by);

  return (
    <div className="flex flex-col gap-3">
      {dialog}
      <PromptDialog open={addFileOpen} onClose={() => setAddFileOpen(false)} onSubmit={addFile}
        title="파일 추가" placeholder="파일명 (예: util.js, extra.css, App.jsx)" submitLabel="추가" />

      {/* C12: 프로젝트 공용 탭 바 */}
      <ProjectNav pid={pid} current="preview" />
      {/* 상단 바: 제목 · 실행/저장 (코드펜 헤더처럼 한 줄) */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900"><MonitorPlay className="text-brand" size={22} /> 프리뷰</h1>
        <Input className="w-full sm:w-56" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="스니펫 제목" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void run(files)} disabled={building}><Play size={14} /> 실행</Button>
          <Button size="sm" onClick={() => title.trim() && save.mutate(saveAsCopy)} disabled={save.isPending}
            title={saveAsCopy ? "다른 사람의 스니펫이라 원본은 못 고쳐요 — 내 스니펫으로 새로 저장돼요" : undefined}>
            <Save size={14} /> {saveAsCopy ? "사본으로 저장" : "저장"}
          </Button>
        </div>
      </div>

      {/* 저장된 스니펫 — 가로 칩 (좌우 공간은 에디터·프리뷰에 양보) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={reset} className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-500 transition hover:border-brand hover:text-brand">
          <Plus size={12} /> 새 스니펫
        </button>
        {listQ.isLoading ? <Spinner /> : snippets.map((s) => (
          <span key={s.id} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${selected === s.id ? "border-brand bg-brand-50 font-semibold text-brand" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>
            <button onClick={() => open(s)} className="max-w-[10rem] truncate"
              title={s.creator_name ? `${s.title} — 만든 사람: ${s.creator_name}` : s.title}>{s.title}</button>
            {canTouch(s.created_by) && (
              <button className="text-slate-300 hover:text-red-500" aria-label="스니펫 삭제"
                onClick={async () => {
                  if (await confirm({ title: "스니펫 삭제", message: `"${s.title}" 스니펫을 삭제할까요?`, confirmLabel: "삭제", tone: "danger" })) remove.mutate(s.id);
                }}><X size={12} /></button>
            )}
          </span>
        ))}
      </div>

      {/* ── 코드펜식 워크스페이스: 좌 = 파일별 에디터 스택(다크) | 우 = 라이브 결과 ── */}
      <div className="grid gap-3 lg:h-[calc(100vh-18.5rem)] lg:grid-cols-2">
        {/* 에디터 스택 */}
        <div className="flex min-w-0 flex-col gap-2 overflow-y-auto rounded-xl bg-[#131417] p-2 lg:h-full">
          {files.map((f, i) => (
            <div key={i} className="flex flex-col overflow-hidden rounded-lg ring-1 ring-white/10">
              <div className="flex items-center gap-2 bg-[#1e1f26] px-3 py-1.5">
                <span className={cx("h-2.5 w-2.5 rounded-sm", fileDot(f.name))} />
                <span className="font-mono text-xs font-semibold text-slate-200">{f.name}</span>
                {files.length > 1 && (
                  <button onClick={() => rmFile(i)} className="ml-auto rounded p-0.5 text-slate-500 transition hover:text-red-400" aria-label={`${f.name} 삭제`}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <textarea
                value={f.content}
                onChange={(e) => setContent(i, e.target.value)}
                spellCheck={false}
                rows={Math.min(16, Math.max(6, f.content.split("\n").length + 1))}
                className="w-full resize-y bg-[#131417] p-3 font-mono text-[13px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-600"
                placeholder={`${f.name} 내용…`}
              />
            </div>
          ))}
          <button onClick={() => setAddFileOpen(true)}
            className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 py-2 text-xs text-slate-500 transition hover:border-white/30 hover:text-slate-300">
            <Plus size={13} /> 파일 추가
          </button>
        </div>

        {/* 라이브 결과 — sandbox iframe: same-origin 금지 + CSP 외부 네트워크 차단 (§10.10) */}
        <Card className="flex min-h-[24rem] flex-col overflow-hidden p-0 lg:h-full">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-500">
            <span className={cx("h-2 w-2 rounded-full", building ? "animate-pulse bg-amber-400" : "bg-emerald-400")} />
            {building ? "빌드 중…" : "실행 결과"} <span className="text-slate-300">· 자동 실행 (sandbox · 외부 네트워크 차단)</span>
            <button onClick={() => void run(files)} className="ml-auto rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand" title="다시 실행" aria-label="다시 실행">
              <RotateCw size={13} />
            </button>
          </div>
          {srcDoc
            ? <iframe title="preview" sandbox="allow-scripts" srcDoc={srcDoc} className="w-full flex-1 bg-white" style={{ minHeight: "20rem" }} />
            : <div className="flex flex-1 items-center justify-center text-sm text-slate-400">{building ? "빌드 중…" : "코드를 입력하면 자동으로 실행돼요."}</div>}
        </Card>
      </div>
    </div>
  );
}
