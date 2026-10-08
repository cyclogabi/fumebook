/**
 * Stoichiometry engine.
 *
 * All values are canonical (mmol, mg, mL, g/mol, g/mL). Relationships:
 *   mass [mg]  = n [mmol] * MW [g/mol]
 *   vol  [mL]  = mass [mg] / (density [g/mL] * 1000)
 *   n    [mmol] = eq * n_limiting
 *
 * The field the user just edited is authoritative; the other quantities in
 * that row are derived from it. Editing the limiting reagent rescales every
 * other (non-solvent) row from its equivalents.
 */

import type { ReagentRow, Role, UnitKind, Units } from "./types";

export type EditableField = "mw" | "eq" | "n" | "mass" | "vol" | "density";

// --- Unit conversion -------------------------------------------------------

const UNIT_FACTOR: Record<string, number> = {
  // amount of substance -> mmol
  µmol: 1e-3,
  mmol: 1,
  mol: 1e3,
  // mass -> mg
  µg: 1e-3,
  mg: 1,
  g: 1e3,
  kg: 1e6,
  // volume -> mL
  µL: 1e-3,
  mL: 1,
  L: 1e3,
};

export function toCanonical(value: number, unit: string): number {
  return value * (UNIT_FACTOR[unit] ?? 1);
}

export function fromCanonical(value: number, unit: string): number {
  return value / (UNIT_FACTOR[unit] ?? 1);
}

/** Display with up to 5 significant figures, no trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  return String(parseFloat(value.toPrecision(5)));
}

export function displayValue(
  canonical: number | null,
  kind: UnitKind,
  units: Units,
): number | null {
  return canonical === null ? null : fromCanonical(canonical, units[kind]);
}

// --- Helpers ---------------------------------------------------------------

const has = (v: number | null): v is number => v !== null && Number.isFinite(v);
const positive = (v: number | null): v is number => has(v) && v > 0;

type Source = "n" | "mass" | "vol";

/** Treat `src` as authoritative and (re)derive the other two quantities. */
function resolveFrom(r: ReagentRow, src: Source): void {
  if (!has(r[src])) {
    r.n = null;
    r.mass = null;
    r.vol = null;
    return;
  }
  if (src === "n") {
    r.mass = positive(r.mw) ? r.n! * r.mw : null;
    r.vol = has(r.mass) && positive(r.density) ? r.mass / (r.density * 1000) : null;
  } else if (src === "mass") {
    r.n = positive(r.mw) ? r.mass! / r.mw : null;
    r.vol = positive(r.density) ? r.mass! / (r.density * 1000) : null;
  } else {
    r.mass = positive(r.density) ? r.vol! * r.density * 1000 : null;
    r.n = has(r.mass) && positive(r.mw) ? r.mass / r.mw : null;
  }
}

/** Pick whichever quantity is set (n preferred) and derive the rest. */
function resolveAny(r: ReagentRow): void {
  if (has(r.n)) resolveFrom(r, "n");
  else if (has(r.mass)) resolveFrom(r, "mass");
  else if (has(r.vol)) resolveFrom(r, "vol");
}

export function limitingN(rows: ReagentRow[]): number | null {
  const lim = rows.find((r) => r.role === "Limiting");
  return lim && positive(lim.n) ? lim.n : null;
}

/** Scale every non-solvent row to the limiting reagent via its equivalents. */
function propagateFromLimiting(rows: ReagentRow[], limId: string): void {
  const nLim = limitingN(rows);
  if (nLim === null) return;
  for (const r of rows) {
    if (r.id === limId || r.role === "Solvent") continue;
    if (has(r.eq)) {
      r.n = r.eq * nLim;
      resolveFrom(r, "n");
    } else if (has(r.n)) {
      r.eq = r.n / nLim;
    }
  }
}

// --- Public API ------------------------------------------------------------

/** Apply a single numeric edit to one row and recalculate dependents. */
export function editField(
  rows: ReagentRow[],
  id: string,
  field: EditableField,
  value: number | null,
): ReagentRow[] {
  const next = rows.map((r) => ({ ...r }));
  const row = next.find((r) => r.id === id);
  if (!row) return rows;

  const isLimiting = row.role === "Limiting";
  const prevN = row.n;

  // The limiting reagent is the 1.0 eq reference by definition.
  if (field === "eq" && isLimiting) return rows;

  row[field] = value;

  switch (field) {
    case "n":
    case "mass":
    case "vol":
      resolveFrom(row, field);
      break;

    case "mw":
      resolveAny(row); // n is preserved when set; mass follows the new MW
      break;

    case "density":
      if (has(row.mass)) {
        row.vol = positive(row.density) ? row.mass / (row.density * 1000) : null;
      } else if (has(row.vol) && positive(row.density)) {
        resolveFrom(row, "vol");
      }
      break;

    case "eq": {
      const nLim = limitingN(next);
      if (has(row.eq) && nLim !== null) {
        row.n = row.eq * nLim;
        resolveFrom(row, "n");
      }
      break;
    }
  }

  if (isLimiting) {
    if (row.n !== prevN) propagateFromLimiting(next, row.id);
  } else if (field !== "eq") {
    const nLim = limitingN(next);
    if (nLim !== null) row.eq = has(row.n) ? row.n / nLim : null;
  }

  return next;
}

/**
 * Change a row's role. Only one row can be limiting; promoting a row demotes
 * the previous one and re-expresses every other row's equivalents against the
 * new reference (amounts stay fixed, eq changes).
 */
export function setRole(rows: ReagentRow[], id: string, role: Role): ReagentRow[] {
  const next = rows.map((r) => ({ ...r }));
  const row = next.find((r) => r.id === id);
  if (!row || row.role === role) return rows;

  row.role = role;
  if (role !== "Limiting") return next;

  for (const r of next) {
    if (r.id !== id && r.role === "Limiting") r.role = "Reagent";
  }
  row.eq = 1;
  const nLim = limitingN(next);
  if (nLim === null) return next;

  for (const r of next) {
    if (r.id === id || r.role === "Solvent") continue;
    if (has(r.n)) r.eq = r.n / nLim;
    else if (has(r.eq)) {
      r.n = r.eq * nLim;
      resolveFrom(r, "n");
    }
  }
  return next;
}

/** Concentration (mol/L) of the limiting reagent in the total solvent volume. */
export function concentration(rows: ReagentRow[]): number | null {
  const nLim = limitingN(rows);
  if (nLim === null) return null;
  const solventVol = rows
    .filter((r) => r.role === "Solvent" && positive(r.vol))
    .reduce((sum, r) => sum + (r.vol ?? 0), 0);
  return solventVol > 0 ? nLim / solventVol : null; // mmol/mL == mol/L
}
