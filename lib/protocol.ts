import { newRow, type ReagentRow } from "./types";
import type { ParsedProtocol } from "./protocolSchema";

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Turn the model's answer into reagent-table rows. The response crossed a
 * network boundary and came from an LLM, so every value is re-checked.
 */
export function toReagentRows(parsed: ParsedProtocol): ReagentRow[] {
  const rows: ReagentRow[] = [];
  for (const raw of parsed.reagents ?? []) {
    const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 200) : "";
    if (!name) continue;

    const role = raw.role === "Limiting" || raw.role === "Solvent" || raw.role === "Catalyst" ? raw.role : "Reagent";
    const row = newRow(role);
    row.name = name;
    row.mass = positive(raw.massMg);
    row.n = positive(raw.mmol);
    row.vol = positive(raw.volumeMl);
    row.eq = positive(raw.equiv) ?? (role === "Limiting" ? 1 : null);
    // Molecular weight follows from mass / amount when both were stated.
    if (row.mass !== null && row.n !== null && row.n > 0) row.mw = row.mass / row.n;
    rows.push(row);
  }

  // Only one reagent can be the limiting one: keep the first, demote the rest.
  let seenLimiting = false;
  for (const row of rows) {
    if (row.role !== "Limiting") continue;
    if (seenLimiting) {
      row.role = "Reagent";
      if (row.eq === 1) row.eq = null;
    }
    seenLimiting = true;
  }
  return rows;
}
