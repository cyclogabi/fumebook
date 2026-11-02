/**
 * Backup / restore of the notebook, attachments included.
 *
 * Two file formats, both plain JSON, both read by the same parser:
 *
 *  - ExperimentBundle ("fumebook-experiment"): ONE experiment with everything that belongs to it.
 *  - FullBackupBundle ("fumebook-backup"): every ExperimentBundle plus the Personal Library and the
 *    profile (initials + starting number).
 *
 * An experiment's own JSON (`experiments/[id].json`) holds the reagents, texts, product / yield,
 * references, Ketcher scheme, units / columns and the TLC photos (base64 data URLs). The other
 * attachments live in `attachments/[id]/` and are embedded here so a bundle is self-contained:
 *
 *   moleculeImageBase64  <- attachments/[id]/molecule.png   (data URL)
 *   nmrWorkspace         <- attachments/[id]/workspace.nmrium (the NMRium workspace JSON, as text:
 *                           exactly what NmrWorkspace wrote, so restoring it is byte-for-byte)
 *   tlcImages            <- the experiment's TLC photos (they are not files: the app keeps them in
 *                           the experiment JSON, so a bundle moves them out of `experiment` into
 *                           this array instead of storing them twice)
 *
 * Older files are still understood: the v1 envelope `{ version: 1, experiments: [Experiment] }` (no
 * attachments) and a bare experiment JSON.
 *
 * Imported data is validated strictly against the shapes in ./types before it is allowed anywhere
 * near storage, then normalised with the same code that loads the experiment files.
 */

import {
  blobToDataUrl,
  isFileLocked,
  loadMoleculeImage,
  loadNmrState,
  normaliseExperiment,
  removeAttachmentFilesQuietly,
  removeAttachments,
  saveMoleculeImage,
  saveNmrState,
} from "./storage";
import {
  isValidInitials,
  isValidStartNumber,
  readInitials,
  readStartNumber,
  START_NUMBER_DEFAULT,
} from "./initials";
import { withAiReactionData } from "./aiReaction";
import { getLibraryCompounds, loadLibrary, normaliseCompounds, type LibraryCompound } from "./library";
import {
  COLUMN_KEYS,
  PRODUCT_MASS_UNITS,
  ROLES,
  UNIT_OPTIONS,
  type Experiment,
  type UnitKind,
} from "./types";

export const BACKUP_VERSION = 2;
/** Refuse absurd files before parsing them (bundles carry images and NMR spectra, so this is generous). */
export const MAX_BACKUP_BYTES = 500 * 1024 * 1024;

export const EXPERIMENT_FORMAT = "fumebook-experiment";
export const BACKUP_FORMAT = "fumebook-backup";

/** The files an experiment owns besides its JSON (the TLC photos stay in the experiment). */
export interface ExperimentAttachments {
  /** `data:image/png;base64,...` of `molecule.png`, or null if there is none. */
  moleculeImageBase64: string | null;
  /** The saved NMRium workspace (JSON text), or null if there is none. */
  nmrWorkspace: string | null;
}

export interface ExperimentBundle extends ExperimentAttachments {
  format: typeof EXPERIMENT_FORMAT;
  version: number;
  exportedAt: string;
  /** The experiment; its `tlcImages` are empty here, the photos are in `tlcImages` below. */
  experiment: Experiment;
  /** TLC plate photos (data URLs). */
  tlcImages: string[];
}

export interface BackupProfile {
  initials: string | null;
  startNumber: number;
}

export interface FullBackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  experiments: ExperimentBundle[];
  library: LibraryCompound[];
  profile: BackupProfile;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Building ------------------------------------------------------------------

