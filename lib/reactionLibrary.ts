"use client";

import { useSyncExternalStore } from "react";
import { assembleAiReactionRecord } from "./aiReaction";
import { libraryCompoundSmiles, type LibraryCompound } from "./library";
import { looseNumber } from "./stoich";
import {
  ROLES,
  newRow,
  uid,
  type Experiment,
  type ReagentRow,
  type Role,
  type StructuredReactionScheme,
} from "./types";

/** Browser key for the portable reaction-template library. */
export const REACTION_LIBRARY_STORAGE_KEY = "fumebook_reaction_library_v1";

const EXPORT_KIND = "fumebook-reaction-library";

/**
 * One reusable reaction: both structure zones, arrow conditions, reagent
 * equivalents (not the masses or mmol of a particular scale), and the encoded
 * Reaction SMILES.
 */
export interface SavedReactionReagent {
  name: string;
  mw: number;
  equivalents: number;
  density?: number;
  isLimiting?: boolean;
  smiles?: string;
  /** Solvent and catalyst rows reload with the same role. */
  role?: Role;
}

export interface SavedReactionTemplate {
  id: string;
  name: string;
  experimentCode?: string;
  createdAt: string;
  reactantName?: string;
  reactantMw?: number | null;
  reactantImage?: string | null;
  reactantCdxml?: string | null;
  reactantSmiles?: string | null;
  productName?: string;
  productMw?: number | null;
  productImage?: string | null;
  productCdxml?: string | null;
  productSmiles?: string | null;
  solvent: string;
  temperature: string;
  time: string;
  atmosphere: string;
  reagentsTemplate: SavedReactionReagent[];
  /** `Reactant>Agents>Product` */
  reactionSmiles: string;
  /** `Reactant>>Product` */
  mappedCoreSmiles: string;
}

/** A reaction captured from the open experiment, before it is named and stored. */
export type ReactionTemplateDraft = Omit<SavedReactionTemplate, "id" | "createdAt" | "name">;

export interface ReactionLibraryExport {
  kind: typeof EXPORT_KIND;
  version: 1;
  exportedAt: string;
  reactions: SavedReactionTemplate[];
}

export interface ReactionLibraryImportResult {
  added: number;
  updated: number;
  total: number;
}

const EMPTY_REACTIONS: SavedReactionTemplate[] = [];

let reactionCache: SavedReactionTemplate[] | null = null;
const reactionListeners = new Set<() => void>();
const emitReactions = () => reactionListeners.forEach((listener) => listener());

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const text = clean(value);
  return text || undefined;
}

/** Keep molfiles and pictures intact. Only drop a value that is blank. */
function optionalStored(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function optionalPositive(value: unknown): number | undefined {
  const n = looseNumber(value);
  return n !== null && n > 0 ? n : undefined;
}

function roleOf(value: unknown): Role | undefined {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : undefined;
}

function normaliseReagent(raw: unknown): SavedReactionReagent | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<SavedReactionReagent>;
  const name = clean(row.name);
  if (!name) return null;
  const mw = looseNumber(row.mw);
  const equivalents = looseNumber(row.equivalents);
  const density = optionalPositive(row.density);
  const smiles = optionalText(row.smiles);
  const role = roleOf(row.role);
  return {
    name,
    mw: mw !== null && mw > 0 ? mw : 0,
    equivalents: equivalents !== null && equivalents > 0 ? equivalents : 0,
    ...(density !== undefined ? { density } : {}),
    ...(row.isLimiting === true ? { isLimiting: true } : {}),
    ...(smiles ? { smiles } : {}),
    ...(role ? { role } : {}),
  };
}

