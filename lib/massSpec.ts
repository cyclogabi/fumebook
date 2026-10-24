import type { MsPeak, MsSpectrumData } from "@/types/experiment";

/** Keep SVG path counts low enough for smooth interaction. */
export const MAX_PLOT_POINTS = 5000;

const HEADER_LINE = /^\s*(#|!|;|\/\/)/;
const JCAMP_LABEL = /^##([^=]+)=(.*)$/;

function splitNumbers(line: string): number[] {
  return line
    .trim()
    .split(/[\s,;]+/)
    .filter((part) => part !== "")
    .map((part) => Number(part.replace(/^[^\d.eE+-]+/, "").replace(/[^\d.eE+-]+$/, "")))
    .filter((n) => Number.isFinite(n));
}

function isJcamp(fileName: string, text: string): boolean {
  return (
    /\.(jdx|dx|jcm)$/i.test(fileName) ||
    /##(JCAMP-DX|TITLE|XYDATA|PEAKTABLE)\s*=/i.test(text.slice(0, 4000))
  );
}

/**
 * JCAMP-DX XYDATA / PEAK TABLE: either (XY..XY) pairs or (X++(Y..Y)) with DELTAX.
 */
function parseJcampPoints(text: string): { mz: number; intensity: number }[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let deltaX = 1;
  let mode: "pairs" | "x++" | null = null;
  let inData = false;
  const points: { mz: number; intensity: number }[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^##END=/i.test(line)) break;

    const label = line.match(JCAMP_LABEL);
    if (label) {
      const key = label[1].replace(/\s+/g, "").toUpperCase();
      const value = label[2].trim();
      if (key === "DELTAX") {
        const n = Number(value);
        if (Number.isFinite(n) && n !== 0) deltaX = n;
      }
      if (key === "XYDATA" || key === "PEAKTABLE" || key === "PEAKASSIGNMENTS") {
        inData = true;
        mode = /\(X\+\+\(Y\.\.Y\)\)/i.test(value) ? "x++" : "pairs";
      }
      continue;
    }

    if (!inData) continue;
    const nums = splitNumbers(line);
    if (nums.length === 0) continue;

    if (mode === "x++") {
      let x = nums[0];
      for (let i = 1; i < nums.length; i++) {
        points.push({ mz: x, intensity: nums[i] });
        x += deltaX;
      }
    } else {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        points.push({ mz: nums[i], intensity: nums[i + 1] });
      }
    }
  }

  return points;
}

function parseTabularPoints(text: string): { mz: number; intensity: number }[] {
  const points: { mz: number; intensity: number }[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || HEADER_LINE.test(line) || line.startsWith("##")) continue;
    if (/^[A-Za-z_(]/.test(line) && !/^[-+]?\d/.test(line)) continue;
    const nums = splitNumbers(line);
    if (nums.length < 2) continue;
    points.push({ mz: nums[0], intensity: nums[1] });
  }
  return points;
}

function downsample(points: { mz: number; intensity: number }[], maxPoints: number) {
  if (points.length <= maxPoints) return points;
  const min = points[0].mz;
  const max = points[points.length - 1].mz;
  const span = max - min;
  if (!(span > 0)) return points.slice(0, maxPoints);

  const binWidth = span / maxPoints;
  const bins: { mz: number; intensity: number }[] = [];
  let binIndex = 0;
  let best: { mz: number; intensity: number } | null = null;

  const flush = () => {
    if (best) bins.push(best);
    best = null;
    binIndex += 1;
  };

  for (const p of points) {
    let target = Math.min(maxPoints - 1, Math.floor((p.mz - min) / binWidth));
    while (binIndex < target) flush();
    if (!best || p.intensity > best.intensity) best = p;
  }
  flush();
  return bins;
}

function toPeaks(points: { mz: number; intensity: number }[]): MsPeak[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.mz) && Number.isFinite(p.intensity) && p.intensity >= 0)
    .sort((a, b) => a.mz - b.mz);
  if (sorted.length === 0) return [];

  const base = Math.max(...sorted.map((p) => p.intensity), 0);
  return downsample(sorted, MAX_PLOT_POINTS).map((p) => ({
    mz: p.mz,
    intensity: base > 0 ? (p.intensity / base) * 100 : 0,
    rawIntensity: p.intensity,
  }));
}

/**
 * Parse a mass-spectrum export (.xy, .xyz, .txt, .csv, .jdx, …) into normalised peaks.
 */
export function parseMassSpectrumFile(fileName: string, text: string): MsSpectrumData {
  const jcamp = isJcamp(fileName, text) ? parseJcampPoints(text) : [];
  const points = jcamp.length >= 2 ? jcamp : parseTabularPoints(text);
  const peaks = toPeaks(points);
  if (peaks.length < 2) {
    throw new Error(
      "No m/z–intensity pairs were found. Use a two-column .xy / .txt / .csv or a JCAMP-DX .jdx file.",
    );
  }
  return {
    fileName: fileName || "spectrum",
    peaks,
    mzMin: peaks[0].mz,
    mzMax: peaks[peaks.length - 1].mz,
  };
}

export function spectrumExtent(peaks: readonly MsPeak[]): { min: number; max: number } {
  if (peaks.length === 0) return { min: 0, max: 1 };
  return { min: peaks[0].mz, max: peaks[peaks.length - 1].mz };
}

/** Local maxima above `threshold` (%), spaced so labels do not collide. */
export function pickLabeledPeaks(
  peaks: readonly MsPeak[],
  threshold: number,
  minMzGap: number,
): MsPeak[] {
  if (peaks.length === 0) return [];
  const candidates: MsPeak[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i];
    if (peak.intensity < threshold) continue;
    const prev = peaks[i - 1];
    const next = peaks[i + 1];
    const isMax =
      (!prev || peak.intensity >= prev.intensity) && (!next || peak.intensity > next.intensity);
    if (isMax) candidates.push(peak);
  }
  candidates.sort((a, b) => b.intensity - a.intensity);
  const chosen: MsPeak[] = [];
  for (const candidate of candidates) {
    if (chosen.every((p) => Math.abs(p.mz - candidate.mz) >= minMzGap)) {
      chosen.push(candidate);
    }
  }
  return chosen.sort((a, b) => a.mz - b.mz).slice(0, 24);
}

export function formatMz(mz: number, range: number): string {
  if (range < 20) return mz.toFixed(4);
  if (range < 80) return mz.toFixed(3);
  return mz.toFixed(2);
}

export function niceTicks(min: number, max: number, count = 6): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [min];
  const raw = span / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-6; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks.length > 0 ? ticks : [min, max];
}

/** Dense profile traces vs sparse centroid sticks. */
export function isProfileSpectrum(peaks: readonly MsPeak[]): boolean {
  if (peaks.length > 400) return true;
  if (peaks.length < 8) return false;
  let total = 0;
  for (let i = 1; i < peaks.length; i++) total += peaks[i].mz - peaks[i - 1].mz;
  const meanGap = total / (peaks.length - 1);
  return meanGap < 0.4;
}
