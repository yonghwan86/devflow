import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FolderTree } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Button, Card, Spinner, toast, useConfirm, PromptDialog } from "../components/ui";
import { ProjectNav } from "../components/ProjectNav";
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

  // C4: 브라우저 prompt() → 앱 다이얼로그 (모바일·디자인 일관성)
  const [createFor, setCreateFor] = useState<{ parent: number | null; initial?: string } | null>(null);
  const createPage = useMutation({
    mutationFn: (v: { parentId: number | null; title: string }) =>
      post<{ page: any }>(`/projects/${pid}/pages`, { title: v.title, parent_id: v.parentId }),
    onSuccess: (r) => { refresh(); setSelectedId(r.page.id); setMobilePane("editor"); },
    // 실패 시 입력한 제목을 잃지 않게 다이얼로그를 같은 값으로 다시 연다 — 단, 사용자가 이미 새로 연 다이얼로그는 덮지 않음
    onError: (e: any, v) => { toast(`생성 실패: ${e.message}`); setCreateFor((cur) => cur ?? { parent: v.parentId, initial: v.title }); },
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
      onCreateRoot={() => setCreateFor({ parent: null })}
      onCreateChild={(pidParent) => setCreateFor({ parent: pidParent })}
      onRename={(id, title) => rename.mutate({ id, title })}
      onDelete={onDelete}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <PromptDialog open={!!createFor} onClose={() => setCreateFor(null)}
        title={createFor?.parent == null ? "새 문서 제목" : "하위 문서 제목"}
        placeholder="문서 제목" submitLabel="만들기" initialValue={createFor?.initial ?? ""}
        onSubmit={(title) => createPage.mutate({ parentId: createFor!.parent, title })} />
      {/* 한 줄 유지: 좁은 화면에선 탭 바가 남는 폭 안에서 가로 스크롤, 전환 버튼은 우측 고정 */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1"><ProjectNav pid={pid} current="pages" /></div>
        {/* 모바일: 트리 ↔ 에디터 전환 */}
        <Button variant="outline" size="sm" className="flex-shrink-0 md:hidden"
          onClick={() => setMobilePane(mobilePane === "tree" ? "editor" : "tree")}
          disabled={mobilePane === "tree" && selectedId == null}>
          {mobilePane === "tree" ? "문서 열기" : "목록"}
        </Button>
      </div>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900"><FolderTree className="text-brand" size={24} /> 문서</h1>

      {q.isLoading ? <div className="py-16"><Spinner /></div> : (
        <div className="flex gap-4">
          {/* 트리: 데스크톱 항상, 모바일은 pane=tree일 때.
              C12: 데스크톱은 화면 높이에 가둬 내부 스크롤 + sticky (문서가 늘어도 페이지가 안 길어짐).
              스크롤은 PageTree 안 노드 목록에만 — "새 문서"·검색은 위에 고정(회의록 목록과 같은 패턴) */}
          <Card className={`w-full flex-shrink-0 flex-col self-start p-3 md:sticky md:top-5 md:max-h-[calc(100vh-2.5rem)] md:w-64 ${mobilePane === "tree" ? "flex" : "hidden md:flex"}`}>
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