function normaliseSavedReaction(raw: unknown): SavedReactionTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<SavedReactionTemplate>;
  const name = clean(item.name);
  if (!name) return null;
  const reactantMw = optionalPositive(item.reactantMw);
  const productMw = optionalPositive(item.productMw);
  return {
    id: clean(item.id) || uid(),
    name,
    ...(optionalText(item.experimentCode) ? { experimentCode: optionalText(item.experimentCode) } : {}),
    createdAt: clean(item.createdAt) || new Date().toISOString(),
    ...(optionalText(item.reactantName) ? { reactantName: optionalText(item.reactantName) } : {}),
    ...(reactantMw !== undefined ? { reactantMw } : {}),
    ...(optionalStored(item.reactantImage) ? { reactantImage: optionalStored(item.reactantImage) } : {}),
    ...(optionalStored(item.reactantCdxml) ? { reactantCdxml: optionalStored(item.reactantCdxml) } : {}),
    ...(optionalText(item.reactantSmiles) ? { reactantSmiles: optionalText(item.reactantSmiles) } : {}),
    ...(optionalText(item.productName) ? { productName: optionalText(item.productName) } : {}),
    ...(productMw !== undefined ? { productMw } : {}),
    ...(optionalStored(item.productImage) ? { productImage: optionalStored(item.productImage) } : {}),
    ...(optionalStored(item.productCdxml) ? { productCdxml: optionalStored(item.productCdxml) } : {}),
    ...(optionalText(item.productSmiles) ? { productSmiles: optionalText(item.productSmiles) } : {}),
    solvent: clean(item.solvent),
    temperature: clean(item.temperature),
    time: clean(item.time),
    atmosphere: clean(item.atmosphere),
    reagentsTemplate: Array.isArray(item.reagentsTemplate)
      ? item.reagentsTemplate
          .map(normaliseReagent)
          .filter((row): row is SavedReactionReagent => row !== null)
      : [],
    reactionSmiles: clean(item.reactionSmiles),
    mappedCoreSmiles: clean(item.mappedCoreSmiles),
  };
}

function loadFromStorage(): SavedReactionTemplate[] {
  if (typeof window === "undefined") return EMPTY_REACTIONS;
  try {
    const raw = window.localStorage.getItem(REACTION_LIBRARY_STORAGE_KEY);
    if (!raw) return EMPTY_REACTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_REACTIONS;
    return parsed
      .map(normaliseSavedReaction)
      .filter((item): item is SavedReactionTemplate => item !== null);
  } catch {
    return EMPTY_REACTIONS;
  }
}

function persistReactions(next: SavedReactionTemplate[]) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(REACTION_LIBRARY_STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      const quota =
        err instanceof DOMException &&
        (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
      throw new Error(
        quota
          ? "Could not save this reaction — browser storage is full. Export the library, delete a few saved reactions, and try again."
          : "Could not save the reaction library to browser storage.",
      );
    }
  }
  reactionCache = next;
  emitReactions();
}

/** Every saved reaction, newest save first. */
export function getSavedReactions(): SavedReactionTemplate[] {
  if (reactionCache === null) reactionCache = loadFromStorage();
  return reactionCache;
}

/**
 * Store a reaction template. A template with the same name (or the same id)
 * is updated and moved to the front of the library.
 */
export function saveReactionTemplate(
  template: ReactionTemplateDraft & { name: string; id?: string; createdAt?: string },
): SavedReactionTemplate {
  const name = template.name.trim();
  if (!name) throw new Error("Name this reaction before saving.");
  const current = getSavedReactions();
  const byName = current.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
  const byId = template.id ? current.findIndex((item) => item.id === template.id) : -1;
  const idx = byId >= 0 ? byId : byName;
  const saved = normaliseSavedReaction({
    ...template,
    name,
    id: idx >= 0 ? current[idx].id : template.id?.trim() || uid(),
    createdAt: new Date().toISOString(),
  });
  if (!saved) throw new Error("Could not save this reaction.");
  const rest = idx >= 0 ? current.filter((_, index) => index !== idx) : current;
  persistReactions([saved, ...rest]);
  return saved;
}

export function deleteReactionTemplate(id: string): void {
  persistReactions(getSavedReactions().filter((item) => item.id !== id));
}

