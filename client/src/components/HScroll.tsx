import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { cx } from "./ui";

// 가로 스크롤 어포던스 — 좌우 가장자리에 맨 ‹ › 글리프.
// 클릭 = 보이는 폭의 80%씩 부드럽게, 꾹 누르면(350ms~) 연속 이동. hover 즉시 스크롤은 의도적으로 없음.
// 그 방향으로 실제 더 스크롤할 수 있을 때만 표시 — 다 들어오는 화면에선 아무것도 안 보인다.
// 컨테이너가 화면보다 길어도 화살표는 "보이는 영역"의 세로 중앙을 따라온다 (주간 뷰처럼 긴 표 대응).
export function HScroll({ children, className, wrapClassName, size = "md", fade, scrollRef }: {
  children: ReactNode;
  className?: string; // 스크롤 컨테이너 클래스 (overflow-x-auto는 여기서 붙임)
  wrapClassName?: string; // 화살표 위치 기준이 되는 바깥 래퍼 클래스
  size?: "sm" | "md"; // sm: 탭바 같은 낮은 줄
  fade?: boolean; // 낮은 줄용 — 잘린 쪽 가장자리를 흰색으로 페이드
  scrollRef?: RefObject<HTMLDivElement>; // 외부에서 스크롤 제어가 필요할 때 (타임라인 오늘/월 이동)
}) {
  const internal = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? internal;
  const [st, setSt] = useState({ left: false, right: false, top: 0 });
  const held = useRef(false);
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const r = el.getBoundingClientRect();
      const visTop = Math.max(0, -r.top);
      const visBottom = Math.min(r.height, window.innerHeight - r.top);
      const top = visBottom > visTop ? (visTop + visBottom) / 2 : r.height / 2;
      setSt({ left: el.scrollLeft > 2, right: el.scrollLeft < max - 2, top });
    };
    update();
    const ro = new ResizeObserver(update); // 필터로 열 수가 바뀌어도 즉시 갱신
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const from = el.scrollLeft;
    const delta = dir * el.clientWidth * 0.8;
    el.scrollBy({ left: delta, behavior: "smooth" });
    // 일부 임베디드 웹뷰가 smooth를 조용히 무시함 — 이동이 없으면 즉시 이동으로 폴백
    window.setTimeout(() => { if (Math.abs(el.scrollLeft - from) < 1) el.scrollLeft = from + delta; }, 120);
  };
  const startHold = (dir: 1 | -1) => {
    held.current = false;
    timer.current = window.setTimeout(() => {
      held.current = true;
      const tick = () => { ref.current?.scrollBy({ left: dir * 14 }); raf.current = requestAnimationFrame(tick); };
      tick();
    }, 350);
  };
  const endHold = () => {
    if (timer.current != null) { clearTimeout(timer.current); timer.current = null; }
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
  };
  useEffect(() => endHold, []);

  const arrow = (dir: 1 | -1) => (
    <button type="button" aria-label={dir < 0 ? "왼쪽으로 이동" : "오른쪽으로 이동"}
      // 꾹 눌러 연속 이동한 뒤 손을 떼면 click이 한 번 더 오므로 그때는 페이지 점프를 건너뜀
      onClick={() => { if (held.current) { held.current = false; return; } step(dir); }}
      onPointerDown={() => startHold(dir)} onPointerUp={endHold} onPointerLeave={endHold}
      style={{ top: st.top }}
      className={cx(
        "absolute z-20 -translate-y-1/2 select-none px-1 font-semibold leading-none text-slate-500/50 transition-colors hover:text-slate-700",
        size === "sm" ? "text-2xl" : "text-5xl",
        dir < 0 ? "left-0.5" : "right-1",
      )}>
      {dir < 0 ? "‹" : "›"}
    </button>
  );

  return (
    <div className={cx("relative", wrapClassName)}>
      <div ref={ref} className={cx("overflow-x-auto", className)}>{children}</div>
      {fade && st.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-l from-transparent to-white" />}
      {fade && st.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-r from-transparent to-white" />}
      {st.left && arrow(-1)}
      {st.right && arrow(1)}
    </div>
  );
}
