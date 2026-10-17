"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NumberInput, { cellInput } from "@/components/NumberInput";
import { suggestDistinctLibraryName, useLibrary } from "@/lib/library";
import {
  formatMoles,
  formatNumber,
  fromCanonical,
  looseNumber,
  productColorAt,
  stoichRatioOf,
  summariseProducts,
  toCanonical,
  type ProductMetrics,
} from "@/lib/stoich";
import {
  PRODUCT_MASS_UNITS,
  newSecondaryProduct,
  type ProductInfo,
  type ProductMassUnit,
  type ReagentRow,
  type SecondaryProduct,
} from "@/lib/types";
import { GOOD_YIELD_PERCENT, computeYield } from "@/lib/yield";

interface Props {
  experimentId?: string;
  product: ProductInfo;
  rows: ReagentRow[];
  onChange: (patch: Partial<ProductInfo>) => void;
  secondaryProducts?: SecondaryProduct[];
  onSecondaryChange?: (fn: (current: SecondaryProduct[]) => SecondaryProduct[]) => void;
  /** Optional primary product CDXML structure from the reaction scheme. */
  productCdxml?: string;
  /** Optional primary product rendered SVG/PNG image data URL from the reaction scheme. */
  productImage?: string;
}

const MASS_DECIMALS: Record<ProductMassUnit, number> = { mg: 1, g: 4 };

const OVER_100_WARNING =
  "Total conversion exceeds 100% — check MW, stoichiometry ratio, or residual solvent.";

const ROW_GRID =
  "grid grid-cols-[minmax(6.5rem,1.3fr)_4.75rem_7.75rem_3.25rem_6.75rem_4.75rem_4.75rem_1.5rem] items-center gap-2";

function isDefaultPrimaryName(name: string, experimentId: string): boolean {
  const trimmed = name.trim().toUpperCase();
  const id = experimentId.trim().toUpperCase();
  if (!trimmed) return true;
  if (!id) return trimmed === "F1";
  return trimmed === id || trimmed === `${id}-F1`;
}

function isDefaultSecondaryName(name: string, experimentId: string, index: number): boolean {
  const trimmed = name.trim().toUpperCase();
  const id = experimentId.trim().toUpperCase();
  if (!trimmed) return true;
  const tag = `F${index + 2}`;
  return id ? trimmed === `${id}-${tag}` || trimmed === tag : trimmed === tag;
}

function isBlankSecondary(
  p: SecondaryProduct,
  experimentId: string,
  index: number,
): boolean {
  return (
    looseNumber(p.mw) === null &&
    looseNumber(p.mass) === null &&
    looseNumber(p.elutionStartCv) === null &&
    looseNumber(p.elutionEndCv) === null &&
    isDefaultSecondaryName(p.name, experimentId, index)
  );
}

/**
 * Compact single-line product & yield rows (screen & print).
 * Defaults to the experiment ID (`GH055`) when there is a single product, and
 * automatically switches to fraction naming (`GH055-F1`, `GH055-F2`, ...) when
 * additional products are added.
 */