/** Pretty JSON for the whole library, so it can move to another computer. */
export function exportReactionLibraryJson(
  reactions: readonly SavedReactionTemplate[] = getSavedReactions(),
): string {
  const file: ReactionLibraryExport = {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    reactions: reactions
      .map((item) => normaliseSavedReaction(item))
      .filter((item): item is SavedReactionTemplate => item !== null),
  };
  return JSON.stringify(file, null, 2);
}

function reactionsFromImport(json: string): SavedReactionTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object" && "reactions" in parsed) {
    const record = parsed as { kind?: unknown; reactions?: unknown };
    if (record.kind !== undefined && record.kind !== EXPORT_KIND) {
      throw new Error("That JSON file is not a Fumebook reaction library.");
    }
    list = record.reactions;
  } else {
    throw new Error("That JSON file does not contain a reaction library.");
  }
  if (!Array.isArray(list)) throw new Error("That JSON file does not contain a reaction library.");
  const reactions = list
    .map(normaliseSavedReaction)
    .filter((item): item is SavedReactionTemplate => item !== null);
  if (reactions.length === 0) throw new Error("That file has no reactions to import.");
  return reactions;
}

/**
 * Read a library export. `merge` updates templates that share an id or a name
 * and adds the rest. `replace` swaps the whole library for the file.
 */
export function importReactionLibraryJson(
  json: string,
  mode: "merge" | "replace" = "merge",
): ReactionLibraryImportResult {
  const incoming = reactionsFromImport(json);
  if (mode === "replace") {
    persistReactions(incoming);
    return { added: incoming.length, updated: 0, total: incoming.length };
  }
  const next = [...getSavedReactions()];
  let added = 0;
  let updated = 0;
  for (const item of incoming) {
    const byId = next.findIndex((current) => current.id === item.id);
    const byName = next.findIndex(
      (current) => current.name.toLowerCase() === item.name.toLowerCase(),
    );
    const idx = byId >= 0 ? byId : byName;
    if (idx >= 0) {
      next[idx] = { ...item, id: next[idx].id };
      updated += 1;
    } else {
      next.unshift(item);
      added += 1;
    }
  }
  persistReactions(next);
  return { added, updated, total: next.length };
}

function resolvedReagentSmiles(
  row: ReagentRow,
  library: readonly LibraryCompound[],
): string | undefined {
  const direct = row.smiles?.trim();
  if (direct) return direct;
  if (row.role === "Limiting" || row.role === "Solvent" || row.name.trim() === "") return undefined;
  const name = row.name.trim().toLowerCase();
  const hit = library.find((compound) => compound.name.trim().toLowerCase() === name);
  const fromLibrary = hit ? libraryCompoundSmiles(hit) : undefined;
  return fromLibrary?.trim() || undefined;
}

function reagentsTemplateFrom(
  rows: readonly ReagentRow[],
  library: readonly LibraryCompound[],
): SavedReactionReagent[] {
  return rows
    .filter((row) => row.name.trim() !== "")
    .map((row) => {
      const limiting = row.role === "Limiting";
      const smiles = resolvedReagentSmiles(row, library);
      const reagent: SavedReactionReagent = {
        name: row.name.trim(),
        mw: row.mw !== null && row.mw > 0 ? row.mw : 0,
        equivalents: limiting ? 1 : row.eq !== null && row.eq > 0 ? row.eq : 0,
      };
      if (row.density !== null && row.density > 0) reagent.density = row.density;
      if (limiting) reagent.isLimiting = true;
      if (smiles) reagent.smiles = smiles;
      if (row.role !== "Reagent") reagent.role = row.role;
      return reagent;
    });
}

