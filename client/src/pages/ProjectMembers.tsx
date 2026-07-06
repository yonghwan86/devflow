import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, UserPlus, Copy, Check, Link2, Trash2, Crown } from "lucide-react";
import { get, post, patch, del, ApiError } from "../lib/api";
import { Button, Card, Input, Badge, Avatar, Field, Select, SkeletonList, toast, useConfirm } from "../components/ui";
import { useAuth } from "../hooks/useAuth";

// 역할 계층: 소유자(owner) > 매니저(manager) > 멤버(member).
const ROLE_LABEL: Record<string, string> = { owner: "소유자", manager: "매니저", member: "멤버" };
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
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const membersQ = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const members = membersQ.data?.members ?? [];
  const myRole = members.find((m) => m.user.id === me?.id)?.role;
  const isOwner = myRole === "owner"; // 소유권 양도는 소유자만
  const canManage = myRole === "owner" || myRole === "manager";

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

  const copy = () => { if (inviteLink) { navigator.clipboard?.writeText(inviteLink); setCopied(true); } };

  return (
    <div className="flex flex-col gap-5">
      {dialog}
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">팀원</h1>

      {canManage && (
        <Card className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-sm">
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
                  <option value="member">멤버</option><option value="manager">매니저</option>
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
                      <Avatar name={u.full_name ?? u.email} size={30} />
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
                  <option value="member">멤버</option><option value="manager">매니저</option>
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
                <Avatar name={displayName} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-800">{displayName}{isSelf && <span className="ml-1 text-xs text-slate-400">(나)</span>}</div>
                  <div className="truncate text-xs text-slate-400">{m.user.email}</div>
                </div>
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
                      <option value="member">멤버</option><option value="manager">매니저</option>
                    </Select>
                    <button
                      disabled={removeMember.isPending}
                      title="제거"
                      aria-label="멤버 제거"
                      className="rounded-lg p-2 text-slate-300 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-300"
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
