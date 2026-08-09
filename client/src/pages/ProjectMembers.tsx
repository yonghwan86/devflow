import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Copy, Check, Link2, Trash2, Crown, Settings2, Layers3, Plus } from "lucide-react";
import { get, post, patch, del, ApiError } from "../lib/api";
import { Button, Card, Input, Badge, Avatar, Field, Select, SkeletonList, Textarea, toast, useConfirm } from "../components/ui";
import { ProjectNav } from "../components/ProjectNav";
import { useAuth } from "../hooks/useAuth";

// 역할 계층: 소유자(owner) > 매니저(manager) > 멤버(member).
const ROLE_LABEL: Record<string, string> = { owner: "소유자", manager: "매니저", member: "멤버" };
const OPERATIONAL_ROLE_LABEL: Record<string, string> = { pm: "PM", pl: "PL", worker: "담당자" };
type AddMode = "existing" | "invite";

export default function ProjectMembers() {
  const [, params] = useRoute("/projects/:id/members");
  const pid = Number(params?.id);
  const { user: me } = useAuth();
  const [mode, setMode] = useState<AddMode>("existing");
  const [email, setEmail] = useState(""); // invite 모드 전용
  const [role, setRole] = useState("member");
  const [filter, setFilter] = useState(""); // 가입자 목록 필터
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [areaLead, setAreaLead] = useState<string>("");
  const [reportEnabled, setReportEnabled] = useState(false);
  const [cutoffHour, setCutoffHour] = useState(21);
  const [meetingTime, setMeetingTime] = useState("09:30");
  const [areaDescriptions, setAreaDescriptions] = useState<Record<number, string>>({});
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const members = membersQ.data?.members ?? [];
  const myRole = members.find((m) => m.user.id === me?.id)?.role;
  const myOperationalRole = members.find((m) => m.user.id === me?.id)?.operational_role;
  const isOwner = myRole === "owner"; // 소유권 양도는 소유자만
  const canManage = myRole === "owner" || myRole === "manager";
  const isPm = myOperationalRole === "pm";
  const isPl = myOperationalRole === "pl";
  const projectQ = useQuery<{ project: any }>({ queryKey: ["project", pid], queryFn: () => get(`/projects/${pid}`) });
  const areasQ = useQuery<{ areas: any[] }>({ queryKey: ["areas", pid], queryFn: () => get(`/projects/${pid}/areas`), enabled: !!projectQ.data?.project?.daily_report_enabled });
  useEffect(() => {
    const project = projectQ.data?.project;
    if (!project) return;
    setReportEnabled(!!project.daily_report_enabled);
    setCutoffHour(project.report_cutoff_hour ?? 21);
    setMeetingTime(project.report_meeting_time ?? "09:30");
  }, [projectQ.data?.project]);
  useEffect(() => {
    const next: Record<number, string> = {};
    for (const area of areasQ.data?.areas ?? []) next[area.id] = area.description ?? "";
    setAreaDescriptions(next);
  }, [areasQ.data?.areas]);

  const addableQ = useQuery<{ users: any[] }>({
    queryKey: ["addable-users", pid],
    queryFn: () => get(`/projects/${pid}/addable-users`),
    enabled: canManage && mode === "existing",
  });
  const addable = (addableQ.data?.users ?? []).filter((u) => {
    const t = filter.trim().toLowerCase();
    if (!t) return true;
    return (u.full_name ?? "").toLowerCase().includes(t) || u.email.toLowerCase().includes(t);
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["members", pid] });
    queryClient.invalidateQueries({ queryKey: ["addable-users", pid] });
  };

  const addExisting = useMutation({
    mutationFn: (userId: number) => post(`/projects/${pid}/members`, { user_id: userId, role }),
    onSuccess: () => { toast("팀원을 추가했습니다.", "success"); setFilter(""); invalidate(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "팀원 추가에 실패했습니다."),
  });
  const invite = useMutation({
    mutationFn: () => post<{ invite_url: string }>(`/projects/${pid}/invites`, { email, role }),
    onSuccess: (r) => { setInviteLink(r.invite_url); setEmail(""); setCopied(false); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "초대 생성에 실패했습니다."),
  });
  const changeRole = useMutation({
    mutationFn: (v: { memberId: number; role: string }) => patch(`/projects/${pid}/members/${v.memberId}`, { role: v.role }),
    onSuccess: () => invalidate(),
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "역할 변경에 실패했습니다."),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: number) => del(`/projects/${pid}/members/${memberId}`),
    onSuccess: () => { toast("멤버를 제거했습니다.", "success"); invalidate(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "멤버 제거에 실패했습니다."),
  });
  const transferOwner = useMutation({
    mutationFn: (userId: number) => post(`/projects/${pid}/transfer-owner`, { user_id: userId }),
    onSuccess: () => { toast("소유권을 넘겼어요. 이제 당신은 매니저입니다.", "success"); invalidate(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "소유권 양도에 실패했습니다."),
  });
  const saveReportSettings = useMutation({
    mutationFn: () => patch(`/projects/${pid}/report-settings`, { daily_report_enabled: reportEnabled, report_cutoff_hour: cutoffHour, report_meeting_time: meetingTime }),
    onSuccess: () => {
      toast("프로젝트 운영 설정을 저장했습니다.", "success");
      queryClient.invalidateQueries({ queryKey: ["project", pid] });
      queryClient.invalidateQueries({ queryKey: ["areas", pid] });
    },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "운영 설정 저장에 실패했습니다."),
  });
  const createArea = useMutation({
    mutationFn: () => post(`/projects/${pid}/areas`, { name: areaName, lead_user_id: areaLead ? Number(areaLead) : null }),
    onSuccess: () => {
      setAreaName(""); setAreaLead(""); toast("영역을 추가했습니다.", "success");
      queryClient.invalidateQueries({ queryKey: ["areas", pid] });
      queryClient.invalidateQueries({ queryKey: ["members", pid] });
    },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "영역 추가에 실패했습니다."),
  });
  const removeArea = useMutation({
    mutationFn: (areaId: number) => del(`/projects/${pid}/areas/${areaId}`),
    onSuccess: () => { toast("영역을 삭제했습니다. 연결 태스크는 미분류로 이동합니다.", "success"); queryClient.invalidateQueries({ queryKey: ["areas", pid] }); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "영역 삭제에 실패했습니다."),
  });
  const updateAreaLead = useMutation({
    mutationFn: (v: { areaId: number; lead_user_id: number | null }) => patch(`/projects/${pid}/areas/${v.areaId}`, { lead_user_id: v.lead_user_id }),
    onSuccess: () => { toast("영역 PL을 변경했습니다.", "success"); queryClient.invalidateQueries({ queryKey: ["areas", pid] }); queryClient.invalidateQueries({ queryKey: ["members", pid] }); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "PL 변경에 실패했습니다."),
  });
  const updateOwnArea = useMutation({
    mutationFn: (v: { areaId: number; description: string }) => patch(`/projects/${pid}/areas/${v.areaId}`, { description: v.description || null }),
    onSuccess: () => { toast("내 영역 설명을 저장했습니다.", "success"); queryClient.invalidateQueries({ queryKey: ["areas", pid] }); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "영역 설명 저장에 실패했습니다."),
  });
  const changeOperationalRole = useMutation({
    mutationFn: (v: { userId: number; operational_role: string }) => patch(`/projects/${pid}/members/${v.userId}/operational-role`, { operational_role: v.operational_role }),
    onSuccess: () => { toast("운영 역할을 변경했습니다.", "success"); invalidate(); },
    onError: (e: unknown) => toast(e instanceof ApiError ? e.message : "운영 역할 변경에 실패했습니다."),
  });

  const copy = () => { if (inviteLink) { navigator.clipboard?.writeText(inviteLink); setCopied(true); } };

  return (
    <div className="flex flex-col gap-5">
      {dialog}
      <ProjectNav pid={pid} current="members" />
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">팀원</h1>

      {isPm && (
        <Card className="space-y-4 border-brand-100 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex items-center gap-2 text-lg font-bold text-slate-900"><Settings2 size={19} className="text-brand" /> 프로젝트 운영 설정</div><p className="mt-1 text-sm text-slate-500">PM만 전체 설정을 바꿀 수 있습니다. PL에게는 자기 영역 관리만 보입니다.</p></div>
            <Badge className="bg-brand-50 text-brand">PM 전용</Badge>
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-slate-50 p-3">
            <div><div className="font-semibold text-slate-800">일일보고 사용</div><div className="text-sm text-slate-500">PM·PL에게만 일일보고 메뉴를 표시합니다.</div></div>
            <input type="checkbox" className="h-5 w-5 accent-indigo-600" checked={reportEnabled} onChange={(e) => setReportEnabled(e.target.checked)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="개발 귀속 마감 시각"><Select value={cutoffHour} onChange={(e) => setCutoffHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</Select></Field>
            <Field label="일일회의 시각"><Input type="time" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} /></Field>
          </div>
          <div className="flex justify-end"><Button onClick={() => saveReportSettings.mutate()} disabled={saveReportSettings.isPending}>운영 설정 저장</Button></div>

          {projectQ.data?.project?.daily_report_enabled && (
            <div className="border-t border-slate-200 pt-4">
              <div className="mb-3 flex items-center gap-2 font-bold text-slate-900"><Layers3 size={18} /> 영역과 PL</div>
              <div className="space-y-2">
                {(areasQ.data?.areas ?? []).map((area) => (
                  <div key={area.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1"><div className="font-semibold text-slate-800">{area.name}</div><div className="text-xs text-slate-400">영역이 없는 태스크는 미분류로 보고됩니다.</div></div>
                    <Select className="w-full sm:w-44" value={area.lead_user_id ?? ""} onChange={(e) => updateAreaLead.mutate({ areaId: area.id, lead_user_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">PL 미지정</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}
                    </Select>
                    <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: "영역 삭제", message: `${area.name} 영역을 삭제할까요? 연결된 태스크는 삭제되지 않고 미분류로 이동합니다.`, confirmLabel: "삭제", tone: "danger" })) removeArea.mutate(area.id); }}><Trash2 size={15} /> 삭제</Button>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_220px_auto]">
                <Input placeholder="새 영역 이름 (예: 결제)" value={areaName} onChange={(e) => setAreaName(e.target.value)} />
                <Select value={areaLead} onChange={(e) => setAreaLead(e.target.value)}><option value="">PL은 나중에 지정</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name ?? m.user.email}</option>)}</Select>
                <Button disabled={!areaName.trim() || createArea.isPending} onClick={() => createArea.mutate()}><Plus size={16} /> 영역 추가</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {isPl && projectQ.data?.project?.daily_report_enabled && (
        <Card className="space-y-4 border-violet-100 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-lg font-bold text-slate-900"><Layers3 size={19} className="text-violet-600" /> 내 영역 관리</div>
              <p className="mt-1 text-sm text-slate-500">프로젝트 전체 설정은 PM이 관리합니다. PL은 자신이 맡은 영역의 설명만 관리하고, 일일보고에서 상태와 코멘트를 확인합니다.</p>
            </div>
            <Badge className="bg-violet-50 text-violet-700">PL 전용</Badge>
          </div>
          {(areasQ.data?.areas ?? []).filter((area) => area.lead_user_id === me?.id).length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">현재 배정된 영역이 없습니다. PM에게 영역 배정을 요청하세요.</p>
          ) : (
            <div className="space-y-3">
              {(areasQ.data?.areas ?? []).filter((area) => area.lead_user_id === me?.id).map((area) => (
                <div key={area.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="font-bold text-slate-900">{area.name}</div>
                  <Field label="영역 설명">
                    <Textarea
                      className="mt-2"
                      rows={3}
                      value={areaDescriptions[area.id] ?? ""}
                      onChange={(event) => setAreaDescriptions((current) => ({ ...current, [area.id]: event.target.value }))}
                      placeholder="이 영역의 범위와 PM이 알아야 할 기준을 적으세요"
                    />
                  </Field>
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" disabled={updateOwnArea.isPending} onClick={() => updateOwnArea.mutate({ areaId: area.id, description: areaDescriptions[area.id] ?? "" })}>영역 설명 저장</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {canManage && (
        <Card className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-1 rounded-xl bg-slate-100 p-1 text-sm sm:grid-cols-2">
            <button
              onClick={() => { setMode("existing"); setInviteLink(null); }}
              className={`flex items-center justify-center gap-1.5 rounded-lg py-2 font-semibold transition-all duration-150 ${mode === "existing" ? "bg-white text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <UserPlus size={16} /> 이미 가입한 팀원 추가
            </button>
            <button
              onClick={() => setMode("invite")}
              className={`flex items-center justify-center gap-1.5 rounded-lg py-2 font-semibold transition-all duration-150 ${mode === "invite" ? "bg-white text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <Link2 size={16} /> 초대 링크 만들기
            </button>
          </div>

          {mode === "existing" ? (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1"><Field label="가입자 검색"><Input placeholder="이름 또는 이메일로 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} /></Field></div>
                <div className="sm:w-40"><Field label="역할"><Select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">담당자</option><option value="manager">PM 권한</option>
                </Select></Field></div>
              </div>
              {addableQ.isLoading ? (
                <SkeletonList count={2} lines={1} />
              ) : addable.length === 0 ? (
                <p className="text-xs text-slate-400">{filter ? "일치하는 가입자가 없어요." : "추가할 수 있는 가입자가 없어요. 아직 가입 전이라면 \"초대 링크 만들기\"를 이용하세요."}</p>
              ) : (
                <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                  {addable.map((u) => (
                    <div key={u.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5">
                      <Avatar name={u.full_name ?? u.email} id={u.id} size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-700">{u.full_name ?? u.email}</div>
                        <div className="truncate text-xs text-slate-400">{u.email}</div>
                      </div>
                      <Button size="sm" variant="outline" disabled={addExisting.isPending} onClick={() => addExisting.mutate(u.id)}>추가</Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1"><Field label="이메일"><Input placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
                <div className="sm:w-40"><Field label="역할"><Select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">담당자</option><option value="manager">PM 권한</option>
                </Select></Field></div>
              </div>
              <Button onClick={() => email && invite.mutate()} disabled={invite.isPending || !email} className="self-start">초대 링크 생성</Button>
              {inviteLink && (
                <div className="animate-fade-in rounded-lg border border-brand-100 bg-brand-50/50 p-3">
                  <div className="mb-1.5 text-xs font-medium text-slate-500">이 1회용 링크를 팀원에게 전달하세요</div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 text-xs text-slate-600">{inviteLink}</code>
                    <Button size="sm" variant="outline" onClick={copy}>{copied ? <><Check size={14} /> 복사됨</> : <><Copy size={14} /> 복사</>}</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {membersQ.isLoading ? <SkeletonList count={3} lines={1} /> : (
        <div className="stagger-children flex flex-col gap-2">
          {members.map((m) => {
            const isSelf = m.user.id === me?.id;
            const targetIsOwner = m.role === "owner";
            const displayName = m.user.full_name ?? m.user.email;
            return (
              <Card key={m.id} className="flex items-center gap-3 py-3">
                <Avatar name={displayName} id={m.user.id} role={m.role} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-800">{displayName}{isSelf && <span className="ml-1 text-xs text-slate-400">(나)</span>}</div>
                  <div className="flex flex-wrap items-center gap-1.5"><span className="truncate text-xs text-slate-400">{m.user.email}</span><Badge className={m.operational_role === "pm" ? "bg-brand-100 text-brand" : m.operational_role === "pl" ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"}>{OPERATIONAL_ROLE_LABEL[m.operational_role] ?? "담당자"}</Badge>{m.role === "owner" && <span className="text-[11px] text-amber-600">기술 소유자</span>}</div>
                </div>
                {isPm && !targetIsOwner && (
                  <Select className="w-24 text-sm" value={m.operational_role ?? "worker"} disabled={changeOperationalRole.isPending} onChange={(e) => changeOperationalRole.mutate({ userId: m.user.id, operational_role: e.target.value })}>
                    <option value="worker">담당자</option><option value="pl">PL</option><option value="pm">PM</option>
                  </Select>
                )}
                {targetIsOwner ? (
                  // 소유자 행: 강등·제거 불가. 소유권은 양도로만 이동한다.
                  <Badge className="flex items-center gap-1 bg-amber-100 text-amber-700"><Crown size={13} /> 소유자</Badge>
                ) : canManage ? (
                  <div className="flex items-center gap-1.5">
                    {isOwner && (
                      <Button
                        size="sm" variant="ghost"
                        disabled={transferOwner.isPending}
                        title="이 팀원에게 소유권을 넘깁니다"
                        onClick={async () => {
                          if (await confirm({
                            title: "소유권 양도",
                            message: `${displayName}님에게 소유권을 넘길까요? 넘기면 당신은 매니저가 되고, 되돌리려면 새 소유자가 다시 양도해야 합니다.`,
                            confirmLabel: "양도", tone: "danger",
                          })) transferOwner.mutate(m.user.id);
                        }}
                      >
                        <Crown size={13} /> 소유자로 지정
                      </Button>
                    )}
                    <Select
                      className="w-24 text-sm"
                      value={m.role}
                      disabled={changeRole.isPending}
                      onChange={async (e) => {
                        const newRole = e.target.value;
                        if (newRole === m.role) return;
                        if (isSelf && newRole !== "manager") {
                          const ok = await confirm({ title: "본인 강등", message: "본인을 멤버로 강등하면 이 프로젝트를 관리할 수 없게 됩니다. 계속할까요?", confirmLabel: "강등", tone: "danger" });
                          if (!ok) return;
                        }
                        changeRole.mutate({ memberId: m.id, role: newRole });
                      }}
                    >
                      <option value="member">일반 접근</option><option value="manager">프로젝트 관리</option>
                    </Select>
                    <button
                      disabled={removeMember.isPending}
                      title="제거"
                      aria-label="멤버 제거"
                      className="rounded-lg p-2.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-300"
                      onClick={async () => {
                        if (await confirm({ title: "멤버 제거", message: `${displayName}님을 프로젝트에서 제거할까요?`, confirmLabel: "제거", tone: "danger" }))
                          removeMember.mutate(m.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ) : (
                  <Badge className="bg-brand-50 text-brand">{ROLE_LABEL[m.role] ?? m.role}</Badge>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