/** One experiment with its molecule picture, TLC photos and NMR workspace embedded. */
export async function buildExperimentBundle(
  experiment: Experiment,
  now = new Date(),
  library?: readonly LibraryCompound[],
): Promise<ExperimentBundle> {
  let moleculeImageBase64: string | null = null;
  let nmrWorkspace: string | null = null;
  try {
    const png = await loadMoleculeImage(experiment.id);
    moleculeImageBase64 = png ? await blobToDataUrl(png) : null;
  } catch (err) {
    throw new Error(`The molecule picture of ${experiment.id} could not be read: ${messageOf(err)}`);
  }
  try {
    nmrWorkspace = await loadNmrState(experiment.id);
  } catch (err) {
    throw new Error(`The NMR workspace of ${experiment.id} could not be read: ${messageOf(err)}`);
  }
  let compounds: readonly LibraryCompound[];
  if (library) {
    compounds = library;
  } else {
    try {
      compounds = await loadLibrary();
    } catch {
      compounds = getLibraryCompounds();
    }
  }
  const prepared = withAiReactionData(experiment, compounds);
  return {
    format: EXPERIMENT_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    experiment: { ...prepared, moleculeImage: moleculeImageBase64 !== null, tlcImages: [] },
    moleculeImageBase64,
    tlcImages: experiment.tlcImages,
    nmrWorkspace,
  };
}

/** Every experiment (with attachments), the whole Personal Library and the profile. */
export async function buildFullBackup(
  experiments: Experiment[],
  now = new Date(),
): Promise<FullBackupBundle> {
  let library: LibraryCompound[];
  try {
    library = await loadLibrary();
  } catch (err) {
    throw new Error(`The Personal Library could not be read: ${messageOf(err)}`);
  }
  const bundles: ExperimentBundle[] = [];
  for (const experiment of experiments) {
    bundles.push(await buildExperimentBundle(experiment, now, library));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    experiments: bundles,
    library,
    profile: { initials: readInitials(), startNumber: readStartNumber() },
  };
}

/** Local calendar date, YYYY-MM-DD (not UTC, so late-evening exports get today's date). */
function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** fumebook_backup_YYYY-MM-DD.json */
export const backupFilename = (now = new Date()) => `fumebook_backup_${localDate(now)}.json`;

/** fumebook_backup_YYYY-MM-DD_pre-restore_HHMMSS.json: unique, so a second one never overwrites the first. */
export function preRestoreFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `fumebook_backup_${localDate(now)}_pre-restore_${time}.json`;
}

