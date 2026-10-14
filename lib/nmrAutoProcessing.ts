import type { init } from "@zakodium/nmrium-core-plugins";

/**
 * Default processing for raw 1D spectra (Bruker / TopSpin FIDs, JEOL, Varian...), in the
 * spirit of MestreNova's "just open it" behaviour.
 *
 * NMRium already runs its own auto-processing when a raw FID is dropped (digital filter,
 * 1 Hz exponential apodization, zero filling, FFT, phase correction), but:
 *   - the phase correction reuses whatever phase the instrument stored (PHC0 / PHC1), which for
 *     a raw FID is usually zero or stale, so spectra often open badly phased;
 *   - there is no baseline correction at all.
 *
 * This plugin runs right after NMRium's own one (plugins run in registration order) and
 *   1. makes the phase correction automatic (an empty value means "find ph0 / ph1 yourself"),
 *   2. adds an airPLS baseline correction as the last step.
 *
 * It only acts while files are being read with auto-processing on, never when a saved
 * workspace is restored, so manual changes (or removing these filters) survive a reload.
 * Spectra that are already processed (e.g. Bruker `pdata`) are left alone.
 */

type NMRiumPlugin = NonNullable<Parameters<typeof init>[0]>[number];

interface FilterLike {
  name: string;
  value?: unknown;
  enabled?: boolean;
}

interface SpectrumLike {
  info?: { isFid?: boolean; dimension?: number };
  filters?: FilterLike[];
}

/** airPLS: the baseline algorithm NMRium's own baseline panel offers first, with its defaults. */
export const DEFAULT_BASELINE = {
  algorithm: "airpls",
  lambda: 200,
  maxIterations: 100,
  tolerance: 0.001,
} as const;

/** Apply the default pipeline to one spectrum. Returns true if it was changed. */
export function applyDefaultProcessing(spectrum: SpectrumLike): boolean {
  const { info, filters } = spectrum;
  if (!info?.isFid || info.dimension !== 1 || !Array.isArray(filters)) return false;

  // Phasing and baseline only make sense on the transformed spectrum, so require the FFT step.
  if (!filters.some((f) => f.name === "fft")) return false;

  let changed = false;

  const phase = filters.find((f) => f.name === "phaseCorrection");
  if (phase) {
    // No ph0 / ph1 in the value = automatic phasing; the result is stored in the filter.
    phase.value = {};
    phase.enabled = true;
  } else {
    filters.push({ name: "phaseCorrection", value: {}, enabled: true });
  }
  changed = true;

  if (!filters.some((f) => f.name === "baselineCorrection")) {
    filters.push({ name: "baselineCorrection", value: { ...DEFAULT_BASELINE }, enabled: true });
    changed = true;
  }
  return changed;
}

export function autoPhaseAndBaselinePlugin(): NMRiumPlugin {
  return {
    id: "fumebook#AutoPhaseAndBaseline",
    version: 1,
    shouldSerialize: false,
    migrations: [],
    onReadProcess: {
      onProcessing(state, options) {
        if (!options.autoProcessing) return;
        for (const spectrum of (state.data?.spectra ?? []) as unknown as SpectrumLike[]) {
          applyDefaultProcessing(spectrum);
        }
      },
    },
  };
}