export default function ProductYieldCard({
  experimentId = "",
  product,
  rows,
  onChange,
  secondaryProducts = [],
  onSecondaryChange,
  productCdxml,
  productImage,
}: Props) {
  const {
    compounds: library,
    add: addLibraryCompound,
    update: updateLibraryCompound,
  } = useLibrary();
  const [savedLibraryFlash, setSavedLibraryFlash] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveMwText, setSaveMwText] = useState("");
  const [saveDensityText, setSaveDensityText] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { name, mw, isolatedMass, massUnit } = product;
  const primaryRatio = stoichRatioOf(product);
  const primaryStartCv = looseNumber(product.elutionStartCv);
  const primaryEndCv = looseNumber(product.elutionEndCv);
  const primaryColor = productColorAt(0);
  const idPrefix = experimentId.trim();
  const defaultPrimaryName =
    secondaryProducts.length > 0
      ? idPrefix
        ? `${idPrefix}-F1`
        : "F1"
      : idPrefix || "F1";

  // Seed default experiment ID name once per experiment if loaded with an empty name.
  const seededForId = useRef<string | null>(null);
  useEffect(() => {
    if (!idPrefix || seededForId.current === idPrefix) return;
    seededForId.current = idPrefix;
    if (name.trim() === "") {
      onChange({ name: defaultPrimaryName });
    }
  }, [idPrefix, name, defaultPrimaryName, onChange]);

  const result = computeYield(rows, mw, isolatedMass);
  const summary = summariseProducts(rows, product, secondaryProducts, idPrefix);
  const primaryMetrics = summary.items[0];
  const secondaryMetrics = summary.items.slice(1);

  const shownMass = isolatedMass === null ? null : fromCanonical(isolatedMass, massUnit);

  const primaryHasData =
    mw !== null ||
    isolatedMass !== null ||
    primaryStartCv !== null ||
    primaryEndCv !== null ||
    !isDefaultPrimaryName(name, idPrefix);
  const hasFilledAdditional = secondaryProducts.some(
    (p, i) => !isBlankSecondary(p, idPrefix, i),
  );
  const isEmpty = !primaryHasData && !hasFilledAdditional;

  const over100 = summary.conversionPercent !== null && summary.conversionPercent > 100;

  const hint = (() => {
    if (result.limitingN === null) {
      return "Mark a reagent as Limiting (with mass or mmol) to calculate yield.";
    }
    if (mw === null && isolatedMass !== null) {
      return "Enter product MW to calculate yield.";
    }
    if (result.theoreticalMg !== null) {
      const shownTheoretical = fromCanonical(result.theoreticalMg / primaryRatio, massUnit);
      return `Theoretical (${formatNumber(primaryRatio)}:1): ${formatNumber(shownTheoretical)} ${massUnit}`;
    }
    return null;
  })();

  const handleAddProduct = () => {
    if (!onSecondaryChange) return;
    if (secondaryProducts.length === 0 && isDefaultPrimaryName(name, idPrefix)) {
      onChange({ name: idPrefix ? `${idPrefix}-F1` : "F1" });
    }
    onSecondaryChange((list) => {
      const nextLabel = idPrefix
        ? `${idPrefix}-F${list.length + 2}`
        : `F${list.length + 2}`;
      return [...list, newSecondaryProduct(massUnit, nextLabel)];
    });
  };

  const patchSecondary = (id: string, patch: Partial<SecondaryProduct>) => {
    onSecondaryChange?.((list) =>
      list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeSecondary = (id: string) => {
    if (!onSecondaryChange) return;
    if (
      secondaryProducts.length === 1 &&
      idPrefix &&
      name.trim().toUpperCase() === `${idPrefix.toUpperCase()}-F1`
    ) {
      onChange({ name: idPrefix });
    }
    onSecondaryChange((list) => list.filter((item) => item.id !== id));
  };

  const displayPrimaryName = name.trim() || defaultPrimaryName;
  const canSaveProductToLibrary = Boolean(
    productImage ||
      productCdxml?.trim() ||
      (mw !== null && mw > 0) ||
      secondaryProducts.some((p) => {
        const m = looseNumber(p.mw);
        return m !== null && m > 0;
      }),
  );

  const existingLibraryMatch = useMemo(() => {
    const trimmed = saveName.trim().toLowerCase();
    if (!trimmed) return null;
    return (library ?? []).find((c) => c.name.trim().toLowerCase() === trimmed) ?? null;
  }, [library, saveName]);

  const distinctNewName = useMemo(
    () => suggestDistinctLibraryName(saveName.trim() || displayPrimaryName, library ?? []),
    [displayPrimaryName, library, saveName],
  );

  function openSaveToLibraryPrompt() {
    setSaveError(null);
    setSaveName(displayPrimaryName);
    setSaveMwText(mw !== null && mw > 0 ? String(mw) : "");
    setSaveDensityText("");
    setSavePromptOpen(true);
  }

  function handleSavePrimaryAsNew(targetName: string) {
    setSaveError(null);
    const parsedMw = saveMwText.trim() === "" ? undefined : looseNumber(saveMwText);
    if (saveMwText.trim() !== "" && (parsedMw === null || parsedMw === undefined || parsedMw <= 0)) {
      setSaveError("Molecular weight must be a positive number.");
      return;
    }
    const parsedDensity =
      saveDensityText.trim() === "" ? undefined : looseNumber(saveDensityText);
    if (
      saveDensityText.trim() !== "" &&
      (parsedDensity === null || parsedDensity === undefined || parsedDensity <= 0)
    ) {
      setSaveError("Density must be a positive number.");
      return;
    }
    const res = addLibraryCompound({
      name: targetName.trim(),
      mw: parsedMw,
      density: parsedDensity,
      cdxml: productCdxml?.trim() || undefined,
      structure: productCdxml?.trim() || undefined,
      imageDataUrl: productImage,
    });
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setSavePromptOpen(false);
    setSavedLibraryFlash(true);
    setTimeout(() => setSavedLibraryFlash(false), 3000);
  }

  function handleUpdateExistingPrimary(existingId: string) {
    setSaveError(null);
    const parsedMw = saveMwText.trim() === "" ? undefined : looseNumber(saveMwText);
    if (saveMwText.trim() !== "" && (parsedMw === null || parsedMw === undefined || parsedMw <= 0)) {
      setSaveError("Molecular weight must be a positive number.");
      return;
    }
    const parsedDensity =
      saveDensityText.trim() === "" ? undefined : looseNumber(saveDensityText);
    if (
      saveDensityText.trim() !== "" &&
      (parsedDensity === null || parsedDensity === undefined || parsedDensity <= 0)
    ) {
      setSaveError("Density must be a positive number.");
      return;
    }
    const res = updateLibraryCompound(existingId, {
      name: saveName.trim(),
      mw: parsedMw,
      density: parsedDensity,
      cdxml: productCdxml?.trim() || undefined,
      structure: productCdxml?.trim() || undefined,
      imageDataUrl: productImage,
    });
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setSavePromptOpen(false);
    setSavedLibraryFlash(true);
    setTimeout(() => setSavedLibraryFlash(false), 3000);
  }

  return (
    <section className={`print:break-inside-avoid ${isEmpty ? "print:hidden" : ""}`}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:mb-1">
        Isolated product &amp; yield
      </h2>

      {/* Screen: compact single-line horizontal product rows */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/40 px-3 py-2 print:hidden">
        {/* Column headers */}
        <div className={`mb-1 ${ROW_GRID} text-[10px] font-medium uppercase tracking-wider text-zinc-400`}>
          <span>Product</span>
          <span className="text-right">MW (g/mol)</span>
          <span className="text-right">m</span>
          <span
            className="text-right"
            title="Moles of limiting reagent consumed per mole of this product formed"
          >
            Ratio
          </span>
          <span
            className="text-center"
            title="Column chromatography elution window in Column Volumes (start – end CV)"
          >
            Elution (CV)
          </span>
          <span className="text-right">n</span>
          <span className="text-right">Yield</span>
          <span aria-hidden />
        </div>

        <div className="divide-y divide-zinc-200/60">
          {/* Primary product row */}
          <div className={`${ROW_GRID} py-1 first:pt-0 last:pb-0`}>
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: primaryColor.hex }}
                title={`Color on elution gradient chart (${displayPrimaryName})`}
                aria-hidden
              />
              <input
                type="text"
                value={name}
                placeholder={defaultPrimaryName}
                aria-label="Product name"
                onChange={(e) => onChange({ name: e.target.value })}
                className={`${cellInput} text-left font-medium`}
              />
            </div>

            <NumberInput
              ariaLabel="Product MW"
              value={mw}
              onCommit={(v) => onChange({ mw: v !== null && v > 0 ? v : null })}
            />

            <div className="flex items-center gap-1">
              <NumberInput
                ariaLabel={`Isolated mass (${massUnit})`}
                value={shownMass}
                onCommit={(v) =>
                  onChange({
                    isolatedMass: v !== null && v >= 0 ? toCanonical(v, massUnit) : null,
                  })
                }
              />
              <UnitToggle
                value={massUnit}
                onSelect={(u) => onChange({ massUnit: u })}
              />
            </div>

            <NumberInput
              ariaLabel="Stoichiometric ratio for primary product"
              value={primaryRatio}
              onCommit={(v) =>
                onChange({ stoichRatio: v !== null && v > 0 ? v : 1 })
              }
            />

            <div className="flex items-center gap-1">
              <NumberInput
                ariaLabel={`${displayPrimaryName} elution start CV`}
                value={primaryStartCv}
                onCommit={(v) =>
                  onChange({ elutionStartCv: v !== null && v >= 0 ? v : undefined })
                }
                className={`${cellInput} px-1 text-right text-xs`}
              />
              <span className="text-xs text-zinc-300" aria-hidden>
                –
              </span>
              <NumberInput
                ariaLabel={`${displayPrimaryName} elution end CV`}
                value={primaryEndCv}
                onCommit={(v) =>
                  onChange({ elutionEndCv: v !== null && v >= 0 ? v : undefined })
                }
                className={`${cellInput} px-1 text-right text-xs`}
              />
            </div>

            <div
              className="truncate text-right text-xs tabular-nums text-zinc-600"
              title="Isolated amount (n = m / MW)"
            >
              {primaryMetrics.nMmol === null ? "–" : formatMoles(primaryMetrics.nMmol)}
            </div>

            <div className="flex justify-end">
              <YieldBadge percent={primaryMetrics.percent} />
            </div>

            <span aria-hidden className="w-6" />
          </div>

          {/* Additional product rows (-F2, -F3, ...) */}
          {secondaryProducts.map((p, i) => (
            <SecondaryProductRow
              key={p.id}
              index={i}
              experimentId={idPrefix}
              product={p}
              metrics={secondaryMetrics[i]}
              onChange={(patch) => patchSecondary(p.id, patch)}
              onRemove={() => removeSecondary(p.id)}
            />
          ))}
        </div>

        {/* Compact footer bar: + Add Product, hint, and multi-product conversion summary */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/70 pt-1.5 text-[11px] text-zinc-500">
          <div className="flex flex-wrap items-center gap-2.5">
            {onSecondaryChange && (
              <button
                type="button"
                onClick={handleAddProduct}
                className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
              >
                + Add Product
              </button>
            )}
            {canSaveProductToLibrary && (
              <button
                type="button"
                onClick={() => {
                  if (savePromptOpen) {
                    setSavePromptOpen(false);
                  } else {
                    openSaveToLibraryPrompt();
                  }
                }}
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  savedLibraryFlash
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : savePromptOpen
                      ? "border-fume-400 bg-fume-50 text-fume-800"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
                }`}
                title={`Save ${displayPrimaryName} (MW and structure) to your Personal Compound Library`}
              >
                {savedLibraryFlash ? "Saved to Library ✓" : "+ Save to Library"}
              </button>
            )}
            {hint && <span className="text-zinc-400">{hint}</span>}
          </div>

          {secondaryProducts.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
              {summary.items.map((item, idx) => (
                <span key={`${item.label}-${idx}`} className="inline-flex items-center gap-1 text-zinc-500">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: productColorAt(idx).hex }}
                    aria-hidden
                  />
                  <span className="font-medium text-zinc-700">{item.name || item.label}</span>
                  {": "}
                  {item.percent === null ? "–" : `${item.percent.toFixed(1)}%`}
                </span>
              ))}
              <span className="font-semibold text-zinc-800">
                Total conversion:{" "}
                <span className={over100 ? "text-amber-700" : "text-zinc-900"}>
                  {summary.conversionPercent === null
                    ? "–"
                    : `${summary.conversionPercent.toFixed(1)}%`}
                </span>
              </span>
            </div>
          )}
        </div>

        {/* Inline "+ Save to Library" prompt with duplicate-name protection */}
        {savePromptOpen && (
          <div className="mt-2 rounded-md border border-fume-200 bg-white p-2.5 text-xs shadow-2xs print:hidden">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Save Product to Personal Compound Library
              </span>
              <button
                type="button"
                onClick={() => setSavePromptOpen(false)}
                className="text-xs text-zinc-400 hover:text-zinc-600"
                aria-label="Close save prompt"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (existingLibraryMatch) {
                      handleSavePrimaryAsNew(distinctNewName);
                    } else {
                      handleSavePrimaryAsNew(saveName);
                    }
                  } else if (e.key === "Escape") {
                    setSavePromptOpen(false);
                  }
                }}
                placeholder="Compound name"
                aria-label="Product compound name for library"
                autoFocus
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={saveMwText}
                onChange={(e) => setSaveMwText(e.target.value)}
                placeholder="MW (g/mol)"
                aria-label="Molecular weight (g/mol)"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={saveDensityText}
                onChange={(e) => setSaveDensityText(e.target.value)}
                placeholder="d (g/mL, optional)"
                aria-label="Density (g/mL)"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </div>

            {saveError && (
              <p role="alert" className="mt-1.5 text-[11px] text-red-600">
                {saveError}
              </p>
            )}

            {existingLibraryMatch ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                <span>
                  Compound <strong>&ldquo;{existingLibraryMatch.name}&rdquo;</strong> already exists
                  in your library — Save as new name or explicitly Update existing:
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleSavePrimaryAsNew(distinctNewName)}
                    className="rounded bg-fume-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-fume-700"
                  >
                    Save as &ldquo;{distinctNewName}&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateExistingPrimary(existingLibraryMatch.id)}
                    className="rounded border border-amber-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  >
                    Update existing
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setSavePromptOpen(false)}
                  className="rounded border border-zinc-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSavePrimaryAsNew(saveName)}
                  className="rounded bg-fume-600 px-3 py-0.5 text-[11px] font-semibold text-white hover:bg-fume-700"
                >
                  Save to Library
                </button>
              </div>
            )}
          </div>
        )}

        {over100 && (
          <p
            role="status"
            className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800"
          >
            {OVER_100_WARNING}
          </p>
        )}
      </div>

      {/* Print: one single compact line per isolated product */}
      <div className="hidden print:block">
        <div className="divide-y divide-zinc-200 border-y border-zinc-200">
          {primaryHasData && (
            <PrintProductLine
              name={displayPrimaryName}
              colorHex={primaryColor.hex}
              mw={mw}
              massValue={shownMass}
              massUnit={massUnit}
              elutionStartCv={primaryStartCv}
              elutionEndCv={primaryEndCv}
              metrics={primaryMetrics}
            />
          )}
          {secondaryProducts.map((p, i) => {
            if (isBlankSecondary(p, idPrefix, i)) return null;
            const metrics = secondaryMetrics[i];
            const fallback = idPrefix ? `${idPrefix}-F${i + 2}` : `F${i + 2}`;
            const unit: ProductMassUnit = p.massUnit ?? "mg";
            const color = productColorAt(i + 1);
            return (
              <PrintProductLine
                key={p.id}
                name={p.name.trim() || fallback}
                colorHex={color.hex}
                mw={looseNumber(p.mw)}
                massValue={looseNumber(p.mass)}
                massUnit={unit}
                elutionStartCv={looseNumber(p.elutionStartCv)}
                elutionEndCv={looseNumber(p.elutionEndCv)}
                metrics={metrics}
              />
            );
          })}
        </div>

        {hasFilledAdditional && (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums text-zinc-600">
            <span>
              {summary.items
                .filter((_, idx) =>
                  idx === 0
                    ? primaryHasData
                    : !isBlankSecondary(secondaryProducts[idx - 1], idPrefix, idx - 1),
                )
                .map(
                  (item) =>
                    `${item.name || item.label}: ${item.percent === null ? "–" : `${item.percent.toFixed(1)}%`}${
                      item.nMmol !== null ? ` (${formatMoles(item.nMmol)})` : ""
                    }`,
                )
                .join(" · ")}
            </span>
            <span className="font-semibold text-zinc-900">
              Total limiting reagent conversion:{" "}
              {summary.conversionPercent === null
                ? "–"
                : `${summary.conversionPercent.toFixed(1)}%`}
              {over100 ? " (>100%)" : ""}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function PrintProductLine({
  name,
  colorHex,
  mw,
  massValue,
  massUnit,
  elutionStartCv,
  elutionEndCv,
  metrics,
}: {
  name: string;
  colorHex: string;
  mw: number | null;
  massValue: number | null;
  massUnit: ProductMassUnit;
  elutionStartCv: number | null;
  elutionEndCv: number | null;
  metrics?: ProductMetrics;
}) {
  const nMmol = metrics?.nMmol ?? null;
  const percent = metrics?.percent ?? null;
  const ratio = metrics?.ratio ?? 1;
  const hasElution =
    elutionStartCv !== null &&
    elutionEndCv !== null &&
    elutionStartCv >= 0 &&
    elutionEndCv >= elutionStartCv &&
    elutionEndCv > 0;

  return (
    <div className="flex items-center justify-between gap-3 py-1 text-xs tabular-nums text-zinc-700">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-900">
          {hasElution && (
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: colorHex }}
              aria-hidden
            />
          )}
          <span>{name}</span>
        </span>
        <span className="text-zinc-300" aria-hidden>
          •
        </span>
        <span>
          MW {mw === null ? "–" : `${formatNumber(mw)} g/mol`}
        </span>
        <span className="text-zinc-300" aria-hidden>
          •
        </span>
        <span>
          m ={" "}
          {massValue === null
            ? "–"
            : `${formatNumber(massValue)} ${massUnit}`}
          {nMmol !== null ? ` (${formatMoles(nMmol)})` : ""}
        </span>
        {ratio !== 1 && (
          <>
            <span className="text-zinc-300" aria-hidden>
              •
            </span>
            <span>ratio {formatNumber(ratio)}:1</span>
          </>
        )}
        {hasElution && (
          <>
            <span className="text-zinc-300" aria-hidden>
              •
            </span>
            <span className="inline-flex items-center gap-1 font-medium text-zinc-800">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: colorHex }}
                aria-hidden
              />
              <span>
                Eluted: {formatNumber(elutionStartCv)}–{formatNumber(elutionEndCv)} CV
              </span>
            </span>
          </>
        )}
      </div>
      <YieldBadge percent={percent} />
    </div>
  );
}

function UnitToggle({
  value,
  onSelect,
}: {
  value: ProductMassUnit;
  onSelect: (unit: ProductMassUnit) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Isolated mass unit"
      className="inline-flex shrink-0 overflow-hidden rounded border border-zinc-200 bg-white text-[10px] font-medium"
    >
      {PRODUCT_MASS_UNITS.map((u) => {
        const active = u === value;
        return (
          <button
            key={u}
            type="button"
            onClick={() => onSelect(u)}
            className={`px-1.5 py-1 transition-colors ${
              active
                ? "bg-fume-600 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {u}
          </button>
        );
      })}
    </div>
  );
}

