"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
  DEFAULT_PRODUCT,
  DEFAULT_UNITS,
  MOLECULE_MODES,
  PRODUCT_MASS_UNITS,
  ROLES,
  UNIT_OPTIONS,
  newExperiment,
  uid,
  type Experiment,
  type GradientPoint,
  type MoleculeMode,
  type ProductInfo,
  type PurificationGradient,
  type ReagentRow,
  type Reference,
  type SecondaryProduct,
  type StructuredReactionScheme,
  type UnitKind,
} from "./types";
import { cleanDoi } from "./references";
import { looseNumber } from "./stoich";
import * as path from "@tauri-apps/api/path";
import { isTauri } from "./tauri";
import {
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove as removeFile, // aliased: the hook below exposes its own `remove`
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

/**
 * Experiment store exposed through useSyncExternalStore.
 * - Desktop (Tauri): each experiment is a JSON file in
 *   `Documents/Fumebook/experiments/[id].json`. `Documents/Fumebook/attachments/`
 *   is created alongside it for raw files (e.g. NMR zips).
 * - Plain browser (e.g. `next dev` preview): falls back to localStorage.
 * - Server / first hydration pass: snapshot is `null` ("not loaded yet"),
 *   so markup always matches; the real data appears right after hydration.
 * - Updates are applied to memory immediately and written out on a short
 *   debounce (images make the payload large).
 */

const STORAGE_KEY = "chem-eln:experiments:v1";
const PERSIST_DELAY_MS = 400;
const APP_DIR_NAME = "Fumebook";
const EXPERIMENTS_DIR_NAME = "experiments";
const ATTACHMENTS_DIR_NAME = "attachments";

let cache: Experiment[] | null = null;
let persistError: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

// --- Environment ------------------------------------------------------------

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Disk layout (Tauri) ------------------------------------------------------

async function getExperimentsDir(): Promise<string> {
  return path.join(await path.documentDir(), APP_DIR_NAME, EXPERIMENTS_DIR_NAME);
}

async function getAttachmentsDir(): Promise<string> {
  return path.join(await path.documentDir(), APP_DIR_NAME, ATTACHMENTS_DIR_NAME);
}

let dirsReady: Promise<void> | null = null;

/**
 * Create `Documents/Fumebook/experiments/` and `Documents/Fumebook/attachments/`
 * if missing. Runs once per session; a failure is not cached so it can be retried.
 * No-op outside Tauri.
 */
export function initStorage(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (!dirsReady) {
    dirsReady = (async () => {
      await mkdir(await getExperimentsDir(), { recursive: true });
      await mkdir(await getAttachmentsDir(), { recursive: true });
    })();
    dirsReady.catch(() => {
      dirsReady = null;
    });
  }
  return dirsReady;
}

/** Experiment ids become file / folder names, so neutralise anything that could escape the folder. */
const safeName = (id: string) => id.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
const fileNameFor = (id: string) => `${safeName(id)}.json`;

async function experimentFilePath(id: string): Promise<string> {
  return path.join(await getExperimentsDir(), fileNameFor(id));
}

/** Matches the "file / folder doesn't exist" errors Tauri returns on Windows, macOS and Linux. */
const isNotFound = (e: unknown) =>
  /not found|no such file|os error [23]\b|cannot find/i.test(errorMessage(e));

// --- Reading & normalising (tolerates older / hand-edited data) -----------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function normaliseRow(raw: Partial<ReagentRow> | null | undefined): ReagentRow {
  const r = raw ?? {};
  return {
    id: typeof r.id === "string" ? r.id : uid(),
    name: typeof r.name === "string" ? r.name : "",
    role: ROLES.includes(r.role as never) ? (r.role as ReagentRow["role"]) : "Reagent",
    mw: num(r.mw),
    eq: num(r.eq),
    n: num(r.n),
    mass: num(r.mass),
    vol: num(r.vol),
    density: num(r.density),
  };
}

function normaliseReference(raw: Partial<Reference> | null | undefined): Reference | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const title = text(raw.title);
  const doi = cleanDoi(text(raw.doi));
  const url = text(raw.url);
  if (!title && !doi && !url) return null;
  return { id: typeof raw.id === "string" ? raw.id : uid(), title, doi, url };
}