/** GH001_experiment.fumebook.json */
export const experimentFilename = (experiment: Pick<Experiment, "id">) =>
  `${experiment.id.replace(/[^A-Za-z0-9_.-]/g, "_")}_experiment.fumebook.json`;

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

  const numberOrText = (v: unknown) =>
    v === undefined || v === null || isStr(v) || (typeof v === "number" && Number.isFinite(v));

  if (raw.product !== undefined) {
    const p = raw.product;
    if (!isObj(p)) return "product must be an object";
    if (!optStr(p.name)) return "product name must be text";
    if (!optNum(p.mw) || !optNum(p.isolatedMass)) return "product numbers must be numeric";
    if (p.massUnit !== undefined && !PRODUCT_MASS_UNITS.includes(p.massUnit as never)) {
      return "unknown product mass unit";
    }
    if (!numberOrText(p.stoichRatio)) return "product stoichRatio must be numeric";
    if (!numberOrText(p.elutionStartCv) || !numberOrText(p.elutionEndCv)) {
      return "product elution CV window must be numeric";
    }
  }

  if (raw.secondaryProducts !== undefined) {
    if (!Array.isArray(raw.secondaryProducts)) return "secondaryProducts must be a list";
    for (const [i, p] of raw.secondaryProducts.entries()) {
      const n = `secondary product ${i + 1}`;
      if (!isObj(p)) return `${n} is not an object`;
      if (!optStr(p.id) || !optStr(p.name) || !optStr(p.appearance)) return `${n} must have text fields`;
      if (!numberOrText(p.mw) || !numberOrText(p.mass)) return `${n}: mw and mass must be numbers`;
      if (p.massUnit !== undefined && !PRODUCT_MASS_UNITS.includes(p.massUnit as never)) {
        return `${n} has an unknown mass unit`;
      }
      if (p.stoichRatio !== undefined && p.stoichRatio !== null && !numberOrText(p.stoichRatio)) {
        return `${n}: stoichRatio must be a number`;
      }
      if (!numberOrText(p.elutionStartCv) || !numberOrText(p.elutionEndCv)) {
        return `${n}: elution CV window must be numeric`;
      }
    }
  }

  if (raw.purificationGradient !== undefined && raw.purificationGradient !== null) {
    const g = raw.purificationGradient;
    if (!isObj(g)) return "purificationGradient must be an object";
    if (g.enabled !== undefined && typeof g.enabled !== "boolean") {
      return "purificationGradient.enabled must be true or false";
    }
    if (!optStr(g.columnSize) || !optStr(g.solventA) || !optStr(g.solventB)) {
      return "purificationGradient text fields must be strings";
    }
    if (!optNum(g.equilibrationCv)) {
      return "purificationGradient.equilibrationCv must be a number";
    }
    if (g.points !== undefined) {
      if (!Array.isArray(g.points)) return "purificationGradient.points must be a list";
      for (const [i, pt] of g.points.entries()) {
        if (!isObj(pt)) return `gradient point ${i + 1} is not an object`;
        if (!optStr(pt.id)) return `gradient point ${i + 1} has an invalid id`;
        if (!optNum(pt.cv) || !optNum(pt.percentB)) {
          return `gradient point ${i + 1}: cv and percentB must be numbers`;
        }
      }
    }
    if (g.productWindow !== undefined && g.productWindow !== null) {
      if (!isObj(g.productWindow)) return "purificationGradient.productWindow must be an object";
      if (
        !optNum(g.productWindow.startCv) ||
        !optNum(g.productWindow.endCv) ||
        !optStr(g.productWindow.label)
      ) {
        return "purificationGradient.productWindow has invalid fields";
      }
    }
    if (g.fractionTlcImage !== undefined && g.fractionTlcImage !== null && g.fractionTlcImage !== "") {
      if (!isStr(g.fractionTlcImage) || !g.fractionTlcImage.startsWith("data:image/")) {
        return "purificationGradient.fractionTlcImage must be an embedded image";
      }
    }
  }

  if (raw.structuredScheme !== undefined && raw.structuredScheme !== null) {
    const s = raw.structuredScheme;
    if (!isObj(s)) return "structuredScheme must be an object";
    for (const imgField of ["reactantImage", "productImage"] as const) {
      const val = s[imgField];
      if (val !== undefined && val !== null && val !== "") {
        if (!isStr(val) || !val.startsWith("data:image/")) {
          return `structuredScheme.${imgField} must be an embedded image`;
        }
      }
    }
    for (const numField of ["reactantDisplayWidth", "productDisplayWidth", "productMw"] as const) {
      const val = s[numField];
      if (val !== undefined && val !== null && typeof val !== "number") {
        return `structuredScheme.${numField} must be a number`;
      }
    }
    for (const txtField of [
      "reactantCdxml",
      "productCdxml",
      "solvent",
      "temperature",
      "duration",
      "atmosphere",
      "extraArrowNotes",
      "productLabel",
    ] as const) {
      if (s[txtField] !== undefined && s[txtField] !== null && !isStr(s[txtField])) {
        return `structuredScheme.${txtField} must be text`;
      }
    }
  }

  if (raw.msSpectrum !== undefined && raw.msSpectrum !== null) {
    const s = raw.msSpectrum;
    if (!isObj(s)) return "msSpectrum must be an object";
    if (!optStr(s.fileName) || !optStr(s.ionizationMode) || !optStr(s.targetNote)) {
      return "msSpectrum text fields must be strings";
    }
    if (!optNum(s.mzMin) || !optNum(s.mzMax)) {
      return "msSpectrum m/z range must be numeric";
    }
    if (s.peaks !== undefined) {
      if (!Array.isArray(s.peaks)) return "msSpectrum.peaks must be a list";
      for (const [i, peak] of s.peaks.entries()) {
        if (!isObj(peak)) return `msSpectrum peak ${i + 1} is not an object`;
        if (!optNum(peak.mz) || !optNum(peak.intensity) || !optNum(peak.rawIntensity)) {
          return `msSpectrum peak ${i + 1} must have numeric m/z and intensity`;
        }
      }
    }
  }

  return null;
}

const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i;
const BARE_BASE64 = /^[A-Za-z0-9+/=\s]+$/;

/** An embedded picture as a data URL (bare base64 is taken to be PNG), or null if it is neither. */
function imageDataUrl(value: string): string | null {
  const text = value.trim();
  if (IMAGE_DATA_URL.test(text)) return text;
  if (BARE_BASE64.test(text)) return `data:image/png;base64,${text}`;
  return null;
}