/** Capture the open reaction, including Reaction SMILES, without writing it yet. */
export function draftReactionTemplate(input: {
  experimentCode?: string;
  reactantName?: string;
  reactantMw?: number | null;
  reactantImage?: string | null;
  reactantCdxml?: string | null;
  reactantSmiles?: string | null;
  productName?: string;
  productMw?: number | null;
  productImage?: string | null;
  productCdxml?: string | null;
  productSmiles?: string | null;
  solvent?: string;
  temperature?: string;
  time?: string;
  atmosphere?: string;
  reagents: readonly ReagentRow[];
  library?: readonly LibraryCompound[];
}): ReactionTemplateDraft {
  const library = input.library ?? [];
  const reactantSmiles = clean(input.reactantSmiles);
  const productSmiles = clean(input.productSmiles);
  const solvent = clean(input.solvent);
  const temperature = clean(input.temperature);
  const time = clean(input.time);
  const atmosphere = clean(input.atmosphere);
  const encoded = assembleAiReactionRecord(
    {
      reactantSmiles: reactantSmiles || undefined,
      productSmiles: productSmiles || undefined,
      reagents: [...input.reagents],
      structuredScheme: {
        solvent,
        temperature,
        duration: time,
        atmosphere,
      },
      product: {
        name: clean(input.productName),
        mw: optionalPositive(input.productMw) ?? null,
        isolatedMass: null,
        massUnit: "mg",
      },
    },
    library,
  );
  const reactantMw = optionalPositive(input.reactantMw);
  const productMw = optionalPositive(input.productMw);
  return {
    ...(optionalText(input.experimentCode)
      ? { experimentCode: optionalText(input.experimentCode) }
      : {}),
    ...(optionalText(input.reactantName) ? { reactantName: optionalText(input.reactantName) } : {}),
    ...(reactantMw !== undefined ? { reactantMw } : {}),
    ...(optionalStored(input.reactantImage) ? { reactantImage: optionalStored(input.reactantImage) } : {}),
    ...(optionalStored(input.reactantCdxml) ? { reactantCdxml: optionalStored(input.reactantCdxml) } : {}),
    ...(reactantSmiles ? { reactantSmiles } : {}),
    ...(optionalText(input.productName) ? { productName: optionalText(input.productName) } : {}),
    ...(productMw !== undefined ? { productMw } : {}),
    ...(optionalStored(input.productImage) ? { productImage: optionalStored(input.productImage) } : {}),
    ...(optionalStored(input.productCdxml) ? { productCdxml: optionalStored(input.productCdxml) } : {}),
    ...(productSmiles ? { productSmiles } : {}),
    solvent,
    temperature,
    time,
    atmosphere,
    reagentsTemplate: reagentsTemplateFrom(input.reagents, library),
    reactionSmiles: encoded.reactionSmiles,
    mappedCoreSmiles: encoded.mappedCoreSmiles,
  };
}

/** `solvent, temperature, time, under atmosphere`, skipping anything blank. */
export function formatReactionConditions(
  template: Pick<SavedReactionTemplate, "solvent" | "temperature" | "time" | "atmosphere">,
): string {
  const parts = [template.solvent, template.temperature, template.time]
    .map((part) => part.trim())
    .filter(Boolean);
  const atmosphere = template.atmosphere.trim();
  if (atmosphere) parts.push(`under ${atmosphere}`);
  return parts.join(", ");
}