function normaliseProduct(raw: Partial<ProductInfo> | null | undefined): ProductInfo {
  const p = raw ?? {};
  const mw = num(p.mw);
  const mass = num(p.isolatedMass);
  const ratio = looseNumber(p.stoichRatio);
  const elutionStartCv = looseNumber(p.elutionStartCv);
  const elutionEndCv = looseNumber(p.elutionEndCv);
  return {
    name: typeof p.name === "string" ? p.name : "",
    mw: mw !== null && mw > 0 ? mw : null,
    isolatedMass: mass !== null && mass >= 0 ? mass : null,
    massUnit: PRODUCT_MASS_UNITS.includes(p.massUnit as never)
      ? (p.massUnit as ProductInfo["massUnit"])
      : DEFAULT_PRODUCT.massUnit,
    ...(ratio !== null && ratio > 0 && ratio !== 1 ? { stoichRatio: ratio } : {}),
    ...(elutionStartCv !== null && elutionStartCv >= 0 ? { elutionStartCv } : {}),
    ...(elutionEndCv !== null && elutionEndCv >= 0 ? { elutionEndCv } : {}),
  };
}

/** A secondary product with defaults filled in; text numbers become numbers, empty ones stay "". */
function normaliseSecondary(raw: unknown): SecondaryProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof SecondaryProduct, unknown>>;
  const field = (v: unknown): string | number => looseNumber(v) ?? "";
  const ratio = looseNumber(r.stoichRatio);
  const elutionStartCv = looseNumber(r.elutionStartCv);
  const elutionEndCv = looseNumber(r.elutionEndCv);
  const product: SecondaryProduct = {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    name: typeof r.name === "string" ? r.name : "",
    mw: field(r.mw),
    mass: field(r.mass),
    massUnit: PRODUCT_MASS_UNITS.includes(r.massUnit as never)
      ? (r.massUnit as SecondaryProduct["massUnit"])
      : "mg",
    stoichRatio: ratio !== null && ratio > 0 ? ratio : 1,
    ...(elutionStartCv !== null && elutionStartCv >= 0 ? { elutionStartCv } : {}),
    ...(elutionEndCv !== null && elutionEndCv >= 0 ? { elutionEndCv } : {}),
  };
  if (typeof r.appearance === "string" && r.appearance !== "") product.appearance = r.appearance;
  return product;
}

function normaliseGradientPoint(raw: unknown): GradientPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof GradientPoint, unknown>>;
  const cv = looseNumber(r.cv);
  const percentB = looseNumber(r.percentB);
  if (cv === null || percentB === null) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    cv: Math.max(0, cv),
    percentB: Math.min(100, Math.max(0, percentB)),
  };
}

function normalisePurificationGradient(raw: unknown): PurificationGradient | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Partial<Record<keyof PurificationGradient, unknown>>;
  const points = Array.isArray(g.points)
    ? g.points
        .map(normaliseGradientPoint)
        .filter((p): p is GradientPoint => p !== null)
        .sort((a, b) => a.cv - b.cv)
    : [];
  const equil = looseNumber(g.equilibrationCv);
  const columnSize = typeof g.columnSize === "string" ? g.columnSize : "";
  const solventA = typeof g.solventA === "string" ? g.solventA : "Cyclohexane";
  const solventB = typeof g.solventB === "string" ? g.solventB : "EtOAc";
  const fractionTlcImage =
    typeof g.fractionTlcImage === "string" && g.fractionTlcImage.startsWith("data:image/")
      ? g.fractionTlcImage
      : undefined;

  let productWindow: PurificationGradient["productWindow"];
  if (g.productWindow && typeof g.productWindow === "object") {
    const pw = g.productWindow as Record<string, unknown>;
    const startCv = looseNumber(pw.startCv);
    const endCv = looseNumber(pw.endCv);
    if (startCv !== null && endCv !== null && startCv >= 0 && endCv >= startCv) {
      productWindow = {
        startCv,
        endCv,
        ...(typeof pw.label === "string" && pw.label.trim() !== ""
          ? { label: pw.label.trim() }
          : {}),
      };
    }
  }

  return {
    enabled: g.enabled === true,
    ...(columnSize ? { columnSize } : {}),
    ...(equil !== null && equil >= 0 ? { equilibrationCv: equil } : {}),
    solventA,
    solventB,
    points,
    ...(productWindow ? { productWindow } : {}),
    ...(fractionTlcImage ? { fractionTlcImage } : {}),
  };
}

