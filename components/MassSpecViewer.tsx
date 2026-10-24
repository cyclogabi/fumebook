"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  formatMz,
  isProfileSpectrum,
  niceTicks,
  parseMassSpectrumFile,
  pickLabeledPeaks,
  spectrumExtent,
} from "@/lib/massSpec";
import { MS_IONIZATION_MODES, type MsPeak, type MsSpectrumData } from "@/types/experiment";

const VIEW_W = 840;
const VIEW_H = 300;
const PAD = { l: 54, r: 16, t: 36, b: 42 };
const INNER_W = VIEW_W - PAD.l - PAD.r;
const INNER_H = VIEW_H - PAD.t - PAD.b;
const Y_TICKS = [0, 20, 40, 60, 80, 100];
const MAX_FILE_BYTES = 20_000_000;
const ACCEPT = ".xy,.xyz,.txt,.csv,.jdx,.dx,.asc,text/plain,text/csv";

interface Props {
  spectrum?: MsSpectrumData;
  onChange: (spectrum: MsSpectrumData | undefined) => void;
}

function xOf(mz: number, min: number, max: number): number {
  const span = max - min || 1;
  return PAD.l + ((mz - min) / span) * INNER_W;
}

function yOf(intensity: number): number {
  return PAD.t + INNER_H - (Math.min(100, Math.max(0, intensity)) / 100) * INNER_H;
}

function nearestPeak(peaks: readonly MsPeak[], mz: number): MsPeak | null {
  if (peaks.length === 0) return null;
  let best = peaks[0];
  let bestDist = Math.abs(peaks[0].mz - mz);
  for (let i = 1; i < peaks.length; i++) {
    const dist = Math.abs(peaks[i].mz - mz);
    if (dist < bestDist) {
      best = peaks[i];
      bestDist = dist;
    }
  }
  return best;
}

