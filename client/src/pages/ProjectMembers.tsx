import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, UserPlus, Copy, Check } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, Card, Input, Badge, Avatar, Field, Select, Spinner } from "../components/ui";

const ROLE_LABEL: Record<string, string> = { owner: "소유자", manager: "매니저", member: "멤버" };

export default function ProjectMembers() {
  const [, params] = useRoute("/projects/:id/members");
  const pid = Number(params?.id);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<{ members: any[] }>({ queryKey: ["members", pid], queryFn: () => get(`/projects/${pid}/members`) });
  const invite = useMutation({
    mutationFn: () => post<{ invite_url: string }>(`/projects/${pid}/invites`, { email, role }),
    onSuccess: (r) => { setInviteLink(r.invite_url); setEmail(""); setCopied(false); },
  });

  const copy = () => { if (inviteLink) { navigator.clipboard?.writeText(inviteLink); setCopied(true); } };

  return (
    <div className="flex flex-col gap-5">
      <Link href={`/projects/${pid}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-brand">
        <ChevronLeft size={18} /> 이전 · 보드로
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-slate-800">팀원</h1>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2 font-semibold text-slate-700"><UserPlus size={18} className="text-brand" /> 초대 링크 만들기</div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1"><Field label="이메일"><Input placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
          <div className="sm:w-40"><Field label="역할"><Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">멤버</option><option value="manager">매니저</option><option value="owner">소유자</option>
          </Select></Field></div>
        </div>
        <Button onClick={() => email && invite.mutate()} disabled={invite.isPending} className="self-start">초대 링크 생성</Button>
        {inviteLink && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
            <div className="mb-1.5 text-xs font-medium text-slate-500">이 1회용 링크를 팀원에게 전달하세요</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 text-xs text-slate-600">{inviteLink}</code>
              <Button size="sm" variant="outline" onClick={copy}>{copied ? <><Check size={14} /> 복사됨</> : <><Copy size={14} /> 복사</>}</Button>
            </div>
          </div>
        )}
      </Card>

      {isLoading ? <Spinner /> : (
        <div className="flex flex-col gap-2">
          {data?.members.map((m) => (
            <Card key={m.id} className="flex items-center gap-3 py-3">
              <Avatar name={m.user.full_name ?? m.user.email} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-800">{m.user.full_name ?? m.user.email}</div>
                <div className="truncate text-xs text-slate-400">{m.user.email}</div>
              </div>
              <Badge className="bg-indigo-50 text-brand">{ROLE_LABEL[m.role] ?? m.role}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