function normaliseStructuredScheme(raw: unknown): StructuredReactionScheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Partial<Record<keyof StructuredReactionScheme, unknown>>;
  const out: StructuredReactionScheme = {};
  if (typeof s.reactantImage === "string" && s.reactantImage.startsWith("data:image/")) {
    out.reactantImage = s.reactantImage;
  }
  if (typeof s.reactantCdxml === "string" && s.reactantCdxml.trim() !== "") {
    out.reactantCdxml = s.reactantCdxml;
  }
  if (typeof s.productImage === "string" && s.productImage.startsWith("data:image/")) {
    out.productImage = s.productImage;
  }
  if (typeof s.productCdxml === "string" && s.productCdxml.trim() !== "") {
    out.productCdxml = s.productCdxml;
  }
  if (typeof s.solvent === "string" && s.solvent.trim() !== "") {
    out.solvent = s.solvent;
  }
  if (typeof s.temperature === "string" && s.temperature.trim() !== "") {
    out.temperature = s.temperature;
  }
  if (typeof s.duration === "string" && s.duration.trim() !== "") {
    out.duration = s.duration;
  }
  if (typeof s.atmosphere === "string" && s.atmosphere.trim() !== "") {
    out.atmosphere = s.atmosphere;
  }
  if (typeof s.extraArrowNotes === "string" && s.extraArrowNotes.trim() !== "") {
    out.extraArrowNotes = s.extraArrowNotes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Fill defaults / drop junk so older or hand-edited data always has the current shape. */
export function normaliseExperiment(raw: Partial<Experiment>): Experiment | null {
  if (!raw || typeof raw.id !== "string") return null;
  const units = { ...DEFAULT_UNITS };
  for (const kind of Object.keys(UNIT_OPTIONS) as UnitKind[]) {
    const stored = raw.units?.[kind];
    if ((UNIT_OPTIONS[kind] as readonly string[]).includes(stored as string)) {
      (units as Record<UnitKind, string>)[kind] = stored as string;
    }
  }
  const columns = { ...DEFAULT_COLUMNS };
  for (const key of COLUMN_KEYS) {
    const visible = raw.columns?.[key];
    if (typeof visible === "boolean") columns[key] = visible;
  }
  const secondary = Array.isArray(raw.secondaryProducts)
    ? raw.secondaryProducts
        .map(normaliseSecondary)
        .filter((p): p is SecondaryProduct => p !== null)
        .map((p, i) => (p.name.trim() === "" ? { ...p, name: `${raw.id}-F${i + 2}` } : p))
    : [];
  const product = normaliseProduct(raw.product);
  const trimmedName = product.name.trim();
  const idUpper = raw.id.toUpperCase();
  if (secondary.length > 0) {
    if (trimmedName === "" || trimmedName.toUpperCase() === idUpper) {
      product.name = `${raw.id}-F1`;
    }
  } else if (trimmedName === "" || trimmedName.toUpperCase() === `${idUpper}-F1`) {
    product.name = raw.id;
  }

  const purificationGradient = normalisePurificationGradient(raw.purificationGradient);
  const structuredScheme = normaliseStructuredScheme(raw.structuredScheme);

  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    dateCreated:
      typeof raw.dateCreated === "string" ? raw.dateCreated : new Date().toISOString(),
    reactionSchemeRxn:
      typeof raw.reactionSchemeRxn === "string" ? raw.reactionSchemeRxn : "",
    moleculeMode: MOLECULE_MODES.includes(raw.moleculeMode as never)
      ? (raw.moleculeMode as MoleculeMode)
      : "draw",
    moleculeImage: raw.moleculeImage === true,
    ...(structuredScheme ? { structuredScheme } : {}),
    procedureText: typeof raw.procedureText === "string" ? raw.procedureText : "",
    purificationText: typeof raw.purificationText === "string" ? raw.purificationText : "",
    ...(purificationGradient ? { purificationGradient } : {}),
    commentsText: typeof raw.commentsText === "string" ? raw.commentsText : "",
    reagents: Array.isArray(raw.reagents) ? raw.reagents.map(normaliseRow) : [],
    product,
    // Only present when the experiment has some: single-product experiments stay exactly as they were.
    ...(secondary.length > 0 ? { secondaryProducts: secondary } : {}),
    tlcImages: Array.isArray(raw.tlcImages)
      ? raw.tlcImages.filter((s): s is string => typeof s === "string")
      : [],
    references: Array.isArray(raw.references)
      ? raw.references.map(normaliseReference).filter((r): r is Reference => r !== null)
      : [],
    units,
    columns,
  };
}

function readFromStorage(): Experiment[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => normaliseExperiment(e as Partial<Experiment>))
      .filter((e): e is Experiment => e !== null);
  } catch {
    return [];
  }
}

