/**
 * Backup / restore of the notebook.
 *
 * File format (one envelope for full backups AND single-experiment exports,
 * so both can be restored through the same Import dialog):
 *
 *   { "version": 1, "exportedAt": "<ISO date>", "experiments": [ ...Experiment ] }
 *
 * Everything the app stores lives inside each experiment (reagent rows, display
 * units and column visibility, product / yield, drawn scheme, TLC images), so
 * exporting the experiments exports all settings too.
 *
 * Imported data is validated strictly against the shapes in ./types before it is
 * allowed anywhere near storage, then normalised with the same code that loads
 * localStorage.
 */

import { normaliseExperiment } from "./storage";
import {
  COLUMN_KEYS,
  PRODUCT_MASS_UNITS,
  ROLES,
  UNIT_OPTIONS,
  type Experiment,
  type UnitKind,
} from "./types";

export const BACKUP_VERSION = 1;
/** Refuse absurdly large files before reading them into memory (localStorage holds ~5 MB). */
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

export interface BackupFile {
  version: number;
  exportedAt: string;
  experiments: Experiment[];
}

// --- Building & downloading ---------------------------------------------------

export function buildBackup(experiments: Experiment[], now = new Date()): BackupFile {
  return { version: BACKUP_VERSION, exportedAt: now.toISOString(), experiments };
}

/** Local calendar date, YYYY-MM-DD (not UTC, so late-evening exports get today's date). */
function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const backupFilename = (now = new Date(), suffix = "") =>
  `eln_backup_${localDate(now)}${suffix}.json`;

export const experimentFilename = (experiment: Experiment) =>
  `${experiment.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download every experiment as eln_backup_YYYY-MM-DD.json. Returns the file name. */
export function downloadBackup(experiments: Experiment[], suffix = ""): string {
  const filename = backupFilename(new Date(), suffix);
  downloadJson(filename, buildBackup(experiments));
  return filename;
}

/** Download a single experiment as GH#####.json. Returns the file name. */
export function downloadExperiment(experiment: Experiment): string {
  const filename = experimentFilename(experiment);
  downloadJson(filename, buildBackup([experiment]));
  return filename;
}

// --- Validation -----------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === undefined || isStr(v);
const optNum = (v: unknown) =>
  v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

/** IDs end up in file names, React keys and the sidebar: keep them plain. */
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

const TEXT_FIELDS = ["title", "procedureText", "purificationText", "commentsText", "reactionSchemeRxn"];
const REAGENT_NUMBERS = ["mw", "eq", "n", "mass", "vol", "density"];

/**
 * Returns a human-readable reason if `raw` is not a valid experiment, else null.
 * Core fields (id, title, dateCreated, reagents) are required; everything added
 * later is optional and defaulted by normalisation, but must have the right type
 * if present.
 */
export function experimentProblem(raw: unknown): string | null {
  if (!isObj(raw)) return "not an object";

  if (!isStr(raw.id) || !ID_PATTERN.test(raw.id)) return "missing or invalid id";
  if (!isStr(raw.title)) return "title must be text";
  if (!isStr(raw.dateCreated) || Number.isNaN(new Date(raw.dateCreated).getTime())) {
    return "dateCreated must be a valid date";
  }
  if (!Array.isArray(raw.reagents)) return "reagents must be a list";

  for (const field of TEXT_FIELDS) {
    if (!optStr(raw[field])) return `${field} must be text`;
  }

  for (const [i, row] of raw.reagents.entries()) {
    if (!isObj(row)) return `reagent row ${i + 1} is not an object`;
    if (!optStr(row.id) || !optStr(row.name)) return `reagent row ${i + 1} has an invalid name`;
    if (row.role !== undefined && !ROLES.includes(row.role as never)) {
      return `reagent row ${i + 1} has an unknown role`;
    }
    for (const field of REAGENT_NUMBERS) {
      if (!optNum(row[field])) return `reagent row ${i + 1}: ${field} must be a number`;
    }
  }

  if (raw.tlcImages !== undefined) {
    if (!Array.isArray(raw.tlcImages)) return "tlcImages must be a list";
    // Only embedded images: an imported file must not make the app fetch remote URLs.
    if (!raw.tlcImages.every((s) => isStr(s) && s.startsWith("data:image/"))) {
      return "tlcImages must be embedded images";
    }
  }

  if (raw.references !== undefined) {
    if (!Array.isArray(raw.references)) return "references must be a list";
    for (const [i, ref] of raw.references.entries()) {
      if (!isObj(ref)) return `reference ${i + 1} is not an object`;
      if (!optStr(ref.title) || !optStr(ref.doi) || !optStr(ref.url)) {
        return `reference ${i + 1} must have text fields`;
      }
    }
  }

  if (raw.units !== undefined) {
    if (!isObj(raw.units)) return "units must be an object";
    for (const kind of Object.keys(UNIT_OPTIONS) as UnitKind[]) {
      const unit = raw.units[kind];
      if (unit !== undefined && !(UNIT_OPTIONS[kind] as readonly string[]).includes(unit as string)) {
        return `unknown ${kind} unit`;
      }
    }
  }

  if (raw.columns !== undefined) {
    if (!isObj(raw.columns)) return "columns must be an object";
    for (const key of COLUMN_KEYS) {
      if (raw.columns[key] !== undefined && typeof raw.columns[key] !== "boolean") {
        return `column "${key}" must be true or false`;
      }
    }
  }

  if (raw.product !== undefined) {
    const p = raw.product;
    if (!isObj(p)) return "product must be an object";
    if (!optStr(p.name)) return "product name must be text";
    if (!optNum(p.mw) || !optNum(p.isolatedMass)) return "product numbers must be numeric";
    if (p.massUnit !== undefined && !PRODUCT_MASS_UNITS.includes(p.massUnit as never)) {
      return "unknown product mass unit";
    }
  }

  return null;
}

export interface SkippedEntry {
  /** e.g. "Entry 3 (GH00007)" */
  label: string;
  reason: string;
}

export type ParsedBackup =
  | {
      ok: true;
      version: number;
      exportedAt: string | null;
      /** Valid, normalised experiments (duplicate IDs inside the file collapsed, last one wins). */
      experiments: Experiment[];
      skipped: SkippedEntry[];
      duplicatesInFile: number;
    }
  | { ok: false; error: string };

/** Parse and validate the text of a backup file. Never throws. */
export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }

  if (!isObj(data) || !("experiments" in data) || !("version" in data)) {
    return {
      ok: false,
      error: 'This does not look like an ELN backup (expected "version" and "experiments").',
    };
  }
  if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) {
    return { ok: false, error: "The backup has an invalid version number." };
  }
  if (data.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup uses format v${data.version}, which is newer than this app understands (v${BACKUP_VERSION}). Update the app to import it.`,
    };
  }
  if (!Array.isArray(data.experiments)) {
    return { ok: false, error: 'The backup\'s "experiments" must be a list.' };
  }

  const byId = new Map<string, Experiment>();
  const skipped: SkippedEntry[] = [];
  let duplicatesInFile = 0;

  data.experiments.forEach((raw: unknown, index) => {
    const idHint = isObj(raw) && isStr(raw.id) ? ` (${raw.id.slice(0, 40)})` : "";
    const label = `Entry ${index + 1}${idHint}`;

    const problem = experimentProblem(raw);
    if (problem) {
      skipped.push({ label, reason: problem });
      return;
    }
    const experiment = normaliseExperiment(raw as Partial<Experiment>);
    if (!experiment) {
      skipped.push({ label, reason: "could not be read" });
      return;
    }
    const key = experiment.id.toUpperCase();
    if (byId.has(key)) duplicatesInFile += 1;
    byId.set(key, experiment);
  });

  return {
    ok: true,
    version: data.version,
    exportedAt: isStr(data.exportedAt) ? data.exportedAt : null,
    experiments: [...byId.values()],
    skipped,
    duplicatesInFile,
  };
}

