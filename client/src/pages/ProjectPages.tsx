import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, FolderTree } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Button, Card, Spinner, toast, useConfirm } from "../components/ui";
import { PageTree, type PageNode } from "../components/PageTree";
import { PageEditor } from "../components/PageEditor";
import { queryClient } from "../lib/queryClient";

// F4: 프로젝트 문서 페이지 — 좌측 트리 + 우측 에디터.
// 모바일: 좌우 분할 대신 트리 ↔ 에디터 화면 전환(모바일 퍼스트).
export default function ProjectPages() {
  const [, params] = useRoute("/projects/:id/pages");
  const pid = Number(params?.id);
  const urlPage = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("page");
  const [selectedId, setSelectedId] = useState<number | null>(urlPage ? Number(urlPage) : null);
  const [mobilePane, setMobilePane] = useState<"tree" | "editor">(urlPage ? "editor" : "tree");
  const { confirm, dialog } = useConfirm();

  const q = useQuery<{ pages: PageNode[]; my_role: string }>({
    queryKey: ["pages", pid],
    queryFn: () => get(`/projects/${pid}/pages`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["pages", pid] });

  const createPage = useMutation({
    mutationFn: (parentId: number | null) => {
      const title = prompt(parentId == null ? "새 문서 제목" : "하위 문서 제목");
      if (!title?.trim()) return Promise.reject(new Error("취소됨"));
      return post<{ page: any }>(`/projects/${pid}/pages`, { title: title.trim(), parent_id: parentId });
    },
    onSuccess: (r) => { refresh(); setSelectedId(r.page.id); setMobilePane("editor"); },
    onError: (e: any) => { if (e.message !== "취소됨") toast(`생성 실패: ${e.message}`); },
  });
  const rename = useMutation({
    mutationFn: (v: { id: number; title: string }) => patch(`/projects/${pid}/pages/${v.id}`, { title: v.title }),
    onSuccess: () => { refresh(); queryClient.invalidateQueries({ queryKey: ["page", pid] }); },
    onError: (e: any) => toast(`이름 변경 실패: ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/projects/${pid}/pages/${id}`),
    onSuccess: (_r, id) => {
      refresh();
      if (selectedId === id) { setSelectedId(null); setMobilePane("tree"); }
      toast("문서를 삭제했어요. 하위 문서는 루트로 이동했어요.");
    },
    onError: (e: any) => toast(`삭제 실패: ${e.message}`),
  });
  const onDelete = async (node: PageNode) => {
    const kids = (node.children ?? []).length;
    const ok = await confirm({
      title: "문서 삭제",
      message: `"${node.title}" 문서를 삭제할까요?${kids ? ` 하위 문서 ${kids}개는 루트로 이동합니다.` : ""} 파생된 태스크는 유지됩니다.`,
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (ok) remove.mutate(node.id);
  };

  const pages = q.data?.pages ?? [];

  const tree = (
    <PageTree
      pages={pages}
      selectedId={selectedId}
      onSelect={(id) => { setSelectedId(id); setMobilePane("editor"); }}
      onCreateRoot={() => createPage.mutate(null)}
      onCreateChild={(pidParent) => createPage.mutate(pidParent)}
      onRename={(id, title) => rename.mutate({ id, title })}
      onDelete={onDelete}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <div className="flex items-center justify-between">
        <Link href={`/projects/${pid}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:text-brand">
          <ChevronLeft size={18} /> 보드로
        </Link>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-600"><FolderTree size={16} className="text-brand" /> 프로젝트 문서</div>
        {/* 모바일: 트리 ↔ 에디터 전환 */}
        <Button variant="outline" size="sm" className="md:hidden"
          onClick={() => setMobilePane(mobilePane === "tree" ? "editor" : "tree")}
          disabled={mobilePane === "tree" && selectedId == null}>
          {mobilePane === "tree" ? "문서 열기" : "목록"}
        </Button>
        <span className="hidden w-20 md:block" />
      </div>

      {q.isLoading ? <div className="py-16"><Spinner /></div> : (
        <div className="flex gap-4">
          {/* 트리: 데스크톱 항상, 모바일은 pane=tree일 때 */}
          <Card className={`w-full flex-shrink-0 self-start p-3 md:block md:w-64 ${mobilePane === "tree" ? "" : "hidden"}`}>
            {tree}
          </Card>
          {/* 에디터: 데스크톱 항상, 모바일은 pane=editor일 때 */}
          <div className={`min-w-0 flex-1 md:block ${mobilePane === "editor" ? "" : "hidden"}`}>
            {selectedId != null ? (
              <PageEditor pid={pid} pageId={selectedId} />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 py-16 text-center text-sm text-slate-400">
                왼쪽에서 문서를 선택하거나 새 문서를 만드세요.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