function writeToStorage(list: Experiment[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// --- Public storage API (disk in Tauri, localStorage in a plain browser) ------

/** Load every experiment. Corrupt / unreadable files are skipped, not fatal. */
export async function getAllExperiments(): Promise<Experiment[]> {
  if (!isTauri()) return readFromStorage();

  await initStorage();
  const dir = await getExperimentsDir();
  const entries = await readDir(dir);

  const loaded = await Promise.all(
    entries
      .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".json"))
      .map(async (e) => {
        try {
          const raw: unknown = JSON.parse(await readTextFile(await path.join(dir, e.name)));
          return normaliseExperiment(raw as Partial<Experiment>);
        } catch (err) {
          console.warn(`Skipping unreadable experiment file ${e.name}:`, err);
          return null;
        }
      }),
  );

  return loaded
    .filter((e): e is Experiment => e !== null)
    .sort(
      (a, b) =>
        a.dateCreated.localeCompare(b.dateCreated) || a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
}

/** Create or overwrite one experiment (`experiments/[id].json`). */
export async function saveExperiment(experiment: Experiment): Promise<void> {
  if (!isTauri()) {
    const rest = readFromStorage().filter((e) => e.id !== experiment.id);
    writeToStorage([...rest, experiment]);
    return;
  }
  await initStorage();
  await writeTextFile(await experimentFilePath(experiment.id), JSON.stringify(experiment, null, 2));
}

/**
 * Delete one experiment and its attachments folder (`attachments/[id]/`, which holds the
 * NMR workspace). Deleting one that doesn't exist is not an error, and a failure to clean
 * up attachments never fails the deletion itself.
 */
export async function deleteExperiment(id: string): Promise<void> {
  if (!isTauri()) {
    writeToStorage(readFromStorage().filter((e) => e.id !== id));
    try {
      window.localStorage.removeItem(nmrStateKey(id));
      window.localStorage.removeItem(moleculeImageKey(id));
    } catch {
      // Storage unavailable - nothing to clean up.
    }
    return;
  }
  try {
    await removeFile(await experimentFilePath(id));
  } catch (err) {
    // Already gone (or never written) - nothing to delete.
    if (!isNotFound(err)) throw err;
  }

  try {
    await removeAttachments(id);
  } catch (err) {
    // No attachments folder (the usual case) or it couldn't be removed: don't block deletion.
    console.warn(`Could not remove attachments for ${id}:`, err);
  }
}

/**
 * Remove everything stored next to an experiment (NMR workspace, molecule picture, scheme.cdxml).
 * Nothing to remove is not an error.
 */
export async function removeAttachments(id: string): Promise<void> {
  if (!isTauri()) {
    try {
      window.localStorage.removeItem(nmrStateKey(id));
      window.localStorage.removeItem(moleculeImageKey(id));
    } catch {
      // Storage unavailable - nothing to clean up.
    }
    return;
  }
  try {
    await removeFile(await getNmrDir(id), { recursive: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

// --- NMRium workspace state -----------------------------------------------------
// Desktop: Documents/Fumebook/attachments/[experimentId]/workspace.nmrium
// Browser: localStorage (one key per experiment; large, so it may hit the quota).

const NMR_STATE_FILE = "workspace.nmrium";
const nmrStateKey = (experimentId: string) => `chem-eln:nmr-state:v1:${experimentId}`;

async function getNmrDir(experimentId: string): Promise<string> {
  return path.join(await getAttachmentsDir(), safeName(experimentId));
}

/** Save the serialized NMRium workspace for an experiment (overwrites the previous one). */
export async function saveNmrState(experimentId: string, stateString: string): Promise<void> {
  if (!isTauri()) {
    window.localStorage.setItem(nmrStateKey(experimentId), stateString);
    return;
  }
  const dir = await getNmrDir(experimentId);
  await mkdir(dir, { recursive: true });
  await writeTextFile(await path.join(dir, NMR_STATE_FILE), stateString);
}

/** Read the saved NMRium workspace, or `null` if this experiment has none yet. */
export async function loadNmrState(experimentId: string): Promise<string | null> {
  if (!isTauri()) return window.localStorage.getItem(nmrStateKey(experimentId));
  try {
    return await readTextFile(await path.join(await getNmrDir(experimentId), NMR_STATE_FILE));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// --- Molecule picture ("Upload Image" mode) -------------------------------------
// Desktop: Documents/Fumebook/attachments/[experimentId]/molecule.png (or molecule.svg for vector SVGs)
// Browser: a data URL in localStorage (one key per experiment).

const MOLECULE_IMAGE_FILE = "molecule.png";
const MOLECULE_SVG_FILE = "molecule.svg";
const moleculeImageKey = (experimentId: string) => `chem-eln:molecule-image:v1:${experimentId}`;

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** Save the molecule picture (a lossless PNG or vector SVG) for an experiment, replacing any previous one. */
export async function saveMoleculeImage(experimentId: string, image: Blob): Promise<void> {
  if (!isTauri()) {
    window.localStorage.setItem(moleculeImageKey(experimentId), await blobToDataUrl(image));
    return;
  }
  const dir = await getNmrDir(experimentId);
  await mkdir(dir, { recursive: true });
  const isSvg = image.type === "image/svg+xml";
  const targetFile = isSvg ? MOLECULE_SVG_FILE : MOLECULE_IMAGE_FILE;
  const staleFile = isSvg ? MOLECULE_IMAGE_FILE : MOLECULE_SVG_FILE;
  await writeFile(await path.join(dir, targetFile), new Uint8Array(await image.arrayBuffer()));
  try {
    await removeFile(await path.join(dir, staleFile));
  } catch {
    // Nothing to remove or locked: ignored.
  }
}

/** Read the saved molecule picture (vector SVG or PNG), or `null` if there is none. */
export async function loadMoleculeImage(experimentId: string): Promise<Blob | null> {
  if (!isTauri()) {
    const url = window.localStorage.getItem(moleculeImageKey(experimentId));
    return url ? (await fetch(url)).blob() : null;
  }
  const dir = await getNmrDir(experimentId);
  try {
    const svgText = await readTextFile(await path.join(dir, MOLECULE_SVG_FILE));
    return new Blob([svgText], { type: "image/svg+xml" });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    const bytes = await readFile(await path.join(dir, MOLECULE_IMAGE_FILE));
    return new Blob([bytes], { type: "image/png" });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Delete the saved molecule picture. Nothing to delete is not an error. */
export async function removeMoleculeImage(experimentId: string): Promise<void> {
  if (!isTauri()) {
    window.localStorage.removeItem(moleculeImageKey(experimentId));
    return;
  }
  const dir = await getNmrDir(experimentId);
  for (const name of [MOLECULE_SVG_FILE, MOLECULE_IMAGE_FILE]) {
    try {
      await removeFile(await path.join(dir, name));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/**
 * Windows "os error 32": the file is held open by another process (ChemDraw, antivirus, the
 * search indexer, a preview pane...), usually only for a moment during save or scan.
 */
export const isFileLocked = (e: unknown) =>
  /os error 32\b|os error 5\b|being used by another process|sharing violation|access is denied/i.test(
    errorMessage(e),
  );

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry a file operation with exponential backoff (default: 3 retries with 50ms, 100ms, 200ms
 * pauses) whenever the OS reports a transient file lock (`os error 32`).
 */
export async function withFileRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [50, 100, 200],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!isFileLocked(err) || attempt === delaysMs.length) {
        throw err;
      }
      await sleep(delaysMs[attempt]);
    }
  }
  throw lastError;
}

/**
 * Remove the files the app keeps in `attachments/[id]/`, one by one, ignoring every failure
 * (locked files included). The fallback when removing the whole folder was refused.
 */
export async function removeAttachmentFilesQuietly(id: string): Promise<void> {
  if (!isTauri()) {
    await removeAttachments(id);
    return;
  }
  const dir = await getNmrDir(id);
  for (const name of [
    MOLECULE_IMAGE_FILE,
    MOLECULE_SVG_FILE,
    NMR_STATE_FILE,
    CDXML_FILES.scheme,
    CDXML_FILES.reactant,
    CDXML_FILES.product,
  ]) {
    try {
      await removeFile(await path.join(dir, name));
    } catch {
      // Missing, locked or protected: whatever is left is overwritten in place later.
    }
  }
}

// --- ChemDraw round trip (desktop only) ------------------------------------------
// Documents/Fumebook/attachments/[experimentId]/scheme.cdxml (or reactant.cdxml / product.cdxml)

export type CdxmlSlot = "scheme" | "reactant" | "product";

const CDXML_FILES: Record<CdxmlSlot, string> = {
  scheme: "scheme.cdxml",
  reactant: "reactant.cdxml",
  product: "product.cdxml",
};

export async function schemeCdxmlPath(
  experimentId: string,
  slot: CdxmlSlot = "scheme",
): Promise<string> {
  return path.join(await getNmrDir(experimentId), CDXML_FILES[slot]);
}

export interface SchemeCdxmlFile {
  path: string;
  text: string;
  /** Last modification time in ms since the epoch (0 if the OS did not report one). */
  modifiedMs: number;
}

/**
 * Write `scheme.cdxml` (or `reactant.cdxml` / `product.cdxml`) with exponential backoff retries
 * and return its full path plus the modification time the OS recorded.
 */
export async function saveSchemeCdxml(
  experimentId: string,
  cdxml: string,
  slot: CdxmlSlot = "scheme",
): Promise<{ path: string; modifiedMs: number }> {
  const dir = await getNmrDir(experimentId);
  await mkdir(dir, { recursive: true });
  const file = await schemeCdxmlPath(experimentId, slot);
  await withFileRetry(() => writeTextFile(file, cdxml), [50, 100, 200]);
  // Brief settle pause so the write handle is completely released before stat / cmd start.
  await sleep(20);
  const info = await withFileRetry(() => stat(file), [50, 100, 200]);
  return { path: file, modifiedMs: info.mtime?.getTime() ?? Date.now() };
}

/** Modification time of `scheme.cdxml` in ms, or `null` if there is no such file. */
export async function schemeCdxmlModified(
  experimentId: string,
  slot: CdxmlSlot = "scheme",
): Promise<number | null> {
  const file = await schemeCdxmlPath(experimentId, slot);
  try {
    const info = await withFileRetry(() => stat(file), [50, 100, 200]);
    return info.mtime?.getTime() ?? 0;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read `scheme.cdxml` (or `reactant.cdxml` / `product.cdxml`) with exponential backoff retries,
 * or `null` if it does not exist yet. If ChemDraw is mid-save (file locked or not yet flushed
 * through `</CDXML>`), retries at 50ms, 100ms, 200ms pauses.
 */
export async function loadSchemeCdxml(
  experimentId: string,
  slot: CdxmlSlot = "scheme",
): Promise<SchemeCdxmlFile | null> {
  const file = await schemeCdxmlPath(experimentId, slot);
  try {
    return await withFileRetry(
      async () => {
        const text = await readTextFile(file);
        if (text.trim() === "" || (/<CDXML[\s>]/i.test(text) && !/<\/CDXML>/i.test(text))) {
          throw new Error("os error 32: CDXML file is still being written by ChemDraw.");
        }
        const info = await stat(file);
        return {
          path: file,
          text,
          modifiedMs: info.mtime?.getTime() ?? Date.now(),
        };
      },
      [50, 100, 200],
    );
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// --- Persisting -------------------------------------------------------------

/** Tauri mode: only the experiments that changed since the last write hit the disk. */
const dirty = new Map<string, Experiment>();
const removedIds = new Set<string>();
let diskQueue: Promise<boolean> = Promise.resolve(true);

function trackChanges(prev: Experiment[], next: Experiment[]) {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  const nextIds = new Set<string>();
  for (const exp of next) {
    nextIds.add(exp.id);
    if (prevById.get(exp.id) !== exp) {
      dirty.set(exp.id, exp);
      removedIds.delete(exp.id);
    }
  }
  for (const id of prevById.keys()) {
    if (!nextIds.has(id)) {
      dirty.delete(id);
      removedIds.add(id);
    }
  }
}

function setPersistError(message: string | null) {
  if (persistError === message) return;
  persistError = message;
  emit();
}

/** Write pending changes to disk. Writes are serialised so they can't interleave. */
function flushToDisk(): Promise<boolean> {
  const toWrite = [...dirty.values()];
  const toRemove = [...removedIds];
  dirty.clear();
  removedIds.clear();

  diskQueue = diskQueue.then(async () => {
    let firstError: unknown = null;

    for (const exp of toWrite) {
      try {
        await saveExperiment(exp);
      } catch (err) {
        firstError ??= err;
        // Keep it queued for the next flush unless a newer version arrived meanwhile.
        if (!dirty.has(exp.id) && !removedIds.has(exp.id)) dirty.set(exp.id, exp);
      }
    }
    for (const id of toRemove) {
      try {
        await deleteExperiment(id);
      } catch (err) {
        firstError ??= err;
        if (!dirty.has(id)) removedIds.add(id);
      }
    }

    if (firstError) {
      setPersistError(
        `Could not save to Documents/${APP_DIR_NAME}/${EXPERIMENTS_DIR_NAME}: ${errorMessage(firstError)}. ` +
          "Your latest changes are not saved yet.",
      );
      return false;
    }
    setPersistError(null);
    return true;
  });
  return diskQueue;
}

/** Write the cache to localStorage now. Returns false if the browser refused (quota etc.). */
function flushToBrowser(): boolean {
  if (cache === null) return true;
  try {
    writeToStorage(cache);
    setPersistError(null);
    return true;
  } catch {
    setPersistError(
      "Browser storage is full or unavailable - your latest changes are not saved. " +
        "Remove some TLC images or delete old experiments.",
    );
    return false;
  }
}

/** Persist pending changes now. Resolves to false if they could not be stored. */
function flush(): Promise<boolean> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return isTauri() ? flushToDisk() : Promise.resolve(flushToBrowser());
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flush(), PERSIST_DELAY_MS);
}

function setExperiments(next: Experiment[]) {
  if (isTauri()) trackChanges(cache ?? [], next);
  cache = next;
  emit();
  schedulePersist();
}

// --- Initial load (Tauri is async; the browser path is synchronous) ----------

let diskLoadStarted = false;

function startDiskLoad() {
  if (diskLoadStarted) return;
  diskLoadStarted = true;
  getAllExperiments()
    .then((list) => {
      if (cache === null) cache = list;
      emit();
    })
    .catch((err) => {
      if (cache === null) cache = [];
      persistError =
        `Could not read Documents/${APP_DIR_NAME}/${EXPERIMENTS_DIR_NAME}: ${errorMessage(err)}`;
      emit();
    });
}

// --- useSyncExternalStore plumbing ------------------------------------------

function subscribe(listener: () => void) {
  listeners.add(listener);

  const onStorage = (e: StorageEvent) => {
    // Another tab changed the data (browser fallback only; disk mode has one window).
    if (!isTauri() && (e.key === STORAGE_KEY || e.key === null)) {
      cache = null;
      emit();
    }
  };
  const onHide = () => void flush();
  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onHide);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onHide);
  };
}

function getSnapshot(): Experiment[] | null {
  if (cache === null) {
    if (isTauri()) startDiskLoad(); // snapshot stays null until the files are read
    else cache = readFromStorage();
  }
  return cache;
}

const getServerSnapshot = (): Experiment[] | null => null;
const getErrorSnapshot = () => persistError;
const getServerErrorSnapshot = () => null;

// --- Public hook --------------------------------------------------------------

export type ExperimentUpdate =
  | Partial<Experiment>
  | ((current: Experiment) => Partial<Experiment>);

export function useExperiments() {
  const experiments = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const storageError = useSyncExternalStore(
    subscribe,
    getErrorSnapshot,
    getServerErrorSnapshot,
  );

  const create = useCallback((): Experiment => {
    const current = getSnapshot() ?? [];
    const created = newExperiment(current);
    setExperiments([...current, created]);
    return created;
  }, []);

  const update = useCallback((id: string, change: ExperimentUpdate) => {
    const current = getSnapshot() ?? [];
    setExperiments(
      current.map((exp) => {
        if (exp.id !== id) return exp;
        const patch = typeof change === "function" ? change(exp) : change;
        return { ...exp, ...patch, id: exp.id };
      }),
    );
  }, []);

  const remove = useCallback((id: string) => {
    const current = getSnapshot() ?? [];
    setExperiments(current.filter((exp) => exp.id !== id));
  }, []);

  /**
   * Swap in a whole new experiment list (backup import) and write it out
   * immediately. Resolves to false if it could not be stored. Pass a function to build the
   * list from the experiments as they are *now* (not as they were when the import started).
   */
  const replaceAll = useCallback(
    (next: Experiment[] | ((current: Experiment[]) => Experiment[])): Promise<boolean> => {
      setExperiments(typeof next === "function" ? next(getSnapshot() ?? []) : next);
      return flush();
    },
    [],
  );

  return { experiments, storageError, create, update, remove, replaceAll };
}

// --- Purification Gradient Presets (`fumebook_gradient_presets`) --------------

export const GRADIENT_PRESETS_STORAGE_KEY = "fumebook_gradient_presets";

export interface GradientPresetPoint {
  cv: number;
  percentB: number;
}

export interface GradientPreset {
  id: string;
  name: string;
  columnSize?: string;
  solventA: string;
  solventB: string;
  equilibrationCv?: number;
  points: GradientPresetPoint[];
}

const DEFAULT_GRADIENT_PRESETS: GradientPreset[] = [
  {
    id: "preset-std-0-20-etoac",
    name: "Standard 0–20% EtOAc over 10 CV",
    solventA: "Cyclohexane",
    solventB: "EtOAc",
    equilibrationCv: 3,
    points: [
      { cv: 0, percentB: 0 },
      { cv: 3, percentB: 0 },
      { cv: 13, percentB: 20 },
    ],
  },
  {
    id: "preset-steep-0-50-etoac",
    name: "Steep 0–50% Gradient",
    solventA: "Cyclohexane",
    solventB: "EtOAc",
    equilibrationCv: 3,
    points: [
      { cv: 0, percentB: 0 },
      { cv: 2, percentB: 0 },
      { cv: 12, percentB: 50 },
    ],
  },
  {
    id: "preset-iso-5-meoh",
    name: "Isocratic 5% MeOH",
    solventA: "DCM",
    solventB: "MeOH",
    equilibrationCv: 3,
    points: [
      { cv: 0, percentB: 5 },
      { cv: 12, percentB: 5 },
    ],
  },
];

let gradientPresetsCache: GradientPreset[] | null = null;
const gradientPresetListeners = new Set<() => void>();
const emitGradientPresets = () => gradientPresetListeners.forEach((l) => l());

function normaliseGradientPreset(raw: unknown): GradientPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<GradientPreset>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  const points: GradientPresetPoint[] = Array.isArray(r.points)
    ? r.points
        .map((pt) => {
          if (!pt || typeof pt !== "object") return null;
          const p = pt as Partial<GradientPresetPoint>;
          const cv = looseNumber(p.cv);
          const percentB = looseNumber(p.percentB);
          if (cv === null || cv < 0 || percentB === null) return null;
          return {
            cv,
            percentB: Math.min(100, Math.max(0, percentB)),
          };
        })
        .filter((pt): pt is GradientPresetPoint => pt !== null)
    : [];
  if (points.length === 0) return null;
  const eq = looseNumber(r.equilibrationCv);
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    name,
    ...(typeof r.columnSize === "string" && r.columnSize.trim()
      ? { columnSize: r.columnSize.trim() }
      : {}),
    solventA: typeof r.solventA === "string" ? r.solventA : "Cyclohexane",
    solventB: typeof r.solventB === "string" ? r.solventB : "EtOAc",
    ...(eq !== null && eq >= 0 ? { equilibrationCv: eq } : {}),
    points,
  };
}

export function loadGradientPresets(): GradientPreset[] {
  if (typeof window === "undefined") return DEFAULT_GRADIENT_PRESETS;
  try {
    const raw = window.localStorage.getItem(GRADIENT_PRESETS_STORAGE_KEY);
    if (raw === null) {
      window.localStorage.setItem(
        GRADIENT_PRESETS_STORAGE_KEY,
        JSON.stringify(DEFAULT_GRADIENT_PRESETS),
      );
      return DEFAULT_GRADIENT_PRESETS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_GRADIENT_PRESETS;
    return parsed
      .map(normaliseGradientPreset)
      .filter((p): p is GradientPreset => p !== null);
  } catch {
    return DEFAULT_GRADIENT_PRESETS;
  }
}

function writeGradientPresets(next: GradientPreset[]) {
  gradientPresetsCache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(GRADIENT_PRESETS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors
    }
  }
  emitGradientPresets();
}

export function saveGradientPreset(input: {
  name: string;
  columnSize?: string;
  solventA: string;
  solventB: string;
  equilibrationCv?: number;
  points: GradientPresetPoint[];
}): GradientPreset {
  const current = gradientPresetsCache ?? loadGradientPresets();
  const trimmedName = input.name.trim() || "Custom Gradient";
  const existingIdx = current.findIndex(
    (p) => p.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const preset: GradientPreset = {
    id: existingIdx >= 0 ? current[existingIdx].id : uid(),
    name: trimmedName,
    ...(input.columnSize?.trim() ? { columnSize: input.columnSize.trim() } : {}),
    solventA: input.solventA.trim() || "Cyclohexane",
    solventB: input.solventB.trim() || "EtOAc",
    ...(input.equilibrationCv !== undefined && input.equilibrationCv >= 0
      ? { equilibrationCv: input.equilibrationCv }
      : {}),
    points: input.points.map((pt) => ({
      cv: Math.max(0, pt.cv),
      percentB: Math.min(100, Math.max(0, pt.percentB)),
    })),
  };
  const next =
    existingIdx >= 0
      ? current.map((p, idx) => (idx === existingIdx ? preset : p))
      : [preset, ...current];
  writeGradientPresets(next);
  return preset;
}

export function deleteGradientPreset(id: string): void {
  const current = gradientPresetsCache ?? loadGradientPresets();
  writeGradientPresets(current.filter((p) => p.id !== id));
}

function subscribeGradientPresets(listener: () => void) {
  gradientPresetListeners.add(listener);
  return () => {
    gradientPresetListeners.delete(listener);
  };
}

function getGradientPresetsSnapshot(): GradientPreset[] {
  if (gradientPresetsCache === null) {
    gradientPresetsCache = loadGradientPresets();
  }
  return gradientPresetsCache;
}

const getGradientPresetsServerSnapshot = (): GradientPreset[] => DEFAULT_GRADIENT_PRESETS;

export function useGradientPresets() {
  const presets = useSyncExternalStore(
    subscribeGradientPresets,
    getGradientPresetsSnapshot,
    getGradientPresetsServerSnapshot,
  );
  return {
    presets,
    savePreset: saveGradientPreset,
    deletePreset: deleteGradientPreset,
  };
}
