"use client";

import { useLayoutEffect, useRef } from "react";

const SYMBOLS = ["→", "⇌", "°C", "±", "µ", "Δ", "×", "≈", "°"];

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
};

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  /** Optional extra controls rendered on the right of the header (screen only). */
  headerExtra?: React.ReactNode;
}

/**
 * Auto-expanding textarea with a small chemistry toolbar (symbols and
 * sub/superscripts). On screen it is a real textarea; when printing, a plain
 * text mirror is shown instead so long text can never be clipped, and empty
 * sections are dropped from the printout.
 */
export default function RichTextarea({
  label,
  value,
  onChange,
  placeholder,
  minRows = 4,
  headerExtra,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content...
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // ...and re-fit when the width changes (window resize, sidebar toggle).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function replaceRange(start: number, end: number, text: string) {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setRangeText(text, start, end, "end");
    onChange(el.value);
  }

  function insertSymbol(symbol: string) {
    const el = ref.current;
    if (!el) return;
    replaceRange(el.selectionStart, el.selectionEnd, symbol);
  }

  /** Convert the selection (or the character before the caret) to sub/superscript. */
  function transform(map: Record<string, string>) {
    const el = ref.current;
    if (!el) return;
    let start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) {
      if (start === 0) return;
      start -= 1;
    }
    const converted = Array.from(el.value.slice(start, end))
      .map((ch) => map[ch] ?? ch)
      .join("");
    replaceRange(start, end, converted);
  }

  const isEmpty = value.trim() === "";

  return (
    <section className={`group ${isEmpty ? "print:hidden" : ""}`}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 print:mb-0.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </h3>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <div
            className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100"
            onMouseDown={(e) => e.preventDefault()} // keep the caret/selection in the textarea
          >
            <ToolButton title="Subscript (selection or previous character)" onClick={() => transform(SUBSCRIPT)}>
              x<sub>2</sub>
            </ToolButton>
            <ToolButton title="Superscript (selection or previous character)" onClick={() => transform(SUPERSCRIPT)}>
              x<sup>2</sup>
            </ToolButton>
            <span className="mx-1 h-3 w-px bg-zinc-200" />
            {SYMBOLS.map((s) => (
              <ToolButton key={s} title={`Insert ${s}`} onClick={() => insertSymbol(s)}>
                {s}
              </ToolButton>
            ))}
          </div>
          {headerExtra}
        </div>
      </div>

      <textarea
        ref={ref}
        value={value}
        rows={minRows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 hover:border-zinc-200 focus:border-fume-500 focus:bg-white focus:outline-none print:hidden"
      />
      <div className="hidden whitespace-pre-wrap break-words text-[11px] leading-snug text-zinc-900 print:block">
        {value}
      </div>
    </section>
  );
}

function ToolButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="min-w-6 rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
    >
      {children}
    </button>
  );
}
