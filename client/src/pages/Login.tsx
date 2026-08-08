import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { get, post } from "../lib/api";
import { Button, Input, Field } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// forgot/forgot_done은 탭이 아니라 로그인 카드 안의 하위 화면 — 탭으로 올리면 "가입"과 같은 위계로 보인다.
type Mode = "login" | "signup" | "bootstrap" | "forgot" | "forgot_done";

function useInviteToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? (window.location.pathname.startsWith("/invite") ? "" : null);
}

export default function Login() {
  const inviteToken = useInviteToken();
  const isInvite = inviteToken !== null; // 초대 링크로 들어온 신규 사용자
  const [mode, setMode] = useState<Mode>("login");
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  // 메일이 꺼진 서버에서는 재설정 요청 폼을 띄우지 않는다 — 눌러도 아무 일이 안 일어나는 헛 동작이 된다.
  const [mailEnabled, setMailEnabled] = useState(false);
  // R0-1: 초대 이메일로 이미 가입된 계정(409 account_exists) → 토큰 유지한 채 로그인 폼 전환,
  // 로그인 성공 시 자동으로 accept-invite-session 호출.
  const [inviteExisting, setInviteExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 로컬 개발 모드(vite dev)에서만 시드 계정(scripts/dev-pglite.ts) 미리 입력 — 배포 빌드는 빈 칸.
  // 자동 로그인은 하지 않는다: 로그인 화면 자체를 확인·수정할 일이 있으므로 버튼은 직접 누른다.
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<Record<string, string>>({
    defaultValues: import.meta.env.DEV ? { email: "owner@devflow.local", password: "password123" } : {},
  });

  // 유저가 아무도 없을 때만 "최초 설정" 노출 (관리자 이미 있으면 숨김)
  useEffect(() => {
    if (isInvite) return;
    get<{ needs_bootstrap: boolean; mail_enabled: boolean }>("/auth/bootstrap-status")
      .then((r) => {
        setNeedsBootstrap(r.needs_bootstrap);
        setMailEnabled(r.mail_enabled);
      })
      .catch(() => {});
  }, [isInvite]);

  const onSubmit = async (v: any) => {
    setError(null);
    try {
      if (mode === "forgot") {
        // 응답은 계정 유무와 무관하게 항상 동일 — 화면 문구도 그에 맞춰 "가입돼 있다면"으로 쓴다.
        await post("/auth/forgot-password", { email: v.email });
        setMode("forgot_done");
        return;
      }
      if (isInvite && inviteExisting) {
        // 기존 계정 보유자: 로그인 → 같은 토큰으로 초대 수락(비번 재설정 없음)
        await post("/auth/login", { email: v.email, password: v.password });
        const r = await post<{ project_id: number | null }>("/auth/accept-invite-session", { token: v.token ?? inviteToken });
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        window.location.href = r.project_id ? `/projects/${r.project_id}` : "/";
        return;
      }
      if (isInvite) {
        // 초대 링크: 계정 생성 + 비밀번호 설정 (이메일은 서버가 초대에서 가져옴)
        try {
          await post("/auth/accept-invite", { token: v.token ?? inviteToken, password: v.password, full_name: v.full_name });
        } catch (e: any) {
          if (e?.code === "account_exists") {
            setInviteExisting(true);
            setError(e.message);
            return;
          }
          throw e;
        }
      } else if (mode === "login") {
        await post("/auth/login", { email: v.email, password: v.password });
      } else if (mode === "signup") {
        await post("/auth/signup", { email: v.email, password: v.password, full_name: v.full_name });
      } else {
        await post("/auth/bootstrap", { email: v.email, password: v.password, full_name: v.full_name });
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      // 공유 대상(/share)처럼 로그인 전 진입한 경로는 로그인 후 그대로 복귀 — 안 그러면 스테이징된 공유가 증발
      const here = window.location.pathname;
      window.location.href = here === "/share" ? "/share" : "/";
    } catch (e: any) {
      setError(e.message ?? "오류가 발생했습니다.");
    }
  };

  const tabs: { id: Mode; label: string }[] = [
    { id: "login", label: "로그인" },
    { id: "signup", label: "가입" },
    ...(needsBootstrap ? [{ id: "bootstrap" as Mode, label: "최초 설정" }] : []),
  ];

  const isForgot = mode === "forgot" || mode === "forgot_done";
  const backToLogin = () => { setMode("login"); setError(null); };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-brand-50 via-white to-slate-50 p-4">
      {/* 은은한 배경 장식 */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-brand-100/50 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-[-8rem] h-80 w-80 rounded-full bg-sky-100/60 blur-3xl" />
      <div className="animate-fade-in-up relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-2.5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-2xl font-black text-white shadow-brand-glow">D</div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">DevFlow</h1>
          <p className="text-sm text-slate-400">프로젝트 · 할일 · 가이드 · 노하우</p>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-floating backdrop-blur">
          {isInvite ? (
            <div className="mb-4 rounded-xl bg-indigo-50 px-3 py-2.5 text-center text-sm font-medium text-brand">
              {inviteExisting ? "이미 계정이 있어요 — 로그인하면 초대를 수락합니다" : "프로젝트 초대를 받았어요 — 계정을 만들어 합류하세요"}
            </div>
          ) : isForgot ? (
            <button type="button" onClick={backToLogin} className="mb-3 text-xs text-slate-500 transition hover:text-slate-700">
              ← 로그인으로
            </button>
          ) : (
            <div className={`mb-5 grid gap-1 rounded-xl bg-slate-100 p-1 text-sm ${tabs.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {tabs.map((t) => (
                <button key={t.id} onClick={() => { setMode(t.id); setError(null); }}
                  className={`rounded-lg py-2 transition-all duration-150 ${mode === t.id ? "bg-white font-semibold text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {mode === "forgot_done" ? (
            <div className="animate-fade-in">
              <p className="mb-1 text-[15px] font-bold text-slate-900">요청이 접수되었습니다</p>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] leading-relaxed text-emerald-700">
                <b>해당 이메일로 가입된 계정이 있다면</b> 재설정 링크를 보내드렸습니다. 메일함(스팸함 포함)을 확인해 주세요.
                <br />
                <span className="text-slate-500">링크는 2시간 뒤 만료되고 1회만 사용할 수 있어요.</span>
              </div>
              <Button variant="outline" className="mt-3 w-full" onClick={backToLogin}>확인</Button>
            </div>
          ) : (
            <form key={mode} onSubmit={handleSubmit(onSubmit)} className="animate-fade-in flex flex-col gap-3">
              {mode === "forgot" && (
                <div className="-mb-1">
                  <p className="mb-1 text-[15px] font-bold text-slate-900">비밀번호 재설정</p>
                  <p className="text-[12.5px] leading-relaxed text-slate-500">
                    {mailEnabled
                      ? "가입한 이메일을 입력하면 재설정 링크를 보내드립니다. 링크는 2시간 뒤 만료돼요."
                      : "이 서버는 메일 발송이 꺼져 있어요. 팀 관리자에게 요청하면 재설정 링크를 만들어 전달해 드립니다."}
                  </p>
                </div>
              )}
              {isInvite && inviteToken === "" && (
                <Field label="초대 토큰"><Input placeholder="붙여넣기" {...register("token")} /></Field>
              )}
              {((isInvite && !inviteExisting) || (!isInvite && mode !== "login" && !isForgot)) && <Field label="이름"><Input placeholder="홍길동" {...register("full_name")} /></Field>}
              {(!isInvite || inviteExisting) && (mode !== "forgot" || mailEnabled) && <Field label="이메일"><Input type="email" placeholder="you@company.com" autoComplete="email" {...register("email")} /></Field>}
              {mode !== "forgot" && <Field label="비밀번호"><Input type="password" placeholder="최소 8자" autoComplete={mode === "login" ? "current-password" : "new-password"} {...register("password")} /></Field>}
              {/* !isInvite 필수 — 초대 링크로 들어온 신규 가입자에게는 '잊은 비밀번호'가 없고,
                  그 화면에선 mailEnabled 조회도 건너뛰어(위 useEffect) 거짓 안내와 고아 필드만 남는다 */}
              {mode === "login" && !isInvite && (
                <div className="-mt-1 flex justify-end">
                  <button type="button" onClick={() => { setMode("forgot"); setError(null); }}
                    className="text-[11.5px] text-slate-500 underline underline-offset-2 transition hover:text-brand">
                    비밀번호를 잊으셨나요?
                  </button>
                </div>
              )}
              {error && <div className="animate-fade-in rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
              {/* 메일이 꺼져 있으면 제출 버튼을 두지 않는다 — 눌러도 아무 일이 없는 버튼은 안 만든다 */}
              {mode === "forgot" && !mailEnabled ? (
                // type="button" 필수 — 공용 Button은 type을 지정하지 않아 폼 안에서는 submit으로 동작한다.
                // (없으면 "돌아가기"가 폼을 제출해 요청 접수 화면으로 튄다)
                <Button type="button" variant="outline" className="mt-1 w-full" onClick={backToLogin}>로그인으로 돌아가기</Button>
              ) : (
                <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
                  {isSubmitting ? "처리 중…" : isInvite ? (inviteExisting ? "로그인하고 합류하기" : "가입하고 합류하기") : mode === "login" ? "로그인" : mode === "signup" ? "가입하기" : mode === "forgot" ? "재설정 요청하기" : "관리자 계정 생성"}
                </Button>
              )}
            </form>
          )}
        </div>

        {!isInvite && !isForgot && (
          <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">
            <span className="font-medium text-slate-500">로그인</span>: 이미 계정이 있으면 · <span className="font-medium text-slate-500">가입</span>: 누구나 (검증 갤러리 열람·리뷰)
            {needsBootstrap && <><br />처음이라면 <span className="font-medium text-slate-500">"최초 설정"</span>으로 관리자를 만드세요.</>}
          </p>
        )}
      </div>
    </div>
  );
}
