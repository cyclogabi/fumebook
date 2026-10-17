/**
 * Core data model for the ELN.
 *
 * Reagent quantities are always stored in canonical units
 * (n: mmol, mass: mg, vol: mL, density: g/mL, MW: g/mol).
 * The displayed unit is a per-experiment *view* setting (see `Units`),
 * so switching mL -> L never loses precision or mutates the data.
 */

import { readInitials, readStartNumber } from "./initials";

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
  /** Moles of limiting reagent consumed per mole of this product formed. 1 when missing. */
  stoichRatio?: number;
}

/**
 * An additional isolated product (side product, isomer, di-substituted product...) of the same
 * reaction. The primary product stays in `Experiment.product`; these only add to it.
 *
 * Numbers may arrive as text (hand-edited / older files): an empty string means "not entered", and
 * loading turns numeric text into numbers.
 */
export interface SecondaryProduct {
  id: string;
  /** e.g. "Side product", "Isomer B", "Di-substituted". */
  name: string;
  /** Molecular weight, g/mol. */
  mw: string | number;
  /** Isolated mass, in `massUnit` (it is converted, not reinterpreted, when the unit is toggled). */
  mass: string | number;
  /** Unit of `mass`; "mg" when missing, like the primary product's selector. */
  massUnit?: ProductMassUnit;
  /** Moles of limiting reagent consumed per mole of this product formed. 1 when missing. */
  stoichRatio?: number;
  /** Optional notes / appearance. */
  appearance?: string;
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

/** How the molecule / reaction scheme section is filled: drawn in Ketcher or an uploaded picture. */
export const MOLECULE_MODES = ["draw", "image"] as const;
export type MoleculeMode = (typeof MOLECULE_MODES)[number];

export interface Experiment {
  id: string; // e.g. "GH00001"
  title: string;
  dateCreated: string; // ISO 8601
  /**
   * Reaction scheme drawn in Ketcher, stored as an Rxnfile (or a Molfile when
   * only molecules are drawn, i.e. no reaction arrow). Empty string = blank canvas.
   * Kept when switching to "image" mode, so the drawing is still there when switching back.
   */
  reactionSchemeRxn: string;
  /** Which of the two the user chose for this experiment. */
  moleculeMode: MoleculeMode;
  /**
   * True once a picture was saved for this experiment
   * (desktop: `Documents/Fumebook/attachments/[id]/molecule.png`). The bytes are not in this JSON.
   */
  moleculeImage: boolean;
  procedureText: string;
  purificationText: string;
  commentsText: string;
  reagents: ReagentRow[];
  product: ProductInfo;
  /**
   * Further isolated products. Optional: experiments saved before this existed simply don't have
   * it, and an experiment with a single product never needs it.
   */
  secondaryProducts?: SecondaryProduct[];
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

/** Only used if no initials are saved (the onboarding dialog normally makes that impossible). */
export const ID_PREFIX = "GH";
/** Experiment IDs are the user's initials plus this many digits: GH001. */
const ID_DIGITS = 3;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function newSecondaryProduct(
  massUnit: ProductMassUnit = "mg",
  name = "",
): SecondaryProduct {
  return { id: uid(), name, mw: "", mass: "", massUnit, stoichRatio: 1 };
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
 * Next experiment ID for `initials`: among the existing IDs that are those initials followed
 * by a number, take the highest number and add one, but never go below `startNumber` (the
 * number the user said their notebook starts at); padded to at least 3 digits.
 *
 * - no experiments yet, start number 56 -> GH056
 * - highest GH012, start number 1 -> GH013
 * - highest GH012, start number 56 -> GH056 (a later start number still wins)
 * - highest GH060, start number 56 -> GH061
 *
 * Other people's IDs (a backup merged in with different initials) are ignored.
 */
export function nextExperimentId(
  existing: Experiment[],
  initials: string,
  startNumber: number = readStartNumber(),
): string {
  const escaped = initials.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}(\\d+)$`, "i");
  let maxNum = 0;
  for (const exp of existing) {
    const match = pattern.exec(exp.id);
    if (!match) continue;
    maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }
  const format = (n: number) => `${initials}${String(n).padStart(ID_DIGITS, "0")}`;
  const taken = new Set(existing.map((e) => e.id.toUpperCase()));
  let next = Math.max(maxNum + 1, Math.floor(startNumber) || 1);
  while (taken.has(format(next).toUpperCase())) next += 1;
  return format(next);
}

/** `initials` and `startNumber` default to the ones saved in the profile. */
export function newExperiment(
  existing: Experiment[],
  initials: string = readInitials() ?? ID_PREFIX,
  startNumber: number = readStartNumber(),
): Experiment {
  const id = nextExperimentId(existing, initials, startNumber);
  return {
    id,
    title: "",
    dateCreated: new Date().toISOString(),
    reactionSchemeRxn: "",
    moleculeMode: "draw",
    moleculeImage: false,
    procedureText: "",
    purificationText: "",
    commentsText: "",
    reagents: [newRow("Limiting"), newRow("Reagent")],
    product: { ...DEFAULT_PRODUCT, name: id },
    tlcImages: [],
    references: [],
    units: { ...DEFAULT_UNITS },
    columns: { ...DEFAULT_COLUMNS },
  };
}
