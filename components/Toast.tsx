"use client";

import { useEffect } from "react";

export interface ToastMessage {
  /** Changes for every toast so a new message restarts the dismiss timer. */
  id: number;
  kind: "success" | "error";
  message: string;
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
}

/** Small confirmation toast, bottom-right. Auto-dismisses; errors stay longer. */
export default function Toast({ toast, onDismiss }: Props) {
  const id = toast?.id;
  const kind = toast?.kind;

  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(onDismiss, kind === "error" ? 10_000 : 6_000);
    return () => clearTimeout(timer);
  }, [id, kind, onDismiss]);

  if (!toast) return null;
  const isError = toast.kind === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      className={`fixed bottom-4 right-4 z-[200] flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg print:hidden ${
        isError
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-900"
      }`}
    >
      <svg
        viewBox="0 0 20 20"
        className={`mt-0.5 size-4 shrink-0 ${isError ? "text-red-500" : "text-emerald-600"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {isError ? <path d="M10 6v5M10 14.5v.01" /> : <path d="M4 10.5l4 4 8-9" />}
      </svg>
      <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
