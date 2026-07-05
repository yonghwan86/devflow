import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { KeyRound, Plug, Copy, Check, Trash2, Plus, ShieldAlert } from "lucide-react";
import { get, post, del } from "../lib/api";
import { Card, Button, Input, Badge, Field, Select, toast, useConfirm, SkeletonList } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// 개인 API 토큰 관리 + MCP 연결 안내. 토큰은 개인용이라 로그인 사용자 누구나 발급 가능.
// 발급 시 원문은 1회만 노출(서버는 해시만 저장) — 화면에서 즉시 복사해 보관해야 함.
const SCOPES: { key: string; label: string; mcp?: boolean }[] = [
  { key: "task:read", label: "태스크 읽기", mcp: true },
  { key: "task:write", label: "태스크 생성/수정", mcp: true },
  { key: "guide:write", label: "가이드 작성/수행 표시", mcp: true },
  { key: "project:read", label: "프로젝트/검색 읽기", mcp: true },
  { key: "comment:write", label: "댓글 작성 (예약)" },
  { key: "skill:read", label: "스킬 읽기 (예약)" },
];
const MCP_SCOPES = SCOPES.filter((s) => s.mcp).map((s) => s.key);
const EXPIRY = [
  { label: "만료 없음", days: 0 },
  { label: "30일", days: 30 },
  { label: "90일", days: 90 },
  { label: "1년", days: 365 },
];

export default function Settings() {
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(MCP_SCOPES));
  const [expiryDays, setExpiryDays] = useState(0);
  const [newToken, setNewToken] = useState<string | null>(null); // 방금 발급된 원문(1회 노출)
  const [copied, setCopied] = useState(false);

  const mcpUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/mcp`;

  const listQ = useQuery<{ tokens: any[] }>({ queryKey: ["tokens"], queryFn: () => get("/tokens") });
  const tokens = listQ.data?.tokens ?? [];

  const create = useMutation({
    mutationFn: () => {
      const body: any = { name: name.trim(), scopes: [...scopes] };
      if (expiryDays > 0) body.expires_at = new Date(Date.now() + expiryDays * 86400_000).toISOString();
      return post<{ token: string }>("/tokens", body);
    },
    onSuccess: (d) => {
      setNewToken(d.token);
      setCopied(false);
      setName("");
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e: any) => toast(`발급 실패: ${e.message}`, "error"),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/tokens/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["tokens"] }); toast("토큰을 폐기했어요.", "success"); },
    onError: (e: any) => toast(`폐기 실패: ${e.message}`, "error"),
  });

  const toggleScope = (k: string) => setScopes((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const copyToken = () => { if (newToken) { navigator.clipboard?.writeText(newToken); setCopied(true); } };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      {dialog}
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
        <KeyRound className="text-brand" size={24} /> API 토큰 & MCP
      </h1>

      {/* MCP 연결 안내 */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2 font-semibold text-slate-700"><Plug size={16} className="text-brand" /> Claude에 MCP로 연결하기</div>
        <p className="text-sm leading-relaxed text-slate-500">
          아래 토큰을 발급한 뒤, Claude(데스크톱/코드)의 MCP 설정에 <b>Streamable HTTP</b> 서버로 등록하면
          Claude에서 내 태스크 조회·생성, 가이드 작성, 지식베이스 검색을 할 수 있어요. 요청은 실제 DevFlow에 반영됩니다.
        </p>
        <div className="flex flex-col gap-1.5 rounded-lg bg-slate-50 p-3 text-xs">
          <div><span className="text-slate-400">URL</span> <code className="ml-1 rounded bg-white px-1.5 py-0.5 text-slate-700">{mcpUrl}</code></div>
          <div><span className="text-slate-400">인증 헤더</span> <code className="ml-1 rounded bg-white px-1.5 py-0.5 text-slate-700">Authorization: Bearer &lt;토큰&gt;</code></div>
        </div>
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
          <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
          이 서버는 Bearer 토큰 인증만 지원해요(OAuth 미지원). Claude의 기본 커넥터로 바로 안 붙으면
          <code className="mx-1 rounded bg-white px-1 py-0.5">mcp-remote</code>처럼 커스텀 헤더를 넣어주는 브릿지가 필요할 수 있어요.
        </div>
      </Card>

      {/* 토큰 발급 */}
      <Card className="flex flex-col gap-3">
        <div className="font-semibold text-slate-700">새 토큰 발급</div>
        <Field label="이름 (용도 구분용)"><Input placeholder="예: Claude MCP" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div>
          <div className="mb-1.5 text-xs font-medium text-slate-500">권한 (스코프)</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label key={s.key} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={scopes.has(s.key)} onChange={() => toggleScope(s.key)} className="h-4 w-4 rounded accent-indigo-600" />
                <span className="flex-1">{s.label}</span>
                {s.mcp && <Badge className="bg-brand-50 text-[10px] text-brand">MCP</Badge>}
              </label>
            ))}
          </div>
          <button className="mt-1.5 text-xs text-brand hover:underline" onClick={() => setScopes(new Set(MCP_SCOPES))}>MCP 권장 권한만 선택</button>
        </div>
        <Field label="만료">
          <Select value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} className="h-9 text-sm">
            {EXPIRY.map((x) => <option key={x.days} value={x.days}>{x.label}</option>)}
          </Select>
        </Field>
        <Button className="self-start" onClick={() => name.trim() && scopes.size > 0 && create.mutate()} disabled={create.isPending || !name.trim() || scopes.size === 0}>
          <Plus size={15} /> 토큰 발급
        </Button>

        {newToken && (
          <div className="animate-fade-in flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
            <div className="text-xs font-semibold text-emerald-700">토큰이 발급됐어요 — 지금 복사해 보관하세요. 이 화면을 벗어나면 다시 볼 수 없어요.</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 text-xs text-slate-700">{newToken}</code>
              <Button size="sm" variant="outline" onClick={copyToken}>{copied ? <><Check size={14} /> 복사됨</> : <><Copy size={14} /> 복사</>}</Button>
            </div>
          </div>
        )}
      </Card>

      {/* 토큰 목록 */}
      <Card className="flex flex-col gap-2">
        <div className="font-semibold text-slate-700">발급된 토큰</div>
        {listQ.isLoading ? <SkeletonList count={2} lines={1} /> : tokens.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-400">아직 발급한 토큰이 없어요.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tokens.map((t) => {
              const revoked = !!t.revoked_at;
              const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
              return (
                <div key={t.id} className={`flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-2 ${revoked || expired ? "opacity-50" : ""}`}>
                  <span className="font-medium text-slate-700">{t.name}</span>
                  <div className="flex flex-wrap gap-1">
                    {(t.scopes ?? []).map((s: string) => <Badge key={s} className="bg-slate-100 text-[10px] text-slate-500">{s}</Badge>)}
                  </div>
                  <span className="ml-auto text-xs text-slate-400">
                    {revoked ? "폐기됨" : expired ? "만료됨" : t.last_used_at ? `최근 사용 ${new Date(t.last_used_at).toLocaleDateString("ko-KR")}` : "미사용"}
                  </span>
                  {!revoked && (
                    <button aria-label="토큰 폐기" className="rounded-md p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                      onClick={async () => { if (await confirm({ title: "토큰 폐기", message: `"${t.name}" 토큰을 폐기할까요? 이 토큰을 쓰는 연결은 즉시 끊겨요.`, confirmLabel: "폐기", tone: "danger" })) revoke.mutate(t.id); }}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
