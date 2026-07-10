import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { MessageSquare, Lightbulb, Check, SkipForward, Send, CheckSquare } from "lucide-react";
import { get, post, patch } from "../lib/api";
import { Card, Button, Textarea, Badge, Avatar, toast } from "./ui";
import { useAuth } from "../hooks/useAuth";

interface Comment {
  id: number; body_html: string; parent_id: number | null; is_guide: boolean;
  checklist_item_id: number | null; checklist_item_content: string | null;
  author: { id: number; full_name: string | null; email: string };
  created_at: string;
  guide_assignees: { id: number; user: { id: number; full_name: string | null; email: string }; state: string; note: string | null }[];
  guide_progress: { applied: number; total: number } | null;
}

function GuideActions({ c, meId, onChange }: { c: Comment; meId: number; onChange: () => void }) {
  const mine = c.guide_assignees.find((g) => g.user.id === meId);
  const [note, setNote] = useState(mine?.note ?? "");
  const mark = useMutation({
    mutationFn: (state: string) => patch(`/comments/${c.id}/guide`, { state, note }),
    onSuccess: onChange,
    onError: (e: any) => toast(`처리 실패: ${e.message}`),
  });
  if (!mine) return null;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-white p-2.5">
      <div className="mb-1.5 text-xs font-medium text-amber-700">내 가이드 수행</div>
      <Textarea placeholder="수행 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mb-2 text-sm" />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={() => mark.mutate("applied")} disabled={mark.isPending}><Check size={14} /> 수행완료</Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => mark.mutate("skipped")} disabled={mark.isPending}><SkipForward size={14} /> 해당없음</Button>
      </div>
      {mine.state !== "pending" && <div className="mt-1.5 text-xs text-slate-500">현재: {mine.state === "applied" ? "✅ 수행완료" : "⏭ 해당없음"}</div>}
    </div>
  );
}

export function UpdatesPanel({ taskId, canManage, onChange }: { taskId: number; canManage: boolean; onChange: () => void }) {
  const { user } = useAuth();
  const [body, setBody] = useState("");
  const [asGuide, setAsGuide] = useState(false);
  const q = useQuery<{ comments: Comment[] }>({ queryKey: ["comments", taskId], queryFn: () => get(`/comments?task_id=${taskId}`) });
  const refresh = () => { q.refetch(); onChange(); };
  const add = useMutation({
    mutationFn: () => post("/comments", { task_id: taskId, body: body.trim(), is_guide: asGuide }),
    onSuccess: () => { setBody(""); setAsGuide(false); refresh(); },
    onError: (e: any) => toast(`댓글 등록 실패: ${e.message}`),
  });
  const comments = q.data?.comments ?? [];

  const stateChip = (s: string) =>
    s === "applied" ? "bg-emerald-100 text-emerald-700" : s === "skipped" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700";
  const stateLabel = (s: string) => (s === "applied" ? "완료" : s === "skipped" ? "해당없음" : "대기");

  return (
    <section>
      <div className="mb-2 flex items-center gap-2"><MessageSquare size={16} className="text-brand" /><h2 className="font-semibold text-slate-700">Updates · 리뷰</h2></div>

      <div className="flex flex-col gap-2">
        {comments.map((c) => (
          <Card key={c.id} className={c.is_guide ? "border-amber-200 bg-amber-50/40" : ""}>
            <div className="flex flex-wrap items-center gap-2">
              <Avatar name={c.author.full_name ?? c.author.email} id={c.author.id} size={26} />
              <span className="text-sm font-medium text-slate-700">{c.author.full_name ?? c.author.email}</span>
              {c.is_guide && <Badge className="bg-amber-100 text-amber-700"><Lightbulb size={11} /> 가이드</Badge>}
              {c.checklist_item_content && (
                <Badge className="bg-brand-50 text-brand"><CheckSquare size={11} /> {c.checklist_item_content}</Badge>
              )}
              {c.guide_progress && <Badge className="ml-auto bg-amber-100 text-amber-700">{c.guide_progress.applied}/{c.guide_progress.total}</Badge>}
            </div>
            <div className="mt-2 text-sm leading-relaxed text-slate-700 [&_a]:text-brand [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1" dangerouslySetInnerHTML={{ __html: c.body_html }} />
            {c.is_guide && c.guide_assignees.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.guide_assignees.map((g) => (
                  <span key={g.id} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs ${stateChip(g.state)}`}>
                    <span className="min-w-0 truncate">{g.user.full_name ?? g.user.email}</span>: {stateLabel(g.state)}
                  </span>
                ))}
              </div>
            )}
            {c.is_guide && user && <GuideActions c={c} meId={user.id} onChange={refresh} />}
          </Card>
        ))}
        {comments.length === 0 && <div className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">아직 댓글이 없어요. 리뷰나 가이드를 남겨보세요.</div>}
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
        <Textarea placeholder="리뷰 코멘트를 작성하세요 (마크다운 지원)" value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="border-0 p-0 focus:ring-0" />
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
          {canManage ? (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={asGuide} onChange={(e) => setAsGuide(e.target.checked)} className="h-4 w-4 accent-amber-500" />
              <span className="inline-flex items-center gap-1"><Lightbulb size={14} className="text-amber-500" /> 가이드로 등록 (담당자별 수행 추적)</span>
            </label>
          ) : <span />}
          <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending || !body.trim()}><Send size={14} /> 등록</Button>
        </div>
      </div>
    </section>
  );
}
