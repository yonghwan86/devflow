import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, Search, MessageCircleQuestion, RefreshCw } from "lucide-react";
import { get, post } from "../lib/api";
import { Card, Badge, Button, Input, Select, Spinner, EmptyState, toast } from "../components/ui";

// P7: AI 검색/Q&A — 내가 속한 프로젝트의 태스크·가이드·스킬 지식베이스
export default function Ai() {
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState<number | "">("");
  const [results, setResults] = useState<any[] | null>(null);
  const [answer, setAnswer] = useState<{ answer: string; sources: any[] } | null>(null);

  const projectsQ = useQuery<{ projects: any[] }>({ queryKey: ["projects"], queryFn: () => get("/projects") });
  const projects = projectsQ.data?.projects ?? [];
  const pidBody = projectId === "" ? {} : { project_id: Number(projectId) };

  const search = useMutation({
    mutationFn: () => post<{ results: any[] }>("/ai/search", { q: q.trim(), ...pidBody }),
    onSuccess: (d) => { setResults(d.results); setAnswer(null); },
    onError: (e: any) => toast(e.message),
  });
  const ask = useMutation({
    mutationFn: () => post<{ answer: string; sources: any[] }>("/ai/ask", { q: q.trim(), ...pidBody }),
    onSuccess: (d) => { setAnswer(d); setResults(null); },
    onError: (e: any) => toast(e.message),
  });
  const reindex = useMutation({
    mutationFn: (pid: number) => post<{ queued: number; done: number; failed: number }>("/ai/reindex", { project_id: pid }),
    onSuccess: (d) => toast(`재색인 완료: ${d.done}건 처리 (실패 ${d.failed})`),
    onError: (e: any) => toast(e.message),
  });

  const srcLabel: Record<string, string> = { task: "태스크", comment: "댓글/가이드", skill: "스킬" };
  const busy = search.isPending || ask.isPending;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><Sparkles className="text-brand" size={24} /> AI 검색 · Q&A</h1>
        {projectId !== "" && (
          <Button variant="outline" size="sm" onClick={() => reindex.mutate(Number(projectId))} disabled={reindex.isPending}>
            <RefreshCw size={14} className={reindex.isPending ? "animate-spin" : ""} /> 이 프로젝트 재색인
          </Button>
        )}
      </div>

      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value === "" ? "" : Number(e.target.value))} className="sm:w-56">
            <option value="">전체 프로젝트</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input placeholder="예: 결제 실패 재시도는 어떻게 처리했지?" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) ask.mutate(); }} />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => q.trim() && ask.mutate()} disabled={busy || !q.trim()}><MessageCircleQuestion size={16} /> 질문하기</Button>
          <Button variant="outline" onClick={() => q.trim() && search.mutate()} disabled={busy || !q.trim()}><Search size={16} /> 검색만</Button>
        </div>
        <p className="text-xs text-slate-400">과거 태스크·가이드·스킬에서 근거를 찾아 답합니다. 자료가 안 나오면 프로젝트를 선택하고 "재색인"을 먼저 눌러주세요.</p>
      </Card>

      {busy && (
        <Card className="flex items-center gap-3 border-brand-100 bg-brand-50/30 py-4">
          <Spinner />
          <span className="text-sm text-slate-500">{ask.isPending ? "지식베이스에서 근거를 찾아 답변을 만드는 중…" : "검색 중…"}</span>
        </Card>
      )}

      {answer && !busy && (
        <Card className="animate-fade-in-up border-brand-100 bg-brand-50/30">
          <div className="mb-1 text-xs font-semibold text-brand">AI 답변</div>
          <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">{answer.answer}</div>
          {answer.sources.length > 0 && (
            <div className="mt-3 border-t border-brand-100 pt-2">
              <div className="mb-1.5 text-xs font-medium text-slate-500">출처 {answer.sources.length}건</div>
              <div className="flex flex-col gap-1.5">
                {answer.sources.map((s, i) => (
                  <div key={i} className="rounded-lg bg-white p-2 text-sm text-slate-600 ring-1 ring-slate-100">
                    <Badge className="mr-1.5 bg-slate-100 text-slate-500">{srcLabel[s.source_type] ?? s.source_type}</Badge>
                    {s.content}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {results && !busy && (
        results.length === 0
          ? <EmptyState title="검색 결과가 없어요" desc="재색인을 실행했는지 확인해보세요." />
          : (
            <div className="stagger-children flex flex-col gap-2">
              {results.map((h, i) => (
                <Card key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-slate-100 text-slate-500">{srcLabel[h.source_type] ?? h.source_type}</Badge>
                    {h.item_key && h.project_id && (
                      <Link href={`/projects/${h.project_id}/tasks/${h.item_key}`} className="font-mono text-xs text-brand hover:underline">{h.item_key}</Link>
                    )}
                    <span className="ml-auto text-xs text-slate-300">유사도 {(h.score * 100).toFixed(0)}%</span>
                  </div>
                  <div className="text-sm leading-relaxed text-slate-700">{h.content}</div>
                </Card>
              ))}
            </div>
          )
      )}
    </div>
  );
}
