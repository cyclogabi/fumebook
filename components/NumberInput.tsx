"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/stoich";

/** Borderless "spreadsheet cell" look shared by the reagent table inputs. */
export const cellInput =
  "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm tabular-nums text-zinc-900 " +
  "placeholder:text-zinc-300 hover:border-zinc-200 focus:border-fume-500 focus:bg-white focus:outline-none " +
  "print:border-0 print:p-0 print:text-[11px] print:placeholder:text-transparent";

/**
 * Numeric text input. While focused it shows exactly what you type ("0.", "1.50")
 * and reports each valid value upward; otherwise it shows the formatted value
 * so recalculated numbers always display cleanly.
 */
export default function NumberInput({
  value,
  onCommit,
  ariaLabel,
  readOnly = false,
  className,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  ariaLabel: string;
  readOnly?: boolean;
  /** Replaces the default table-cell styling (include alignment). */
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const formatted = value === null ? "" : formatNumber(value);
  const shown = draft ?? formatted;

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={shown}
      readOnly={readOnly}
      placeholder="–"
      onFocus={(e) => {
        if (readOnly) return;
        setDraft(formatted);
        e.currentTarget.select();
      }}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const text = e.target.value;
        if (!/^\d*[.,]?\d*$/.test(text)) return; // digits and one decimal separator only
        setDraft(text);
        if (text === "") return onCommit(null);
        const parsed = Number(text.replace(",", "."));
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
      className={`${className ?? `${cellInput} text-right`} ${
        readOnly ? "cursor-default text-zinc-500 hover:border-transparent focus:border-transparent" : ""
      }`}
    />
  );
}
