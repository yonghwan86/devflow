import { useState } from "react";
import { useForm } from "react-hook-form";
import { post } from "../lib/api";
import { Button, Input, Field } from "../components/ui";
import { queryClient } from "../lib/queryClient";

type Mode = "login" | "signup" | "invite" | "bootstrap";

function useInviteToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? (window.location.pathname.startsWith("/invite") ? "" : null);
}

export default function Login() {
  const inviteToken = useInviteToken();
  const [mode, setMode] = useState<Mode>(inviteToken !== null ? "invite" : "login");
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { isSubmitting } } = useForm();

  const onSubmit = async (v: any) => {
    setError(null);
    try {
      if (mode === "login") await post("/auth/login", { email: v.email, password: v.password });
      else if (mode === "signup") await post("/auth/signup", { email: v.email, password: v.password, full_name: v.full_name });
      else if (mode === "bootstrap") await post("/auth/bootstrap", { email: v.email, password: v.password, full_name: v.full_name });
      else await post("/auth/accept-invite", { token: v.token ?? inviteToken, password: v.password, full_name: v.full_name });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      window.location.href = "/";
    } catch (e: any) {
      setError(e.message ?? "오류가 발생했습니다.");
    }
  };

  const tabs: { id: Mode; label: string }[] = [
    { id: "login", label: "로그인" },
    { id: "signup", label: "가입" },
    { id: "invite", label: "초대 가입" },
    { id: "bootstrap", label: "최초 설정" },
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
          <div className="mb-5 grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1 text-sm">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => { setMode(t.id); setError(null); }}
                className={`rounded-lg py-2 transition ${mode === t.id ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500"}`}>
                {t.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
            {mode === "invite" && inviteToken === "" && (
              <Field label="초대 토큰"><Input placeholder="붙여넣기" {...register("token")} /></Field>
            )}
            {mode !== "login" && <Field label="이름"><Input placeholder="홍길동" {...register("full_name")} /></Field>}
            <Field label="이메일"><Input type="email" placeholder="you@company.com" {...register("email")} /></Field>
            <Field label="비밀번호"><Input type="password" placeholder="최소 8자" {...register("password")} /></Field>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
            <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
              {isSubmitting ? "처리 중…" : mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : mode === "invite" ? "초대로 가입하기" : "관리자 계정 생성"}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">
          <span className="font-medium text-slate-500">가입</span>: 누구나 — 검증 갤러리 열람·리뷰 가능 · <span className="font-medium text-slate-500">초대 가입</span>: 프로젝트 팀원<br />
          처음이라면 <span className="font-medium text-slate-500">"최초 설정"</span>으로 관리자를 만드세요.
        </p>
      </div>
    </div>
  );
}
