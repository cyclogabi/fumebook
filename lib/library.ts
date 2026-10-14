"use client";

import { useCallback, useSyncExternalStore } from "react";
import * as path from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "./tauri";
import { uid } from "./types";

/**
 * Personal compound library: the user's own reagents / products / reference structures,
 * ready to drop into the sketcher.
 *
 * - Desktop (Tauri): one JSON array in `Documents/Fumebook/library.json`.
 * - Plain browser (`next dev` preview): the same array in localStorage.
 * - The list is kept in memory (shared by every component using `useLibrary`) and written
 *   straight out after each change; writes are queued so they can't land out of order.
 */

/** SMILES (one line), a MOLfile ("mol", also what an SDF's first record becomes) or ChemDraw CDXML. */
export type StructureFormat = "smiles" | "mol" | "cdxml";

export interface LibraryCompound {
  id: string;
  name: string;
  /** SMILES (one line), a MOLfile (multi-line, ends with "M  END") or CDXML (XML text). */
  structure: string;
  format: StructureFormat;
  /** Optional free text: supplier, CAS number, hazards... */
  notes: string;
  /** Molecular weight in g/mol. Fills the MW column when the compound is picked in the reagent table. */
  mw?: number;
  /** Density in g/mL (liquids). Fills the Density column when picked in the reagent table. */
  density?: number;
}

export type CompoundInput = {
  name: string;
  structure: string;
  notes?: string;
  /** g/mol; must be a positive number when given. */
  mw?: number | null;
  /** g/mL; must be a positive number when given. */
  density?: number | null;
  /** Name of the file the structure came from (a `.cdxml` name marks the text as CDXML). */
  fileName?: string;
};

const APP_DIR_NAME = "Fumebook";
const LIBRARY_FILE_NAME = "library.json";
const STORAGE_KEY = "chem-eln:library:v1";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isNotFound = (e: unknown) =>
  /not found|no such file|os error [23]\b|cannot find/i.test(errorMessage(e));

// --- Structure text helpers ---------------------------------------------------

/**
 * What kind of structure text this is:
 * - CDXML: the text contains `<CDXML`, or the file is named `*.cdxml` (and the text is XML);
 * - MOLfile: has an "M  END" line or a V2000 / V3000 counts line, or is multi-line;
 * - SMILES: anything else (one token).
 */
export function detectFormat(structure: string, fileName?: string): StructureFormat {
  const text = structure.trim();
  if (/<CDXML[\s>]/i.test(text)) return "cdxml";
  if (fileName && /\.cdxml$/i.test(fileName.trim()) && text.startsWith("<")) return "cdxml";
  if (/\bM\s+END\b/.test(text) || /\bV[23]000\b/.test(text)) return "mol";
  return text.includes("\n") ? "mol" : "smiles";
}

/**
 * Normalise a pasted structure: LF line endings, no trailing blanks. A MOLfile keeps its leading
 * blank lines (the title line is allowed to be empty) and gets a final newline.
 */
export function cleanStructure(raw: string, fileName?: string): string {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (text.trim() === "") return "";
  return detectFormat(text, fileName) === "mol" ? text.trimEnd() + "\n" : text.trim();
}

/**
 * The structure text of a file the user picked. An SDF can hold many records; only the first
 * one is used (`note` says so). Everything else is passed through as is.
 */
export function structureFromFile(
  fileName: string,
  text: string,
): { structure: string; note?: string } {
  const normalised = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/\.sdf$/i.test(fileName) || /^\$\$\$\$\s*$/m.test(normalised)) {
    const records = normalised.split(/^\$\$\$\$\s*$/m).filter((r) => r.trim() !== "");
    const first = records[0] ?? "";
    // Drop the data items ("> <NAME>") after the structure, Ketcher only needs the connection table.
    const end = /^M {2}END\s*$/m.exec(first);
    const structure = end ? first.slice(0, end.index + end[0].length) : first;
    return {
      structure,
      note: records.length > 1 ? "Only the first structure of the SDF file was used." : undefined,
    };
  }
  return { structure: normalised };
}

/**
 * A structure as Ketcher wants to read it (for `setMolecule` / `addFragment`). Ketcher guesses the
 * format from the text, and treats any text without a line break as SMILES, so CDXML that was
 * saved or pasted on a single line would be misread. Break the line after the first tag then.
 * SMILES go through unchanged apart from trimming.
 *
 * A MOLfile is fixed-layout: three header lines (title, program, comment: each may be empty)
 * and the counts line must be line 4. So its leading blank lines and spaces are never touched;
 * only trailing whitespace is dropped.
 */
