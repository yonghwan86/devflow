import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FolderKanban, Plus, ChevronRight, Globe, LogIn, MoreHorizontal, Archive, Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import { get, post, ApiError } from "../lib/api";
import { Button, Card, Input, Badge, EmptyState, Modal, Field, SkeletonCard, toast } from "../components/ui";
import { toDayKey, dayKeyToServer } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "../hooks/useAuth";
import { setActiveProject, clearActiveProject } from "../lib/activeProject";

interface Project { id: number; key: string; name: string; description: string | null; status: string; my_role: string | null; member_count?: number; start_date?: string | null; end_date?: string | null; }
interface TrashProject extends Project { deleted_at: string; days_left: number; }
interface Impact { tasks: number; pages: number; meetings: number; events: number; snippets: number; skills_published: number; skills_draft: number; }
// 역할 계층: 소유자 > 매니저 > 멤버.
const ROLE_LABEL: Record<string, string> = { owner: "소유자", manager: "매니저", member: "멤버" };
// S: 카드 기간 배지 — 올해면 연도 생략, 한쪽만 있으면 물결로 방향 표시. Date 왕복 금지(F3).
function fmtRangeShort(start?: string | null, end?: string | null) {
  const s = toDayKey(start);
  const e = toDayKey(end);
  if (!s && !e) return null;
  const thisYear = String(new Date().getFullYear());
  const f = (key: string) => {
    const [y, m, d] = key.split("-");
    return `${y === thisYear ? "" : `${y}. `}${Number(m)}. ${Number(d)}.`;
  };
  return `${s ? f(s) : ""} ~ ${e ? f(e) : ""}`.trim();
}

