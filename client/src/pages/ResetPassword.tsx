import { useState } from "react";
import { useForm } from "react-hook-form";
import { post } from "../lib/api";
import { Button, Input, Field } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// 재설정 링크(/reset?token=...) 진입 화면. 초대 수락(/invite?token=...)과 같은 규약.
// 로그인 여부와 무관하게 열려야 하므로 App의 인증 분기보다 앞에서 렌더된다.
export default function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<{ password: string; confirm: string }>();

  const onSubmit = async (v: { password: string; confirm: string }) => {
    setError(null);
    if (v.password !== v.confirm) {
      setError("두 비밀번호가 서로 다릅니다.");
      return;
    }
    try {
      await post("/auth/reset-password", { token, password: v.password });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      // 서버가 재설정과 동시에 로그인시켜 준다 — 바로 홈으로.
      window.location.href = "/";
    } catch (e: any) {
      setError(e.message ?? "오류가 발생했습니다.");
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-brand-50 via-white to-slate-50 p-4">
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-brand-100/50 blur-3xl" />
      <div className="animate-fade-in-up relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-2.5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-2xl font-black text-white shadow-brand-glow">D</div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">DevFlow</h1>
          <p className="text-sm text-slate-400">프로젝트 · 할일 · 가이드 · 노하우</p>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-floating backdrop-blur">
          {!token ? (
            <>
              <p className="mb-1 text-[15px] font-bold text-slate-900">링크가 유효하지 않습니다</p>
              <p className="mb-4 text-[12.5px] leading-relaxed text-slate-500">
                재설정 토큰이 없습니다. 메일의 링크를 주소창에 그대로 붙여넣었는지 확인해 주세요.
              </p>
              <Button variant="outline" className="w-full" onClick={() => (window.location.href = "/")}>
                로그인으로 돌아가기
              </Button>
            </>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="animate-fade-in flex flex-col gap-3">
              <div className="-mb-1">
                <p className="mb-1 text-[15px] font-bold text-slate-900">새 비밀번호 설정</p>
                <p className="text-[12.5px] leading-relaxed text-slate-500">
                  설정하면 바로 로그인되고, <b>다른 기기의 로그인은 모두 해제</b>됩니다.
                </p>
              </div>
              <Field label="새 비밀번호">
                <Input type="password" placeholder="최소 8자" autoComplete="new-password" {...register("password")} />
              </Field>
              <Field label="새 비밀번호 확인">
                <Input type="password" placeholder="한 번 더 입력" autoComplete="new-password" {...register("confirm")} />
              </Field>
              {error && (
                <div className="animate-fade-in rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                  {error}
                  <br />
                  <button type="button" onClick={() => (window.location.href = "/")} className="mt-1 underline underline-offset-2">
                    로그인 화면으로
                  </button>
                </div>
              )}
              <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
                {isSubmitting ? "처리 중…" : "비밀번호 설정하고 로그인"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
