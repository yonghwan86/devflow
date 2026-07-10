import { Link, useLocation } from "wouter";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Home, FolderKanban, BookMarked, LogOut, LayoutDashboard, Sparkles, Store, ShieldCheck, Settings as SettingsIcon } from "lucide-react";
import { Avatar, ToastHost, cx } from "./ui";
import { MiniCalendar } from "./MiniCalendar";
import { useAuth } from "../hooks/useAuth";
import { post } from "../lib/api";
import { getActiveProject, subscribeActiveProject } from "../lib/activeProject";

async function logout() {
  await post("/auth/logout").catch(() => {});
  window.location.href = "/";
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { user } = useAuth();
  const active = useSyncExternalStore(subscribeActiveProject, getActiveProject); // 마지막으로 연 프로젝트 — 전환·이름 변경 즉시 반영

  const workspaceTabs = [
    ...(active ? [{ href: `/projects/${active.id}`, label: active.name, short: active.key, icon: LayoutDashboard }] : []),
    { href: "/my-work", label: "My Work", short: "My Work", icon: Home },
    { href: "/projects", label: "프로젝트", short: "프로젝트", icon: FolderKanban },
  ];
  const libraryTabs = [
    { href: "/ai", label: "AI 검색", short: "AI", icon: Sparkles },
    { href: "/skills", label: "스킬", short: "스킬", icon: BookMarked },
    { href: "/gallery", label: "갤러리", short: "갤러리", icon: Store },
    ...(user?.is_admin ? [{ href: "/admin", label: "관리자", short: "관리", icon: ShieldCheck }] : []),
  ];
  const tabs = [...workspaceTabs, ...libraryTabs];
  // "/projects"는 정확히 목록일 때만 활성 (프로젝트 보드와 구분)
  const isActive = (href: string) =>
    href === "/projects" ? loc === "/projects" : loc === href || loc.startsWith(href + "/");

  const NavItem = ({ t }: { t: (typeof tabs)[number] }) => {
    const Icon = t.icon;
    const on = isActive(t.href);
    return (
      <Link
        href={t.href}
        className={cx(
          "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
          on ? "bg-brand-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
        )}
      >
        {on && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" />}
        <Icon size={18} strokeWidth={on ? 2.3 : 2} className="flex-shrink-0 transition-transform duration-150 group-hover:scale-105" />
        <span className="truncate">{t.label}</span>
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen bg-[#f7f8fa]">
      <ToastHost />
      {/* Desktop sidebar — C10: 본문이 길어도 미니 달력·설정·로그아웃이 항상 보이게
          화면 높이에 고정(sticky+h-screen)하고, 길어질 수 있는 건 메뉴 영역만 내부 스크롤 */}
      <aside className="hidden w-60 flex-col border-r border-slate-200/80 bg-white md:sticky md:top-0 md:flex md:h-screen">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-black text-white shadow-sm">D</div>
          <span className="text-lg font-bold tracking-tight text-slate-900">DevFlow</span>
        </div>
        <nav className="flex flex-1 flex-col overflow-y-auto px-3">
          <div className="flex flex-col gap-0.5">
            {workspaceTabs.map((t) => <NavItem key={t.href} t={t} />)}
          </div>
          <div className="mt-4 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">라이브러리</div>
          <div className="flex flex-col gap-0.5">
            {libraryTabs.map((t) => <NavItem key={t.href} t={t} />)}
          </div>
        </nav>
        <MiniCalendar />
        {user && (
          <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-3">
            <Avatar name={user.full_name ?? user.email} id={user.id} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-700">{user.full_name ?? "사용자"}</div>
              <div className="truncate text-xs text-slate-400">{user.email}</div>
            </div>
            <Link href="/settings" title="설정 · API 토큰"
              className={cx("rounded-lg p-2 transition hover:bg-slate-100 hover:text-slate-600", isActive("/settings") ? "text-brand" : "text-slate-400")}>
              <SettingsIcon size={16} />
            </Link>
            <button onClick={logout} title="로그아웃" className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
              <LogOut size={16} />
            </button>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 py-3 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-black text-white">D</div>
            <span className="font-bold text-slate-900">DevFlow</span>
          </div>
          {user && (
            <div className="flex items-center gap-1">
              <Link href="/settings" className={cx("rounded-lg p-2 transition hover:bg-slate-100", isActive("/settings") ? "text-brand" : "text-slate-500")} aria-label="설정"><SettingsIcon size={18} /></Link>
              <button onClick={logout} className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100" aria-label="로그아웃"><LogOut size={18} /></button>
            </div>
          )}
        </header>

        <main className="page-enter mx-auto w-full max-w-screen-2xl flex-1 px-4 py-5 pb-safe md:px-8 md:pb-8">{children}</main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200/80 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = isActive(t.href);
          return (
            <Link key={t.href} href={t.href}
              className={cx(
                "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 min-h-touch py-2 text-[11px] transition-colors duration-150 active:bg-slate-50",
                on ? "text-brand font-semibold" : "text-slate-500",
              )}>
              <span className={cx("flex h-7 w-11 items-center justify-center rounded-full transition-colors duration-150", on && "bg-brand-50")}>
                <Icon size={20} strokeWidth={on ? 2.4 : 2} />
              </span>
              <span className="w-full truncate px-1 text-center">{t.short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
