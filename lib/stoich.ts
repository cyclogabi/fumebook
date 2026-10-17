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

import type { Experiment, ProductInfo, ReagentRow, Role, SecondaryProduct, UnitKind, Units } from "./types";

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

function clearSolventFields(r: ReagentRow): void {
  r.mw = null;
  r.mass = null;
  r.n = null;
  r.eq = null;
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

  // Solvent rows only hold a volume and a density; everything else stays cleared.
  if (row.role === "Solvent") {
    if (field !== "vol" && field !== "density") return rows;
    row[field] = value;
    clearSolventFields(row);
    return next;
  }

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
  if (role === "Solvent") {
    // Keep a volume (derive it from a mass + density if that's all there was), drop the rest.
    if (!has(row.vol) && has(row.mass) && positive(row.density)) {
      row.vol = row.mass / (row.density * 1000);
    }
    clearSolventFields(row);
    return next;
  }
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

/**
 * Scale a concentration in mol/L to a readable value and unit (M, mM, µM, nM),
 * keeping the number between 1 and 999 where possible, e.g. 0.025 -> "25 mM".
 */
export function formatConcentration(molar: number): string {
  if (!Number.isFinite(molar) || molar <= 0) return "";
  const scales: [number, number, string][] = [
    [1, 1, "M"],
    [1e-3, 1e3, "mM"],
    [1e-6, 1e6, "µM"],
  ];
  let value = molar * 1e9;
  let unit = "nM";
  for (const [min, factor, u] of scales) {
    if (molar >= min) {
      value = molar * factor;
      unit = u;
      break;
    }
  }
  // Rounding to 3 significant digits can reach 1000 (e.g. 0.9996 M): bump up a unit.
  let text = String(parseFloat(value.toPrecision(3)));
  if (parseFloat(text) >= 1000 && unit !== "M") {
    const up = { nM: "µM", "µM": "mM", mM: "M" }[unit]!;
    text = String(parseFloat((value / 1000).toPrecision(3)));
    unit = up;
  }
  if (/e/i.test(text)) text = String(Math.round(parseFloat(text)));
  return `${text} ${unit}`;
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

// --- Isolated products: individual yields and total limiting-reagent conversion ----------------
//
// For every isolated product i (the primary one plus each secondary product):
//   n_i       = mass_i / MW_i                  (mmol, with mass in mg and MW in g/mol)
//   n_theo,i  = n_limiting / stoichRatio_i     (stoichRatio = moles of limiting reagent per mole of product)
//   yield_i   = n_i / n_theo,i * 100
// and the limiting reagent that ended up in isolated products is
//   conversion = sum(n_i * stoichRatio_i) / n_limiting * 100

/** A number from a number or numeric text ("12.5", "12,5"); null for empty / anything else. */
export function looseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Moles of limiting reagent per mole of product; anything that is not a positive number counts as 1. */
export function stoichRatioOf(product: Pick<SecondaryProduct, "stoichRatio">): number {
  const ratio = looseNumber(product.stoichRatio);
  return ratio !== null && ratio > 0 ? ratio : 1;
}

const MG_PER_UNIT = { mg: 1, g: 1000 } as const;

/** The isolated mass of a secondary product in mg (canonical), or null if it is empty / not a number. */
export function secondaryMassMg(product: SecondaryProduct): number | null {
  const mass = looseNumber(product.mass);
  return mass === null ? null : mass * MG_PER_UNIT[product.massUnit === "g" ? "g" : "mg"];
}

export interface ProductMetrics {
  /** Moles actually isolated (mmol). */
  nMmol: number | null;
  /** Moles the limiting reagent could give at most (mmol). */
  theoreticalMmol: number | null;
  /** Individual yield, %. */
  percent: number | null;
  ratio: number;
}

/** Moles and individual yield of one product. `nLimiting` is in mmol, `massMg` in mg, `mw` in g/mol. */
export function productMetrics(
  massMg: number | null,
  mw: number | null,
  ratio: number,
  nLimiting: number | null,
): ProductMetrics {
  const nMmol = massMg !== null && positive(mw) && massMg >= 0 ? massMg / mw : null;
  const theoreticalMmol = positive(nLimiting) ? nLimiting / ratio : null;
  const percent =
    nMmol !== null && theoreticalMmol !== null ? (nMmol / theoreticalMmol) * 100 : null;
  return { nMmol, theoreticalMmol, percent, ratio };
}

export interface ProductSummaryItem extends ProductMetrics {
  /** Fallback fraction identifier: `GH055` (single product) or `GH055-F1`, `GH055-F2`, ... */
  label: string;
  name: string;
  /** Has a molecular weight and a mass above zero, so it counts towards the conversion. */
  valid: boolean;
}

export interface ProductsSummary {
  items: ProductSummaryItem[];
  /** Total limiting-reagent conversion, %: null without a limiting amount or any complete product. */
  conversionPercent: number | null;
}

/** Every product's metrics plus the total conversion of the limiting reagent. */
export function summariseProducts(
  rows: ReagentRow[],
  product: ProductInfo,
  secondary: readonly SecondaryProduct[] = [],
  experimentId = "",
): ProductsSummary {
  const nLim = limitingN(rows);
  const idPrefix = experimentId.trim();
  const primaryFallback =
    secondary.length > 0
      ? idPrefix
        ? `${idPrefix}-F1`
        : "F1"
      : idPrefix || "F1";
  const rawPrimaryName = product.name.trim();
  const primaryName =
    rawPrimaryName === "" ||
    (secondary.length > 0 && idPrefix !== "" && rawPrimaryName.toUpperCase() === idPrefix.toUpperCase())
      ? primaryFallback
      : rawPrimaryName;

  const items: ProductSummaryItem[] = [
    {
      ...productMetrics(product.isolatedMass, product.mw, stoichRatioOf(product), nLim),
      label: primaryFallback,
      name: primaryName,
      valid: positive(product.mw) && positive(product.isolatedMass),
    },
    ...secondary.map((p, i): ProductSummaryItem => {
      const massMg = secondaryMassMg(p);
      const mw = looseNumber(p.mw);
      const fallback = idPrefix ? `${idPrefix}-F${i + 2}` : `F${i + 2}`;
      const rawName = p.name.trim();
      return {
        ...productMetrics(massMg, mw, stoichRatioOf(p), nLim),
        label: fallback,
        name: rawName || fallback,
        valid: positive(mw) && positive(massMg),
      };
    }),
  ];

  let consumed = 0;
  let any = false;
  for (const item of items) {
    if (!item.valid || item.nMmol === null) continue;
    consumed += item.nMmol * item.ratio;
    any = true;
  }
  return {
    items,
    conversionPercent: any && nLim !== null ? (consumed / nLim) * 100 : null,
  };
}

/** "1.25 mmol" from 1.25 mmol, "85 µmol" from 0.085 mmol (below 1 mmol the µmol reads better). */
export function formatMoles(mmol: number): string {
  if (!Number.isFinite(mmol)) return "";
  if (mmol >= 1 || mmol === 0) return `${formatNumber(parseFloat(mmol.toPrecision(3)))} mmol`;
  return `${formatNumber(parseFloat((mmol * 1000).toPrecision(3)))} µmol`;
}

/**
 * The yield as the dashboard shows it: the primary product's yield, e.g. "58%", or "58% (+18%)"
 * when secondary products add 18 points. `null` when the primary yield cannot be worked out.
 */
export function yieldSummary(experiment: Experiment): string | null {
  const secondary = experiment.secondaryProducts ?? [];
  const { items } = summariseProducts(
    experiment.reagents,
    experiment.product,
    secondary,
    experiment.id,
  );
  const [primary, ...others] = items;
  if (primary.percent === null) return null;
  const extra = others.reduce(
    (sum, item) => (item.valid && item.percent !== null ? sum + item.percent : sum),
    0,
  );
  const base = `${Math.round(primary.percent)}%`;
  return extra > 0 ? `${base} (+${Math.round(extra)}%)` : base;
}

// --- Per-product color palette & CV elution bands ----------------------------

export interface ProductColor {
  hex: string;
  text: string;
  badgeBg: string;
}

export const PRODUCT_PALETTE: readonly ProductColor[] = [
  { hex: "#10b981", text: "#047857", badgeBg: "#ecfdf5" }, // Product 1 / F1: Emerald/Teal
  { hex: "#f59e0b", text: "#b45309", badgeBg: "#fffbeb" }, // Product 2 / F2: Amber/Orange
  { hex: "#8b5cf6", text: "#6d28d9", badgeBg: "#f5f3ff" }, // Product 3 / F3: Violet/Purple
  { hex: "#f43f5e", text: "#be123c", badgeBg: "#fff1f2" }, // Product 4 / F4: Rose/Pink
  { hex: "#0ea5e9", text: "#0369a1", badgeBg: "#f0f9ff" }, // Product 5 / F5: Sky Blue
];

export function productColorAt(index: number): ProductColor {
  return PRODUCT_PALETTE[index % PRODUCT_PALETTE.length];
}

export interface ProductElutionBand {
  id: string;
  name: string;
  startCv: number;
  endCv: number;
  color: ProductColor;
}

/**
 * Resolve every product that has a valid elution CV window (`startCv` and `endCv`),
 * paired with its resolved fraction/product name (`GH055` or `GH055-F1`, `GH055-F2`, ...)
 * and distinct palette color. Falls back to `legacyWindow` if no product has an elution window.
 */
export function resolveProductElutionBands(
  experimentId: string,
  product?: ProductInfo,
  secondary: readonly SecondaryProduct[] = [],
  legacyWindow?: { startCv: number; endCv: number; label?: string },
): ProductElutionBand[] {
  const idPrefix = (experimentId ?? "").trim();
  const primaryFallback =
    secondary.length > 0
      ? idPrefix
        ? `${idPrefix}-F1`
        : "F1"
      : idPrefix || "F1";
  const rawPrimaryName = product?.name?.trim() ?? "";
  const primaryName =
    rawPrimaryName === "" ||
    (secondary.length > 0 &&
      idPrefix !== "" &&
      rawPrimaryName.toUpperCase() === idPrefix.toUpperCase())
      ? primaryFallback
      : rawPrimaryName;

  const bands: ProductElutionBand[] = [];

  const pStart = looseNumber(product?.elutionStartCv);
  const pEnd = looseNumber(product?.elutionEndCv);
  if (pStart !== null && pEnd !== null && pStart >= 0 && pEnd >= pStart && pEnd > 0) {
    bands.push({
      id: "primary",
      name: primaryName,
      startCv: pStart,
      endCv: pEnd,
      color: productColorAt(0),
    });
  }

  secondary.forEach((sec, i) => {
    const start = looseNumber(sec.elutionStartCv);
    const end = looseNumber(sec.elutionEndCv);
    if (start === null || end === null || start < 0 || end < start || end <= 0) return;
    const fallback = idPrefix ? `${idPrefix}-F${i + 2}` : `F${i + 2}`;
    bands.push({
      id: sec.id,
      name: sec.name.trim() || fallback,
      startCv: start,
      endCv: end,
      color: productColorAt(i + 1),
    });
  });

  if (
    bands.length === 0 &&
    legacyWindow &&
    legacyWindow.startCv >= 0 &&
    legacyWindow.endCv >= legacyWindow.startCv &&
    legacyWindow.endCv > 0
  ) {
    bands.push({
      id: "legacy-window",
      name: legacyWindow.label?.trim() || primaryName,
      startCv: legacyWindow.startCv,
      endCv: legacyWindow.endCv,
      color: productColorAt(0),
    });
  }

  return bands;
}
