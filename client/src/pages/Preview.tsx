import { useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, Play, Save, Plus, X, MonitorPlay } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Card, Button, Input, Spinner, toast, useConfirm, PromptDialog } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// P9: 라이브 프리뷰 — A tier: sandbox iframe srcdoc + 강화 CSP (§10.10)
// JSX(.jsx) 파일은 esbuild-wasm을 지연 로드해 브라우저에서 변환 (실패 시 안내)

interface SFile { name: string; content: string }

const DEFAULT_FILES: SFile[] = [
  { name: "index.html", content: "<!doctype html>\n<h1>Hello DevFlow</h1>\n<button id=\"b\">클릭</button>\n" },
  { name: "style.css", content: "body{font-family:sans-serif;padding:16px}\nbutton{padding:8px 14px}\n" },
  { name: "app.js", content: "document.getElementById('b').onclick = () => toast('동작!');\n" },
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

export default function Preview() {
  const [, params] = useRoute("/projects/:id/preview");
  const pid = Number(params?.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState("새 스니펫");
  const [files, setFiles] = useState<SFile[]>(DEFAULT_FILES);
  const [active, setActive] = useState(0);
  const [srcDoc, setSrcDoc] = useState<string>("");
  const [building, setBuilding] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const { confirm, dialog } = useConfirm();

  const listQ = useQuery<{ snippets: any[] }>({ queryKey: ["snippets", pid], queryFn: () => get(`/snippets?project_id=${pid}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["snippets", pid] });

  const save = useMutation({
    mutationFn: () =>
      selected == null
        ? post<{ snippet: any }>("/snippets", { project_id: pid, title, files })
        : patch<{ snippet: any }>(`/snippets/${selected}`, { title, files }),
    onSuccess: (d: any) => { setSelected(d.snippet.id); refresh(); },
    onError: (e: any) => toast(`저장 실패: ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/snippets/${id}`),
    onSuccess: () => { refresh(); if (selected != null) reset(); },
    onError: (e: any) => toast(e.message),
  });

  const reset = () => { setSelected(null); setTitle("새 스니펫"); setFiles(DEFAULT_FILES); setActive(0); setSrcDoc(""); };
  const open = (s: any) => { setSelected(s.id); setTitle(s.title); setFiles(s.files); setActive(0); setSrcDoc(""); };

  const run = async () => {
    setBuilding(true);
    try {
      setSrcDoc(await buildSrcDoc(files));
    } catch (e: any) {
      toast(`빌드 실패: ${e?.message ?? e}\n(JSX 변환은 인터넷 연결이 필요합니다)`);
    } finally {
      setBuilding(false);
    }
  };

  const setContent = (v: string) => setFiles((fs) => fs.map((f, i) => (i === active ? { ...f, content: v } : f)));
  const addFile = (name: string) => {
    if (!name || !/^[\w.\-]+$/.test(name)) { toast("파일명 형식이 올바르지 않아요. 예: util.js, extra.css, App.jsx"); return; }
    setFiles((fs) => [...fs, { name, content: "" }]);
    setActive(files.length);
  };
  const rmFile = (i: number) => { setFiles((fs) => fs.filter((_, j) => j !== i)); setActive(0); };

  const snippets = listQ.data?.snippets ?? [];

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <PromptDialog open={addFileOpen} onClose={() => setAddFileOpen(false)} onSubmit={addFile}
        title="파일 추가" placeholder="파일명 (예: util.js, extra.css, App.jsx)" submitLabel="추가" />
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><MonitorPlay className="text-brand" size={24} /> 라이브 프리뷰</h1>

      <div className="grid gap-4 lg:grid-cols-[16rem,1fr]">
        {/* 저장된 스니펫 */}
        <Card className="flex h-fit flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">스니펫</span>
            <Button size="sm" variant="outline" onClick={reset}><Plus size={13} /> 새로</Button>
          </div>
          {listQ.isLoading ? <Spinner /> : snippets.length === 0
            ? <div className="py-2 text-xs text-slate-500">저장된 스니펫이 없어요.</div>
            : snippets.map((s) => (
              <div key={s.id} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition ${selected === s.id ? "bg-brand-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-50"}`}>
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => open(s)}>{s.title}</button>
                <button className="flex-shrink-0 rounded p-1 text-slate-400 transition hover:text-red-500" aria-label="스니펫 삭제"
                  onClick={async () => {
                    if (await confirm({ title: "스니펫 삭제", message: `"${s.title}" 스니펫을 삭제할까요?`, confirmLabel: "삭제", tone: "danger" })) remove.mutate(s.id);
                  }}><X size={13} /></button>
              </div>
            ))}
        </Card>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="w-full sm:max-w-xs" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="스니펫 제목" />
            <Button onClick={run} disabled={building}><Play size={15} /> 실행</Button>
            <Button variant="outline" onClick={() => title.trim() && save.mutate()} disabled={save.isPending}><Save size={15} /> 저장</Button>
          </div>

          {/* 파일 탭 + 에디터 */}
          <Card className="p-0">
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-2 pt-2">
              {files.map((f, i) => (
                <span key={i} className={`inline-flex items-center gap-1 rounded-t-lg px-3 py-1.5 font-mono text-xs ${active === i ? "bg-slate-100 font-semibold text-slate-800" : "text-slate-500 hover:bg-slate-50"}`}>
                  <button onClick={() => setActive(i)}>{f.name}</button>
                  {files.length > 1 && <button onClick={() => rmFile(i)} className="text-slate-300 hover:text-red-500"><X size={11} /></button>}
                </span>
              ))}
              <button onClick={() => setAddFileOpen(true)} className="ml-1 rounded p-1 text-slate-400 transition hover:bg-slate-100" aria-label="파일 추가"><Plus size={14} /></button>
            </div>
            <textarea
              value={files[active]?.content ?? ""}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              className="h-64 w-full resize-y rounded-b-xl bg-slate-900 p-3 font-mono text-[13px] leading-relaxed text-slate-100 outline-none"
            />
          </Card>

          {/* sandbox iframe: same-origin 금지 + CSP 외부 네트워크 차단 (§10.10) */}
          <Card className="p-0">
            <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-500">실행 결과 (sandbox · 외부 네트워크 차단)</div>
            {srcDoc
              ? <iframe title="preview" sandbox="allow-scripts" srcDoc={srcDoc} className="h-80 w-full rounded-b-xl bg-white" />
              : <div className="flex h-40 items-center justify-center text-sm text-slate-400">{building ? "빌드 중…" : "실행을 누르면 여기에 결과가 표시돼요."}</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}
