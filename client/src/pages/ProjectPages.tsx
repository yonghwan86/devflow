import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FolderTree, Trash2 } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Button, Card, Modal, NameChip, Spinner, toast, useConfirm, PromptDialog } from "../components/ui";
import { ProjectNav } from "../components/ProjectNav";
import { useTextFileIntake, titleFromFilename } from "../lib/textFile";
import { PageTree, type PageNode } from "../components/PageTree";
import { PageEditor } from "../components/PageEditor";
import { fmtDate } from "../lib/format";
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
    mutationFn: (v: { parentId: number | null; title: string; content?: string }) =>
      post<{ page: any }>(`/projects/${pid}/pages`, { title: v.title, parent_id: v.parentId, ...(v.content != null ? { content: v.content } : {}) }),
    onSuccess: (r) => { refresh(); setSelectedId(r.page.id); setMobilePane("editor"); },
    // 실패 시 입력한 제목을 잃지 않게 다이얼로그를 같은 값으로 다시 연다 — 단, 사용자가 이미 새로 연 다이얼로그는 덮지 않음
    onError: (e: any, v) => { toast(`생성 실패: ${e.message}`); setCreateFor((cur) => cur ?? { parent: v.parentId, initial: v.title }); },
  });
  // 파일로 새 문서 — 제목=파일명, 본문=파일 내용 (POST가 content를 이미 받으므로 서버 변경 없음)
  const fileIntake = useTextFileIntake({
    maxBytes: 700 * 1024,
    onText: (text, f) => createPage.mutate({ parentId: null, title: titleFromFilename(f.name) || "새 문서", content: text }),
    onError: (m) => toast(m),
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
      queryClient.invalidateQueries({ queryKey: ["pages-trash", pid] });
      if (selectedId === id) { setSelectedId(null); setMobilePane("tree"); }
      toast("휴지통으로 이동했어요. 휴지통에서 복원할 수 있어요.");
    },
    onError: (e: any) => toast(`삭제 실패: ${e.message}`),
  });
  const onDelete = async (node: PageNode) => {
    const kids = (node.children ?? []).length;
    const ok = await confirm({
      title: "문서 삭제",
      message: `"${node.title}" 문서를 휴지통으로 옮길까요?${kids ? ` 하위 문서 ${kids}개는 루트로 이동합니다.` : ""} 휴지통에서 복원하거나 영구 삭제할 수 있어요. 파생된 태스크는 유지됩니다.`,
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (ok) remove.mutate(node.id);
  };

  // 휴지통 — 매니저 전용 (복원·영구삭제)
  const [trashOpen, setTrashOpen] = useState(false);
  const trashQ = useQuery<{ pages: any[] }>({
    queryKey: ["pages-trash", pid],
    queryFn: () => get(`/projects/${pid}/pages-trash`),
    enabled: trashOpen,
  });
  const restorePage = useMutation({
    mutationFn: (id: number) => post(`/projects/${pid}/pages/${id}/restore`, {}),
    onSuccess: () => { refresh(); trashQ.refetch(); toast("복원했어요. 부모 문서가 남아 있으면 원래 위치로, 없으면 루트로 돌아와요."); },
    onError: (e: any) => toast(`복원 실패: ${e.message}`),
  });
  const purgePage = useMutation({
    mutationFn: (id: number) => del(`/projects/${pid}/pages/${id}/permanent`),
    onSuccess: () => { trashQ.refetch(); toast("영구 삭제했어요."); },
    onError: (e: any) => toast(`영구 삭제 실패: ${e.message}`),
  });

  const pages = q.data?.pages ?? [];

  const canManage = ["owner", "manager"].includes(q.data?.my_role ?? "");
  const tree = (
    <PageTree
      pages={pages}
      selectedId={selectedId}
      onSelect={(id) => { setSelectedId(id); setMobilePane("editor"); }}
      onCreateRoot={() => setCreateFor({ parent: null })}
      onCreateFromFile={fileIntake.openPicker}
      onCreateChild={(pidParent) => setCreateFor({ parent: pidParent })}
      onRename={(id, title) => rename.mutate({ id, title })}
      onDelete={onDelete}
      canDelete={canManage}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <PromptDialog open={!!createFor} onClose={() => setCreateFor(null)}
        title={createFor?.parent == null ? "새 문서 제목" : "하위 문서 제목"}
        placeholder="문서 제목" submitLabel="만들기" initialValue={createFor?.initial ?? ""}
        onSubmit={(title) => createPage.mutate({ parentId: createFor!.parent, title })} />
      {/* 휴지통 — 매니저 전용: 삭제된 문서 복원/영구 삭제 */}
      <Modal open={trashOpen} onClose={() => setTrashOpen(false)} title="문서 휴지통">
        {trashQ.isLoading ? (
          <div className="py-8"><Spinner /></div>
        ) : trashQ.isError ? (
          <div className="py-8 text-center text-sm text-slate-400">휴지통을 불러오지 못했어요. 잠시 후 다시 열어주세요.</div>
        ) : (trashQ.data?.pages ?? []).length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">휴지통이 비어 있어요.</div>
        ) : (
          <div className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto">
            {(trashQ.data?.pages ?? []).map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-700">{p.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    삭제 {p.deleter_name ? <NameChip name={p.deleter_name} /> : "알 수 없음"} {fmtDate(p.deleted_at)}
                  </div>
                </div>
                <Button size="sm" variant="outline" className="flex-shrink-0" onClick={() => restorePage.mutate(p.id)} disabled={restorePage.isPending}>복원</Button>
                <Button size="sm" variant="ghost" className="flex-shrink-0 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  onClick={async () => {
                    if (await confirm({ title: "영구 삭제", message: `"${p.title}" 문서를 영구 삭제할까요? 본문과 버전 기록이 완전히 지워져 복구할 수 없어요.`, confirmLabel: "영구 삭제", tone: "danger" })) purgePage.mutate(p.id);
                  }}
                  disabled={purgePage.isPending}>
                  영구 삭제
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
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
            {canManage && (
              <button className="mt-2 inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                onClick={() => setTrashOpen(true)}>
                <Trash2 size={13} /> 휴지통
              </button>
            )}
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
