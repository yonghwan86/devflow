import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { post } from "../lib/api";
import { Card, Button, Spinner } from "../components/ui";
import { queryClient } from "../lib/queryClient";

// 이미 로그인한 사용자가 초대 링크(/invite?token=...)를 열었을 때의 합류 화면.
// (로그인 안 한 경우엔 App이 Login을 렌더 → 초대 탭으로 처리)
export default function InviteAccept() {
  const [, navigate] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [state, setState] = useState<"idle" | "joining" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const join = async () => {
    setState("joining");
    try {
      const r = await post<{ project_id: number | null }>("/auth/accept-invite-session", { token });
      await queryClient.invalidateQueries();
      setState("done");
      setTimeout(() => navigate(r.project_id ? `/projects/${r.project_id}` : "/", { replace: true }), 700);
    } catch (e: any) {
      setState("error");
      setMessage(e.message ?? "초대를 수락할 수 없습니다.");
    }
  };

  useEffect(() => {
    if (!token) { setState("error"); setMessage("초대 토큰이 없습니다."); }
  }, [token]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="flex w-full max-w-md flex-col items-center gap-4 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-black text-white">D</div>
        {state === "done" ? (
          <>
            <h1 className="text-lg font-bold text-slate-800">프로젝트에 합류했어요 🎉</h1>
            <p className="text-sm text-slate-500">잠시 후 프로젝트로 이동합니다…</p>
            <Spinner />
          </>
        ) : state === "error" ? (
          <>
            <h1 className="text-lg font-bold text-slate-800">초대를 수락하지 못했어요</h1>
            <p className="text-sm text-slate-500">{message}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate("/", { replace: true })}>홈으로</Button>
              <Button onClick={() => { post("/auth/logout").finally(() => { window.location.href = `/invite?token=${token}`; }); }}>
                다른 계정으로 가입
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold text-slate-800">프로젝트 초대</h1>
            <p className="text-sm text-slate-500">초대를 수락하면 이 프로젝트의 팀원으로 합류합니다.</p>
            <Button className="w-full" onClick={join} disabled={state === "joining"}>
              {state === "joining" ? "합류 중…" : "초대 수락하고 합류하기"}
            </Button>
            <button className="text-xs text-slate-400 hover:text-brand" onClick={() => navigate("/", { replace: true })}>
              나중에 하기
            </button>
          </>
        )}
      </Card>
    </div>
  );
}
