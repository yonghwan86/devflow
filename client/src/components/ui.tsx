import * as React from "react";
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from "lucide-react";

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
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-1";
  const sizes: Record<BtnSize, string> = { sm: "h-8 px-3 text-xs", md: "h-10 px-4 text-sm min-h-touch" };
  const variants: Record<BtnVariant, string> = {
    primary: "bg-brand text-white shadow-sm hover:bg-brand-700 hover:shadow-brand-glow",
    outline: "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:border-slate-300",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
    danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
    subtle: "bg-brand-50 text-brand hover:bg-brand-100",
  };
  return <button className={cx(base, sizes[size], variants[variant], className)} {...props} />;
}

export function IconButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-all duration-150 hover:bg-slate-100 hover:text-slate-700 active:scale-95",
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
          "w-full rounded-lg border border-slate-200 bg-white px-3 min-h-touch text-[15px] shadow-sm outline-none transition-all duration-150 placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-400 focus:ring-4 focus:ring-brand-50",
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
          "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[15px] shadow-sm outline-none transition-all duration-150 placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-400 focus:ring-4 focus:ring-brand-50",
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
        "w-full rounded-lg border border-slate-200 bg-white px-3 min-h-touch text-[15px] shadow-sm outline-none transition-all duration-150 hover:border-slate-300 focus:border-brand-400 focus:ring-4 focus:ring-brand-50",
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
  return <div className={cx("rounded-xl border border-slate-200/80 bg-white p-4 shadow-card", className)} {...props} />;
}

/* ---------------- PageHeader — 페이지 상단 패턴 통일 ---------------- */
export function PageHeader({ title, desc, actions, className }: { title: React.ReactNode; desc?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("mb-5 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
        {desc && <p className="mt-1 text-sm text-slate-500">{desc}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
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
      <div
        className={cx("h-full rounded-full transition-all duration-500", pct >= 100 ? "bg-emerald-500" : "bg-brand")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ---------------- Skeleton — 로딩 상태 ---------------- */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx("animate-pulse rounded-lg bg-slate-200/70", className)} />
  );
}
export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <Card className="space-y-2.5">
      <Skeleton className="h-4 w-2/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cx("h-3", i % 2 === 0 ? "w-full" : "w-4/5")} />
      ))}
    </Card>
  );
}
export function SkeletonList({ count = 3, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}

/* ---------------- EmptyState ---------------- */
export function EmptyState({ icon, title, desc, action }: { icon?: React.ReactNode; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="animate-fade-in flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-12 text-center">
      {icon && (
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-white text-brand shadow-card">
          {icon}
        </div>
      )}
      <div className="font-semibold text-slate-700">{title}</div>
      {desc && <div className="mt-1 max-w-xs text-sm leading-relaxed text-slate-400">{desc}</div>}
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
const TOAST_ICON: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={17} className="flex-shrink-0 text-emerald-500" />,
  error: <AlertCircle size={17} className="flex-shrink-0 text-red-500" />,
  info: <Info size={17} className="flex-shrink-0 text-brand-400" />,
};
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
            "animate-toast-in pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl border bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-floating",
            t.kind === "error" ? "border-red-100" : t.kind === "success" ? "border-emerald-100" : "border-slate-100",
          )}>
          {TOAST_ICON[t.kind]}
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="animate-slide-up sm:animate-scale-in w-full max-w-md rounded-t-2xl bg-white p-5 shadow-floating sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title && (
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="text-lg font-bold text-slate-900">{title}</div>
            <button onClick={onClose} className="-mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="닫기">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/* ---------------- ConfirmDialog — 브라우저 confirm() 대체 ---------------- */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "확인",
  cancelLabel = "취소",
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}) {
  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="animate-scale-in w-full max-w-sm rounded-2xl bg-white p-5 shadow-floating"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <div className={cx(
            "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full",
            tone === "danger" ? "bg-red-50 text-red-500" : "bg-brand-50 text-brand",
          )}>
            {tone === "danger" ? <AlertTriangle size={19} /> : <Info size={19} />}
          </div>
          <div className="min-w-0 pt-0.5">
            <div className="font-bold text-slate-900">{title}</div>
            {message && <div className="mt-1 text-sm leading-relaxed text-slate-500">{message}</div>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>{cancelLabel}</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} size="sm" onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* useConfirm — 명령형 confirm 대체 훅. const { confirm, dialog } = useConfirm(); JSX에 {dialog} 포함 */
export function useConfirm() {
  const [state, setState] = React.useState<{
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    tone?: "default" | "danger";
    resolve: (ok: boolean) => void;
  } | null>(null);

  const confirm = React.useCallback(
    (opts: { title: string; message?: React.ReactNode; confirmLabel?: string; tone?: "default" | "danger" }) =>
      new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );

  const dialog = state ? (
    <ConfirmDialog
      open
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      tone={state.tone}
      onClose={() => { state.resolve(false); setState(null); }}
      onConfirm={() => { state.resolve(true); setState(null); }}
    />
  ) : null;

  return { confirm, dialog };
}

/* ---------------- PromptDialog — 브라우저 prompt() 대체 ---------------- */
export function PromptDialog({
  open,
  onClose,
  onSubmit,
  title,
  placeholder,
  submitLabel = "확인",
  initialValue = "",
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
}) {
  const [value, setValue] = React.useState(initialValue);
  React.useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);
  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="animate-scale-in w-full max-w-sm rounded-2xl bg-white p-5 shadow-floating"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-3 font-bold text-slate-900">{title}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (!v) return;
            onSubmit(v);
            onClose();
          }}
        >
          <Input autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>취소</Button>
            <Button type="submit" size="sm">{submitLabel}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
