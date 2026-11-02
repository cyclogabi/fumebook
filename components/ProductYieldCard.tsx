"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NumberInput, { cellInput } from "@/components/NumberInput";
import { detectFormat, suggestDistinctLibraryName, useLibrary } from "@/lib/library";
import { extractCanonicalSmilesFailSafe } from "@/components/MoleculeSection";
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
  suggestFractionLabel,
  type IsolatedFractionRole,
  type ProductInfo,
  type ProductMassUnit,
  type ReagentRow,
  type SecondaryProduct,
} from "@/lib/types";
import { GOOD_YIELD_PERCENT } from "@/lib/yield";

interface Props {
  experimentId?: string;
  product: ProductInfo;
  rows: ReagentRow[];
  onChange: (patch: Partial<ProductInfo>) => void;
  secondaryProducts?: SecondaryProduct[];
  onSecondaryChange?: (fn: (current: SecondaryProduct[]) => SecondaryProduct[]) => void;
  /** Optional primary product CDXML, molfile, or SMILES stored on the reaction scheme. */
  productCdxml?: string;
  /** Optional primary product rendered SVG/PNG image data URL from the reaction scheme. */
  productImage?: string;
  /** SMILES already extracted for the reaction-scheme product, when one exists. */
  productSmiles?: string;
  /** Molecular weight of the drawn reaction-scheme target, g/mol. Not a fraction's MW. */
  schemeMw?: number | null;
  /** Write fraction 1 and the other rows together when one of them is linked to the scheme. */
  onFractionsCommit?: (next: { product: ProductInfo; secondaryProducts: SecondaryProduct[] }) => void;
}

const MASS_DECIMALS: Record<ProductMassUnit, number> = { mg: 1, g: 4 };

const OVER_100_WARNING =
  "Total conversion exceeds 100% — check MW, stoichiometry ratio, or residual solvent.";

const ROW_GRID =
  "grid min-w-[880px] grid-cols-[minmax(220px,1.6fr)_4.75rem_7.75rem_3.25rem_6.75rem_4.75rem_4.75rem_1.5rem] items-center gap-2";

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
    p.isolatedRole !== "target" &&
    looseNumber(p.mw) === null &&
    looseNumber(p.mass) === null &&
    looseNumber(p.elutionStartCv) === null &&
    looseNumber(p.elutionEndCv) === null &&
    isDefaultSecondaryName(p.name, experimentId, index)
  );
}

