import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BookMarked, ChevronLeft, Download, Upload, AlertTriangle } from "lucide-react";
import { get, patch } from "../lib/api";
import { Card, Badge, Button, EmptyState, SkeletonCard } from "../components/ui";
import { queryClient } from "../lib/queryClient";

interface Skill {
  id: number; title: string; name: string; description: string | null;
  body: string; antipatterns: string | null; status: string; tags: string[];
}

export default function Skills() {
  const [sel, setSel] = useState<Skill | null>(null);
  const { data, isLoading } = useQuery<{ skills: Skill[] }>({ queryKey: ["skills"], queryFn: () => get("/skills") });
  const publish = useMutation({
    mutationFn: (id: number) => patch<{ skill: Skill }>(`/skills/${id}`, { status: "published" }),
    onSuccess: (r) => { setSel(r.skill); queryClient.invalidateQueries({ queryKey: ["skills"] }); },
  });

  if (isLoading) return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">스킬 라이브러리</h1>
      <div className="grid gap-3 sm:grid-cols-2"><SkeletonCard lines={2} /><SkeletonCard lines={2} /><SkeletonCard lines={2} /><SkeletonCard lines={2} /></div>
    </div>
  );

  if (sel) {
    return (
      <div className="flex flex-col gap-4">
        <button className="inline-flex items-center gap-1 self-start text-sm text-slate-500 hover:text-brand" onClick={() => setSel(null)}><ChevronLeft size={16} /> 목록</button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{sel.title}</h1>
            <div className="mt-1 font-mono text-xs text-slate-400">{sel.name}</div>
          </div>
          <Badge className={sel.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>{sel.status === "published" ? "게시됨" : "초안"}</Badge>
        </div>
        {sel.description && <Card className="bg-slate-50 text-sm text-slate-600">{sel.description}</Card>}
        <Card><pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">{sel.body}</pre></Card>
        {sel.antipatterns && (
          <Card className="border-amber-200 bg-amber-50/40">
            <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-700"><AlertTriangle size={16} /> 안티패턴 (재사용 시 주의)</div>
            <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700">{sel.antipatterns}</pre>
          </Card>
        )}
        <div className="flex flex-wrap gap-2">
          {sel.status !== "published" && <Button onClick={() => publish.mutate(sel.id)} disabled={publish.isPending}><Upload size={16} /> 전사 라이브러리에 게시</Button>}
          <a href={`/api/skills/${sel.id}/export`}><Button variant="outline"><Download size={16} /> SKILL.md 내보내기</Button></a>
        </div>
      </div>
    );
  }

  const skills = data?.skills ?? [];
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">스킬 라이브러리</h1>
      {skills.length === 0 ? (
        <EmptyState icon={<BookMarked size={22} />} title="아직 추출된 스킬이 없어요"
          desc="프로젝트를 완료하면 적용된 가이드·해결한 blocker·안티패턴이 SKILL.md 초안으로 자동 추출돼요." />
      ) : (
        <div className="stagger-children grid gap-3 sm:grid-cols-2">
          {skills.map((s) => (
            <Card key={s.id} className="cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover" onClick={() => setSel(s)}>
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-slate-800">{s.title}</div>
                <Badge className={s.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>{s.status === "published" ? "게시됨" : "초안"}</Badge>
              </div>
              <div className="mt-1 line-clamp-2 text-sm text-slate-600">{s.description}</div>
              {s.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{s.tags.map((t) => <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">#{t}</span>)}</div>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
