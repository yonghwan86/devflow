import { Link, useLocation } from "wouter";
import type { ReactNode } from "react";
import { Home, FolderKanban, BookMarked, LogOut, LayoutDashboard, Sparkles, Store, ShieldCheck } from "lucide-react";
import { Avatar, ToastHost } from "./ui";
import { MiniCalendar } from "./MiniCalendar";
import { useAuth } from "../hooks/useAuth";
import { post } from "../lib/api";
import { getActiveProject } from "../lib/activeProject";

async function logout() {
  await post("/auth/logout").catch(() => {});
  window.location.href = "/";
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { user } = useAuth();
  const active = getActiveProject(); // 마지막으로 연 프로젝트 → 사이드바/탭에 고정

  const tabs = [
    ...(active ? [{ href: `/projects/${active.id}`, label: active.name, short: active.key, icon: LayoutDashboard }] : []),
    { href: "/my-work", label: "My Work", short: "My Work", icon: Home },
    { href: "/projects", label: "프로젝트", short: "프로젝트", icon: FolderKanban },
    { href: "/ai", label: "AI 검색", short: "AI", icon: Sparkles },
    { href: "/skills", label: "스킬", short: "스킬", icon: BookMarked },
    { href: "/gallery", label: "갤러리", short: "갤러리", icon: Store },
    ...(user?.is_admin ? [{ href: "/admin", label: "관리자", short: "관리", icon: ShieldCheck }] : []),
  ];
  // "/projects"는 정확히 목록일 때만 활성 (프로젝트 보드와 구분)
  const isActive = (href: string) =>
    href === "/projects" ? loc === "/projects" : loc === href || loc.startsWith(href + "/");

  return (
    <div className="flex min-h-screen bg-slate-50">
      <ToastHost />
      {/* Desktop sidebar */}
      <aside className="hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-black text-white">D</div>
          <span className="text-lg font-bold tracking-tight text-slate-800">DevFlow</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <Link key={t.href} href={t.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${isActive(t.href) ? "bg-indigo-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-100"}`}>
                <Icon size={18} strokeWidth={2} className="flex-shrink-0" />
                <span className="truncate">{t.label}</span>
              </Link>
            );
          })}
        </nav>
        <MiniCalendar />
        {user && (
          <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-3">
            <Avatar name={user.full_name ?? user.email} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-700">{user.full_name ?? "사용자"}</div>
              <div className="truncate text-xs text-slate-400">{user.email}</div>
            </div>
            <button onClick={logout} title="로그아웃" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <LogOut size={16} />
            </button>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-xs font-black text-white">D</div>
            <span className="font-bold text-slate-800">DevFlow</span>
          </div>
          {user && <button onClick={logout} className="text-slate-400"><LogOut size={18} /></button>}
        </header>

        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-5 pb-safe md:px-8 md:pb-8">{children}</main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 backdrop-blur md:hidden">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <Link key={t.href} href={t.href}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 min-h-touch py-2 text-[11px] ${isActive(t.href) ? "text-brand font-semibold" : "text-slate-500"}`}>
              <Icon size={20} strokeWidth={isActive(t.href) ? 2.4 : 2} />
              <span className="w-full truncate px-1 text-center">{t.short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