export default function Projects() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [startDate, setStartDate] = useState(""); // 기간(선택) — 타임라인 '전체' 배율의 기준
  const [endDate, setEndDate] = useState("");
  const [tab, setTab] = useState<"mine" | "all">("mine");

  const { data, isLoading } = useQuery<{ projects: Project[] }>({ queryKey: ["projects"], queryFn: () => get("/projects") });
  const allQ = useQuery<{ projects: Project[] }>({
    queryKey: ["projects-all"],
    queryFn: () => get("/projects/all"),
    enabled: !!user?.is_admin && tab === "all",
  });
  const create = useMutation({
    mutationFn: () => post("/projects", {
      name,
      description: desc,
      ...(startDate ? { start_date: dayKeyToServer(startDate) } : {}),
      ...(endDate ? { end_date: dayKeyToServer(endDate) } : {}),
    }),
    onSuccess: () => { setName(""); setDesc(""); setStartDate(""); setEndDate(""); setOpen(false); queryClient.invalidateQueries({ queryKey: ["projects"] }); },
  });
  const joinAsAdmin = useMutation({
    mutationFn: (p: Project) => post(`/projects/${p.id}/join-as-admin`, {}),
    onSuccess: (_r, p) => {
      setActiveProject({ id: p.id, key: p.key, name: p.name });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["projects-all"] });
      navigate(`/projects/${p.id}`);
    },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "참여에 실패했습니다."),
  });

  // ── 보관 / 휴지통 ──
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  // 삭제 다이얼로그: 영향 요약을 받아온 뒤 이름 타이핑을 요구한다.
  const [delTarget, setDelTarget] = useState<{ p: Project; impact: Impact | null; mode: "trash" | "purge" } | null>(null);
  const [confirmName, setConfirmName] = useState("");

  const trashQ = useQuery<{ projects: TrashProject[]; retention_days: number }>({
    queryKey: ["projects-trash"],
    queryFn: () => get("/projects/trash"),
  });
  const trashed = trashQ.data?.projects ?? [];
  const retentionDays = trashQ.data?.retention_days ?? 30;

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    queryClient.invalidateQueries({ queryKey: ["projects-all"] });
    queryClient.invalidateQueries({ queryKey: ["projects-trash"] });
  };

  const archive = useMutation({
    mutationFn: (v: { p: Project; archived: boolean }) => post(`/projects/${v.p.id}/archive`, { archived: v.archived }),
    onSuccess: (_r, v) => { toast(v.archived ? "보관했어요." : "보관을 해제했어요.", "success"); refetchAll(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "실패했습니다.", "error"),
  });
  const trash = useMutation({
    mutationFn: (v: { p: Project; name: string }) => post(`/projects/${v.p.id}/trash`, { confirm_name: v.name }),
    onSuccess: (_r, v) => {
      // 활성 프로젝트가 삭제 대상이면 해제 — 안 하면 사이드바·홈("/")이 계속 그 프로젝트를 가리키고
      // 진입 시 requireMember가 막아 빈 화면·리다이렉트 루프가 된다.
      clearActiveProject(v.p.id);
      toast(`휴지통으로 옮겼어요. ${retentionDays}일 안에 복원할 수 있어요.`, "success");
      closeDel();
      refetchAll();
    },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "실패했습니다.", "error"),
  });
  const restore = useMutation({
    mutationFn: (p: TrashProject) => post(`/projects/${p.id}/restore`, {}),
    onSuccess: () => { toast("복원했어요.", "success"); refetchAll(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "실패했습니다.", "error"),
  });
  const purge = useMutation({
    mutationFn: (v: { p: Project; name: string }) => post(`/projects/${v.p.id}/purge`, { confirm_name: v.name }),
    onSuccess: (_r, v) => { clearActiveProject(v.p.id); toast("영구 삭제했어요.", "success"); closeDel(); refetchAll(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "실패했습니다.", "error"),
  });

  // 바깥을 누르면 ⋯ 메뉴가 닫힌다 — 카드가 그리드로 여러 개라 열린 채 남으면 헷갈린다.
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  const closeDel = () => { setDelTarget(null); setConfirmName(""); };
  // 삭제 전 영향 조회 — "무엇이 사라지고 무엇이 남는지"를 먼저 보여준다.
  const openDelete = async (p: Project, mode: "trash" | "purge") => {
    setMenuFor(null);
    setConfirmName("");
    // 다이얼로그를 **먼저** 연다. 예전엔 await 뒤에 setDelTarget이 있어서 집계 조회가 실패하면
    // 다이얼로그가 아예 안 열렸다 — 요약은 판단 재료일 뿐인데 삭제·휴지통 비우기가 통째로 막혔다.
    setDelTarget({ p, impact: null, mode });
    try {
      const r = await get<{ impact: Impact }>(`/projects/${p.id}/deletion-impact`);
      setDelTarget((cur) => (cur && cur.p.id === p.id ? { ...cur, impact: r.impact } : cur)); // 그새 닫혔거나 바뀌었으면 무시
    } catch {
      /* 다이얼로그 안에서 "요약 없이도 삭제할 수 있습니다"로 안내한다 */
    }
  };

  const canManage = (p: Project) => !!user?.is_admin || p.my_role === "owner" || p.my_role === "manager";

  const all = data?.projects ?? [];
  const projects = all.filter((p) => p.status !== "archived");
  const archivedList = all.filter((p) => p.status === "archived");
  const allProjects = allQ.data?.projects ?? [];

  const ProjectCard = ({ p }: { p: Project }) => (
    // relative 래퍼 — ⋯ 메뉴가 Link 밖에 떠야 카드 이동과 섞이지 않는다.
    <div className="relative h-full">
      <Link href={`/projects/${p.id}`}>
        <Card className="group h-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{p.key}</span>
              {p.status !== "active" && <Badge className="bg-slate-100 text-slate-500">{p.status === "completed" ? "완료" : "보관"}</Badge>}
            </div>
            <div className="flex items-center gap-1">
              {/* 관리 가능한 사람에게만 자리를 비워둔다 — 아니면 화살표가 그대로 우측 끝 */}
              {canManage(p) && <span className="w-6" aria-hidden />}
              <ChevronRight size={18} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand" />
            </div>
          </div>
          <div className="mt-2 font-semibold text-slate-800">{p.name}</div>
          {p.description && <div className="mt-1 line-clamp-2 text-sm text-slate-400">{p.description}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge className="bg-brand-50 text-brand">{p.my_role ? ROLE_LABEL[p.my_role] ?? p.my_role : "멤버"}</Badge>
            {fmtRangeShort(p.start_date, p.end_date) && <Badge className="bg-slate-100 font-medium text-slate-500">{fmtRangeShort(p.start_date, p.end_date)}</Badge>}
          </div>
        </Card>
      </Link>
      {canManage(p) && (
        <>
          <button
            type="button"
            aria-label="프로젝트 관리"
            className="absolute right-9 top-3.5 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            // Link 안이 아니라 위에 떠 있지만, 카드 클릭 영역과 겹치므로 전파를 확실히 끊는다.
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id); }}
          >
            <MoreHorizontal size={17} />
          </button>
          {menuFor === p.id && (
            <div className="absolute right-8 top-11 z-20 min-w-[9.5rem] rounded-xl border border-slate-200 bg-white p-1.5 shadow-floating">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                onClick={(e) => { e.preventDefault(); setMenuFor(null); archive.mutate({ p, archived: p.status !== "archived" }); }}
              >
                <Archive size={14} /> {p.status === "archived" ? "보관 해제" : "보관하기"}
              </button>
              <div className="my-1 h-px bg-slate-100" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-red-600 transition hover:bg-red-50"
                onClick={(e) => { e.preventDefault(); void openDelete(p, "trash"); }}
              >
                <Trash2 size={14} /> 삭제…
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  // 접이 섹션 헤더 — 회의록 월 접기와 같은 규약(▸/▾ + 개수 배지)
  const SectionToggle = ({ open, onToggle, label, count, tone }: { open: boolean; onToggle: () => void; label: string; count: number; tone?: "danger" }) => (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-2 text-sm font-semibold transition ${tone === "danger" ? "text-slate-500 hover:text-red-600" : "text-slate-500 hover:text-slate-700"}`}
    >
      <span className="text-xs">{open ? "▾" : "▸"}</span> {label}
      <Badge className="bg-slate-100 text-slate-500">{count}</Badge>
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">프로젝트</h1>
        <Button onClick={() => setOpen(true)}><Plus size={16} /> 새 프로젝트</Button>
      </div>

      {user?.is_admin && (
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm">
          <button onClick={() => setTab("mine")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold transition ${tab === "mine" ? "bg-white text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            <FolderKanban size={15} /> 내 프로젝트
          </button>
          <button onClick={() => setTab("all")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold transition ${tab === "all" ? "bg-white text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            <Globe size={15} /> 전체 (관리자)
          </button>
        </div>
      )}

      {tab === "all" && user?.is_admin ? (
        allQ.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2"><SkeletonCard lines={2} /><SkeletonCard lines={2} /></div>
        ) : (
          <div className="stagger-children grid gap-3 sm:grid-cols-2">
            {allProjects.map((p) => (
              p.my_role ? <ProjectCard key={p.id} p={p} /> : (
                <Card key={p.id} className="flex h-full flex-col opacity-70">
                  <div className="flex items-start justify-between">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{p.key}</span>
                    <span className="text-xs text-slate-400">멤버 {p.member_count ?? 0}명</span>
                  </div>
                  <div className="mt-2 font-semibold text-slate-700">
                    {p.name}
                    {p.status === "archived" && <Badge className="ml-1.5 bg-slate-100 text-slate-500">보관</Badge>}
                  </div>
                  {p.description && <div className="mt-1 line-clamp-2 text-sm text-slate-400">{p.description}</div>}
                  {/* 관리자는 참여하지 않고도 정리할 수 있다 — 참여하면 팀원 목록에 이름이 남기 때문 */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={joinAsAdmin.isPending}
                      onClick={() => joinAsAdmin.mutate(p)}>
                      <LogIn size={14} /> 매니저로 참여
                    </Button>
                    <Button size="sm" variant="outline" disabled={archive.isPending}
                      onClick={() => archive.mutate({ p, archived: p.status !== "archived" })}>
                      <Archive size={14} /> {p.status === "archived" ? "보관 해제" : "보관"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600" onClick={() => void openDelete(p, "trash")}>
                      <Trash2 size={14} /> 삭제
                    </Button>
                  </div>
                </Card>
              )
            ))}
          </div>
        )
      ) : isLoading ? (
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
          {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}

      {/* 보관됨 — 활성 목록에서 빠지고 여기로. 기본 접힘 (회의록 월 접기와 같은 규약) */}
      {tab === "mine" && archivedList.length > 0 && (
        <div className="border-t border-dashed border-slate-200 pt-4">
          <SectionToggle open={showArchived} onToggle={() => setShowArchived((v) => !v)} label="보관됨" count={archivedList.length} />
          {showArchived && (
            <div className="stagger-children mt-3 grid gap-3 opacity-75 sm:grid-cols-2">
              {archivedList.map((p) => <ProjectCard key={p.id} p={p} />)}
            </div>
          )}
        </div>
      )}

      {/* 휴지통 — 복원하거나 지금 영구 삭제. 30일이 지나면 자동으로 사라진다 */}
      {tab === "mine" && trashed.length > 0 && (
        <div className="border-t border-dashed border-slate-200 pt-4">
          <SectionToggle open={showTrash} onToggle={() => setShowTrash((v) => !v)} label="휴지통" count={trashed.length} tone="danger" />
          {showTrash && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-xs text-slate-400">{retentionDays}일이 지나면 자동으로 영구 삭제돼요. 기다리지 않고 지금 지울 수도 있어요.</p>
              {trashed.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                  <span className="rounded-md bg-white px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{p.key}</span>
                  <div className="min-w-[8rem] flex-1">
                    <div className="truncate text-sm font-medium text-slate-600">{p.name}</div>
                    <div className="text-[11.5px] text-slate-400">
                      {p.days_left > 0 ? `${p.days_left}일 뒤 영구 삭제` : "곧 영구 삭제됩니다"}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(p)}>
                    <RotateCcw size={14} /> 복원
                  </Button>
                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => void openDelete(p, "purge")}>
                    <Trash2 size={14} /> 지금 영구 삭제
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 삭제 확인 — 영향 요약 + 노하우 초안 경고 + 이름 타이핑 (서버도 같은 확인을 강제한다) */}
      <Modal open={!!delTarget} onClose={closeDel} title={delTarget?.mode === "purge" ? "지금 영구 삭제" : "프로젝트 삭제"}>
        {delTarget && (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-slate-600">
              <b className="text-slate-800">{delTarget.p.name}</b>
              {delTarget.mode === "purge"
                ? " 을(를) 지금 영구 삭제합니다. 되돌릴 수 없어요."
                : ` 을(를) 휴지통으로 옮깁니다. ${retentionDays}일 안에는 복원할 수 있어요.`}
            </p>

            {/* 영향 요약은 판단 재료일 뿐 삭제의 전제 조건이 아니다 — 집계를 못 받아도 삭제는 계속할 수 있다 */}
            {delTarget.impact ? (
              <>
                {/* 노하우 초안 경고 — 차단하지 않는다. 소유자가 없으면 게시할 사람이 없어 영영 못 지우게 되기 때문 */}
                {delTarget.impact.skills_draft > 0 && (
                  <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-800">
                    <AlertTriangle size={16} className="mt-0.5 flex-none" />
                    <div>
                      검수 전 <b>노하우 초안 {delTarget.impact.skills_draft}건</b>이 있어요. 삭제해도 사라지지는 않지만
                      프로젝트 연결이 끊겨 <b>'미분류'</b>로 이동합니다(작성자와 관리자에게만 보여요).
                      <br />
                      가능하면 먼저 <b>노하우 라이브러리에서 게시</b>하면 조직 전체에 남습니다.
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12.5px] leading-relaxed">
                  <div className="text-red-600">
                    <b>삭제됨</b> — 태스크 {delTarget.impact.tasks}개 · 문서 {delTarget.impact.pages}개 · 회의록 {delTarget.impact.meetings}개
                    {" · "}일정 {delTarget.impact.events}개 · 스니펫 {delTarget.impact.snippets}개 · 초대·활동기록
                  </div>
                  <div className="mt-1 text-emerald-700">
                    <b>보존됨</b> — 게시된 노하우 {delTarget.impact.skills_published}건, 갤러리 제출물 (프로젝트 연결만 끊김)
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-500">
                무엇이 사라지는지 요약을 불러오는 중이에요. 요약 없이도 삭제할 수 있습니다.
              </div>
            )}

            <Field label={`확인을 위해 "${delTarget.p.name}"을(를) 그대로 입력하세요`}>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={delTarget.p.name}
                // 모바일 기본값(iOS Safari는 autocapitalize="sentences")이 첫 글자를 대문자로 바꿔버린다.
                // 서버·클라 모두 trim 후 대소문자 그대로 비교하므로 영문 이름이면 계속 불일치가 난다.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {confirmName.trim() !== delTarget.p.name.trim() && (
                // 버튼이 왜 안 눌리는지 알려준다 — disabled는 pointer-events까지 죽어 툴팁도 안 뜬다
                <p className="mt-1 text-[12px] text-slate-500">
                  {confirmName ? "이름이 정확히 일치해야 버튼이 활성화돼요." : "위 이름을 그대로 입력하면 버튼이 활성화돼요."}
                </p>
              )}
            </Field>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeDel}>취소</Button>
              <Button
                variant="danger"
                disabled={confirmName.trim() !== delTarget.p.name.trim() || trash.isPending || purge.isPending}
                onClick={() =>
                  delTarget.mode === "purge"
                    ? purge.mutate({ p: delTarget.p, name: confirmName })
                    : trash.mutate({ p: delTarget.p, name: confirmName })
                }
              >
                {delTarget.mode === "purge" ? "영구 삭제" : "휴지통으로 이동"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={open} onClose={() => setOpen(false)} title="새 프로젝트">
        <div className="flex flex-col gap-3">
          <Field label="이름"><Input placeholder="예: 모바일 앱 개편" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="설명 (선택)"><Input placeholder="한 줄 설명" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Field label="기간 (선택)">
            <div className="flex items-center gap-1.5">
              <Input type="date" className="text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} title="시작일" />
              <span className="text-slate-300">~</span>
              <Input type="date" className="text-sm" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} title="종료일 — 시작일보다 앞설 수 없어요" />
            </div>
            <div className="mt-1 text-[11.5px] text-slate-400">타임라인 '전체' 보기의 기준 기간이 돼요. 나중에 프로젝트 화면에서 바꿀 수 있어요.</div>
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>취소</Button>
            <Button onClick={() => name && create.mutate()} disabled={create.isPending || !!(startDate && endDate && endDate < startDate)}>만들기</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
