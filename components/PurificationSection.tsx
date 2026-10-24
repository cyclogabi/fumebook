"use client";

import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import NumberInput, { cellInput } from "./NumberInput";
import RichTextarea from "./RichTextarea";
import { fileToDataUrl } from "@/lib/images";
import { useLibrary } from "@/lib/library";
import {
  formatNumber,
  resolveProductElutionBands,
  type ProductElutionBand,
} from "@/lib/stoich";
import { useGradientPresets, type GradientPreset } from "@/lib/storage";
import {
  newGradientPoint,
  type GradientPoint,
  type ProductInfo,
  type PurificationGradient,
  type SecondaryProduct,
} from "@/lib/types";

interface Props {
  experimentId?: string;
  purificationText: string;
  onPurificationTextChange: (text: string) => void;
  gradient?: PurificationGradient;
  onGradientChange: (gradient: PurificationGradient | undefined) => void;
  product: ProductInfo;
  secondaryProducts?: SecondaryProduct[];
}

const SOLVENT_A_SUGGESTIONS = [
  "Cyclohexane",
  "Hexanes",
  "Pentane",
  "Heptane",
  "DCM",
  "Toluene",
  "H₂O",
];

const SOLVENT_B_SUGGESTIONS = [
  "EtOAc",
  "MeOH",
  "Acetone",
  "Et₂O",
  "MeCN",
  "DCM",
  "iPrOH",
];

const COLUMN_SIZE_SUGGESTIONS = [
  "10g SiO₂",
  "25g SiO₂",
  "40g SiO₂",
  "80g SiO₂",
  "120g SiO₂",
  "320g SiO₂",
  "25g Biotage SNAP",
  "50g Biotage SNAP",
  "100g Biotage SNAP",
  "C18 Reverse Phase",
];

const PANORAMIC_TLC_MAX_EDGE = 1800;