/** The attachments of one bundle entry, or the reason they are unusable. */
function readAttachments(raw: Obj): { ok: true; value: ExperimentAttachments } | { ok: false; problem: string } {
  let moleculeImageBase64: string | null = null;
  const image = raw.moleculeImageBase64;
  if (image !== undefined && image !== null && image !== "") {
    if (!isStr(image)) return { ok: false, problem: "moleculeImageBase64 must be text" };
    moleculeImageBase64 = imageDataUrl(image);
    if (moleculeImageBase64 === null) return { ok: false, problem: "moleculeImageBase64 is not a valid image" };
  }

  let nmrWorkspace: string | null = null;
  const nmr = raw.nmrWorkspace;
  if (nmr !== undefined && nmr !== null && nmr !== "") {
    // Stored as JSON text; an embedded object is accepted too (hand-made files).
    nmrWorkspace = isStr(nmr) ? nmr : isObj(nmr) ? JSON.stringify(nmr) : null;
    if (nmrWorkspace === null) return { ok: false, problem: "nmrWorkspace must be the workspace JSON" };
    try {
      JSON.parse(nmrWorkspace);
    } catch {
      return { ok: false, problem: "nmrWorkspace is not valid JSON" };
    }
  }
  return { ok: true, value: { moleculeImageBase64, nmrWorkspace } };
}

export interface SkippedEntry {
  /** e.g. "Entry 3 (GH00007)" */
  label: string;
  reason: string;
}

/** What kind of file was read. */
export type BackupKind = "backup" | "experiment" | "plain";

export type ParsedBackup =
  | {
      ok: true;
      kind: BackupKind;
      version: number;
      exportedAt: string | null;
      /** Valid, normalised experiments (duplicate IDs inside the file collapsed, last one wins). TLC photos included. */
      experiments: Experiment[];
      /** Molecule picture and NMR workspace per experiment ID. Only bundles have them; older files have none. */
      attachments: Record<string, ExperimentAttachments>;
      /** The Personal Library in a full backup, otherwise null. */
      library: LibraryCompound[] | null;
      /** initials + starting number in a full backup, otherwise null. */
      profile: BackupProfile | null;
      skipped: SkippedEntry[];
      duplicatesInFile: number;
    }
  | { ok: false; error: string };

export type ValidBackup = Extract<ParsedBackup, { ok: true }>;

function readProfile(raw: unknown): BackupProfile | null {
  if (!isObj(raw)) return null;
  const initials = isValidInitials(raw.initials as string) ? (raw.initials as string) : null;
  if (initials === null) return null;
  const start = raw.startNumber;
  return {
    initials,
    startNumber: isValidStartNumber(start) ? start : START_NUMBER_DEFAULT,
  };
}

