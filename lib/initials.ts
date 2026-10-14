/**
 * The user's profile: initials ("GH") prefix every experiment ID (GH001, GH002, ...), and the
 * starting number says where the numbering begins (someone with 55 paper experiments starts at
 * 56 -> GH056). Both are asked for on first launch, can be changed later from the profile
 * dialog, and are kept in localStorage.
 */
import { useSyncExternalStore } from "react";

export const INITIALS_KEY = "fumebook-initials";
export const START_NUMBER_KEY = "fumebook-start-number";

/** Experiment numbering starts at 1 unless the user says otherwise. */
export const START_NUMBER_DEFAULT = 1;
/** Six digits is far more than a notebook needs and keeps IDs a sensible length. */
export const START_NUMBER_MAX = 999_999;

export const INITIALS_MIN = 2;
export const INITIALS_MAX = 3;

/** Uppercase, letters only, at most INITIALS_MAX of them (what the input field allows). */
export function sanitiseInitials(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, INITIALS_MAX);
}

export function isValidInitials(value: string | null | undefined): value is string {
  return typeof value === "string" && new RegExp(`^[A-Z]{${INITIALS_MIN},${INITIALS_MAX}}$`).test(value);
}

/** The saved initials, or null if there are none yet (or the stored value is not valid). */
export function readInitials(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(INITIALS_KEY);
    return isValidInitials(stored) ? stored : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** Subscribe to changes (this tab via saveInitials, other tabs via the storage event). */
export function subscribeInitials(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === INITIALS_KEY || e.key === START_NUMBER_KEY || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The saved initials, `""` if there are none yet, and `undefined` until the page has hydrated
 * (the server render can't know). Re-renders when they are saved.
 */
export function useSavedInitials(): string | undefined {
  return useSyncExternalStore(
    subscribeInitials,
    () => readInitials() ?? "",
    () => undefined,
  );
}

/** Save the initials. Returns false if they are invalid or the browser refused to store them. */
export function saveInitials(raw: string): boolean {
  const value = sanitiseInitials(raw);
  if (!isValidInitials(value)) return false;
  try {
    window.localStorage.setItem(INITIALS_KEY, value);
  } catch {
    return false;
  }
  listeners.forEach((l) => l());
  return true;
}

// --- Starting experiment number -----------------------------------------------------

export function isValidStartNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= START_NUMBER_DEFAULT &&
    value <= START_NUMBER_MAX
  );
}

/** What the user typed -> a valid starting number, or null ("", "0", "12x", too big...). */
export function parseStartNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return isValidStartNumber(value) ? value : null;
}

/** The saved starting number; 1 when none was saved (or the stored value is not valid). */
export function readStartNumber(): number {
  if (typeof window === "undefined") return START_NUMBER_DEFAULT;
  try {
    return parseStartNumber(window.localStorage.getItem(START_NUMBER_KEY) ?? "") ?? START_NUMBER_DEFAULT;
  } catch {
    return START_NUMBER_DEFAULT;
  }
}

/** The saved starting number (1 on the server render and when none is saved). */
export function useSavedStartNumber(): number {
  return useSyncExternalStore(subscribeInitials, readStartNumber, () => START_NUMBER_DEFAULT);
}

// --- Whole profile -------------------------------------------------------------------

/**
 * Save initials and starting number together: both are stored, or neither is changed.
 * Returns false if either is invalid or the browser refused to store them.
 */
export function saveProfile(rawInitials: string, startNumber: number): boolean {
  const initials = sanitiseInitials(rawInitials);
  if (!isValidInitials(initials) || !isValidStartNumber(startNumber)) return false;
  let previous: [string | null, string | null] | null = null;
  try {
    previous = [
      window.localStorage.getItem(INITIALS_KEY),
      window.localStorage.getItem(START_NUMBER_KEY),
    ];
    window.localStorage.setItem(INITIALS_KEY, initials);
    window.localStorage.setItem(START_NUMBER_KEY, String(startNumber));
  } catch {
    if (previous) {
      try {
        const [oldInitials, oldStart] = previous;
        if (oldInitials === null) window.localStorage.removeItem(INITIALS_KEY);
        else window.localStorage.setItem(INITIALS_KEY, oldInitials);
        if (oldStart === null) window.localStorage.removeItem(START_NUMBER_KEY);
        else window.localStorage.setItem(START_NUMBER_KEY, oldStart);
      } catch {
        // Storage is unusable; nothing more to restore.
      }
    }
    return false;
  }
  listeners.forEach((l) => l());
  return true;
}

/** Forget initials and starting number, so the welcome dialog asks for them again. Experiments are untouched. */
export function resetProfile(): void {
  try {
    window.localStorage.removeItem(INITIALS_KEY);
    window.localStorage.removeItem(START_NUMBER_KEY);
  } catch {
    // Nothing to reset if storage is unavailable.
  }
  listeners.forEach((l) => l());
}
