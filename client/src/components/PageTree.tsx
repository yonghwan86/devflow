import { useState } from "react";
import { FileText, Plus, ChevronRight, ChevronDown, Pencil, Trash2 } from "lucide-react";
import { Button, Input } from "./ui";

// F4: 문서 트리 — 서버는 flat 목록(parent_id)을 주고 여기서 조립한다.
export interface PageNode {
  id: number;
  parent_id: number | null;
  title: string;
  sort_order: number;
  created_by: number | null;
  children?: PageNode[];
}

export function buildTree(flat: PageNode[]): PageNode[] {
  const byId = new Map<number, PageNode>(flat.map((p) => [p.id, { ...p, children: [] }]));
  const roots: PageNode[] = [];
  for (const p of byId.values()) {
    if (p.parent_id != null && byId.has(p.parent_id)) byId.get(p.parent_id)!.children!.push(p);
    else roots.push(p); // 부모가 삭제돼 set null된 노드는 루트로 승격
  }
  return roots;
}

function Node({ node, depth, selectedId, onSelect, onCreateChild, onRename, onDelete }: {
  node: PageNode; depth: number; selectedId: number | null;
  onSelect: (id: number) => void;
  onCreateChild: (parentId: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (node: PageNode) => void;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const hasKids = (node.children ?? []).length > 0;
  const selected = selectedId === node.id;
  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-sm transition ${selected ? "bg-indigo-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-100"}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <button className="flex-shrink-0 rounded p-1 text-slate-400 hover:text-slate-600" onClick={() => setOpen(!open)}>
          {hasKids ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <FileText size={13} />}
        </button>
        {editing ? (
          <Input
            className="h-7 min-h-0 flex-1 px-1.5 text-sm" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) { onRename(node.id, title.trim()); setEditing(false); }
              if (e.key === "Escape") { setTitle(node.title); setEditing(false); }
            }}
            onBlur={() => { setTitle(node.title); setEditing(false); }}
          />
        ) : (
          <button className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(node.id)} title={node.title}>
            {node.title}
          </button>
        )}
        {/* 모바일(터치)에는 hover가 없어 항상 노출, 데스크톱은 hover 시 노출 */}
        <span className="flex flex-shrink-0 gap-0.5 md:hidden md:group-hover:flex">
          <button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-brand" title="하위 문서" onClick={() => onCreateChild(node.id)}><Plus size={13} /></button>
          <button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-brand" title="이름 변경" onClick={() => { setTitle(node.title); setEditing(true); }}><Pencil size={12} /></button>
          <button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-rose-500" title="삭제" onClick={() => onDelete(node)}><Trash2 size={12} /></button>
        </span>
      </div>
      {open && (node.children ?? []).map((c) => (
        <Node key={c.id} node={c} depth={depth + 1} selectedId={selectedId}
          onSelect={onSelect} onCreateChild={onCreateChild} onRename={onRename} onDelete={onDelete} />
      ))}
    </div>
  );
}

export function PageTree({ pages, selectedId, onSelect, onCreateRoot, onCreateChild, onRename, onDelete }: {
  pages: PageNode[]; selectedId: number | null;
  onSelect: (id: number) => void;
  onCreateRoot: () => void;
  onCreateChild: (parentId: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (node: PageNode) => void;
}) {
  // C7: 문서가 쌓이면 트리 스캔이 힘들어짐 — 제목 검색(일치 노드 + 조상 경로 유지)
  const [q, setQ] = useState("");
  const norm = q.trim().toLowerCase();
  const visible = norm
    ? (() => {
        const byId = new Map(pages.map((p) => [p.id, p]));
        const keep = new Set<number>();
        for (const p of pages) {
          if (!p.title.toLowerCase().includes(norm)) continue;
          let cur: PageNode | undefined = p;
          while (cur && !keep.has(cur.id)) {
            keep.add(cur.id);
            cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
          }
        }
        return pages.filter((p) => keep.has(p.id));
      })()
    : pages;
  const roots = buildTree(visible);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" onClick={onCreateRoot}><Plus size={14} /> 새 문서</Button>
      {pages.length > 5 && (
        <Input className="mt-1 h-8 text-xs" placeholder="문서 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      {norm && <div className="px-1 text-[11px] text-slate-400">{visible.length ? `일치 ${visible.length}건 (경로 포함)` : "일치하는 문서가 없어요"}</div>}
      <div className="mt-1 flex flex-col">
        {roots.map((n) => (
          <Node key={n.id} node={n} depth={0} selectedId={selectedId}
            onSelect={onSelect} onCreateChild={onCreateChild} onRename={onRename} onDelete={onDelete} />
        ))}
        {roots.length === 0 && <div className="px-2 py-6 text-center text-xs text-slate-400">아직 문서가 없어요.<br />"새 문서"로 시작하세요.</div>}
      </div>
    </div>
  );
}