/** Parse and validate the text of a backup / experiment file. Never throws. */
export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }

  if (!isObj(data)) {
    return { ok: false, error: "This does not look like a Fumebook export or backup." };
  }

  let kind: BackupKind;
  let entries: unknown[];
  let version = 1;
  if (Array.isArray(data.experiments)) {
    kind = "backup";
    entries = data.experiments;
    if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) {
      return { ok: false, error: "The backup has an invalid version number." };
    }
    version = data.version;
  } else if (isObj(data.experiment)) {
    kind = "experiment";
    entries = [data];
    if (typeof data.version === "number") version = data.version;
  } else if (isStr(data.id) && Array.isArray(data.reagents)) {
    kind = "plain";
    entries = [data];
  } else {
    return {
      ok: false,
      error:
        'This does not look like a Fumebook export or backup (expected an experiment, or "version" and "experiments").',
    };
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `This file uses format v${version}, which is newer than this app understands (v${BACKUP_VERSION}). Update the app to import it.`,
    };
  }

  const byId = new Map<string, { experiment: Experiment; attachments: ExperimentAttachments | null }>();
  const skipped: SkippedEntry[] = [];
  let duplicatesInFile = 0;

  entries.forEach((raw: unknown, index) => {
    const body = isObj(raw) && isObj(raw.experiment) ? raw.experiment : raw;
    const idHint = isObj(body) && isStr(body.id) ? ` (${body.id.slice(0, 40)})` : "";
    const label = `Entry ${index + 1}${idHint}`;

    let attachments: ExperimentAttachments | null = null;
    let candidate: unknown = body;
    if (isObj(raw) && isObj(raw.experiment)) {
      // A bundle: its TLC photos live beside the experiment (older writers left them inside it).
      const tlcImages = raw.tlcImages !== undefined ? raw.tlcImages : raw.experiment.tlcImages;
      candidate = { ...raw.experiment, tlcImages };
      const read = readAttachments(raw);
      if (!read.ok) {
        skipped.push({ label, reason: read.problem });
        return;
      }
      attachments = read.value;
    }

    const problem = experimentProblem(candidate);
    if (problem) {
      skipped.push({ label, reason: problem });
      return;
    }
    const experiment = normaliseExperiment(candidate as Partial<Experiment>);
    if (!experiment) {
      skipped.push({ label, reason: "could not be read" });
      return;
    }
    // A bundle is authoritative about its picture: no image in it means none for the experiment.
    if (attachments) experiment.moleculeImage = attachments.moleculeImageBase64 !== null;

    const key = experiment.id.toUpperCase();
    if (byId.has(key)) duplicatesInFile += 1;
    byId.set(key, { experiment, attachments });
  });

  const experiments: Experiment[] = [];
  const attachmentsById: Record<string, ExperimentAttachments> = {};
  for (const { experiment, attachments } of byId.values()) {
    experiments.push(experiment);
    if (attachments) attachmentsById[experiment.id] = attachments;
  }

  return {
    ok: true,
    kind,
    version,
    exportedAt: isStr(data.exportedAt) ? data.exportedAt : null,
    experiments,
    attachments: attachmentsById,
    library: kind === "backup" && Array.isArray(data.library) ? normaliseCompounds(data.library) : null,
    profile: kind === "backup" ? readProfile(data.profile) : null,
    skipped,
    duplicatesInFile,
  };
}

// --- Writing attachments back ------------------------------------------------------

/** A `data:` URL as a Blob. Decoded by hand: no `fetch` of a data URL, which a strict CSP may forbid. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) throw new Error("Not a data URL.");
  const [, mime, base64, payload] = match;
  const binary = base64 ? atob(payload.replace(/\s+/g, "")) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: mime || "image/png" });
}

/**
 * Write one experiment's picture and NMR workspace to `attachments/[id]/` (`molecule.png`,
 * `workspace.nmrium`). With `replace`, whatever the experiment had there is removed first, so the
 * folder ends up holding exactly what the bundle held. Throws if anything could not be written.
 */
export async function restoreAttachments(
  id: string,
  attachments: ExperimentAttachments,
  replace: boolean,
): Promise<void> {
  if (replace) await clearAttachmentsTolerantly(id);
  if (attachments.moleculeImageBase64) {
    const png = dataUrlToBlob(attachments.moleculeImageBase64);
    await retryWhileLocked(() => saveMoleculeImage(id, png));
  }
  if (attachments.nmrWorkspace) {
    const workspace = attachments.nmrWorkspace;
    await retryWhileLocked(() => saveNmrState(id, workspace));
  }
}

/**
 * Empty `attachments/[id]/` before a restore without ever failing the import over it.
 *
 * Windows refuses to delete a folder while any process holds a file in it open ("os error 32").
 * That must not abort a "Replace All" / overwrite: the folder is then kept (the writes below
 * create it if needed, `mkdir` recursive, and overwrite `molecule.png` / `workspace.nmrium` in
 * place) and its known files are removed one by one, each failure ignored.
 */
async function clearAttachmentsTolerantly(id: string): Promise<void> {
  try {
    await removeAttachments(id);
    return;
  } catch (err) {
    console.warn(
      `Could not remove attachments/${id}${isFileLocked(err) ? " (a file is in use)" : ""}; ` +
        "overwriting its files in place instead:",
      err,
    );
  }
  try {
    await removeAttachmentFilesQuietly(id);
  } catch (err) {
    console.warn(`Leftover cleanup of attachments/${id} failed (ignored):`, err);
  }
}

const LOCK_RETRIES = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a write, retrying a few times (with a growing pause) while the target is locked by another process. */
async function retryWhileLocked(write: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isFileLocked(err) || attempt >= LOCK_RETRIES) throw err;
      await sleep(200 * attempt);
    }
  }
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
