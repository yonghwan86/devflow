import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, UserPlus, Copy, Check, Link2 } from "lucide-react";
import { get, post, ApiError } from "../lib/api";
import { Button, Card, Input, Badge, Avatar, Field, Select, SkeletonList, toast } from "../components/ui";

const ROLE_LABEL: Record<string, string> = { owner: "소유자", manager: "매니저", member: "멤버" };
type AddMode = "existing" | "invite";

export default function ProjectMembers() {
  const [, params] = useRoute("/projects/:id/members");
  const pid = Number(params?.id);
  const [mode, setMode] = useState<AddMode>("existing");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });

  const addExisting = useMutation({
    mutationFn: () => post(`/projects/${pid}/members`, { email, role }),
    onSuccess: () => {
      toast("팀원을 추가했습니다.", "success");
      setEmail("");
      queryClient.invalidateQueries({ queryKey: ["members", pid] });
    },
    onError: (e: unknown) => {
      toast(e instanceof ApiError ? e.message : "팀원 추가에 실패했습니다.");
    },
  });
  const invite = useMutation({
    mutationFn: () => post<{ invite_url: string }>(`/projects/${pid}/invites`, { email, role }),
    onSuccess: (r) => { setInviteLink(r.invite_url); setEmail(""); setCopied(false); },
  });

  const copy = () => { if (inviteLink) { navigator.clipboard?.writeText(inviteLink); setCopied(true); } };

  return (
    <div className="flex flex-col gap-5">
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">팀원</h1>

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

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1"><Field label="이메일"><Input placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
          <div className="sm:w-40"><Field label="역할"><Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">멤버</option><option value="manager">매니저</option><option value="owner">소유자</option>
          </Select></Field></div>
        </div>

        {mode === "existing" ? (
          <>
            <Button onClick={() => email && addExisting.mutate()} disabled={addExisting.isPending || !email} className="self-start">
              {addExisting.isPending ? "추가 중…" : "팀원으로 추가"}
            </Button>
            <p className="text-xs text-slate-400">DevFlow에 이미 가입된 사용자만 바로 추가할 수 있어요. 아직 가입 전이라면 "초대 링크 만들기"를 이용하세요.</p>
          </>
        ) : (
          <>
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

      {isLoading ? <SkeletonList count={3} lines={1} /> : (
        <div className="stagger-children flex flex-col gap-2">
          {data?.members.map((m) => (
            <Card key={m.id} className="flex items-center gap-3 py-3">
              <Avatar name={m.user.full_name ?? m.user.email} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-800">{m.user.full_name ?? m.user.email}</div>
                <div className="truncate text-xs text-slate-400">{m.user.email}</div>
              </div>
              <Badge className="bg-brand-50 text-brand">{ROLE_LABEL[m.role] ?? m.role}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