export function prepareForKetcher(structure: string): string {
  const text = structure.replace(/^\uFEFF/, "");
  const format = detectFormat(text);
  if (format === "mol") return text.trimEnd();
  const trimmed = text.trim();
  if (format === "cdxml" && !trimmed.includes("\n")) return trimmed.replace(">", ">\n");
  return trimmed;
}

/** A positive, finite number, or undefined (for MW and density). */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Library compounds matching what is typed in a reagent-name field: names that start with the text
 * first, then names or notes that contain it. Empty text matches nothing.
 */
export function searchLibrary(
  compounds: readonly LibraryCompound[],
  query: string,
  limit = 8,
): LibraryCompound[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: LibraryCompound[] = [];
  const contains: LibraryCompound[] = [];
  for (const c of compounds) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q) || c.notes.toLowerCase().includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** "MW 46.07 g/mol · 0.789 g/mL", or "" when the compound has neither. */
export function describeProperties(c: Pick<LibraryCompound, "mw" | "density">): string {
  const fmt = (v: number) => String(parseFloat(v.toPrecision(5)));
  const parts: string[] = [];
  if (c.mw !== undefined) parts.push(`MW ${fmt(c.mw)} g/mol`);
  if (c.density !== undefined) parts.push(`${fmt(c.density)} g/mL`);
  return parts.join(" \u00b7 ");
}

// --- Reading & writing ----------------------------------------------------------

/** Formats saved before CDXML support called MOLfiles "molfile". */
function normaliseFormat(value: unknown, structure: string): StructureFormat {
  if (value === "smiles" || value === "mol" || value === "cdxml") return value;
  if (value === "molfile") return "mol";
  return detectFormat(structure);
}

function normaliseCompound(raw: unknown): LibraryCompound | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const structure = typeof r.structure === "string" ? r.structure : "";
  if (!name || structure.trim() === "") return null;
  const compound: LibraryCompound = {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    name,
    structure,
    format: normaliseFormat(r.format, structure),
    notes: typeof r.notes === "string" ? r.notes : "",
  };
  const mw = positiveNumber(r.mw);
  const density = positiveNumber(r.density);
  if (mw !== undefined) compound.mw = mw;
  if (density !== undefined) compound.density = density;
  return compound;
}

function parseLibrary(text: string): LibraryCompound[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("library.json must contain a list of compounds.");
  return parsed.map(normaliseCompound).filter((c): c is LibraryCompound => c !== null);
}

async function libraryFilePath(): Promise<string> {
  return path.join(await path.documentDir(), APP_DIR_NAME, LIBRARY_FILE_NAME);
}

