import { useEffect } from "react";

export type ToastTone = "info" | "success" | "warn";

export type ToastItem = {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
};

type ToastStackProps = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  autoDismissMs?: number;
};

export function ToastStack({
  toasts,
  onDismiss,
  autoDismissMs = 2800,
}: ToastStackProps) {
  useEffect(() => {
    if (!toasts.length) {
      return;
    }

    const timers = toasts.map((toast) =>
      window.setTimeout(() => onDismiss(toast.id), autoDismissMs)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [toasts, onDismiss, autoDismissMs]);

  if (!toasts.length) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-70 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => {
        const toneClass =
          toast.tone === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : toast.tone === "warn"
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-slate-200 bg-white text-slate-900";

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-xl border px-3 py-2 shadow-sm ${toneClass}`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold leading-5">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-xs opacity-80">{toast.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="rounded p-0.5 text-xs opacity-70 transition hover:opacity-100"
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