export default function MassSpecViewer({ spectrum, onChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId().replace(/:/g, "");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(15);
  const [hover, setHover] = useState<{ mz: number; peak: MsPeak; x: number; y: number } | null>(
    null,
  );
  const [boxZoom, setBoxZoom] = useState<{ x0: number; x1: number } | null>(null);
  const boxZoomRef = useRef<{ x0: number; x1: number } | null>(null);

  const peaks = spectrum?.peaks ?? [];
  const extent = useMemo(() => spectrumExtent(peaks), [peaks]);
  const viewMin = spectrum?.mzMin ?? extent.min;
  const viewMax = spectrum?.mzMax ?? extent.max;
  const range = Math.max(viewMax - viewMin, 1e-6);

  const visible = useMemo(
    () => peaks.filter((p) => p.mz >= viewMin && p.mz <= viewMax),
    [peaks, viewMin, viewMax],
  );

  const labeled = useMemo(() => {
    const gap = Math.max(range * 0.035, range < 40 ? 0.15 : 0.8);
    return pickLabeledPeaks(visible, threshold, gap);
  }, [visible, threshold, range]);

  const profile = useMemo(() => isProfileSpectrum(peaks), [peaks]);
  const xTicks = useMemo(() => niceTicks(viewMin, viewMax, 7), [viewMin, viewMax]);

  const profilePath = useMemo(() => {
    if (!profile || visible.length === 0) return "";
    return visible
      .map((p, i) => {
        const cmd = i === 0 ? "M" : "L";
        return `${cmd}${xOf(p.mz, viewMin, viewMax).toFixed(2)} ${yOf(p.intensity).toFixed(2)}`;
      })
      .join(" ");
  }, [profile, visible, viewMin, viewMax]);

  const patchSpectrum = useCallback(
    (patch: Partial<MsSpectrumData>) => {
      if (!spectrum) return;
      onChange({ ...spectrum, ...patch });
    },
    [onChange, spectrum],
  );

  const setViewRange = useCallback(
    (min: number, max: number) => {
      if (!spectrum) return;
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      if (!(hi > lo)) return;
      onChange({ ...spectrum, mzMin: lo, mzMax: hi });
    },
    [onChange, spectrum],
  );

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is too large to parse in the notebook.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsed = parseMassSpectrumFile(file.name, await file.text());
      onChange({
        ...parsed,
        ionizationMode: spectrum?.ionizationMode,
        targetNote: spectrum?.targetNote,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The spectrum file could not be read.");
    } finally {
      setBusy(false);
    }
  }

  const mzFromClientX = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return viewMin;
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * VIEW_W;
      const t = Math.min(1, Math.max(0, (x - PAD.l) / INNER_W));
      return viewMin + t * (viewMax - viewMin);
    },
    [viewMin, viewMax],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !spectrum) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const mz = mzFromClientX(e.clientX);
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      const nextRange = Math.max(range * factor, 1);
      const left = mz - viewMin;
      const nextMin = mz - left * (nextRange / range);
      setViewRange(nextMin, nextMin + nextRange);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mzFromClientX, range, setViewRange, spectrum, viewMin]);

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (peaks.length === 0) return;
    const mz = mzFromClientX(e.clientX);
    const peak = nearestPeak(visible.length > 0 ? visible : peaks, mz);
    if (!peak) return;
    if (boxZoomRef.current) {
      const x = xOf(mz, viewMin, viewMax);
      boxZoomRef.current = { ...boxZoomRef.current, x1: x };
      setBoxZoom({ ...boxZoomRef.current });
    }
    setHover({
      mz: peak.mz,
      peak,
      x: xOf(peak.mz, viewMin, viewMax),
      y: yOf(peak.intensity),
    });
  }

  function handlePointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0 || !spectrum) return;
    const mz = mzFromClientX(e.clientX);
    const x = xOf(mz, viewMin, viewMax);
    boxZoomRef.current = { x0: x, x1: x };
    setBoxZoom(boxZoomRef.current);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const box = boxZoomRef.current;
    boxZoomRef.current = null;
    setBoxZoom(null);
    if (!box || !spectrum) return;
    const width = Math.abs(box.x1 - box.x0);
    if (width < 8) return;
    const toMz = (x: number) => viewMin + ((x - PAD.l) / INNER_W) * (viewMax - viewMin);
    setViewRange(toMz(Math.min(box.x0, box.x1)), toMz(Math.max(box.x0, box.x1)));
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released
    }
  }

  const hasSpectrum = peaks.length > 0;
  const baselineY = yOf(0);
  const boxLeft = boxZoom ? Math.min(boxZoom.x0, boxZoom.x1) : 0;
  const boxWidth = boxZoom ? Math.abs(boxZoom.x1 - boxZoom.x0) : 0;

  return (
    <section className={hasSpectrum ? "print:break-inside-avoid" : "print:hidden"}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:mb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Mass spectrum
        </h2>
        {hasSpectrum && (
          <p className="text-[11px] text-zinc-500 print:text-black">
            {spectrum?.ionizationMode ? `${spectrum.ionizationMode} · ` : ""}
            {spectrum?.fileName}
          </p>
        )}
      </div>

      {hasSpectrum && (
        <div className="mb-2 flex flex-wrap items-end gap-2 print:hidden">
          <label className="text-[11px] text-zinc-500">
            Ionization
            <select
              value={spectrum?.ionizationMode ?? ""}
              onChange={(e) => patchSpectrum({ ionizationMode: e.target.value || undefined })}
              className="ml-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-800 focus:border-fume-500 focus:outline-none"
            >
              <option value="">—</option>
              {MS_IONIZATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[12rem] flex-1 text-[11px] text-zinc-500">
            Expected ion
            <input
              value={spectrum?.targetNote ?? ""}
              onChange={(e) => patchSpectrum({ targetNote: e.target.value })}
              placeholder="[M+H]+ or [M+Na]+"
              className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
            />
          </label>
          <label className="text-[11px] text-zinc-500">
            m/z min
            <input
              type="number"
              step="any"
              value={Number.isFinite(viewMin) ? Number(viewMin.toFixed(4)) : ""}
              onChange={(e) => setViewRange(Number(e.target.value), viewMax)}
              className="ml-1 w-20 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs tabular-nums focus:border-fume-500 focus:outline-none"
            />
          </label>
          <label className="text-[11px] text-zinc-500">
            m/z max
            <input
              type="number"
              step="any"
              value={Number.isFinite(viewMax) ? Number(viewMax.toFixed(4)) : ""}
              onChange={(e) => setViewRange(viewMin, Number(e.target.value))}
              className="ml-1 w-20 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs tabular-nums focus:border-fume-500 focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => setViewRange(extent.min, extent.max)}
            className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Reset zoom
          </button>
          <label className="text-[11px] text-zinc-500">
            Labels ≥ {threshold}%
            <input
              type="range"
              min={1}
              max={50}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="ml-1 align-middle"
            />
          </label>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Replace file
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              onChange(undefined);
            }}
            className="rounded border border-transparent px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
          >
            Clear
          </button>
        </div>
      )}

      {hasSpectrum && spectrum?.targetNote?.trim() && (
        <p className="mb-1 hidden text-[11px] text-zinc-700 print:block print:text-black">
          {spectrum.ionizationMode ? `${spectrum.ionizationMode}. ` : ""}
          {spectrum.targetNote.trim()}
        </p>
      )}

      {hasSpectrum ? (
        <div className="relative rounded-md border border-zinc-200 bg-white print:border-gray-300 print:bg-transparent">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            role="img"
            aria-label="Mass spectrum"
            className="block h-auto w-full cursor-crosshair touch-none bg-white print:cursor-default print:bg-transparent"
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => {
              setHover(null);
              boxZoomRef.current = null;
              setBoxZoom(null);
            }}
          >
            <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="white" className="print:fill-white" />
            <clipPath id={clipId}>
              <rect x={PAD.l} y={PAD.t} width={INNER_W} height={INNER_H} />
            </clipPath>

            {Y_TICKS.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.l}
                  x2={PAD.l + INNER_W}
                  y1={yOf(tick)}
                  y2={yOf(tick)}
                  stroke="#e4e4e7"
                  strokeWidth="1"
                  className="print:stroke-gray-300"
                />
                <text
                  x={PAD.l - 6}
                  y={yOf(tick) + 3}
                  textAnchor="end"
                  className="fill-zinc-500 print:fill-black"
                  fontSize="10"
                >
                  {tick}
                </text>
              </g>
            ))}

            {xTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={xOf(tick, viewMin, viewMax)}
                  x2={xOf(tick, viewMin, viewMax)}
                  y1={PAD.t + INNER_H}
                  y2={PAD.t + INNER_H + 4}
                  stroke="#52525b"
                  strokeWidth="1"
                  className="print:stroke-black"
                />
                <text
                  x={xOf(tick, viewMin, viewMax)}
                  y={VIEW_H - 14}
                  textAnchor="middle"
                  className="fill-zinc-600 print:fill-black"
                  fontSize="10"
                >
                  {formatMz(tick, range)}
                </text>
              </g>
            ))}

            <line
              x1={PAD.l}
              y1={PAD.t}
              x2={PAD.l}
              y2={PAD.t + INNER_H}
              stroke="#18181b"
              strokeWidth="1.2"
              className="print:stroke-black"
            />
            <line
              x1={PAD.l}
              y1={baselineY}
              x2={PAD.l + INNER_W}
              y2={baselineY}
              stroke="#18181b"
              strokeWidth="1.2"
              className="print:stroke-black"
            />

            <g clipPath={`url(#${clipId})`}>
              {profile ? (
                <path
                  d={profilePath}
                  fill="none"
                  stroke="#18181b"
                  strokeWidth="1.1"
                  className="print:stroke-black"
                />
              ) : (
                visible.map((peak, index) => (
                  <line
                    key={`${index}-${peak.mz}`}
                    x1={xOf(peak.mz, viewMin, viewMax)}
                    x2={xOf(peak.mz, viewMin, viewMax)}
                    y1={baselineY}
                    y2={yOf(peak.intensity)}
                    stroke="#18181b"
                    strokeWidth="1.15"
                    className="print:stroke-black"
                  />
                ))
              )}

              {labeled.map((peak) => (
                <text
                  key={`lbl-${peak.mz}`}
                  x={xOf(peak.mz, viewMin, viewMax)}
                  y={yOf(peak.intensity) - 4}
                  textAnchor="middle"
                  className="fill-zinc-800 print:fill-black"
                  fontSize="9"
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                >
                  {formatMz(peak.mz, range)}
                </text>
              ))}

              {hover && (
                <g className="print:hidden">
                  <line
                    x1={hover.x}
                    x2={hover.x}
                    y1={PAD.t}
                    y2={PAD.t + INNER_H}
                    stroke="#476d96"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                  <circle cx={hover.x} cy={hover.y} r="3.2" fill="#33547a" />
                </g>
              )}

              {boxZoom && boxWidth > 2 && (
                <rect
                  x={boxLeft}
                  y={PAD.t}
                  width={boxWidth}
                  height={INNER_H}
                  fill="#476d96"
                  fillOpacity="0.12"
                  stroke="#33547a"
                  strokeDasharray="4 3"
                  className="print:hidden"
                />
              )}
            </g>

            <text
              x={14}
              y={PAD.t + INNER_H / 2}
              textAnchor="middle"
              transform={`rotate(-90 14 ${PAD.t + INNER_H / 2})`}
              className="fill-zinc-500 print:fill-black"
              fontSize="10"
            >
              Relative Abundance (%)
            </text>
            <text
              x={PAD.l + INNER_W / 2}
              y={VIEW_H - 2}
              textAnchor="middle"
              className="fill-zinc-500 print:fill-black"
              fontSize="10"
            >
              m/z
            </text>
          </svg>

          {hover && (
            <div
              className="pointer-events-none absolute rounded border border-zinc-200 bg-white/95 px-2 py-1 text-[11px] text-zinc-800 shadow-sm print:hidden"
              style={{
                left: `${Math.min(86, Math.max(8, (hover.x / VIEW_W) * 100))}%`,
                top: 8,
                transform: "translateX(-50%)",
              }}
            >
              <span className="font-mono tabular-nums">
                m/z {formatMz(hover.peak.mz, range)}
              </span>
              <span className="mx-1 text-zinc-300">·</span>
              <span className="tabular-nums">{hover.peak.intensity.toFixed(1)}%</span>
            </div>
          )}
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void loadFile(e.dataTransfer.files?.[0]);
          }}
          className={`flex min-h-[8rem] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-6 text-center text-xs print:hidden ${
            dragging
              ? "border-fume-500 bg-fume-50 text-fume-700"
              : "border-zinc-300 bg-zinc-50/40 text-zinc-500 hover:border-fume-300"
          }`}
        >
          <span className="font-medium text-zinc-700">
            {busy ? "Parsing spectrum…" : "Drop an ESI-MS file, or click to browse"}
          </span>
          <span className="mt-1 text-[10px] text-zinc-500">.xy, .txt, .csv, or .jdx</span>
        </div>
      )}

      {spectrum?.targetNote?.trim() && hasSpectrum && (
        <p className="mt-1.5 text-[11px] text-zinc-600 print:hidden">{spectrum.targetNote.trim()}</p>
      )}

      {error && (
        <p role="alert" className="mt-1.5 text-xs text-red-600 print:hidden">
          {error}
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          void loadFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </section>
  );
}