function defaultGradient(existing?: PurificationGradient): PurificationGradient {
  if (existing) {
    return {
      ...existing,
      enabled: true,
      solventA: existing.solventA || "Cyclohexane",
      solventB: existing.solventB || "EtOAc",
      points:
        existing.points.length > 0
          ? existing.points
          : [
              newGradientPoint(0, 0),
              newGradientPoint(3, 0),
              newGradientPoint(10, 20),
            ],
    };
  }
  return {
    enabled: true,
    columnSize: "",
    equilibrationCv: 3,
    solventA: "Cyclohexane",
    solventB: "EtOAc",
    points: [
      newGradientPoint(0, 0),
      newGradientPoint(3, 0),
      newGradientPoint(10, 20),
    ],
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/**
 * Format `% Solvent B` as an A:B ratio badge, e.g.:
 * - `0% B`  -> `100:0 A:B`
 * - `2% B`  -> `98:2 A:B`
 * - `20% B` -> `80:20 (4:1) A:B`
 * - `50% B` -> `50:50 (1:1) A:B`
 */
export function formatEluentRatio(percentB: number): string {
  const b = Math.min(100, Math.max(0, percentB));
  const a = Math.max(0, 100 - b);
  const aStr = formatNumber(parseFloat(a.toFixed(1)));
  const bStr = formatNumber(parseFloat(b.toFixed(1)));
  if (
    b > 0 &&
    b < 100 &&
    Number.isInteger(a) &&
    Number.isInteger(b)
  ) {
    const d = gcd(a, b);
    const simpA = a / d;
    const simpB = b / d;
    if (simpA + simpB <= 12 && (simpA !== a || simpB !== b)) {
      return `${aStr}:${bStr} (${simpA}:${simpB}) A:B`;
    }
  }
  return `${aStr}:${bStr} A:B`;
}

export default function PurificationSection({
  experimentId = "",
  purificationText,
  onPurificationTextChange,
  gradient,
  onGradientChange,
  product,
  secondaryProducts = [],
}: Props) {
  const columnListId = useId();
  const { compounds: library } = useLibrary();
  const { presets: gradientPresets, savePreset, deletePreset } = useGradientPresets();

  const [autoScaleY, setAutoScaleY] = useState(true);
  const [showTlcUploader, setShowTlcUploader] = useState(false);
  const [tlcDragging, setTlcDragging] = useState(false);
  const [tlcBusy, setTlcBusy] = useState(false);
  const [tlcError, setTlcError] = useState<string | null>(null);
  const [loadPresetOpen, setLoadPresetOpen] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState("");
  const [savedPresetFlash, setSavedPresetFlash] = useState(false);

  const tlcInputRef = useRef<HTMLInputElement>(null);
  const tlcBoxRef = useRef<HTMLDivElement>(null);
  const presetDropdownRef = useRef<HTMLDivElement>(null);
  const presetNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loadPresetOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!presetDropdownRef.current?.contains(e.target as Node)) {
        setLoadPresetOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLoadPresetOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [loadPresetOpen]);

  const isGradientEnabled = gradient?.enabled === true;
  const fractionTlcImage = gradient?.fractionTlcImage;
  const isTlcVisible = Boolean(fractionTlcImage) || showTlcUploader || isGradientEnabled;

  const sortedPoints = useMemo(() => {
    const pts = gradient?.points ?? [];
    return [...pts].sort((a, b) => a.cv - b.cv);
  }, [gradient?.points]);

  const elutionBands = useMemo(
    () =>
      resolveProductElutionBands(
        experimentId,
        product,
        secondaryProducts,
        gradient?.productWindow,
      ),
    [experimentId, product, secondaryProducts, gradient?.productWindow],
  );

  const hasText = purificationText.trim() !== "";
  const hasPrintedGradient = isGradientEnabled && sortedPoints.length > 0;
  const hasPrintedTlc = Boolean(fractionTlcImage);
  const isCompletelyEmpty = !hasText && !hasPrintedGradient && !hasPrintedTlc;

  function patchGradient(patch: Partial<PurificationGradient>) {
    const base: PurificationGradient = gradient ?? {
      enabled: false,
      solventA: "Cyclohexane",
      solventB: "EtOAc",
      points: [],
    };
    onGradientChange({ ...base, ...patch });
  }

  function toggleGradient() {
    if (isGradientEnabled) {
      patchGradient({ enabled: false });
    } else {
      onGradientChange(defaultGradient(gradient));
    }
  }

  function updatePoint(id: string, patch: Partial<GradientPoint>) {
    if (!gradient) return;
    const nextPoints = gradient.points.map((pt) =>
      pt.id === id ? { ...pt, ...patch } : pt,
    );
    patchGradient({ points: nextPoints });
  }

  function sortPointsInState() {
    if (!gradient) return;
    const sorted = [...gradient.points].sort((a, b) => a.cv - b.cv);
    const changed = sorted.some((pt, i) => pt.id !== gradient.points[i]?.id);
    if (changed) patchGradient({ points: sorted });
  }

  function insertPoint() {
    const current = gradient ? [...gradient.points].sort((a, b) => a.cv - b.cv) : [];
    const last = current[current.length - 1];
    const nextCv = last ? parseFloat((last.cv + 3).toFixed(2)) : 0;
    const nextPercentB = last ? last.percentB : 0;
    patchGradient({
      enabled: true,
      points: [...current, newGradientPoint(nextCv, nextPercentB)],
    });
  }

  function removePoint(id: string) {
    if (!gradient) return;
    patchGradient({ points: gradient.points.filter((pt) => pt.id !== id) });
  }

  function suggestPresetName(): string {
    if (!gradient || sortedPoints.length === 0) {
      return "Standard 0–20% EtOAc over 10 CV";
    }
    const minB = sortedPoints[0].percentB;
    const maxB = sortedPoints[sortedPoints.length - 1].percentB;
    const totalCv = sortedPoints[sortedPoints.length - 1].cv;
    const solB = gradient.solventB.trim() || "EtOAc";
    const solA = gradient.solventA.trim() || "Cyclohexane";
    if (minB === maxB) {
      return `Isocratic ${formatNumber(minB)}% ${solB} in ${solA}`;
    }
    return `${formatNumber(minB)}–${formatNumber(maxB)}% ${solB} over ${formatNumber(totalCv)} CV`;
  }

  function handleOpenSavePreset() {
    setPresetNameInput(suggestPresetName());
    setSavePresetOpen(true);
    setLoadPresetOpen(false);
    setTimeout(() => presetNameRef.current?.select(), 20);
  }

  function handleCommitSavePreset() {
    if (!gradient) return;
    const trimmed = presetNameInput.trim() || suggestPresetName();
    savePreset({
      name: trimmed,
      columnSize: gradient.columnSize,
      solventA: gradient.solventA,
      solventB: gradient.solventB,
      equilibrationCv: gradient.equilibrationCv,
      points: sortedPoints.map((pt) => ({ cv: pt.cv, percentB: pt.percentB })),
    });
    setSavePresetOpen(false);
    setSavedPresetFlash(true);
    setTimeout(() => setSavedPresetFlash(false), 2500);
  }

  function handleApplyPreset(preset: GradientPreset) {
    onGradientChange({
      ...(gradient ?? {}),
      enabled: true,
      columnSize: preset.columnSize ?? gradient?.columnSize ?? "",
      solventA: preset.solventA,
      solventB: preset.solventB,
      equilibrationCv: preset.equilibrationCv,
      points: preset.points.map((pt) => newGradientPoint(pt.cv, pt.percentB)),
    });
    setLoadPresetOpen(false);
  }

  async function handleFractionTlcFiles(files: File[]) {
    const file = files.find((f) => f.type.startsWith("image/"));
    if (!file) {
      if (files.length > 0) setTlcError("Only image files can be uploaded.");
      return;
    }
    setTlcBusy(true);
    setTlcError(null);
    try {
      const dataUrl = await fileToDataUrl(file, PANORAMIC_TLC_MAX_EDGE);
      patchGradient({ fractionTlcImage: dataUrl });
      setShowTlcUploader(true);
    } catch {
      setTlcError("Could not process the fraction TLC image.");
    } finally {
      setTlcBusy(false);
    }
  }

  // Allow Ctrl+V paste into the panoramic fraction TLC strip when clicked inside it.
  const handleFilesRef = useRef(handleFractionTlcFiles);
  useEffect(() => {
    handleFilesRef.current = handleFractionTlcFiles;
  });
  useEffect(() => {
    let clickedInTlcBox = false;
    const onPointerDown = (e: PointerEvent) => {
      clickedInTlcBox =
        e.target instanceof Node && (tlcBoxRef.current?.contains(e.target) ?? false);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!clickedInTlcBox || e.defaultPrevented) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      e.preventDefault();
      void handleFilesRef.current(files);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("paste", onPaste, true);
    };
  }, []);

  const libraryNames = useMemo(
    () => (library ?? []).map((c) => c.name).filter(Boolean),
    [library],
  );

  const solventAOptions = useMemo(
    () => Array.from(new Set([...SOLVENT_A_SUGGESTIONS, ...libraryNames])),
    [libraryNames],
  );
  const solventBOptions = useMemo(
    () => Array.from(new Set([...SOLVENT_B_SUGGESTIONS, ...libraryNames])),
    [libraryNames],
  );

  return (
    <div className={`print:break-inside-avoid ${isCompletelyEmpty ? "print:hidden" : ""}`}>
      {/* Print-only heading when the free-text notes are empty but the gradient or fraction TLC is printed */}
      {!hasText && (hasPrintedGradient || hasPrintedTlc) && (
        <h3 className="mb-1 hidden text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:block">
          Purification
        </h3>
      )}

      <RichTextarea
        label="Purification"
        value={purificationText}
        onChange={onPurificationTextChange}
        placeholder="Purification notes"
        minRows={3}
        headerExtra={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggleGradient}
              className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                isGradientEnabled
                  ? "border-fume-300 bg-fume-50 text-fume-800 hover:bg-fume-100"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
              }`}
            >
              {isGradientEnabled ? "✓ Column Elution Gradient" : "+ Column Elution Gradient"}
            </button>
            {!isTlcVisible && (
              <button
                type="button"
                onClick={() => setShowTlcUploader(true)}
                className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
              >
                + Fractions TLC Strip
              </button>
            )}
          </div>
        }
      />

      {/* Interactive Elution Gradient Builder (Screen) */}
      {isGradientEnabled && gradient && (
        <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 print:hidden">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Flash Chromatography Elution Gradient
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* Save Gradient button */}
              <button
                type="button"
                onClick={handleOpenSavePreset}
                className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  savedPresetFlash
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
                }`}
                title="Save this solvent & CV gradient profile as a reusable preset"
              >
                {savedPresetFlash ? "Saved Gradient ✓" : "Save Gradient"}
              </button>

              {/* Load Gradient dropdown */}
              <div ref={presetDropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setLoadPresetOpen((v) => !v);
                    setSavePresetOpen(false);
                  }}
                  aria-expanded={loadPresetOpen}
                  className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
                  title="Load a saved elution gradient preset"
                >
                  Load Gradient ▾
                </button>

                {loadPresetOpen && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-lg">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Saved Gradient Presets ({gradientPresets.length})
                    </div>
                    {gradientPresets.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-zinc-400">
                        No presets saved yet. Click &ldquo;Save Gradient&rdquo; to store one.
                      </p>
                    ) : (
                      <ul className="max-h-56 divide-y divide-zinc-100 overflow-y-auto">
                        {gradientPresets.map((preset) => {
                          const firstB = preset.points[0]?.percentB ?? 0;
                          const lastPt = preset.points[preset.points.length - 1];
                          const lastB = lastPt?.percentB ?? 0;
                          const maxCv = lastPt?.cv ?? 0;
                          return (
                            <li
                              key={preset.id}
                              className="flex items-center justify-between gap-1 rounded px-2 py-1.5 hover:bg-fume-50"
                            >
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(preset)}
                                className="min-w-0 flex-1 text-left"
                              >
                                <span className="block truncate text-xs font-medium text-zinc-800">
                                  {preset.name}
                                </span>
                                <span className="block truncate text-[10px] text-zinc-500">
                                  {preset.solventA} / {preset.solventB} ·{" "}
                                  {firstB === lastB
                                    ? `${formatNumber(firstB)}% B`
                                    : `${formatNumber(firstB)}→${formatNumber(lastB)}% B`}{" "}
                                  ({formatNumber(maxCv)} CV
                                  {preset.equilibrationCv !== undefined
                                    ? `, Equil ${formatNumber(preset.equilibrationCv)} CV`
                                    : ""}
                                  )
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deletePreset(preset.id);
                                }}
                                title={`Delete preset "${preset.name}"`}
                                aria-label={`Delete preset ${preset.name}`}
                                className="grid size-5 shrink-0 place-items-center rounded text-zinc-300 hover:bg-red-50 hover:text-red-600"
                              >
                                ×
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={toggleGradient}
                className="ml-1 text-[11px] font-medium text-zinc-400 hover:text-red-600"
              >
                Remove gradient
              </button>
            </div>
          </div>

          {/* Inline prompt bar when saving a gradient preset */}
          {savePresetOpen && (
            <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-md border border-fume-200 bg-white px-2.5 py-2 shadow-xs">
              <span className="text-xs font-medium text-zinc-700">Preset name:</span>
              <input
                ref={presetNameRef}
                type="text"
                value={presetNameInput}
                onChange={(e) => setPresetNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCommitSavePreset();
                  } else if (e.key === "Escape") {
                    setSavePresetOpen(false);
                  }
                }}
                placeholder="Preset name"
                aria-label="Gradient preset name"
                className="min-w-[14rem] flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCommitSavePreset}
                className="rounded bg-fume-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-fume-700"
              >
                Save Preset
              </button>
              <button
                type="button"
                onClick={() => setSavePresetOpen(false)}
                className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </div>
          )}

          {/* 1 compact row of header controls: Column Size, Solvent A, Solvent B, Equilibration CV */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.1fr_1.1fr_1.1fr_6.5rem]">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                Column / Stationary Phase
              </span>
              <input
                type="text"
                list={columnListId}
                value={gradient.columnSize ?? ""}
                placeholder="Column size"
                onChange={(e) => patchGradient({ columnSize: e.target.value })}
                className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
              />
              <datalist id={columnListId}>
                {COLUMN_SIZE_SUGGESTIONS.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>

            <SolventInput
              label="Solvent A (Weak)"
              value={gradient.solventA}
              placeholder="Solvent A"
              suggestions={solventAOptions}
              onChange={(solventA) => patchGradient({ solventA })}
            />

            <SolventInput
              label="Solvent B (Polar)"
              value={gradient.solventB}
              placeholder="Solvent B"
              suggestions={solventBOptions}
              onChange={(solventB) => patchGradient({ solventB })}
            />

            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                Equil. (CV)
              </span>
              <NumberInput
                ariaLabel="Equilibration column volumes"
                value={gradient.equilibrationCv ?? null}
                onCommit={(v) =>
                  patchGradient({
                    equilibrationCv: v !== null && v >= 0 ? v : undefined,
                  })
                }
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-right text-xs tabular-nums text-zinc-900 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
              />
            </label>
          </div>

          {/* Two-column layout on wider screens: Points table on the left, live SVG chart on the right */}
          <div className="mt-3 grid grid-cols-1 items-start gap-3 lg:grid-cols-[1fr_1.45fr]">
            {/* Coordinate Points Table */}
            <div className="rounded-md border border-zinc-200 bg-white p-2.5">
              <div className="mb-1.5 grid grid-cols-[1.5rem_4.5rem_4.5rem_1fr_1.5rem] items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                <span>#</span>
                <span className="text-right">CV</span>
                <span className="text-right">% {gradient.solventB || "B"}</span>
                <span>A:B Ratio &amp; ΔCV</span>
                <span aria-hidden />
              </div>

              <div className="divide-y divide-zinc-100">
                {gradient.points.map((pt, idx) => {
                  const prev = idx > 0 ? gradient.points[idx - 1] : null;
                  const deltaCv = prev !== null ? pt.cv - prev.cv : null;
                  const deltaB = prev !== null ? pt.percentB - prev.percentB : null;
                  const segmentTag =
                    deltaCv === null
                      ? "Start"
                      : deltaCv === 0
                        ? "0 CV · Step"
                        : `${deltaCv > 0 ? "+" : ""}${formatNumber(parseFloat(deltaCv.toFixed(2)))} CV · ${
                            deltaB === 0 ? "Iso" : "Ramp"
                          }`;

                  return (
                    <div
                      key={pt.id}
                      onBlur={sortPointsInState}
                      className="grid grid-cols-[1.5rem_4.5rem_4.5rem_1fr_1.5rem] items-center gap-2 py-1 first:pt-0 last:pb-0"
                    >
                      <span className="font-mono text-[11px] text-zinc-400">
                        {idx + 1}
                      </span>

                      <NumberInput
                        ariaLabel={`Point ${idx + 1} CV`}
                        value={pt.cv}
                        onCommit={(v) =>
                          updatePoint(pt.id, { cv: v !== null && v >= 0 ? v : 0 })
                        }
                        className={`${cellInput} border-zinc-200 bg-zinc-50/50 text-right text-xs`}
                      />

                      <NumberInput
                        ariaLabel={`Point ${idx + 1} % Solvent B`}
                        value={pt.percentB}
                        onCommit={(v) =>
                          updatePoint(pt.id, {
                            percentB:
                              v !== null ? Math.min(100, Math.max(0, v)) : 0,
                          })
                        }
                        className={`${cellInput} border-zinc-200 bg-zinc-50/50 text-right text-xs`}
                      />

                      <div className="flex flex-wrap items-center gap-1 text-[10px]">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono font-medium text-zinc-700">
                          {formatEluentRatio(pt.percentB)}
                        </span>
                        <span className="rounded bg-fume-50 px-1.5 py-0.5 font-mono text-fume-700">
                          {segmentTag}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => removePoint(pt.id)}
                        title={`Remove point ${idx + 1}`}
                        aria-label={`Remove point ${idx + 1}`}
                        className="grid size-5 place-items-center rounded text-zinc-300 hover:bg-red-50 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2">
                <button
                  type="button"
                  onClick={insertPoint}
                  className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
                >
                  + Insert Point
                </button>

                {elutionBands.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    {elutionBands.map((band) => (
                      <span
                        key={band.id}
                        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium"
                        style={{
                          backgroundColor: band.color.badgeBg,
                          borderColor: band.color.hex,
                          color: band.color.text,
                        }}
                      >
                        <span
                          className="inline-block size-1.5 rounded-full"
                          style={{ backgroundColor: band.color.hex }}
                          aria-hidden
                        />
                        {band.name} ({formatNumber(band.startCv)}–{formatNumber(band.endCv)} CV)
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-[10px] text-zinc-400">
                    Set Elution (CV) on each product below to highlight bands
                  </span>
                )}
              </div>
            </div>

            {/* Live SVG Elution Graph */}
            <div className="rounded-md border border-zinc-200 bg-white p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Elution Profile (% {gradient.solventB || "B"} vs. CV)
                </span>
                <button
                  type="button"
                  onClick={() => setAutoScaleY((v) => !v)}
                  className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
                  title="Toggle between 0–100% Y-axis and auto-scaled Y-axis when %B is low"
                >
                  Y-axis: {autoScaleY ? "Auto-scale" : "0–100%"}
                </button>
              </div>
              <GradientSvgChart
                points={sortedPoints}
                solventA={gradient.solventA}
                solventB={gradient.solventB}
                elutionBands={elutionBands}
                autoScaleY={autoScaleY}
                className="h-56 min-h-[220px] w-full print:h-36"
              />
            </div>
          </div>
        </div>
      )}

      {/* Panoramic Consecutive Fractions / Tubes TLC Strip (Screen) */}
      {isTlcVisible && (
        <div ref={tlcBoxRef} className="mt-2 print:hidden">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Column Fractions / Tubes TLC Strip (Consecutive Plates)
            </span>
            {!fractionTlcImage && !isGradientEnabled && (
              <button
                type="button"
                onClick={() => setShowTlcUploader(false)}
                className="text-[11px] text-zinc-400 hover:text-zinc-600"
              >
                Hide
              </button>
            )}
          </div>

          <input
            ref={tlcInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void handleFractionTlcFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />

          {fractionTlcImage ? (
            <div
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setTlcDragging(true);
              }}
              onDragLeave={() => setTlcDragging(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setTlcDragging(false);
                void handleFractionTlcFiles(Array.from(e.dataTransfer.files));
              }}
              className={`group relative flex h-44 w-full items-center justify-center overflow-hidden rounded-md border bg-zinc-50/70 p-2 ${
                tlcDragging ? "border-fume-500 bg-fume-50" : "border-zinc-200"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- embedded data URL */}
              <img
                src={fractionTlcImage}
                alt="Consecutive column fractions TLC strip"
                className="h-full w-full object-contain"
              />
              <div className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => tlcInputRef.current?.click()}
                  disabled={tlcBusy}
                  className="rounded border border-zinc-300 bg-white/95 px-2 py-0.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => patchGradient({ fractionTlcImage: undefined })}
                  disabled={tlcBusy}
                  className="rounded border border-zinc-300 bg-white/95 px-2 py-0.5 text-xs font-medium text-red-600 shadow-sm hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => tlcInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  tlcInputRef.current?.click();
                }
              }}
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setTlcDragging(true);
              }}
              onDragLeave={() => setTlcDragging(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setTlcDragging(false);
                void handleFractionTlcFiles(Array.from(e.dataTransfer.files));
              }}
              className={`flex h-36 w-full cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 text-center text-xs transition-colors ${
                tlcDragging
                  ? "border-fume-500 bg-fume-50 text-fume-700"
                  : "border-zinc-300 bg-zinc-50/30 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50"
              }`}
            >
              <span className="font-medium text-zinc-700">
                {tlcBusy
                  ? "Processing fraction TLC strip…"
                  : "Drop panoramic TLC image of consecutive column tubes / fractions here"}
              </span>
              <span className="mt-0.5 text-[11px] text-zinc-400">
                Sized for 1 TLC tall × 5–6 TLC plates wide · Click to browse or click here &amp; press Ctrl+V
              </span>
            </div>
          )}

          {tlcError && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {tlcError}
            </p>
          )}
        </div>
      )}

      {/* Print layout: super compact side-by-side gradient summary + SVG plot + optional panoramic fraction TLC strip */}
      {(hasPrintedGradient || hasPrintedTlc) && (
        <div className="mt-1 hidden space-y-1.5 print:block">
          {hasPrintedGradient && gradient && (
            <div className="grid grid-cols-[1fr_1.35fr] items-center gap-3 rounded border border-zinc-200 px-2.5 py-1">
              <div className="min-w-0 space-y-1 text-[10px] leading-snug text-zinc-700">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-zinc-900">
                  {gradient.columnSize && <span>{gradient.columnSize}</span>}
                  {gradient.columnSize && <span className="text-zinc-300">|</span>}
                  <span>
                    A: {gradient.solventA || "Solvent A"}, B: {gradient.solventB || "Solvent B"}
                  </span>
                  {gradient.equilibrationCv !== undefined && (
                    <>
                      <span className="text-zinc-300">|</span>
                      <span>Equil: {formatNumber(gradient.equilibrationCv)} CV</span>
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[9.5px] text-zinc-600">
                  {sortedPoints.map((pt, i) => (
                    <span key={pt.id} className="inline-flex items-center gap-1">
                      {i > 0 && <span className="text-zinc-400">→</span>}
                      <span>
                        {formatNumber(pt.cv)} CV: <strong>{formatNumber(pt.percentB)}% B</strong>{" "}
                        <span className="text-zinc-400">
                          ({formatNumber(100 - pt.percentB)}:{formatNumber(pt.percentB)})
                        </span>
                      </span>
                    </span>
                  ))}
                </div>

                {elutionBands.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5 text-[9.5px]">
                    {elutionBands.map((band) => (
                      <span
                        key={band.id}
                        className="inline-flex items-center gap-1 font-medium"
                        style={{ color: band.color.text }}
                      >
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: band.color.hex }}
                          aria-hidden
                        />
                        <span>
                          {band.name} ({formatNumber(band.startCv)}–{formatNumber(band.endCv)} CV)
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <GradientSvgChart
                points={sortedPoints}
                solventA={gradient.solventA}
                solventB={gradient.solventB}
                elutionBands={elutionBands}
                autoScaleY={autoScaleY}
                className="h-36 w-full print:h-36"
              />
            </div>
          )}

          {hasPrintedTlc && fractionTlcImage && (
            <div className="flex flex-col items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- embedded data URL */}
              <img
                src={fractionTlcImage}
                alt="Column fractions TLC strip"
                className="mx-auto block max-h-24 w-auto max-w-full rounded-none border border-zinc-300 object-contain"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SolventInput({
  label,
  value,
  placeholder,
  suggestions,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  suggestions: string[];
  onChange: (value: string) => void;
}) {
  const listId = useId();
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <input
        type="text"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </label>
  );
}

function GradientSvgChart({
  points,
  solventA,
  solventB,
  elutionBands,
  autoScaleY,
  className = "",
}: {
  points: GradientPoint[];
  solventA: string;
  solventB: string;
  elutionBands: ProductElutionBand[];
  autoScaleY: boolean;
  className?: string;
}) {
  const width = 520;
  const height = 230;
  const padLeft = 52;
  const padRight = 26;
  const padTop = 24;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxCvPoints = points.reduce((m, p) => Math.max(m, p.cv), 0);
  const maxCvBands = elutionBands.reduce((m, b) => Math.max(m, b.endCv), 0);
  const maxCv = Math.max(1, maxCvPoints, maxCvBands);

  const maxBRaw = points.reduce((m, p) => Math.max(m, p.percentB), 0);
  const maxY =
    autoScaleY && maxBRaw <= 30
      ? Math.max(10, Math.ceil((maxBRaw + 2) / 5) * 5)
      : 100;

  const yTicks =
    maxY === 100
      ? [0, 25, 50, 75, 100]
      : [0, Math.round(maxY * 0.25), Math.round(maxY * 0.5), Math.round(maxY * 0.75), maxY];

  const xStep = maxCv <= 10 ? 2 : maxCv <= 25 ? 5 : maxCv <= 50 ? 10 : 20;
  const xTicks: number[] = [];
  for (let v = 0; v <= maxCv; v += xStep) xTicks.push(v);
  if (xTicks[xTicks.length - 1] !== maxCv) xTicks.push(maxCv);

  const xOf = (cv: number) => padLeft + (Math.min(maxCv, Math.max(0, cv)) / maxCv) * plotW;
  const yOf = (b: number) =>
    padTop + plotH - (Math.min(maxY, Math.max(0, b)) / maxY) * plotH;

  const polylinePoints = points
    .map((p) => `${xOf(p.cv).toFixed(1)},${yOf(p.percentB).toFixed(1)}`)
    .join(" ");

  const areaPath =
    points.length > 0
      ? `M ${xOf(points[0].cv).toFixed(1)} ${yOf(0).toFixed(1)} ` +
        points
          .map((p) => `L ${xOf(p.cv).toFixed(1)} ${yOf(p.percentB).toFixed(1)}`)
          .join(" ") +
        ` L ${xOf(points[points.length - 1].cv).toFixed(1)} ${yOf(0).toFixed(1)} Z`
      : "";

  const yAxisLabel = `% ${solventB.trim() || "Solvent B"} in ${solventA.trim() || "Solvent A"}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`select-none overflow-visible ${className}`}
      role="img"
      aria-label={`Elution gradient chart: ${yAxisLabel} versus Column Volumes`}
    >
      {/* Horizontal gridlines & Y-axis labels */}
      {yTicks.map((tick) => {
        const y = yOf(tick);
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={padLeft + plotW}
              y2={y}
              stroke={tick === 0 ? "#a1a1aa" : "#e4e4e7"}
              strokeWidth={tick === 0 ? "1.1" : "0.85"}
              strokeDasharray={tick === 0 ? undefined : "3,2"}
            />
            <text
              x={padLeft - 6}
              y={y + 3.5}
              textAnchor="end"
              fontSize="11"
              fontWeight="500"
              fill="#52525b"
            >
              {tick}%
            </text>
          </g>
        );
      })}

      {/* Vertical X-axis ticks */}
      {xTicks.map((tick) => {
        const x = xOf(tick);
        return (
          <g key={tick}>
            <line
              x1={x}
              y1={padTop + plotH}
              x2={x}
              y2={padTop + plotH + 4.5}
              stroke="#a1a1aa"
              strokeWidth="1.1"
            />
            <text
              x={x}
              y={padTop + plotH + 16}
              textAnchor="middle"
              fontSize="11"
              fontWeight="500"
              fill="#52525b"
            >
              {formatNumber(tick)}
            </text>
          </g>
        );
      })}

      {/* Y-axis spine */}
      <line
        x1={padLeft}
        y1={padTop}
        x2={padLeft}
        y2={padTop + plotH}
        stroke="#a1a1aa"
        strokeWidth="1.1"
      />

      {/* Per-product color-coded CV elution bands */}
      {elutionBands.map((band, bandIdx) => {
        const x1 = xOf(band.startCv);
        const x2 = xOf(band.endCv);
        const bandW = Math.max(2, x2 - x1);
        const labelText = `${band.name} (${formatNumber(band.startCv)}–${formatNumber(band.endCv)} CV)`;
        const midX = (x1 + x2) / 2;
        const badgeW = Math.max(52, labelText.length * 5.6 + 12);
        const clampedX = Math.min(
          padLeft + plotW - badgeW / 2,
          Math.max(padLeft + badgeW / 2, midX),
        );
        const badgeY = padTop + 3 + (bandIdx % 2) * 16;

        return (
          <g key={band.id}>
            <rect
              x={x1}
              y={padTop}
              width={bandW}
              height={plotH}
              fill={band.color.hex}
              fillOpacity={0.18}
            />
            <line
              x1={x1}
              y1={padTop}
              x2={x1}
              y2={padTop + plotH}
              stroke={band.color.hex}
              strokeWidth="1.2"
              strokeDasharray="3,2"
            />
            <line
              x1={x2}
              y1={padTop}
              x2={x2}
              y2={padTop + plotH}
              stroke={band.color.hex}
              strokeWidth="1.2"
              strokeDasharray="3,2"
            />
            <rect
              x={clampedX - badgeW / 2}
              y={badgeY}
              width={badgeW}
              height={15}
              rx={3.5}
              fill={band.color.badgeBg}
              stroke={band.color.hex}
              strokeWidth="0.9"
            />
            <text
              x={clampedX}
              y={badgeY + 10.5}
              textAnchor="middle"
              fontSize="9.5"
              fontWeight="600"
              fill={band.color.text}
            >
              {labelText}
            </text>
          </g>
        );
      })}

      {/* Shaded area under gradient profile */}
      {areaPath && <path d={areaPath} fill="rgba(217, 79, 136, 0.12)" />}

      {/* Gradient polyline */}
      {points.length > 1 && (
        <polyline
          fill="none"
          stroke="#d94f88"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polylinePoints}
        />
      )}

      {/* Vertices & coordinate labels */}
      {points.map((pt, i) => {
        const cx = xOf(pt.cv);
        const cy = yOf(pt.percentB);
        const nearTop = cy < padTop + 18;
        const nearRight = cx > padLeft + plotW - 32;
        const nearLeft = cx < padLeft + 24;
        const labelY = nearTop ? cy + 15 : cy - 7;
        const anchor = nearRight ? "end" : nearLeft ? "start" : "middle";

        return (
          <g key={pt.id}>
            <circle
              cx={cx}
              cy={cy}
              r="4"
              fill="#fff"
              stroke="#b53a6d"
              strokeWidth="2.2"
            />
            <text
              x={cx + (i > 0 && points[i - 1].cv === pt.cv ? 5 : 0)}
              y={labelY}
              textAnchor={anchor}
              fontSize="10.5"
              fontWeight="700"
              fill="#27272a"
              paintOrder="stroke"
              stroke="#ffffff"
              strokeWidth="3"
              strokeLinejoin="round"
            >
              ({formatNumber(pt.cv)}, {formatNumber(pt.percentB)}%)
            </text>
          </g>
        );
      })}

      {/* X-axis label */}
      <text
        x={padLeft + plotW / 2}
        y={height - 5}
        textAnchor="middle"
        fontSize="12"
        fontWeight="600"
        fill="#3f3f46"
      >
        Elution Volume (CV)
      </text>

      {/* Y-axis label */}
      <text
        transform={`translate(13, ${padTop + plotH / 2}) rotate(-90)`}
        textAnchor="middle"
        fontSize="11.5"
        fontWeight="600"
        fill="#3f3f46"
      >
        {yAxisLabel}
      </text>
    </svg>
  );
}
