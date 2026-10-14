/** Height presets for the structure editor, and where the chosen height is remembered. */

export const SKETCHER_HEIGHTS = [
  { label: "Compact", px: 380 },
  { label: "Standard", px: 500 },
  { label: "Tall", px: 750 },
] as const;

export const DEFAULT_SKETCHER_HEIGHT = 500;
export const MIN_SKETCHER_HEIGHT = 280;
export const MAX_SKETCHER_HEIGHT = 1600;

const KEY = "chem-eln:sketcher-height:v1";

export function clampSketcherHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SKETCHER_HEIGHT;
  return Math.min(MAX_SKETCHER_HEIGHT, Math.max(MIN_SKETCHER_HEIGHT, Math.round(px)));
}

/** The remembered height, or the default when nothing valid is stored (or storage is blocked). */
export function readSketcherHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(KEY));
    return stored > 0 ? clampSketcherHeight(stored) : DEFAULT_SKETCHER_HEIGHT;
  } catch {
    return DEFAULT_SKETCHER_HEIGHT;
  }
}

export function saveSketcherHeight(px: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampSketcherHeight(px)));
  } catch {
    // Storage full or blocked: the height just won't be remembered.
  }
}