/** Search by experiment code, name, reagent, conditions, or either SMILES form. */
export function reactionMatchesQuery(template: SavedReactionTemplate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    template.name,
    template.experimentCode,
    template.reactantName,
    template.productName,
    template.solvent,
    template.temperature,
    template.time,
    template.atmosphere,
    template.reactionSmiles,
    template.mappedCoreSmiles,
    template.reactantSmiles,
    template.productSmiles,
    ...template.reagentsTemplate.flatMap((row) => [row.name, row.smiles]),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function zoneStructure(cdxml?: string | null, smiles?: string | null): string | undefined {
  if (typeof cdxml === "string" && cdxml.trim()) return cdxml;
  // A smiles-only side still has to live on the zone, or the next extraction
  // pass treats the box as empty and wipes the SMILES that were just loaded.
  const text = smiles?.trim();
  return text || undefined;
}

function schemeFromTemplate(template: SavedReactionTemplate): StructuredReactionScheme | undefined {
  const scheme: StructuredReactionScheme = {};
  if (template.reactantImage) scheme.reactantImage = template.reactantImage;
  const reactant = zoneStructure(template.reactantCdxml, template.reactantSmiles);
  if (reactant) scheme.reactantCdxml = reactant;
  if (template.productImage) scheme.productImage = template.productImage;
  const product = zoneStructure(template.productCdxml, template.productSmiles);
  if (product) scheme.productCdxml = product;
  if (template.solvent.trim()) scheme.solvent = template.solvent.trim();
  if (template.temperature.trim()) scheme.temperature = template.temperature.trim();
  if (template.time.trim()) scheme.duration = template.time.trim();
  if (template.atmosphere.trim()) scheme.atmosphere = template.atmosphere.trim();
  return Object.keys(scheme).length > 0 ? scheme : undefined;
}

function rowsFromTemplate(template: SavedReactionTemplate): ReagentRow[] {
  let limitingUsed = false;
  const rows: ReagentRow[] = [];
  for (const item of template.reagentsTemplate) {
    const name = item.name.trim();
    if (!name) continue;
    let role: Role = item.role ?? "Reagent";
    if (item.isLimiting || role === "Limiting") {
      if (limitingUsed) role = "Reagent";
      else {
        role = "Limiting";
        limitingUsed = true;
      }
    }
    const solvent = role === "Solvent";
    rows.push({
      id: uid(),
      name,
      role,
      mw: !solvent && item.mw > 0 ? item.mw : null,
      eq: role === "Limiting" ? 1 : solvent ? null : item.equivalents > 0 ? item.equivalents : null,
      // A template is a recipe, not a scale. The next starting mass recalculates mmol.
      n: null,
      mass: null,
      vol: null,
      density: item.density !== undefined && item.density > 0 ? item.density : null,
      ...(item.smiles?.trim() ? { smiles: item.smiles.trim() } : {}),
    });
  }
  if (!limitingUsed) {
    rows.unshift({
      ...newRow("Limiting"),
      name: template.reactantName?.trim() ?? "",
      mw: template.reactantMw && template.reactantMw > 0 ? template.reactantMw : null,
    });
  } else {
    const limiting = rows.find((row) => row.role === "Limiting");
    if (limiting) {
      if (!limiting.name.trim() && template.reactantName?.trim()) {
        limiting.name = template.reactantName.trim();
      }
      if (
        (limiting.mw === null || limiting.mw <= 0) &&
        template.reactantMw &&
        template.reactantMw > 0
      ) {
        limiting.mw = template.reactantMw;
      }
    }
  }
  return rows;
}

/**
 * Fields to write onto the open experiment. Reagent masses, mmol, and volumes are
 * cleared so the saved equivalents wait for a new starting mass.
 * The template's product name and molecular weight are written onto the reaction scheme
 * only. Isolated fractions on `experiment` are left untouched.
 * Call this through the experiment undo updater so Ctrl+Z restores the previous reaction.
 */
export function applySavedReaction(
  _experiment: Experiment,
  template: SavedReactionTemplate,
): Partial<Experiment> {
  const scheme = schemeFromTemplate(template) ?? {};
  const productName = template.productName?.trim();
  if (productName) scheme.productLabel = productName;
  if (template.productMw && template.productMw > 0) scheme.productMw = template.productMw;
  return {
    structuredScheme: Object.keys(scheme).length > 0 ? scheme : undefined,
    reactantSmiles: template.reactantSmiles?.trim() || undefined,
    productSmiles: template.productSmiles?.trim() || undefined,
    reagents: rowsFromTemplate(template),
  };
}

function subscribeReactions(listener: () => void) {
  reactionListeners.add(listener);
  return () => {
    reactionListeners.delete(listener);
  };
}

function getReactionSnapshot(): SavedReactionTemplate[] {
  return getSavedReactions();
}

const getReactionServerSnapshot = (): SavedReactionTemplate[] => EMPTY_REACTIONS;

export function useReactionLibrary() {
  const reactions = useSyncExternalStore(
    subscribeReactions,
    getReactionSnapshot,
    getReactionServerSnapshot,
  );
  return {
    reactions,
    saveReactionTemplate,
    deleteReactionTemplate,
    exportReactionLibraryJson,
    importReactionLibraryJson,
  };
}