// --- Merge / replace -------------------------------------------------------------

export interface MergeResult {
  experiments: Experiment[];
  added: number;
  updated: number;
  /** Already present with identical content. */
  unchanged: number;
}

/**
 * Merge: new IDs are added, existing IDs (case-insensitive) are updated from the
 * backup, and experiments that are not in the backup are left alone.
 */
export function mergeExperiments(current: Experiment[], incoming: Experiment[]): MergeResult {
  const incomingById = new Map(incoming.map((e) => [e.id.toUpperCase(), e]));
  const seen = new Set<string>();
  let updated = 0;
  let unchanged = 0;

  const merged = current.map((existing) => {
    const key = existing.id.toUpperCase();
    const next = incomingById.get(key);
    if (!next) return existing;
    seen.add(key);
    const replacement = { ...next, id: existing.id };
    if (JSON.stringify(replacement) === JSON.stringify(existing)) {
      unchanged += 1;
      return existing;
    }
    updated += 1;
    return replacement;
  });

  const fresh = incoming.filter((e) => !seen.has(e.id.toUpperCase()));
  return {
    experiments: [...merged, ...fresh],
    added: fresh.length,
    updated,
    unchanged,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeMerge(r: MergeResult): string {
  const parts = [`${r.added} added`];
  if (r.updated > 0) parts.push(`${r.updated} updated`);
  if (r.unchanged > 0) parts.push(`${r.unchanged} already up to date`);
  const touched = r.added + r.updated;
  return touched === 0
    ? `Nothing to import - all ${plural(r.unchanged, "experiment")} already up to date.`
    : `Imported ${plural(touched, "experiment")} (${parts.join(", ")}).`;
}

export function describeReplace(restored: number, replaced: number): string {
  return replaced > 0
    ? `Restored ${plural(restored, "experiment")}. ${plural(replaced, "previous experiment")} replaced.`
    : `Imported ${plural(restored, "experiment")}.`;
}
