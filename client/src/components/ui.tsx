import * as React from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------------- Button ---------------- */
type BtnVariant = "primary" | "outline" | "ghost" | "danger" | "subtle";
type BtnSize = "sm" | "md";
export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap";
  const sizes: Record<BtnSize, string> = { sm: "h-8 px-3 text-xs", md: "h-10 px-4 text-sm min-h-touch" };
  const variants: Record<BtnVariant, string> = {
    primary: "bg-brand text-white hover:bg-indigo-700 shadow-sm",
    outline: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300",
    ghost: "text-slate-600 hover:bg-slate-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
    subtle: "bg-indigo-50 text-brand hover:bg-indigo-100",
  };
  return <button className={cx(base, sizes[size], variants[variant], className)} {...props} />;
}

export function IconButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 active:scale-95",
        className,
      )}
      {...props}
    />
  );
}

/* ---------------- Inputs ---------------- */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return (
      <input
        ref={ref}
        {...props}
        className={cx(
          "w-full rounded-lg border border-slate-200 bg-white px-3 min-h-touch text-[15px] outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-indigo-50",
          props.className,
        )}
      />
    );
  },
);
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea(props, ref) {
    return (
      <textarea
        ref={ref}
        {...props}
        className={cx(
          "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[15px] outline-none transition placeholder:text-slate-400 focus:border-brand focus:ring-4 focus:ring-indigo-50",
          props.className,
        )}
      />
    );
  },
);
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "w-full rounded-lg border border-slate-200 bg-white px-3 min-h-touch text-[15px] outline-none focus:border-brand focus:ring-4 focus:ring-indigo-50",
        className,
      )}
    />
  );
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

/* ---------------- Card ---------------- */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)]", className)} {...props} />;
}

/* ---------------- Badge ---------------- */
export function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

/* ---------------- Avatar ---------------- */
const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700", "bg-orange-100 text-orange-700", "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700", "bg-teal-100 text-teal-700", "bg-sky-100 text-sky-700",
  "bg-indigo-100 text-indigo-700", "bg-violet-100 text-violet-700", "bg-fuchsia-100 text-fuchsia-700",
];
export function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
// 이니셜 규칙: 한글 이름(성+이름)은 이름 부분(뒤 2자) — "이유빈"→"유빈". 영문은 단어 첫 글자 조합.
function initialsOf(name: string): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  if (/[가-힣]/.test(n)) {
    const solid = n.replace(/\s+/g, "");
    return solid.length >= 3 ? solid.slice(-2) : solid;
  }
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = initialsOf(name);
  return (
    <span
      className={cx("inline-flex items-center justify-center rounded-full font-semibold", avatarColor(name))}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      title={name}
    >
      {initials}
    </span>
  );
}
export function AvatarGroup({ names, size = 24 }: { names: string[]; size?: number }) {
  const shown = names.slice(0, 4);
  return (
    <div className="flex -space-x-1.5">
      {shown.map((n, i) => (
        <span key={i} className="rounded-full ring-2 ring-white">
          <Avatar name={n} size={size} />
        </span>
      ))}
      {names.length > 4 && (
        <span className="inline-flex items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500 ring-2 ring-white" style={{ width: size, height: size }}>
          +{names.length - 4}
        </span>
      )}
    </div>
  );
}

/* ---------------- ProgressBar ---------------- */
export function ProgressBar({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-slate-100", className)}>
      <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({ icon, title, desc, action }: { icon?: React.ReactNode; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-12 text-center">
      {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white text-brand shadow-sm">{icon}</div>}
      <div className="font-semibold text-slate-700">{title}</div>
      {desc && <div className="mt-1 max-w-xs text-sm text-slate-400">{desc}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand" />;
}

/* ---------------- Toast (alert 대체 — 상태 피드백용 마이크로 인터랙션) ---------------- */
type ToastKind = "info" | "success" | "error";
export function toast(message: string, kind?: ToastKind) {
  const k: ToastKind = kind ?? (/실패|오류|없습니다|불가|금지/.test(message) ? "error" : "info");
  window.dispatchEvent(new CustomEvent("devflow:toast", { detail: { message, kind: k } }));
}
export function ToastHost() {
  const [items, setItems] = React.useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  React.useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { message: string; kind: ToastKind };
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-3), { id, ...d }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3800);
    };
    window.addEventListener("devflow:toast", on);
    return () => window.removeEventListener("devflow:toast", on);
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div key={t.id}
          className={cx(
            "animate-toast-in pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg",
            t.kind === "error" ? "bg-red-600" : t.kind === "success" ? "bg-emerald-600" : "bg-slate-800",
          )}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {title && <div className="mb-3 text-lg font-bold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
