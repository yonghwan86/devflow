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
        <button className="flex-shrink-0 text-slate-300 hover:text-slate-500" onClick={() => setOpen(!open)}>
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
        <span className="hidden flex-shrink-0 gap-0.5 group-hover:flex">
          <button className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand" title="하위 문서" onClick={() => onCreateChild(node.id)}><Plus size={13} /></button>
          <button className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand" title="이름 변경" onClick={() => { setTitle(node.title); setEditing(true); }}><Pencil size={12} /></button>
          <button className="rounded p-1 text-slate-400 hover:bg-white hover:text-rose-500" title="삭제" onClick={() => onDelete(node)}><Trash2 size={12} /></button>
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
  const roots = buildTree(pages);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" onClick={onCreateRoot}><Plus size={14} /> 새 문서</Button>
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
