import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { get, post } from "../lib/api";
import { Button, Input, Field } from "../components/ui";
import { queryClient } from "../lib/queryClient";

type Mode = "login" | "signup" | "bootstrap";

function useInviteToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? (window.location.pathname.startsWith("/invite") ? "" : null);
}

export default function Login() {
  const inviteToken = useInviteToken();
  const isInvite = inviteToken !== null; // 초대 링크로 들어온 신규 사용자
  const [mode, setMode] = useState<Mode>("login");
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { isSubmitting } } = useForm();

  // 유저가 아무도 없을 때만 "최초 설정" 노출 (관리자 이미 있으면 숨김)
  useEffect(() => {
    if (isInvite) return;
    get<{ needs_bootstrap: boolean }>("/auth/bootstrap-status")
      .then((r) => setNeedsBootstrap(r.needs_bootstrap))
      .catch(() => {});
  }, [isInvite]);

  const onSubmit = async (v: any) => {
    setError(null);
    try {
      if (isInvite) {
        // 초대 링크: 계정 생성 + 비밀번호 설정 (이메일은 서버가 초대에서 가져옴)
        await post("/auth/accept-invite", { token: v.token ?? inviteToken, password: v.password, full_name: v.full_name });
      } else if (mode === "login") {
        await post("/auth/login", { email: v.email, password: v.password });
      } else if (mode === "signup") {
        await post("/auth/signup", { email: v.email, password: v.password, full_name: v.full_name });
      } else {
        await post("/auth/bootstrap", { email: v.email, password: v.password, full_name: v.full_name });
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      window.location.href = "/";
    } catch (e: any) {
      setError(e.message ?? "오류가 발생했습니다.");
    }
  };

  const tabs: { id: Mode; label: string }[] = [
    { id: "login", label: "로그인" },
    { id: "signup", label: "가입" },
    ...(needsBootstrap ? [{ id: "bootstrap" as Mode, label: "최초 설정" }] : []),
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-indigo-50 to-slate-50 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-black text-white shadow-lg shadow-indigo-200">D</div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">DevFlow</h1>
          <p className="text-sm text-slate-400">프로젝트 · 할일 · 가이드 · 노하우</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {isInvite ? (
            <div className="mb-4 rounded-xl bg-indigo-50 px-3 py-2.5 text-center text-sm font-medium text-brand">
              프로젝트 초대를 받았어요 — 계정을 만들어 합류하세요
            </div>
          ) : (
            <div className={`mb-5 grid gap-1 rounded-xl bg-slate-100 p-1 text-sm ${tabs.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {tabs.map((t) => (
                <button key={t.id} onClick={() => { setMode(t.id); setError(null); }}
                  className={`rounded-lg py-2 transition ${mode === t.id ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
            {isInvite && inviteToken === "" && (
              <Field label="초대 토큰"><Input placeholder="붙여넣기" {...register("token")} /></Field>
            )}
            {(isInvite || mode !== "login") && <Field label="이름"><Input placeholder="홍길동" {...register("full_name")} /></Field>}
            {!isInvite && <Field label="이메일"><Input type="email" placeholder="you@company.com" {...register("email")} /></Field>}
            <Field label="비밀번호"><Input type="password" placeholder="최소 8자" {...register("password")} /></Field>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
            <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
              {isSubmitting ? "처리 중…" : isInvite ? "가입하고 합류하기" : mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : "관리자 계정 생성"}
            </Button>
          </form>
        </div>

        {!isInvite && (
          <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">
            <span className="font-medium text-slate-500">로그인</span>: 이미 계정이 있으면 · <span className="font-medium text-slate-500">가입</span>: 누구나 (검증 갤러리 열람·리뷰)
            {needsBootstrap && <><br />처음이라면 <span className="font-medium text-slate-500">"최초 설정"</span>으로 관리자를 만드세요.</>}
          </p>
        )}
      </div>
    </div>
  );
}