function YieldBadge({ percent }: { percent: number | null }) {
  const high = percent !== null && percent > GOOD_YIELD_PERCENT;
  return (
    <div
      aria-label="Percentage yield"
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-right text-xs font-bold tabular-nums transition-colors print:px-2 print:py-0.5 print:text-xs ${
        percent === null
          ? "border-zinc-200 bg-white text-zinc-400"
          : high
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : "border-zinc-300 bg-white text-zinc-800"
      }`}
    >
      {percent === null ? "–" : `${percent.toFixed(1)} %`}
    </div>
  );
}

function SecondaryProductRow({
  index,
  experimentId,
  product,
  metrics,
  onChange,
  onRemove,
}: {
  index: number;
  experimentId: string;
  product: SecondaryProduct;
  metrics?: ProductMetrics;
  onChange: (patch: Partial<SecondaryProduct>) => void;
  onRemove: () => void;
}) {
  const label = experimentId ? `${experimentId}-F${index + 2}` : `F${index + 2}`;
  const mwNum = looseNumber(product.mw);
  const massNum = looseNumber(product.mass);
  const ratioNum = looseNumber(product.stoichRatio);
  const startCvNum = looseNumber(product.elutionStartCv);
  const endCvNum = looseNumber(product.elutionEndCv);
  const currentUnit: ProductMassUnit = product.massUnit ?? "mg";
  const color = productColorAt(index + 1);

  const setUnit = (unit: ProductMassUnit) => {
    if (unit === currentUnit) return;
    const currentMg =
      massNum !== null && massNum >= 0 ? toCanonical(massNum, currentUnit) : null;
    const converted = currentMg !== null ? fromCanonical(currentMg, unit) : null;
    onChange({
      massUnit: unit,
      mass:
        converted !== null
          ? parseFloat(converted.toFixed(MASS_DECIMALS[unit]))
          : "",
    });
  };

  return (
    <div className={`${ROW_GRID} py-1 first:pt-0 last:pb-0`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color.hex }}
          title={`Color on elution gradient chart (${product.name.trim() || label})`}
          aria-hidden
        />
        <input
          type="text"
          value={product.name}
          placeholder={label}
          aria-label={`${label} name`}
          onChange={(e) => onChange({ name: e.target.value })}
          className={`${cellInput} text-left font-medium`}
        />
      </div>

      <NumberInput
        ariaLabel={`${label} MW`}
        value={mwNum}
        onCommit={(v) => onChange({ mw: v !== null && v > 0 ? v : "" })}
      />

      <div className="flex items-center gap-1">
        <NumberInput
          ariaLabel={`${label} isolated mass (${currentUnit})`}
          value={massNum}
          onCommit={(v) => onChange({ mass: v !== null && v >= 0 ? v : "" })}
        />
        <UnitToggle value={currentUnit} onSelect={setUnit} />
      </div>

      <NumberInput
        ariaLabel={`${label} stoichiometric ratio`}
        value={ratioNum}
        onCommit={(v) => onChange({ stoichRatio: v !== null && v > 0 ? v : 1 })}
      />

      <div className="flex items-center gap-1">
        <NumberInput
          ariaLabel={`${label} elution start CV`}
          value={startCvNum}
          onCommit={(v) =>
            onChange({ elutionStartCv: v !== null && v >= 0 ? v : undefined })
          }
          className={`${cellInput} px-1 text-right text-xs`}
        />
        <span className="text-xs text-zinc-300" aria-hidden>
          –
        </span>
        <NumberInput
          ariaLabel={`${label} elution end CV`}
          value={endCvNum}
          onCommit={(v) =>
            onChange({ elutionEndCv: v !== null && v >= 0 ? v : undefined })
          }
          className={`${cellInput} px-1 text-right text-xs`}
        />
      </div>

      <div
        className="truncate text-right text-xs tabular-nums text-zinc-600"
        title="Isolated amount (n = m / MW)"
      >
        {metrics?.nMmol != null ? formatMoles(metrics.nMmol) : "–"}
      </div>

      <div className="flex justify-end">
        <YieldBadge percent={metrics?.percent ?? null} />
      </div>

      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${product.name.trim() || label}`}
        aria-label={`Remove ${product.name.trim() || label}`}
        className="grid size-6 place-items-center rounded text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        ×
      </button>
    </div>
  );
}
