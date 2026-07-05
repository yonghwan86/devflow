import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FolderKanban, Plus, ChevronRight } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, Card, Input, Badge, EmptyState, Modal, Field, SkeletonCard } from "../components/ui";
import { queryClient } from "../lib/queryClient";

interface Project { id: number; key: string; name: string; description: string | null; status: string; my_role: string; }
// G1: owner 폐지 — owner 라벨은 잔존 행 대비 폴백만.
const ROLE_LABEL: Record<string, string> = { owner: "매니저", manager: "매니저", member: "멤버" };

export default function Projects() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const { data, isLoading } = useQuery<{ projects: Project[] }>({ queryKey: ["projects"], queryFn: () => get("/projects") });
  const create = useMutation({
    mutationFn: () => post("/projects", { name, description: desc }),
    onSuccess: () => { setName(""); setDesc(""); setOpen(false); queryClient.invalidateQueries({ queryKey: ["projects"] }); },
  });

  const projects = data?.projects ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">프로젝트</h1>
        <Button onClick={() => setOpen(true)}><Plus size={16} /> 새 프로젝트</Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonCard lines={2} /><SkeletonCard lines={2} /><SkeletonCard lines={2} /><SkeletonCard lines={2} />
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={22} />}
          title="아직 프로젝트가 없어요"
          desc="첫 프로젝트를 만들고 팀원을 초대해 할 일을 배정해 보세요."
          action={<Button onClick={() => setOpen(true)}><Plus size={16} /> 프로젝트 만들기</Button>}
        />
      ) : (
        <div className="stagger-children grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="group h-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{p.key}</span>
                    {p.status !== "active" && <Badge className="bg-slate-100 text-slate-500">{p.status === "completed" ? "완료" : "보관"}</Badge>}
                  </div>
                  <ChevronRight size={18} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand" />
                </div>
                <div className="mt-2 font-semibold text-slate-800">{p.name}</div>
                {p.description && <div className="mt-1 line-clamp-2 text-sm text-slate-400">{p.description}</div>}
                <div className="mt-3"><Badge className="bg-brand-50 text-brand">{ROLE_LABEL[p.my_role] ?? p.my_role}</Badge></div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="새 프로젝트">
        <div className="flex flex-col gap-3">
          <Field label="이름"><Input placeholder="예: 모바일 앱 개편" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="설명 (선택)"><Input placeholder="한 줄 설명" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>취소</Button>
            <Button onClick={() => name && create.mutate()} disabled={create.isPending}>만들기</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
