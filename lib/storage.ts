"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
  DEFAULT_PRODUCT,
  DEFAULT_UNITS,
  PRODUCT_MASS_UNITS,
  ROLES,
  UNIT_OPTIONS,
  newExperiment,
  uid,
  type Experiment,
  type ProductInfo,
  type ReagentRow,
  type Reference,
  type UnitKind,
} from "./types";
import { cleanDoi } from "./references";

/**
 * localStorage-backed experiment store exposed through useSyncExternalStore.
 * - Server / first hydration pass: snapshot is `null` ("not loaded yet"),
 *   so markup always matches; the real data appears right after hydration.
 * - Updates are applied to memory immediately and written to localStorage
 *   on a short debounce (images make the payload large).
 */

const STORAGE_KEY = "chem-eln:experiments:v1";
const PERSIST_DELAY_MS = 400;

let cache: Experiment[] | null = null;
let persistError: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

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
  return {
    name: typeof p.name === "string" ? p.name : "",
    mw: mw !== null && mw > 0 ? mw : null,
    isolatedMass: mass !== null && mass >= 0 ? mass : null,
    massUnit: PRODUCT_MASS_UNITS.includes(p.massUnit as never)
      ? (p.massUnit as ProductInfo["massUnit"])
      : DEFAULT_PRODUCT.massUnit,
  };
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
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    dateCreated:
      typeof raw.dateCreated === "string" ? raw.dateCreated : new Date().toISOString(),
    reactionSchemeRxn:
      typeof raw.reactionSchemeRxn === "string" ? raw.reactionSchemeRxn : "",
    procedureText: typeof raw.procedureText === "string" ? raw.procedureText : "",
    purificationText: typeof raw.purificationText === "string" ? raw.purificationText : "",
    commentsText: typeof raw.commentsText === "string" ? raw.commentsText : "",
    reagents: Array.isArray(raw.reagents) ? raw.reagents.map(normaliseRow) : [],
    product: normaliseProduct(raw.product),
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

// --- Persisting -------------------------------------------------------------

/** Write the cache to localStorage now. Returns false if the browser refused (quota etc.). */
function flush(): boolean {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (cache === null) return true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    if (persistError) {
      persistError = null;
      emit();
    }
    return true;
  } catch {
    persistError =
      "Browser storage is full or unavailable - your latest changes are not saved. " +
      "Remove some TLC images or delete old experiments.";
    emit();
    return false;
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, PERSIST_DELAY_MS);
}

function setExperiments(next: Experiment[]) {
  cache = next;
  emit();
  schedulePersist();
}

// --- useSyncExternalStore plumbing ------------------------------------------

function subscribe(listener: () => void) {
  listeners.add(listener);

  const onStorage = (e: StorageEvent) => {
    // Another tab changed the data.
    if (e.key === STORAGE_KEY || e.key === null) {
      cache = null;
      emit();
    }
  };
  const onHide = () => flush();
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
  if (cache === null) cache = readFromStorage();
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
   * Swap in a whole new experiment list (backup import) and write it to
   * localStorage immediately. Returns false if the browser could not store it.
   */
  const replaceAll = useCallback((next: Experiment[]): boolean => {
    setExperiments(next);
    return flush();
  }, []);

  return { experiments, storageError, create, update, remove, replaceAll };
}
