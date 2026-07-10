import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, FileText, NotebookPen, MonitorPlay, Users } from "lucide-react";
import { get } from "../lib/api";
import { cx } from "./ui";
import { HScroll } from "./HScroll";

export type ProjectSection = "board" | "pages" | "meetings" | "preview" | "members";

// C12: 프로젝트 하위 화면 공용 탭 바 — 어느 화면에서든 보드·문서·회의록·프리뷰·팀원으로 한 번에 이동.
// ("보드로 돌아가서 다시 들어가는" 왕복 제거. current 미지정 = 태스크 상세 같은 하위 진입 화면)
export function ProjectNav({ pid, current }: { pid: number; current?: ProjectSection }) {
  // 팀원 수 배지 — 각 화면이 이미 쓰는 ["members", pid] 캐시를 공유
  const membersQ = useQuery<{ members: any[] }>({
    queryKey: ["members", pid],
    queryFn: () => get(`/projects/${pid}/members`),
    enabled: Number.isFinite(pid),
  });
  const memberCount = membersQ.data?.members?.length ?? 0;

  const tabs: { id: ProjectSection; href: string; label: string; icon: any; badge?: number }[] = [
    { id: "board", href: `/projects/${pid}`, label: "보드", icon: LayoutDashboard },
    { id: "pages", href: `/projects/${pid}/pages`, label: "문서", icon: FileText },
    { id: "meetings", href: `/projects/${pid}/meetings`, label: "회의록", icon: NotebookPen },
    { id: "preview", href: `/projects/${pid}/preview`, label: "프리뷰", icon: MonitorPlay },
    { id: "members", href: `/projects/${pid}/members`, label: "팀원", icon: Users, badge: memberCount || undefined },
  ];

  return (
    // 모바일에서 탭이 잘릴 때 희미한 ‹ › + 가장자리 페이드로 "옆으로 더 있음"을 표시 (HScroll)
    <HScroll size="sm" fade wrapClassName="w-full max-w-full rounded-xl border border-slate-200 bg-white shadow-sm sm:w-fit"
      className="rounded-xl">
      <nav aria-label="프로젝트 메뉴" className="flex w-max items-center gap-1 p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = t.id === current;
          return (
            <Link key={t.id} href={t.href} aria-current={on ? "page" : undefined}
              className={cx(
                "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition",
                on ? "bg-brand-50 font-semibold text-brand" : "text-slate-600 hover:bg-slate-50 hover:text-slate-800",
              )}>
              <Icon size={15} /> {t.label}
              {t.badge != null && <span className={cx("text-[11px]", on ? "text-brand/70" : "text-slate-400")}>{t.badge}</span>}
            </Link>
          );
        })}
      </nav>
    </HScroll>
  );
}