/**
 * Isolated fractions and their yields. Fraction 1 defaults to `<experiment>-F1`.
 * A row with no molecular weight of its own uses the scheme product MW for yield.
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
  productSmiles,
  schemeMw = null,
}: Props) {
  const {
    compounds: library,
    add: addLibraryCompound,
    update: updateLibraryCompound,
  } = useLibrary();
  const [savedLibraryName, setSavedLibraryName] = useState<string | null>(null);
  const [savedRowKey, setSavedRowKey] = useState<string | null>(null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveRowKey, setSaveRowKey] = useState("primary");
  const [saveName, setSaveName] = useState("");
  const [saveAliases, setSaveAliases] = useState("");
  const [saveIupac, setSaveIupac] = useState("");
  const [saveCas, setSaveCas] = useState("");
  const [saveMwText, setSaveMwText] = useState("");
  const [saveDensityText, setSaveDensityText] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { name, mw, isolatedMass, massUnit } = product;
  const primaryRatio = stoichRatioOf(product);
  const primaryStartCv = looseNumber(product.elutionStartCv);
  const primaryEndCv = looseNumber(product.elutionEndCv);
  const primaryColor = productColorAt(0);
  const idPrefix = experimentId.trim();
  const defaultPrimaryName = idPrefix ? `${idPrefix}-F1` : "F1";
  const linkedSchemeMw = schemeMw !== null && schemeMw > 0 ? schemeMw : null;

  // An empty fraction 1 starts as GH055-F1. A name already stored is left alone,
  // and the scheme-target caption is never copied into this row.
  const seededForId = useRef<string | null>(null);
  useEffect(() => {
    if (!idPrefix || seededForId.current === idPrefix) return;
    seededForId.current = idPrefix;
    if (name.trim() === "") {
      onChange({ name: defaultPrimaryName });
    }
  }, [idPrefix, name, defaultPrimaryName, onChange]);

  const summary = summariseProducts(
    rows,
    product,
    secondaryProducts,
    idPrefix,
    linkedSchemeMw,
  );
  const primaryMetrics = summary.items[0];
  const secondaryMetrics = summary.items.slice(1);

  const shownMass = isolatedMass === null ? null : fromCanonical(isolatedMass, massUnit);

  const primaryHasData =
    mw !== null ||
    isolatedMass !== null ||
    primaryStartCv !== null ||
    primaryEndCv !== null ||
    product.isolatedRole === "target" ||
    !isDefaultPrimaryName(name, idPrefix);
  const hasFilledAdditional = secondaryProducts.some(
    (p, i) => !isBlankSecondary(p, idPrefix, i),
  );
  const isEmpty = !primaryHasData && !hasFilledAdditional;

  const over100 = summary.conversionPercent !== null && summary.conversionPercent > 100;

  const hint = linkedSchemeMw
    ? `MW uses the scheme product (${formatNumber(linkedSchemeMw)} g/mol) until you type a different value on a fraction.`
    : "Enter a molecular weight on a fraction, or draw the scheme product, to calculate yield.";

  const handleAddProduct = () => {
    if (!onSecondaryChange) return;
    onSecondaryChange((list) => {
      const nextLabel = suggestFractionLabel(idPrefix, [name, ...list.map((item) => item.name)]);
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
    onSecondaryChange((list) => list.filter((item) => item.id !== id));
  };

  const displayPrimaryName = name.trim() || defaultPrimaryName;
  const schemeMwTitle = linkedSchemeMw
    ? `Scheme molecular weight (${formatNumber(linkedSchemeMw)} g/mol). Type a number to override this fraction.`
    : undefined;

  function secondaryFractionName(item: SecondaryProduct, index: number): string {
    return item.name.trim() || (idPrefix ? `${idPrefix}-F${index + 2}` : `F${index + 2}`);
  }

  function saveRowFor(key: string): {
    key: string;
    name: string;
    role: IsolatedFractionRole | undefined;
    mw: number | null;
  } | null {
    if (key === "primary") {
      return { key, name: displayPrimaryName, role: product.isolatedRole, mw };
    }
    const index = secondaryProducts.findIndex((item) => item.id === key);
    if (index < 0) return null;
    const item = secondaryProducts[index];
    return {
      key,
      name: secondaryFractionName(item, index),
      role: item.isolatedRole,
      mw: looseNumber(item.mw),
    };
  }

  function schemeDrawing(): {
    hasDrawing: boolean;
    structure?: string;
    cdxml?: string;
    image?: string;
    smiles?: string;
    source: string;
  } {
    const raw = (productCdxml ?? "").trim();
    const format = raw ? detectFormat(raw) : null;
    const cdxml = raw && /<CDXML[\s>]/i.test(raw) ? raw : undefined;
    const molfile = format === "mol" ? raw : "";
    const smilesFromRaw = format === "smiles" ? raw : "";
    const smiles = (productSmiles ?? "").trim() || smilesFromRaw;
    const structure = cdxml || molfile || smiles;
    const image =
      productImage && productImage.trim().startsWith("data:image/")
        ? productImage.trim()
        : undefined;
    return {
      hasDrawing: Boolean(structure || image),
      structure: structure || undefined,
      cdxml,
      image,
      smiles: smiles || undefined,
      source: cdxml || molfile || raw,
    };
  }

  function inheritsSchemeStructure(role: IsolatedFractionRole | undefined): boolean {
    if (!schemeDrawing().hasDrawing) return false;
    if (role === "target") return true;
    const claimed =
      product.isolatedRole === "target" ||
      secondaryProducts.some((item) => item.isolatedRole === "target");
    return !claimed;
  }

  function preferredSaveKey(): string {
    if (product.isolatedRole === "target") return "primary";
    return secondaryProducts.find((item) => item.isolatedRole === "target")?.id ?? "primary";
  }

  const openSaveRow = saveRowFor(saveRowKey);
  const openInheritsScheme = openSaveRow ? inheritsSchemeStructure(openSaveRow.role) : false;

  const existingLibraryMatch = useMemo(() => {
    const trimmed = saveName.trim().toLowerCase();
    if (!trimmed) return null;
    return (library ?? []).find((c) => c.name.trim().toLowerCase() === trimmed) ?? null;
  }, [library, saveName]);

  const distinctNewName = useMemo(
    () => suggestDistinctLibraryName(saveName.trim() || openSaveRow?.name || "Compound", library ?? []),
    [library, openSaveRow?.name, saveName],
  );

  function openSaveToLibraryPrompt(key = preferredSaveKey()) {
    const row = saveRowFor(key);
    if (!row) return;
    setSaveRowKey(row.key);
    setSaveName(row.name);
    const inherit = inheritsSchemeStructure(row.role);
    const suggestedMw =
      row.role === "target" && linkedSchemeMw
        ? linkedSchemeMw
        : row.mw !== null && row.mw > 0
          ? row.mw
          : inherit && linkedSchemeMw
            ? linkedSchemeMw
            : null;
    setSaveMwText(suggestedMw !== null ? String(suggestedMw) : "");
    setSaveDensityText("");
    const existing = (library ?? []).find(
      (compound) => compound.name.trim().toLowerCase() === row.name.trim().toLowerCase(),
    );
    setSaveAliases(existing?.aliases?.join(", ") ?? "");
    setSaveIupac(existing?.iupacName ?? "");
    setSaveCas(existing?.casNumber ?? "");
    const claimed =
      product.isolatedRole === "target" ||
      secondaryProducts.some((item) => item.isolatedRole === "target");
    if (!inherit && !(row.mw !== null && row.mw > 0) && !linkedSchemeMw) {
      setSaveError(
        claimed
          ? `${row.name} is not linked to the scheme and has no molecular weight. Link it, or enter its MW, before saving.`
          : `Draw the product on the reaction scheme, or enter a molecular weight for ${row.name}, before saving.`,
      );
    } else {
      setSaveError(null);
    }
    setSavePromptOpen(true);
  }

  function buildFractionLibraryInput(targetName: string):
    | {
        ok: true;
        input: Parameters<typeof addLibraryCompound>[0];
        source: string;
      }
    | { ok: false; error: string } {
    const trimmedName = targetName.trim();
    if (!trimmedName) return { ok: false, error: "Give the compound a name." };
    const parsedMw = saveMwText.trim() === "" ? undefined : looseNumber(saveMwText);
    if (saveMwText.trim() !== "" && (parsedMw === null || parsedMw === undefined || parsedMw <= 0)) {
      return { ok: false, error: "Molecular weight must be a positive number." };
    }
    const parsedDensity =
      saveDensityText.trim() === "" ? undefined : looseNumber(saveDensityText);
    if (
      saveDensityText.trim() !== "" &&
      (parsedDensity === null || parsedDensity === undefined || parsedDensity <= 0)
    ) {
      return { ok: false, error: "Density must be a positive number." };
    }
    const row = saveRowFor(saveRowKey);
    const inherit = row ? inheritsSchemeStructure(row.role) : false;
    const drawing = inherit ? schemeDrawing() : null;
    const mwValue =
      parsedMw ??
      (row?.role === "target" && linkedSchemeMw ? linkedSchemeMw : undefined) ??
      (inherit && linkedSchemeMw ? linkedSchemeMw : undefined);
    if (!drawing?.hasDrawing && mwValue === undefined && !saveCas.trim() && !saveIupac.trim() && !saveAliases.trim()) {
      return {
        ok: false,
        error: row
          ? `${row.name} has no structure or molecular weight to save. Draw the scheme product, link this fraction, or enter its MW.`
          : "Draw the product on the reaction scheme, or enter a molecular weight, before saving.",
      };
    }
    return {
      ok: true,
      source: drawing?.source ?? "",
      input: {
        name: trimmedName,
        mw: mwValue,
        density: parsedDensity,
        structure: drawing?.structure,
        cdxml: drawing?.cdxml,
        imageDataUrl: drawing?.image,
        smiles: drawing?.smiles ?? null,
        aliases: saveAliases,
        iupacName: saveIupac,
        casNumber: saveCas,
      },
    };
  }

  function rememberSavedFraction(compoundId: string, compoundName: string, source: string, smiles?: string) {
    setSavePromptOpen(false);
    setSavedLibraryName(compoundName);
    setSavedRowKey(saveRowKey);
    window.setTimeout(() => {
      setSavedLibraryName((current) => (current === compoundName ? null : current));
      setSavedRowKey((current) => (current === saveRowKey ? null : current));
    }, 3000);
    const raw = source.trim();
    if (smiles?.trim() || !raw || detectFormat(raw) === "smiles") return;
    void extractCanonicalSmilesFailSafe(raw).then((next) => {
      if (!next) return;
      updateLibraryCompound(compoundId, { name: compoundName, smiles: next });
    });
  }

  function handleSaveFractionAsNew(targetName: string) {
    const built = buildFractionLibraryInput(targetName);
    if (!built.ok) {
      setSaveError(built.error);
      return;
    }
    const res = addLibraryCompound(built.input);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setSaveError(null);
    rememberSavedFraction(res.compound.id, res.compound.name, built.source, res.compound.smiles);
  }

  function handleUpdateExistingFraction(existingId: string) {
    const built = buildFractionLibraryInput(saveName);
    if (!built.ok) {
      setSaveError(built.error);
      return;
    }
    const res = updateLibraryCompound(existingId, built.input);
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setSaveError(null);
    rememberSavedFraction(res.compound.id, res.compound.name, built.source, res.compound.smiles);
  }

  return (
    <section className={`print:break-inside-avoid ${isEmpty ? "print:hidden" : ""}`}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:mb-1">
        Isolated fractions &amp; yield
      </h2>

      {/* Screen: compact single-line horizontal product rows */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50/40 px-3 py-2 print:hidden">
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
            <div className="flex min-w-[220px] items-center gap-1.5">
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
                aria-label="Fraction 1 name"
                onChange={(e) => onChange({ name: e.target.value, libraryMatch: undefined })}
                className={`${cellInput} min-w-[180px] flex-1 text-left font-medium`}
              />
              <FractionLibraryButton
                label={displayPrimaryName}
                saved={savedRowKey === "primary"}
                onClick={() => openSaveToLibraryPrompt("primary")}
              />
              {product.libraryMatch && (
                <span className="shrink-0 whitespace-nowrap rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200 print:hidden">
                  Matched in Library ✓
                </span>
              )}
            </div>

            <NumberInput
              ariaLabel="Product MW"
              value={mw !== null && mw > 0 ? mw : linkedSchemeMw}
              dimmed={(mw === null || mw <= 0) && linkedSchemeMw !== null}
              title={(mw === null || mw <= 0) ? schemeMwTitle : undefined}
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
              <YieldBadge
                percent={primaryMetrics.percent}
                title={
                  (mw === null || mw <= 0) && linkedSchemeMw
                    ? `Yield uses the scheme MW (${formatNumber(linkedSchemeMw)} g/mol)`
                    : undefined
                }
              />
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
              schemeMw={linkedSchemeMw}
              onChange={(patch) => patchSecondary(p.id, patch)}
              onSaveLibrary={() => openSaveToLibraryPrompt(p.id)}
              librarySaved={savedRowKey === p.id}
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
                savedLibraryName
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : savePromptOpen
                    ? "border-fume-400 bg-fume-50 text-fume-800"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
              }`}
              title={
                savedLibraryName
                  ? `${savedLibraryName} was saved to the Personal Library`
                  : `Save ${
                      (savePromptOpen ? openSaveRow?.name : saveRowFor(preferredSaveKey())?.name) ??
                      displayPrimaryName
                    } to your Personal Compound Library`
              }
            >
              {savedLibraryName ? `Saved ${savedLibraryName} to Library ✓` : "+ Save to Library"}
            </button>
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
                Save {openSaveRow?.name ?? "fraction"} to Personal Compound Library
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
                      handleSaveFractionAsNew(distinctNewName);
                    } else {
                      handleSaveFractionAsNew(saveName);
                    }
                  } else if (e.key === "Escape") {
                    setSavePromptOpen(false);
                  }
                }}
                placeholder="Display name / nickname"
                aria-label="Product display name"
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
                placeholder="Density (g/mL)"
                aria-label="Density (g/mL)"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </div>
            <input
              type="text"
              value={saveAliases}
              onChange={(e) => setSaveAliases(e.target.value)}
              placeholder="Aliases, comma-separated"
              aria-label="Synonyms and aliases"
              className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
            />
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={saveIupac}
                onChange={(e) => setSaveIupac(e.target.value)}
                placeholder="IUPAC / systematic name"
                aria-label="IUPAC or systematic name"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
              <input
                type="text"
                value={saveCas}
                onChange={(e) => setSaveCas(e.target.value)}
                placeholder="CAS number"
                aria-label="CAS number"
                spellCheck={false}
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </div>

            {openInheritsScheme && !saveError && (
              <p className="mt-1.5 text-[11px] text-zinc-500">
                Structure and 2D preview come from the reaction-scheme product.
                {linkedSchemeMw ? ` Molecular weight ${formatNumber(linkedSchemeMw)} g/mol.` : ""}
              </p>
            )}

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
                    onClick={() => handleSaveFractionAsNew(distinctNewName)}
                    className="rounded bg-fume-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-fume-700"
                  >
                    Save as &ldquo;{distinctNewName}&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateExistingFraction(existingLibraryMatch.id)}
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
                  onClick={() => handleSaveFractionAsNew(saveName)}
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
              mw={mw !== null && mw > 0 ? mw : linkedSchemeMw}
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
            const fallback =
              p.name.trim() ||
              suggestFractionLabel(idPrefix, [
                name,
                ...secondaryProducts.slice(0, i).map((item) => item.name),
              ]);
            const unit: ProductMassUnit = p.massUnit ?? "mg";
            const color = productColorAt(i + 1);
            return (
              <PrintProductLine
                key={p.id}
                name={p.name.trim() || fallback}
                colorHex={color.hex}
                mw={looseNumber(p.mw) ?? linkedSchemeMw}
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

function YieldBadge({ percent, title }: { percent: number | null; title?: string }) {
  const high = percent !== null && percent > GOOD_YIELD_PERCENT;
  return (
    <div
      aria-label="Percentage yield"
      title={title}
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

function FractionLibraryButton({
  label,
  saved,
  onClick,
}: {
  label: string;
  saved: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={saved ? `${label} saved to the Personal Library` : `Save ${label} to the Personal Library`}
      aria-label={saved ? `${label} saved to Library` : `Save ${label} to Library`}
      className={`grid size-6 shrink-0 place-items-center rounded print:hidden ${
        saved
          ? "bg-emerald-50 text-emerald-700"
          : "text-zinc-400 hover:bg-fume-50 hover:text-fume-700"
      }`}
    >
      {saved ? (
        <span className="text-[10px] font-semibold" aria-hidden>
          ✓
        </span>
      ) : (
        <svg
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 2.5h8a1 1 0 0 1 1 1v10l-5-3-5 3v-10a1 1 0 0 1 1-1Z" />
          <path d="M8 5v4M6 7h4" />
        </svg>
      )}
    </button>
  );
}

function SecondaryProductRow({
  index,
  experimentId,
  product,
  metrics,
  schemeMw,
  onChange,
  onSaveLibrary,
  librarySaved = false,
  onRemove,
}: {
  index: number;
  experimentId: string;
  product: SecondaryProduct;
  metrics?: ProductMetrics;
  schemeMw: number | null;
  onChange: (patch: Partial<SecondaryProduct>) => void;
  onSaveLibrary: () => void;
  librarySaved?: boolean;
  onRemove: () => void;
}) {
  const label =
    product.name.trim() ||
    (experimentId ? `${experimentId}-F${index + 2}` : `F${index + 2}`);
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
      <div className="flex min-w-[220px] items-center gap-1.5">
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
          aria-label={`${label} fraction id`}
          onChange={(e) => onChange({ name: e.target.value })}
          className={`${cellInput} min-w-[180px] flex-1 text-left font-medium`}
        />
        <FractionLibraryButton label={label} saved={librarySaved} onClick={onSaveLibrary} />
      </div>

      <NumberInput
        ariaLabel={`${label} MW`}
        value={mwNum !== null && mwNum > 0 ? mwNum : schemeMw}
        dimmed={(mwNum === null || mwNum <= 0) && schemeMw !== null}
        title={
          (mwNum === null || mwNum <= 0) && schemeMw
            ? `Scheme molecular weight (${formatNumber(schemeMw)} g/mol). Type a number to override this fraction.`
            : undefined
        }
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
        <YieldBadge
          percent={metrics?.percent ?? null}
          title={
            (mwNum === null || mwNum <= 0) && schemeMw
              ? `Yield uses the scheme MW (${formatNumber(schemeMw)} g/mol)`
              : undefined
          }
        />
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