/** Read the whole library; a missing file is an empty library. */
export async function loadLibrary(): Promise<LibraryCompound[]> {
  if (!isTauri()) {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseLibrary(raw) : [];
  }
  let text: string;
  try {
    text = await readTextFile(await libraryFilePath());
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return parseLibrary(text);
}

/** Overwrite the library with `compounds`. */
export async function saveLibrary(compounds: LibraryCompound[]): Promise<void> {
  const text = JSON.stringify(compounds, null, 2);
  if (!isTauri()) {
    window.localStorage.setItem(STORAGE_KEY, text);
    return;
  }
  const file = await libraryFilePath();
  await mkdir(await path.dirname(file), { recursive: true });
  await writeTextFile(file, text);
}

// --- Shared store (useSyncExternalStore) ---------------------------------------------

let cache: LibraryCompound[] | null = null;
let storeError: string | null = null;
let loadStarted = false;
/** The file exists but could not be read: don't overwrite it with whatever we have in memory. */
let readFailed = false;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setError(message: string | null) {
  if (storeError === message) return;
  storeError = message;
  emit();
}

function startLoad() {
  if (loadStarted) return;
  loadStarted = true;
  loadLibrary()
    .then((list) => {
      // An add() that raced the first read wins: it already put its own list in the cache.
      cache ??= list;
      emit();
    })
    .catch((err) => {
      cache ??= [];
      readFailed = true;
      setError(`Could not read the library (${LIBRARY_FILE_NAME}): ${errorMessage(err)}`);
    });
}

function getSnapshot(): LibraryCompound[] | null {
  if (cache === null) startLoad();
  return cache;
}

function persist(list: LibraryCompound[]) {
  writeQueue = writeQueue.then(async () => {
    try {
      await saveLibrary(list);
      setError(null);
    } catch (err) {
      setError(`Could not save the library (${LIBRARY_FILE_NAME}): ${errorMessage(err)}`);
    }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getServerSnapshot = (): LibraryCompound[] | null => null;
const getErrorSnapshot = () => storeError;
const getServerErrorSnapshot = () => null;

/** Alphabetical, so the list reads like a reagent cabinet. */
const byName = (a: LibraryCompound, b: LibraryCompound) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Valid compounds from untrusted data (a backup file); anything unusable is dropped. */
export function normaliseCompounds(raw: unknown): LibraryCompound[] {
  return Array.isArray(raw)
    ? raw.map(normaliseCompound).filter((c): c is LibraryCompound => c !== null)
    : [];
}

const compoundKey = (c: LibraryCompound) => `${c.name.trim().toLowerCase()}\u0000${c.structure.trim()}`;

/**
 * Merge compounds from a backup into the library and write it out. Compounds already there (same
 * id, or same name and structure) are left alone. Throws, changing nothing, if the library file
 * could not be read (so an unreadable file is never overwritten) or if the write failed.
 */
export async function mergeLibraryCompounds(
  incoming: LibraryCompound[],
): Promise<{ added: number; skipped: number }> {
  if (incoming.length === 0) return { added: 0, skipped: 0 };
  if (cache === null) {
    try {
      cache = await loadLibrary();
    } catch (err) {
      throw new Error(`The library file could not be read: ${errorMessage(err)}`);
    }
  }
  if (readFailed) throw new Error("The library file could not be read, so it was not changed.");

  const current = cache;
  const ids = new Set(current.map((c) => c.id));
  const keys = new Set(current.map(compoundKey));
  const fresh: LibraryCompound[] = [];
  for (const compound of incoming) {
    if (ids.has(compound.id) || keys.has(compoundKey(compound))) continue;
    ids.add(compound.id);
    keys.add(compoundKey(compound));
    fresh.push(compound);
  }
  if (fresh.length === 0) return { added: 0, skipped: incoming.length };

  const next = [...current, ...fresh].sort(byName);
  cache = next;
  emit();
  persist(next);
  await writeQueue;
  if (storeError) throw new Error(storeError);
  return { added: fresh.length, skipped: incoming.length - fresh.length };
}

export function useLibrary() {
  const compounds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const error = useSyncExternalStore(subscribe, getErrorSnapshot, getServerErrorSnapshot);

  /** Add a compound. Returns it, or an error message if the input is unusable. */
  const add = useCallback(
    (input: CompoundInput): { ok: true; compound: LibraryCompound } | { ok: false; error: string } => {
      if (cache === null) return { ok: false, error: "The library is still loading." };
      if (readFailed) {
        return { ok: false, error: "The library file could not be read, so nothing was changed." };
      }
      const name = input.name.trim();
      const structure = cleanStructure(input.structure, input.fileName);
      if (!name) return { ok: false, error: "Give the compound a name." };
      if (!structure) {
        return { ok: false, error: "Paste a SMILES, MOLfile or CDXML for the structure." };
      }
      const format = detectFormat(structure, input.fileName);
      if (format === "cdxml" && !/<CDXML[\s>]/i.test(structure)) {
        return { ok: false, error: "That does not look like a ChemDraw CDXML file." };
      }
      for (const [label, value] of [
        ["Molecular weight", input.mw],
        ["Density", input.density],
      ] as const) {
        if (value != null && positiveNumber(value) === undefined) {
          return { ok: false, error: `${label} must be a positive number.` };
        }
      }
      const compound: LibraryCompound = {
        id: uid(),
        name,
        structure,
        format,
        notes: (input.notes ?? "").trim(),
      };
      const mw = positiveNumber(input.mw);
      const density = positiveNumber(input.density);
      if (mw !== undefined) compound.mw = mw;
      if (density !== undefined) compound.density = density;
      const next = [...(getSnapshot() ?? []), compound].sort(byName);
      cache = next;
      emit();
      persist(next);
      return { ok: true, compound };
    },
    [],
  );

  const remove = useCallback((id: string) => {
    if (cache === null || readFailed) return;
    const next = (getSnapshot() ?? []).filter((c) => c.id !== id);
    cache = next;
    emit();
    persist(next);
  }, []);

  return { compounds: compounds ? [...compounds].sort(byName) : null, error, add, remove };
}
