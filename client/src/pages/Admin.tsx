import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ShieldCheck, KeyRound, PlugZap, Save } from "lucide-react";
import { get, patch, post } from "../lib/api";
import { Card, Button, Input, Select, Field, Badge, toast, useConfirm, SkeletonList } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { queryClient } from "../lib/queryClient";

// 관리자 설정 — LLM 프로바이더/키를 UI에서 관리 (키는 암호화 저장, 화면에는 마스킹만)
export default function Admin() {
  const { user } = useAuth();
  const { confirm, dialog } = useConfirm();
  const q = useQuery<{ settings: any }>({ queryKey: ["admin-settings"], queryFn: () => get("/admin/settings"), enabled: !!user?.is_admin });
  const [form, setForm] = useState({ llm_provider: "mock", llm_api_key: "", llm_model: "", llm_base_url: "", embedding_model: "" });

  useEffect(() => {
    const s = q.data?.settings;
    if (s) setForm({ llm_provider: s.llm_provider, llm_api_key: "", llm_model: s.llm_model, llm_base_url: s.llm_base_url, embedding_model: s.embedding_model });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        llm_provider: form.llm_provider,
        llm_model: form.llm_model,
        llm_base_url: form.llm_base_url,
        embedding_model: form.embedding_model,
      };
      if (form.llm_api_key.trim()) body.llm_api_key = form.llm_api_key.trim(); // 비워두면 기존 키 유지
      return patch("/admin/settings", body);
    },
    onSuccess: () => { toast("설정이 저장됐어요. 재시작 없이 즉시 적용됩니다.", "success"); setForm((f) => ({ ...f, llm_api_key: "" })); queryClient.invalidateQueries({ queryKey: ["admin-settings"] }); },
    onError: (e: any) => toast(`저장 실패: ${e.message}`, "error"),
  });
  const removeKey = useMutation({
    mutationFn: () => patch("/admin/settings", { llm_api_key: "" }),
    onSuccess: () => { toast("키를 삭제했어요. mock 모드로 동작합니다.", "success"); queryClient.invalidateQueries({ queryKey: ["admin-settings"] }); },
    onError: (e: any) => toast(e.message, "error"),
  });
  const testConn = useMutation({
    mutationFn: () => post<{ ok: boolean; error?: string; note?: string }>("/admin/settings/test", {}),
    onSuccess: (d) => (d.ok ? toast(`연결 성공${d.note ? ` — ${d.note}` : ""}`, "success") : toast(`연결 실패: ${d.error}`, "error")),
    onError: (e: any) => toast(e.message, "error"),
  });

  if (!user?.is_admin)
    return <div className="py-16 text-center text-slate-400">관리자만 접근할 수 있는 페이지예요.</div>;
  if (q.isLoading) return <div className="mx-auto max-w-2xl pt-4"><SkeletonList count={2} lines={4} /></div>;
  const s = q.data!.settings;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      {dialog}
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
        <ShieldCheck className="text-brand" size={24} /> 관리자 설정
      </h1>

      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-700"><KeyRound size={16} className="text-brand" /> AI (LLM / 임베딩)</div>
          <Badge className={s.llm_api_key_set ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}>
            {s.llm_api_key_set ? `키 등록됨 ${s.llm_api_key_masked}` : "키 없음 (mock 동작)"}
          </Badge>
        </div>
        <p className="text-sm text-slate-500">
          키를 등록하면 AI 검색·Q&A·가이드 제안·회의록 구조화·SKILL.md 추출이 실제 모델로 동작해요.
          키는 <b>AES-256 암호화로 저장</b>되고 다시 표시되지 않습니다.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="프로바이더">
            <Select value={form.llm_provider} onChange={(e) => setForm({ ...form, llm_provider: e.target.value })}>
              <option value="mock">mock (키 없음 · 오프라인)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </Field>
          <Field label="모델">
            <Input value={form.llm_model} onChange={(e) => setForm({ ...form, llm_model: e.target.value })} placeholder="gpt-4o-mini / claude-…" />
          </Field>
          <Field label={`API 키 ${s.llm_api_key_set ? "(비워두면 기존 키 유지)" : ""}`}>
            <Input type="password" value={form.llm_api_key} onChange={(e) => setForm({ ...form, llm_api_key: e.target.value })} placeholder="sk-…" autoComplete="off" />
          </Field>
          <Field label="임베딩 모델 (openai)">
            <Input value={form.embedding_model} onChange={(e) => setForm({ ...form, embedding_model: e.target.value })} placeholder="text-embedding-3-small" />
          </Field>
          <Field label="Base URL (선택 — 프록시/호환 API)">
            <Input value={form.llm_base_url} onChange={(e) => setForm({ ...form, llm_base_url: e.target.value })} placeholder="비워두면 공식 엔드포인트" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}><Save size={15} /> 저장</Button>
          <Button variant="outline" onClick={() => testConn.mutate()} disabled={testConn.isPending}>
            <PlugZap size={15} /> {testConn.isPending ? "테스트 중…" : "연결 테스트"}
          </Button>
          {s.llm_api_key_set && (
            <Button variant="ghost"
              onClick={async () => {
                if (await confirm({ title: "API 키 삭제", message: "키를 삭제하면 mock 모드로 동작합니다. 삭제할까요?", confirmLabel: "삭제", tone: "danger" })) removeKey.mutate();
              }}>키 삭제</Button>
          )}
          <span className="ml-auto text-xs text-slate-400">임베딩 모델을 바꾸면 각 프로젝트에서 재색인이 필요해요.</span>
        </div>
      </Card>

      <Card className="text-sm leading-relaxed text-slate-500">
        <b className="text-slate-700">권한 안내</b> — 이 설정은 사이트 관리자(최초 설정 계정)만 변경할 수 있어요.
        LLM 키는 비용과 직결되므로 팀원에게는 노출·수정 권한이 없습니다. 변경 즉시 서버 재시작 없이 적용됩니다.
      </Card>
    </div>
  );
}
