/**
 * Core data model for the ELN.
 *
 * Reagent quantities are always stored in canonical units
 * (n: mmol, mass: mg, vol: mL, density: g/mL, MW: g/mol).
 * The displayed unit is a per-experiment *view* setting (see `Units`),
 * so switching mL -> L never loses precision or mutates the data.
 */

export const ROLES = ["Limiting", "Reagent", "Solvent", "Catalyst"] as const;
export type Role = (typeof ROLES)[number];

export const UNIT_OPTIONS = {
  n: ["µmol", "mmol", "mol"],
  mass: ["µg", "mg", "g", "kg"],
  vol: ["µL", "mL", "L"],
} as const;

export type UnitKind = keyof typeof UNIT_OPTIONS;
export type Units = { [K in UnitKind]: (typeof UNIT_OPTIONS)[K][number] };

export const COLUMN_KEYS = ["mw", "eq", "n", "mass", "vol", "density"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type Columns = Record<ColumnKey, boolean>;

export interface ReagentRow {
  id: string;
  name: string;
  role: Role;
  /** g/mol */
  mw: number | null;
  /** equivalents relative to the limiting reagent */
  eq: number | null;
  /** mmol */
  n: number | null;
  /** mg */
  mass: number | null;
  /** mL */
  vol: number | null;
  /** g/mL */
  density: number | null;
}

export const PRODUCT_MASS_UNITS = ["mg", "g"] as const;
export type ProductMassUnit = (typeof PRODUCT_MASS_UNITS)[number];

/** Isolated product and yield bookkeeping for the experiment. */
export interface ProductInfo {
  name: string;
  /** g/mol */
  mw: number | null;
  /** mg, canonical - `massUnit` only controls how it is displayed / typed. */
  isolatedMass: number | null;
  massUnit: ProductMassUnit;
}

export const DEFAULT_PRODUCT: ProductInfo = {
  name: "",
  mw: null,
  isolatedMass: null,
  massUnit: "mg",
};

/**
 * A literature reference. Text and links only - never PDFs, which would
 * blow the ~5 MB localStorage budget.
 */
export interface Reference {
  id: string;
  title: string;
  /** Bare DOI, e.g. "10.1021/ja01234a001" (no resolver prefix). */
  doi: string;
  url: string;
}

export interface Experiment {
  id: string; // e.g. "GH00001"
  title: string;
  dateCreated: string; // ISO 8601
  /**
   * Reaction scheme drawn in Ketcher, stored as an Rxnfile (or a Molfile when
   * only molecules are drawn, i.e. no reaction arrow). Empty string = blank canvas.
   */
  reactionSchemeRxn: string;
  procedureText: string;
  purificationText: string;
  commentsText: string;
  reagents: ReagentRow[];
  product: ProductInfo;
  /** base64 data URLs */
  tlcImages: string[];
  references: Reference[];
  units: Units;
  columns: Columns;
}

export const DEFAULT_UNITS: Units = { n: "mmol", mass: "mg", vol: "mL" };
export const DEFAULT_COLUMNS: Columns = {
  mw: true,
  eq: true,
  n: true,
  mass: true,
  vol: true,
  density: true,
};

export const ID_PREFIX = "GH";
const DEFAULT_ID_WIDTH = 5;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function newRow(role: Role = "Reagent"): ReagentRow {
  return {
    id: uid(),
    name: "",
    role,
    mw: null,
    eq: role === "Limiting" ? 1 : null,
    n: null,
    mass: null,
    vol: null,
    density: null,
  };
}

/**
 * Next experiment ID: take the highest existing GH number and add one,
 * keeping the zero-padding width of that ID (GH00009 -> GH00010).
 */
export function nextExperimentId(existing: Experiment[]): string {
  const pattern = new RegExp(`^${ID_PREFIX}(\\d+)$`, "i");
  let maxNum = 0;
  let width = DEFAULT_ID_WIDTH;
  for (const exp of existing) {
    const match = pattern.exec(exp.id);
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (num >= maxNum) {
      maxNum = num;
      width = Math.max(match[1].length, 1);
    }
  }
  const taken = new Set(existing.map((e) => e.id.toUpperCase()));
  let next = maxNum + 1;
  let id = `${ID_PREFIX}${String(next).padStart(width, "0")}`;
  while (taken.has(id.toUpperCase())) {
    next += 1;
    id = `${ID_PREFIX}${String(next).padStart(width, "0")}`;
  }
  return id;
}

export function newExperiment(existing: Experiment[]): Experiment {
  return {
    id: nextExperimentId(existing),
    title: "",
    dateCreated: new Date().toISOString(),
    reactionSchemeRxn: "",
    procedureText: "",
    purificationText: "",
    commentsText: "",
    reagents: [newRow("Limiting"), newRow("Reagent")],
    product: { ...DEFAULT_PRODUCT },
    tlcImages: [],
    references: [],
    units: { ...DEFAULT_UNITS },
    columns: { ...DEFAULT_COLUMNS },
  };
}
