import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Store, Star, ExternalLink, Plus, ChevronLeft } from "lucide-react";
import { get, post } from "../lib/api";
import { Card, Button, Input, Textarea, Badge, Select, Spinner, EmptyState, Avatar, toast } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { queryClient } from "../lib/queryClient";

// P11 검증 갤러리 (링크형): 로그인 회원 누구나 열람·리뷰. 게이트 충족 시 validated.
const CATEGORY_LABEL: Record<string, string> = { ux: "UX", perf: "성능", bug: "버그", market: "시장성", other: "기타" };

function Stars({ value, onChange, size = 18 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)}
          className={onChange ? "transition hover:scale-110" : "cursor-default"}>
          <Star size={size} className={n <= value ? "fill-amber-400 text-amber-400" : "text-slate-200"} />
        </button>
      ))}
    </span>
  );
}

export default function Gallery() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", summary: "", demo_url: "", project_id: "" as string });
  const [fb, setFb] = useState({ rating: 5, body: "", category: "other" });

  const listQ = useQuery<{ submissions: any[] }>({ queryKey: ["gallery"], queryFn: () => get("/gallery") });
  const detailQ = useQuery<any>({ queryKey: ["gallery", selected], queryFn: () => get(`/gallery/${selected}`), enabled: selected != null });
  const projectsQ = useQuery<{ projects: any[] }>({ queryKey: ["projects"], queryFn: () => get("/projects") });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["gallery"] }); queryClient.invalidateQueries({ queryKey: ["gallery", selected] }); };

  const submit = useMutation({
    mutationFn: () => post("/gallery", {
      title: form.title.trim(), summary: form.summary.trim(),
      ...(form.demo_url.trim() ? { demo_url: form.demo_url.trim() } : {}),
      ...(form.project_id ? { project_id: Number(form.project_id) } : {}),
    }),
    onSuccess: () => { setShowForm(false); setForm({ title: "", summary: "", demo_url: "", project_id: "" }); refresh(); toast("제출했어요. 리뷰가 쌓이면 검증 완료로 승격돼요.", "success"); },
    onError: (e: any) => toast(`제출 실패: ${e.message}`, "error"),
  });
  const leaveFeedback = useMutation({
    mutationFn: () => post(`/gallery/${selected}/feedback`, { rating: fb.rating, body: fb.body.trim(), category: fb.category }),
    onSuccess: () => { setFb({ rating: 5, body: "", category: "other" }); refresh(); toast("리뷰를 남겼어요. 감사합니다!", "success"); },
    onError: (e: any) => toast(e.message, "error"),
  });

  const subs = listQ.data?.submissions ?? [];
  const detail = detailQ.data;

  /* ---------- 상세 ---------- */
  if (selected != null && detail) {
    const s = detail.submission;
    const mine = s.submitted_by === user?.id;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <button onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-brand">
          <ChevronLeft size={18} /> 갤러리로
        </button>
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-800">{s.title}</h1>
            <Badge className={s.status === "validated" ? "bg-emerald-100 text-emerald-700" : s.status === "rejected" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}>
              {s.status === "validated" ? "✓ 검증 완료" : s.status === "rejected" ? "반려" : "검증 중"}
            </Badge>
            <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500">
              <Stars value={Math.round(s.avg_rating)} /> {s.avg_rating} ({s.review_count}개 리뷰 / 승격 기준 {s.min_reviews}개·평균 {s.min_avg_rating}점)
            </span>
          </div>
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">{s.summary}</p>
          {s.demo_url && (
            <a href={s.demo_url} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-brand transition hover:bg-indigo-100">
              <ExternalLink size={15} /> 데모 열기
            </a>
          )}
        </Card>

        {/* 내 리뷰 */}
        {!mine && !detail.my_review && (
          <Card className="flex flex-col gap-2">
            <div className="font-semibold text-slate-700">리뷰 남기기</div>
            <div className="flex flex-wrap items-center gap-3">
              <Stars value={fb.rating} onChange={(v) => setFb({ ...fb, rating: v })} size={22} />
              <Select className="h-9 w-auto text-sm" value={fb.category} onChange={(e) => setFb({ ...fb, category: e.target.value })}>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </div>
            <Textarea rows={3} placeholder="사용해보고 느낀 점을 구체적으로 남겨주세요" value={fb.body} onChange={(e) => setFb({ ...fb, body: e.target.value })} />
            <Button className="self-end" onClick={() => fb.body.trim() && leaveFeedback.mutate()} disabled={leaveFeedback.isPending || !fb.body.trim()}>등록</Button>
          </Card>
        )}
        {mine && <Card className="text-sm text-slate-400">본인 제출물에는 리뷰할 수 없어요.</Card>}

        {/* 피드백 목록 */}
        <div className="flex flex-col gap-2">
          {detail.feedback.map((f: any) => (
            <Card key={f.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Avatar name={f.reviewer.full_name ?? f.reviewer.email} size={22} />
                <span className="text-sm font-medium text-slate-700">{f.reviewer.full_name ?? f.reviewer.email}</span>
                <Badge className="bg-slate-100 text-slate-500">{CATEGORY_LABEL[f.category]}</Badge>
                <span className="ml-auto"><Stars value={f.rating} size={14} /></span>
              </div>
              <p className="text-sm leading-relaxed text-slate-700">{f.body}</p>
            </Card>
          ))}
          {detail.feedback.length === 0 && <Card className="py-6 text-center text-sm text-slate-400">첫 리뷰를 남겨보세요.</Card>}
        </div>
      </div>
    );
  }

  /* ---------- 목록 ---------- */
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-800"><Store className="text-brand" size={24} /> 검증 갤러리</h1>
        <Button onClick={() => setShowForm((v) => !v)}><Plus size={15} /> 프로젝트 제출</Button>
      </div>
      <p className="-mt-3 text-sm text-slate-400">완료된 프로젝트를 제출하면 회원들의 리뷰·평점으로 시장 생존성을 사전 검증해요. 기준 충족 시 "검증 완료"로 승격됩니다.</p>

      {showForm && (
        <Card className="flex flex-col gap-2.5">
          <Input placeholder="제목" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Textarea rows={3} placeholder="어떤 프로젝트인지, 뭘 검증받고 싶은지 요약" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="데모 URL (https://…)" value={form.demo_url} onChange={(e) => setForm({ ...form, demo_url: e.target.value })} />
            <Select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
              <option value="">내부 프로젝트 연결 안 함</option>
              {(projectsQ.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <Button className="self-end" onClick={() => form.title.trim() && form.summary.trim() && submit.mutate()} disabled={submit.isPending}>제출</Button>
        </Card>
      )}

      {listQ.isLoading ? <div className="py-16"><Spinner /></div>
        : subs.length === 0 ? (
          <EmptyState icon={<Store size={22} />} title="아직 제출된 프로젝트가 없어요" desc="완료한 프로젝트를 제출해 팀 밖의 시선으로 검증받아보세요." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {subs.map((s) => (
              <Card key={s.id} onClick={() => setSelected(s.id)} className="flex cursor-pointer flex-col gap-2 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 truncate font-semibold text-slate-800">{s.title}</div>
                  <Badge className={s.status === "validated" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
                    {s.status === "validated" ? "✓ 검증" : "검증 중"}
                  </Badge>
                </div>
                <p className="line-clamp-2 text-sm text-slate-500">{s.summary}</p>
                <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-slate-400">
                  <Avatar name={s.submitter.full_name ?? s.submitter.email} size={18} /> {s.submitter.full_name}
                  <span className="ml-auto inline-flex items-center gap-1"><Stars value={Math.round(s.avg_rating)} size={13} /> {s.avg_rating > 0 ? s.avg_rating : "-"} · {s.review_count}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
