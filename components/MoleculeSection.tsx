"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";
import ReagentNameInput from "./ReagentNameInput";
import { hasCdxmlContent, useChemDrawLink } from "./useChemDrawLink";
import { searchDictionary, type ChemicalEntry } from "@/lib/chemicalDictionary";
import { cleanClipboardText, isValidChemicalText } from "@/lib/chemText";
import {
  readChemDrawClipboard,
  readClipboardImageBase64,
  readClipboardText,
} from "@/lib/clipboard";
import { dataUrlToTrimmedPngDataUrl, imageFileToPng } from "@/lib/images";
import {
  describeProperties,
  detectFormat,
  prepareForKetcher,
  searchLibrary,
  suggestDistinctLibraryName,
  useLibrary,
  type CompoundInput,
  type LibraryCompound,
} from "@/lib/library";
import { editField, formatNumber, looseNumber } from "@/lib/stoich";
import { blobToDataUrl, saveSchemeCdxml } from "@/lib/storage";
import { isTauri } from "@/lib/tauri";
import {
  newRow,
  type MoleculeMode,
  type ProductInfo,
  type ReagentRow,
  type SecondaryProduct,
  type StructuredReactionScheme,
} from "@/lib/types";

interface Props {
  experimentId: string;
  /** Saved Rxnfile/Molfile of the drawing. */
  reactionScheme: string;
  onReactionSchemeChange: (rxn: string) => void;
  mode: MoleculeMode;
  onModeChange: (mode: MoleculeMode) => void;
  /** A picture was saved as `molecule.png` / `molecule.svg`. */
  hasImage: boolean;
  onHasImageChange: (hasImage: boolean) => void;
  /** 3-Zone Structured Reaction Scheme ([Reactant] -> [Arrow + Conditions] -> [Product]). */
  structuredScheme?: StructuredReactionScheme;
  onStructuredSchemeChange: (scheme: StructuredReactionScheme | undefined) => void;
  /** Experiment reagents (synced with Left Zone Limiting Reagent & Center Zone Above-Arrow Reagents). */
  reagents: ReagentRow[];
  onReagentsChange: (fn: (rows: ReagentRow[]) => ReagentRow[]) => void;
  /** Primary product & secondary products (synced with Right Zone Product label & MW). */
  product: ProductInfo;
  onProductChange?: (patch: Partial<ProductInfo>) => void;
  secondaryProducts?: SecondaryProduct[];
  /** Open the Personal Library dialog. */
  onOpenLibrary: () => void;
  ref?: Ref<MoleculeSectionHandle>;
}

export type StructureZone = "reactant" | "product";

/** What the rest of the page (the reagent table) can ask of this section. */
export interface MoleculeSectionHandle {
  /**
   * Add a library compound's structure to the scheme (`reactant` or `product` zone).
   * Resolves to an error message, or null when it was added.
   */
  insertCompound: (
    compound: LibraryCompound,
    preferredZone?: StructureZone,
  ) => Promise<string | null>;
}

const REACTION_SOLVENT_SUGGESTIONS = [
  "dry THF",
  "THF",
  "DCM",
  "MeCN",
  "DMF",
  "DMSO",
  "PhMe",
  "Et₂O",
  "1,4-Dioxane",
  "MeOH",
  "EtOH",
  "iPrOH",
  "Acetone",
  "H₂O",
  "DCM / H₂O (4:1)",
  "THF / H₂O (3:1)",
];

const ATMOSPHERE_OPTIONS = ["Ar", "N₂", "Air"] as const;

const KEY_PASTE_FALLBACK_MS = 150;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type StandaloneStructService = ReturnType<
  InstanceType<
    typeof import("ketcher-standalone").StandaloneStructServiceProvider
  >["createStructService"]
>;

let sharedStructServicePromise: Promise<StandaloneStructService> | null = null;

const INDIGO_LENIENT_OPTIONS: Record<string, string | number | boolean> = {
  "ignore-stereochemistry-errors": true,
  "ignore-bad-valence": true,
  "mass-skip-error-on-pseudoatoms": true,
  "gross-formula-add-rsites": true,
  "gross-formula-add-isotopes": true,
  ignoreStereochemistryErrors: true,
  ignoreBadValence: true,
};

/**
 * Strip wedge/hash bond stereo flags (columns 10–12 -> `  0`) from a V2000 Molfile copy
 * so Indigo can still compute MW or render 3D perspective structures where 3 bonds near a
 * stereoatom are wedged (`"stereocenters: all 3 bonds up near stereoatom"`).
 */
function stripMolfileBondStereo(molfile: string): string {
  const lines = molfile.split(/\r?\n/);
  const v2000Idx = lines.findIndex((l) => /V2000\s*$/i.test(l));
  if (v2000Idx < 0) return molfile;
  const countsLine = lines[v2000Idx];
  const nAtoms = parseInt(countsLine.slice(0, 3).trim(), 10);
  const nBonds = parseInt(countsLine.slice(3, 6).trim(), 10);
  if (!Number.isFinite(nAtoms) || !Number.isFinite(nBonds) || nBonds <= 0) {
    return molfile;
  }
  const bondStart = v2000Idx + 1 + nAtoms;
  const bondEnd = Math.min(lines.length, bondStart + nBonds);
  const out = [...lines];
  for (let i = bondStart; i < bondEnd; i++) {
    const line = out[i];
    if (line && line.length >= 12 && !line.startsWith("M  ")) {
      out[i] = `${line.slice(0, 9)}  0${line.slice(12)}`;
    }
  }
  return out.join("\n");
}

async function getStandaloneStructService(): Promise<StandaloneStructService> {
  if (typeof window === "undefined") {
    throw new Error("Ketcher structure service can only run in the browser.");
  }
  if (!sharedStructServicePromise) {
    sharedStructServicePromise = (async () => {
      const { StandaloneStructServiceProvider } = await import("ketcher-standalone");
      const provider = new StandaloneStructServiceProvider();
      const service = provider.createStructService(INDIGO_LENIENT_OPTIONS);
      // Prevent IndigoService.getStandardServerOptions from throwing
      // "Cannot getting options because there are no ketcherId" when no <Editor> is mounted,
      // and always include lenient stereochemistry/valence options for 3D perspective structures.
      const internal = service as unknown as {
        defaultOptions?: Record<string, unknown>;
        getStandardServerOptions?: (opts?: Record<string, unknown>) => Record<string, unknown>;
      };
      if (typeof internal.getStandardServerOptions === "function") {
        internal.getStandardServerOptions = (opts?: Record<string, unknown>) => ({
          ...INDIGO_LENIENT_OPTIONS,
          ...(internal.defaultOptions ?? {}),
          ...(opts ?? {}),
        });
      }
      return service;
    })().catch((err) => {
      sharedStructServicePromise = null;
      throw err;
    });
  }
  return sharedStructServicePromise;
}

/**
 * Render a chemical structure string (CDXML, Molfile, or SMILES) into a vector
 * `data:image/svg+xml;base64,...` data URL and compute its Molecular Weight (`MW`, g/mol)
 * using Indigo (`structService.generateImageAsBase64`, `structService.convert`, and `structService.calculate`).
 */
export async function renderStructureToVectorSvg(rawText: string): Promise<{
  svgDataUrl: string;
  cdxml: string;
  mw: number | null;
}> {
  const prepared = prepareForKetcher(rawText);
  const format = detectFormat(prepared);
  const service = await getStandaloneStructService();

  let structForRender = prepared;
  if (format === "smiles") {
    const laidOut = await service.layout(
      {
        struct: prepared.trim(),
        output_format: "chemical/x-mdl-molfile" as never,
      },
      INDIGO_LENIENT_OPTIONS,
    );
    if (laidOut?.struct) {
      structForRender = laidOut.struct;
    }
  }

  let b64: string;
  try {
    b64 = await service.generateImageAsBase64(structForRender, {
      outputFormat: "svg",
      backgroundColor: "255, 255, 255",
      ...INDIGO_LENIENT_OPTIONS,
    });
  } catch (err) {
    if (format === "mol") {
      const stripped = stripMolfileBondStereo(structForRender);
      b64 = await service.generateImageAsBase64(stripped, {
        outputFormat: "svg",
        backgroundColor: "255, 255, 255",
        ...INDIGO_LENIENT_OPTIONS,
      });
      structForRender = stripped;
    } else {
      throw err;
    }
  }
  const svgDataUrl = b64.startsWith("data:") ? b64 : `data:image/svg+xml;base64,${b64}`;

  let cdxml = prepared;
  if (format !== "cdxml") {
    try {
      const converted = await service.convert(
        {
          struct: structForRender,
          output_format: "chemical/x-cdxml" as never,
        },
        INDIGO_LENIENT_OPTIONS,
      );
      if (converted?.struct) {
        cdxml = converted.struct;
      }
    } catch (err) {
      console.warn("Indigo CDXML conversion failed, keeping raw structure:", err);
    }
  }

  const mw = await calculateMwWithIndigoFallback(structForRender);
  return { svgDataUrl, cdxml, mw };
}

async function calculateMwWithIndigoFallback(struct: string): Promise<number | null> {
  try {
    const service = await getStandaloneStructService();
    let res;
    try {
      res = await service.calculate(
        {
          struct,
          properties: ["molecular-weight"],
        },
        INDIGO_LENIENT_OPTIONS,
      );
    } catch (innerErr) {
      if (detectFormat(struct) === "mol") {
        const stripped = stripMolfileBondStereo(struct);
        res = await service.calculate(
          {
            struct: stripped,
            properties: ["molecular-weight"],
          },
          INDIGO_LENIENT_OPTIONS,
        );
      } else {
        throw innerErr;
      }
    }
    const rawMw = res?.["molecular-weight"];
    const val = typeof rawMw === "number" ? rawMw : parseFloat(String(rawMw ?? ""));
    return Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : null;
  } catch (err) {
    console.warn("Indigo MW calculation failed, skipping MW:", err);
    return null;
  }
}

/**
 * Dual-stream clipboard extractor for `Ctrl+V` pastes:
 * 1. Reads `read_clipboard_image_base64()` (Rust `arboard` + `CF_ENHMETAFILE` PNG reader)
 *    and `read_chemdraw_clipboard()` (Rust `CDXML` / `MDLCT` / `SMILES` reader).
 * 2. When `read_clipboard_image_base64()` returns a base64 PNG (or browser `event.clipboardData`
 *    provides a native image), passes it through `dataUrlToTrimmedPngDataUrl` (`trimCanvasWhiteBorder`)
 *    and uses it as `reactantImage` / `productImage` (preserving ChemDraw's pixel-perfect 3D perspective,
 *    red ring fills, bold wedges, and faded rear bonds).
 * 3. Uses the `CDXML` / `MDLCT` / `SMILES` string from `read_chemdraw_clipboard()` in a fail-safe
 *    background `try / catch` block to calculate `MW` via Indigo and save `CDXML` for ChemDraw editing.
 *    If Indigo throws a stereocenter or header validation error, logs a warning and still completes
 *    the image + CDXML paste with `mw: null`.
 */
export async function extractDualStreamClipboard(event?: ClipboardEvent): Promise<{
  imageDataUrl: string;
  cdxml: string;
  structureText: string;
  mw: number | null;
} | null> {
  const items = Array.from(event?.clipboardData?.items ?? []).filter((i) => i.kind === "file");
  const svgItem = items.find((i) => i.type === "image/svg+xml");
  const rasterItem =
    items.find((i) => i.type === "image/png") ??
    items.find((i) => i.type.startsWith("image/"));

  const syncText = cleanClipboardText(event?.clipboardData?.getData("text/plain") ?? "");

  // 1. Read the native clipboard image (`read_clipboard_image_base64`) and the chemical structure
  //    (`read_chemdraw_clipboard`) sequentially so Windows `OpenClipboard` never contends between threads.
  const rustPngDataUrl = await readClipboardImageBase64();
  const chemDrawText = await readChemDrawClipboard();

  let nativeImageUrl = "";
  if (rustPngDataUrl) {
    try {
      nativeImageUrl = await dataUrlToTrimmedPngDataUrl(rustPngDataUrl);
    } catch {
      nativeImageUrl = rustPngDataUrl;
    }
  } else if (svgItem) {
    const file = svgItem.getAsFile();
    if (file) {
      const prepared = await imageFileToPng(file);
      nativeImageUrl = await blobToDataUrl(prepared);
    }
  } else if (/^<(?:\?xml[^>]*>\s*)?<svg[\s>]/i.test(syncText.trim())) {
    const svgBlob = new Blob([syncText.trim()], { type: "image/svg+xml" });
    nativeImageUrl = await blobToDataUrl(svgBlob);
  } else if (rasterItem) {
    const file = rasterItem.getAsFile();
    if (file) {
      const prepared = await imageFileToPng(file);
      nativeImageUrl = await blobToDataUrl(prepared);
    }
  }

  // 2. Pick the chemical structure string (`CDXML` / `MDLCT` / `SMILES`)
  let chemText = chemDrawText ?? "";
  if (!chemText && isValidChemicalText(syncText)) {
    chemText = syncText;
  }
  if (!chemText) {
    const fallbackText = await readClipboardText();
    if (isValidChemicalText(fallbackText)) {
      chemText = fallbackText;
    }
  }

  // 3. When we have a native clipboard image, use it directly as the displayed structure
  //    and use `chemText` strictly in a fail-safe background block to calculate MW via Indigo.
  if (nativeImageUrl) {
    let mw: number | null = null;
    let cdxml = "";
    if (chemText) {
      const prepared = prepareForKetcher(chemText);
      const format = detectFormat(prepared);
      if (format === "cdxml") {
        cdxml = prepared;
      } else {
        cdxml = prepared;
        try {
          const service = await getStandaloneStructService();
          const converted = await service.convert(
            {
              struct: prepared,
              output_format: "chemical/x-cdxml" as never,
            },
            INDIGO_LENIENT_OPTIONS,
          );
          if (converted?.struct) {
            cdxml = converted.struct;
          }
        } catch (err) {
          console.warn("Indigo CDXML conversion failed during paste, keeping raw structure:", err);
        }
      }

      try {
        mw = await calculateMwWithIndigoFallback(prepared);
      } catch (err) {
        console.warn("Indigo MW calculation failed, skipping MW:", err);
        mw = null;
      }
    }
    return {
      imageDataUrl: nativeImageUrl,
      cdxml,
      structureText: chemText,
      mw,
    };
  }

  // 4. Text-only structure paste (e.g. copied SMILES or Molfile text without a clipboard bitmap)
  if (chemText) {
    try {
      const rendered = await renderStructureToVectorSvg(chemText);
      return {
        imageDataUrl: rendered.svgDataUrl,
        cdxml: rendered.cdxml,
        structureText: chemText,
        mw: rendered.mw,
      };
    } catch (err) {
      console.warn("Indigo structure rendering failed:", err);
      throw err;
    }
  }

  return null;
}

/** Auto-append `°C` if the user typed a plain number (e.g. `80`, `-78`, `0`, or `-78 to 0`). */
export function normaliseTemperatureInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return `${trimmed.replace(",", ".")} °C`;
  }
  if (/^[+-]?\d+(?:[.,]\d+)?\s*(?:to|–|-)\s*[+-]?\d+(?:[.,]\d+)?$/i.test(trimmed)) {
    return `${trimmed.replace(/,/g, ".")} °C`;
  }
  return trimmed;
}

/** Auto-append `h` if the user typed a plain number (e.g. `16` or `2.5`). */
export function normaliseDurationInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return `${trimmed.replace(",", ".")} h`;
  }
  return trimmed;
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement
  );
}

export default function MoleculeSection({
  experimentId,
  structuredScheme,
  onStructuredSchemeChange,
  reagents,
  onReagentsChange,
  product,
  onProductChange,
  secondaryProducts = [],
  onOpenLibrary,
  ref,
}: Props) {
  const {
    compounds: library,
    add: addLibraryCompound,
    update: updateLibraryCompound,
  } = useLibrary();
  const [selectedZone, setSelectedZone] = useState<StructureZone>("reactant");
  const [reactantNotice, setReactantNotice] = useState<string | null>(null);
  const [reactantError, setReactantError] = useState<string | null>(null);
  const [productNotice, setProductNotice] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);

  const schemeRef = useRef(structuredScheme);
  const onSchemeChangeRef = useRef(onStructuredSchemeChange);
  const onReagentsChangeRef = useRef(onReagentsChange);
  const onProductChangeRef = useRef(onProductChange);
  useEffect(() => {
    schemeRef.current = structuredScheme;
    onSchemeChangeRef.current = onStructuredSchemeChange;
    onReagentsChangeRef.current = onReagentsChange;
    onProductChangeRef.current = onProductChange;
  });

  const patchStructured = useCallback((patch: Partial<StructuredReactionScheme>) => {
    const next: StructuredReactionScheme = { ...(schemeRef.current ?? {}), ...patch };
    const cleaned: StructuredReactionScheme = {};
    if (next.reactantImage) cleaned.reactantImage = next.reactantImage;
    if (next.reactantCdxml?.trim()) cleaned.reactantCdxml = next.reactantCdxml;
    if (next.productImage) cleaned.productImage = next.productImage;
    if (next.productCdxml?.trim()) cleaned.productCdxml = next.productCdxml;
    if (next.solvent?.trim()) cleaned.solvent = next.solvent;
    if (next.temperature?.trim()) cleaned.temperature = next.temperature;
    if (next.duration?.trim()) cleaned.duration = next.duration;
    if (next.atmosphere?.trim()) cleaned.atmosphere = next.atmosphere;
    if (next.extraArrowNotes?.trim()) cleaned.extraArrowNotes = next.extraArrowNotes;
    const result = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    schemeRef.current = result;
    onSchemeChangeRef.current(result);
  }, []);

  /**
   * Apply a molecular weight (and optional name / density) calculated from a structure
   * or picked from the Personal Library into either the Limiting Reagent row (`reactant`)
   * or the Primary Product (`product`).
   */
  const syncZoneMetadata = useCallback(
    (
      zone: StructureZone,
      meta: { name?: string; mw?: number | null; density?: number | null },
    ) => {
      if (zone === "reactant") {
        onReagentsChangeRef.current((cur) => {
          let limIdx = cur.findIndex((r) => r.role === "Limiting");
          let next = cur;
          if (limIdx < 0) {
            const newLim = newRow("Limiting");
            next = [newLim, ...cur];
            limIdx = 0;
          }
          const targetId = next[limIdx].id;
          if (meta.name !== undefined && meta.name.trim() !== "") {
            next = next.map((r) =>
              r.id === targetId ? { ...r, name: meta.name!.trim() } : r,
            );
          }
          if (meta.mw !== undefined && meta.mw !== null && meta.mw > 0) {
            next = editField(next, targetId, "mw", meta.mw);
          }
          if (meta.density !== undefined) {
            next = editField(
              next,
              targetId,
              "density",
              meta.density !== null && meta.density > 0 ? meta.density : null,
            );
          }
          return next;
        });
      } else {
        const patch: Partial<ProductInfo> = {};
        if (meta.name !== undefined && meta.name.trim() !== "") {
          patch.name = meta.name.trim();
        }
        if (meta.mw !== undefined && meta.mw !== null && meta.mw > 0) {
          patch.mw = meta.mw;
        }
        if (Object.keys(patch).length > 0) {
          onProductChangeRef.current?.(patch);
        }
      }
    },
    [],
  );

  // ChemDraw round-trip hooks for Reactant (`reactant.cdxml`) and Product (`product.cdxml`)
  const getReactantCdxml = useCallback(async () => {
    const raw = (schemeRef.current?.reactantCdxml ?? "").trim();
    if (!raw) return "";
    if (/<CDXML[\s>]/i.test(raw)) return raw;
    try {
      const { cdxml: converted } = await renderStructureToVectorSvg(raw);
      return /<CDXML[\s>]/i.test(converted) ? converted : "";
    } catch {
      return "";
    }
  }, []);

  const loadReactantCdxml = useCallback(
    async (incomingCdxml: string) => {
      if (!hasCdxmlContent(incomingCdxml)) {
        patchStructured({ reactantImage: undefined, reactantCdxml: undefined });
        return;
      }
      const { svgDataUrl, cdxml: normalizedCdxml, mw } =
        await renderStructureToVectorSvg(incomingCdxml);
      patchStructured({ reactantImage: svgDataUrl, reactantCdxml: normalizedCdxml });
      if (mw !== null && mw > 0) {
        syncZoneMetadata("reactant", { mw });
      }
    },
    [patchStructured, syncZoneMetadata],
  );

  const getProductCdxml = useCallback(async () => {
    const raw = (schemeRef.current?.productCdxml ?? "").trim();
    if (!raw) return "";
    if (/<CDXML[\s>]/i.test(raw)) return raw;
    try {
      const { cdxml: converted } = await renderStructureToVectorSvg(raw);
      return /<CDXML[\s>]/i.test(converted) ? converted : "";
    } catch {
      return "";
    }
  }, []);

  const loadProductCdxml = useCallback(
    async (incomingCdxml: string) => {
      if (!hasCdxmlContent(incomingCdxml)) {
        patchStructured({ productImage: undefined, productCdxml: undefined });
        return;
      }
      const { svgDataUrl, cdxml: normalizedCdxml, mw } =
        await renderStructureToVectorSvg(incomingCdxml);
      patchStructured({ productImage: svgDataUrl, productCdxml: normalizedCdxml });
      if (mw !== null && mw > 0) {
        syncZoneMetadata("product", { mw });
      }
    },
    [patchStructured, syncZoneMetadata],
  );

  const reactantChemDraw = useChemDrawLink({
    experimentId,
    slot: "reactant",
    getCdxml: getReactantCdxml,
    loadCdxml: loadReactantCdxml,
    onNotice: (msg) => {
      setReactantError(null);
      setReactantNotice(msg);
      setTimeout(() => setReactantNotice(null), 4000);
    },
    onError: setReactantError,
  });

  const productChemDraw = useChemDrawLink({
    experimentId,
    slot: "product",
    getCdxml: getProductCdxml,
    loadCdxml: loadProductCdxml,
    onNotice: (msg) => {
      setProductError(null);
      setProductNotice(msg);
      setTimeout(() => setProductNotice(null), 4000);
    },
    onError: setProductError,
  });

  const stopZoneWatcher = useCallback(
    (zone: StructureZone) => {
      if (zone === "reactant") {
        reactantChemDraw.stopWatching();
      } else {
        productChemDraw.stopWatching();
      }
    },
    [reactantChemDraw, productChemDraw],
  );

  /**
   * Clear a structure zone (`reactant` or `product`):
   * - Stops any active ChemDraw watcher on that zone,
   * - Clears its image and CDXML,
   * - Clears the Limiting Reagent's `name`, `mw`, and `density` (for `reactant`)
   *   or the Primary Product's `mw` (for `product`).
   */
  const clearZone = useCallback(
    (zone: StructureZone) => {
      stopZoneWatcher(zone);
      if (zone === "reactant") {
        setReactantError(null);
        setReactantNotice(null);
        patchStructured({ reactantImage: undefined, reactantCdxml: undefined });
        onReagentsChangeRef.current((cur) => {
          const lim = cur.find((r) => r.role === "Limiting");
          if (!lim) return cur;
          let next = cur.map((r) => (r.id === lim.id ? { ...r, name: "" } : r));
          next = editField(next, lim.id, "mw", null);
          next = editField(next, lim.id, "density", null);
          return next;
        });
      } else {
        setProductError(null);
        setProductNotice(null);
        patchStructured({ productImage: undefined, productCdxml: undefined });
        onProductChangeRef.current?.({ mw: null });
      }
    },
    [patchStructured, stopZoneWatcher],
  );

  /**
   * Load a `LibraryCompound` into `targetZone`:
   * - Stops any active ChemDraw watcher on `targetZone`,
   * - Renders its structure (or uses its pre-rendered `imageDataUrl` + `cdxml`),
   * - Writes its `.cdxml` to `reactant.cdxml` or `product.cdxml` on disk when in Tauri,
   * - Populates `MW` (and `name`/`density` when picked for that zone).
   */
  const loadLibraryCompoundIntoZone = useCallback(
    async (
      compound: LibraryCompound,
      targetZone: StructureZone,
      applyName = false,
    ): Promise<string | null> => {
      try {
        stopZoneWatcher(targetZone);
        let svgDataUrl = compound.imageDataUrl ?? "";
        let cdxml = compound.cdxml ?? "";
        let computedMw: number | null = compound.mw ?? null;

        const rawStruct = (compound.cdxml || compound.structure || "").trim();
        if ((!svgDataUrl || !cdxml || computedMw === null) && rawStruct) {
          const rendered = await renderStructureToVectorSvg(rawStruct);
          if (!svgDataUrl) svgDataUrl = rendered.svgDataUrl;
          if (!cdxml) cdxml = rendered.cdxml;
          if (computedMw === null) computedMw = rendered.mw;
        }

        if (!svgDataUrl && computedMw === null) {
          return `"${compound.name}" does not have a saved structure.`;
        }

        if (targetZone === "reactant") {
          patchStructured({
            ...(svgDataUrl ? { reactantImage: svgDataUrl } : {}),
            ...(cdxml ? { reactantCdxml: cdxml } : {}),
          });
        } else {
          patchStructured({
            ...(svgDataUrl ? { productImage: svgDataUrl } : {}),
            ...(cdxml ? { productCdxml: cdxml } : {}),
          });
        }

        if (isTauri() && cdxml && /<CDXML[\s>]/i.test(cdxml)) {
          await saveSchemeCdxml(experimentId, cdxml, targetZone).catch(() => {});
        }

        syncZoneMetadata(targetZone, {
          ...(applyName ? { name: compound.name } : {}),
          mw: computedMw,
          ...(targetZone === "reactant" && compound.density !== undefined
            ? { density: compound.density }
            : {}),
        });

        return null;
      } catch (err) {
        return `Could not load structure: ${messageOf(err)}`;
      }
    },
    [experimentId, patchStructured, stopZoneWatcher, syncZoneMetadata],
  );

  useImperativeHandle(
    ref,
    () => ({
      async insertCompound(compound, preferredZone) {
        const targetZone: StructureZone = preferredZone ?? selectedZone;
        setSelectedZone(targetZone);
        return loadLibraryCompoundIntoZone(
          compound,
          targetZone,
          targetZone === "reactant",
        );
      },
    }),
    [selectedZone, loadLibraryCompoundIntoZone],
  );

  // Limiting reagent info for Left Zone caption
  const limitingRow = useMemo(
    () => reagents.find((r) => r.role === "Limiting") ?? null,
    [reagents],
  );

  // Additional (non-limiting, non-solvent) reagents for Above-Arrow list
  const arrowReagents = useMemo(
    () =>
      reagents.filter(
        (r) => r.role !== "Limiting" && r.role !== "Solvent" && r.name.trim() !== "",
      ),
    [reagents],
  );

  // Primary product resolved name & MW for Right Zone caption
  const primaryProductName = useMemo(() => {
    const idPrefix = experimentId.trim();
    const fallback =
      secondaryProducts.length > 0
        ? idPrefix
          ? `${idPrefix}-F1`
          : "F1"
        : idPrefix || "Product";
    const rawName = product.name.trim();
    if (
      rawName === "" ||
      (secondaryProducts.length > 0 &&
        idPrefix !== "" &&
        rawName.toUpperCase() === idPrefix.toUpperCase())
    ) {
      return fallback;
    }
    return rawName;
  }, [experimentId, product.name, secondaryProducts.length]);

  const hasStructuredVisualContent = Boolean(
    structuredScheme?.reactantImage ||
      structuredScheme?.productImage ||
      structuredScheme?.solvent?.trim() ||
      structuredScheme?.temperature?.trim() ||
      structuredScheme?.duration?.trim() ||
      structuredScheme?.atmosphere?.trim() ||
      structuredScheme?.extraArrowNotes?.trim() ||
      arrowReagents.length > 0,
  );

  const activeChemDraw = selectedZone === "reactant" ? reactantChemDraw : productChemDraw;

  function handleOpenSelectedInChemDraw() {
    if (selectedZone === "reactant") {
      productChemDraw.stopWatching();
      void reactantChemDraw.open();
    } else {
      reactantChemDraw.stopWatching();
      void productChemDraw.open();
    }
  }

  return (
    <section
      className={`print:w-full print:break-inside-avoid ${
        hasStructuredVisualContent ? "" : "print:hidden"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:mb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Reaction scheme
        </h2>

        {/* Central Hybrid Selection & ChemDraw Toolbar (screen only, hidden in print) */}
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <div
            role="group"
            aria-label="Selected structure zone"
            className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-100/80 p-0.5 text-[11px]"
          >
            <button
              type="button"
              onClick={() => setSelectedZone("reactant")}
              aria-pressed={selectedZone === "reactant"}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                selectedZone === "reactant"
                  ? "bg-white text-fume-800 shadow-2xs"
                  : "text-zinc-500 hover:text-zinc-800"
              }`}
              title="Select Reactant (Left) box as target for Ctrl+V, Library, and ChemDraw"
            >
              Reactant
            </button>
            <button
              type="button"
              onClick={() => setSelectedZone("product")}
              aria-pressed={selectedZone === "product"}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                selectedZone === "product"
                  ? "bg-white text-fume-800 shadow-2xs"
                  : "text-zinc-500 hover:text-zinc-800"
              }`}
              title="Select Product (Right) box as target for Ctrl+V, Library, and ChemDraw"
            >
              Product
            </button>
          </div>

          {activeChemDraw.supported && (
            <button
              type="button"
              onClick={handleOpenSelectedInChemDraw}
              disabled={activeChemDraw.busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-fume-300 bg-fume-50 px-2.5 py-1 text-xs font-semibold text-fume-800 shadow-2xs transition-colors hover:bg-fume-100 disabled:opacity-60"
              title={`Open the selected ${selectedZone === "reactant" ? "Reactant" : "Product"} structure in ChemDraw`}
            >
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
                <path d="M8 2l5 3v6l-5 3-5-3V5l5-3z" />
              </svg>
              {activeChemDraw.busy === "open"
                ? "Opening ChemDraw…"
                : activeChemDraw.busy === "reload"
                  ? "Syncing ChemDraw…"
                  : `Open ${selectedZone === "reactant" ? "Reactant" : "Product"} in ChemDraw`}
            </button>
          )}
        </div>
      </div>

      {/* 3-Zone Structured Reaction Scheme: [Reactant Zone] -> [Arrow + Conditions] -> [Product Zone] */}
      <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_minmax(220px,1.1fr)_1fr] print:grid-cols-[1fr_minmax(175px,1.05fr)_1fr] print:gap-2">
        {/* LEFT ZONE: Limiting Reagent / Starting Material */}
        <StructureZoneCard
          experimentId={experimentId}
          zone="reactant"
          title="Limiting Reagent / SM"
          active={selectedZone === "reactant"}
          onActivate={() => setSelectedZone("reactant")}
          imageDataUrl={structuredScheme?.reactantImage}
          cdxml={structuredScheme?.reactantCdxml}
          chemDrawWatching={reactantChemDraw.watching}
          chemDrawJustUpdated={reactantChemDraw.justUpdated}
          chemDrawBusy={reactantChemDraw.busy}
          onStopWatching={reactantChemDraw.stopWatching}
          notice={reactantNotice}
          externalError={reactantError}
          onClearError={() => setReactantError(null)}
          onUpdate={(img, cdxml, mw) => {
            reactantChemDraw.stopWatching();
            patchStructured({
              reactantImage: img,
              ...(cdxml !== undefined ? { reactantCdxml: cdxml } : {}),
            });
            if (mw !== undefined && mw !== null && mw > 0) {
              syncZoneMetadata("reactant", { mw });
            }
          }}
          onClear={() => clearZone("reactant")}
          captionName={limitingRow?.name.trim() || "Limiting reagent"}
          captionNamePlaceholder={!limitingRow?.name.trim()}
          captionMw={limitingRow?.mw ?? null}
          captionDensity={limitingRow?.density ?? null}
          defaultLibraryName={limitingRow?.name.trim() || `${experimentId || "Compound"}-SM`}
          library={library ?? []}
          onPickFromLibrary={(compound) =>
            loadLibraryCompoundIntoZone(compound, "reactant", true)
          }
          onAddToLibrary={addLibraryCompound}
          onUpdateInLibrary={updateLibraryCompound}
          onManageLibrary={onOpenLibrary}
        />

        {/* CENTER ZONE: Above-Arrow Reagents, Vector Arrow, Below-Arrow Conditions */}
        <CenterConditionsZone
          reagents={reagents}
          arrowReagents={arrowReagents}
          onReagentsChange={onReagentsChange}
          library={library ?? []}
          structuredScheme={structuredScheme}
          onPatchScheme={patchStructured}
        />

        {/* RIGHT ZONE: Primary Product */}
        <StructureZoneCard
          experimentId={experimentId}
          zone="product"
          title="Product"
          active={selectedZone === "product"}
          onActivate={() => setSelectedZone("product")}
          imageDataUrl={structuredScheme?.productImage}
          cdxml={structuredScheme?.productCdxml}
          chemDrawWatching={productChemDraw.watching}
          chemDrawJustUpdated={productChemDraw.justUpdated}
          chemDrawBusy={productChemDraw.busy}
          onStopWatching={productChemDraw.stopWatching}
          notice={productNotice}
          externalError={productError}
          onClearError={() => setProductError(null)}
          onUpdate={(img, cdxml, mw) => {
            productChemDraw.stopWatching();
            patchStructured({
              productImage: img,
              ...(cdxml !== undefined ? { productCdxml: cdxml } : {}),
            });
            if (mw !== undefined && mw !== null && mw > 0) {
              syncZoneMetadata("product", { mw });
            }
          }}
          onClear={() => clearZone("product")}
          captionName={primaryProductName}
          captionNamePlaceholder={false}
          captionMw={product.mw}
          captionDensity={null}
          defaultLibraryName={primaryProductName}
          library={library ?? []}
          onPickFromLibrary={(compound) =>
            loadLibraryCompoundIntoZone(compound, "product", true)
          }
          onAddToLibrary={addLibraryCompound}
          onUpdateInLibrary={updateLibraryCompound}
          onManageLibrary={onOpenLibrary}
        />
      </div>
    </section>
  );
}

// --- Left & Right Structure Zone Card -----------------------------------------

interface StructureZoneCardProps {
  experimentId: string;
  zone: StructureZone;
  title: string;
  active: boolean;
  onActivate: () => void;
  imageDataUrl?: string;
  cdxml?: string;
  chemDrawWatching: boolean;
  chemDrawJustUpdated: boolean;
  chemDrawBusy: "open" | "reload" | null;
  onStopWatching: () => void;
  notice: string | null;
  externalError: string | null;
  onClearError: () => void;
  onUpdate: (
    imageDataUrl: string | undefined,
    cdxml?: string,
    mw?: number | null,
  ) => void;
  onClear: () => void;
  captionName: string;
  captionNamePlaceholder?: boolean;
  captionMw: number | null;
  captionDensity: number | null;
  defaultLibraryName: string;
  library: readonly LibraryCompound[];
  onPickFromLibrary: (compound: LibraryCompound) => Promise<string | null>;
  onAddToLibrary: (
    input: CompoundInput,
  ) => { ok: true; compound: LibraryCompound } | { ok: false; error: string };
  onUpdateInLibrary: (
    id: string,
    input: CompoundInput & { clearStructure?: boolean },
  ) => { ok: true; compound: LibraryCompound } | { ok: false; error: string };
  onManageLibrary: () => void;
}

function StructureZoneCard({
  experimentId,
  zone,
  title,
  active,
  onActivate,
  imageDataUrl,
  cdxml,
  chemDrawWatching,
  chemDrawJustUpdated,
  chemDrawBusy,
  onStopWatching,
  notice,
  externalError,
  onClearError,
  onUpdate,
  onClear,
  captionName,
  captionNamePlaceholder = false,
  captionMw,
  captionDensity,
  defaultLibraryName,
  library,
  onPickFromLibrary,
  onAddToLibrary,
  onUpdateInLibrary,
  onManageLibrary,
}: StructureZoneCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const savePromptRef = useRef<HTMLDivElement>(null);

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  // Inline "+ Save to Library" prompt state (prevents accidental overwrites)
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveMwText, setSaveMwText] = useState("");
  const [saveDensityText, setSaveDensityText] = useState("");

  const error = localError ?? externalError;
  const setError = useCallback(
    (msg: string | null) => {
      setLocalError(msg);
      if (msg === null) onClearError();
    },
    [onClearError],
  );

  const onUpdateRef = useRef(onUpdate);
  const onStopWatchingRef = useRef(onStopWatching);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
    onStopWatchingRef.current = onStopWatching;
  });

  // Close library picker on outside click / Escape
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // Close save prompt on Escape
  useEffect(() => {
    if (!savePromptOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSavePromptOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [savePromptOpen]);

  /** Clicking the box selects this zone as the active target (does NOT auto-launch ChemDraw). */
  function handleBoxClick() {
    onActivate();
    setError(null);
  }

  /** Process dropped or selected files (.svg, .png, .jpg, .cdxml, .mol). */
  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    onStopWatchingRef.current();
    const structFile = files.find((f) => /\.(cdxml|mol|rxn|sdf)$/i.test(f.name));
    if (structFile) {
      setBusy(true);
      setError(null);
      try {
        const text = await structFile.text();
        const { svgDataUrl, cdxml: nextCdxml, mw } = await renderStructureToVectorSvg(text);
        onUpdateRef.current(svgDataUrl, nextCdxml, mw);
        if (isTauri() && nextCdxml && /<CDXML[\s>]/i.test(nextCdxml)) {
          await saveSchemeCdxml(experimentId, nextCdxml, zone).catch(() => {});
        }
      } catch (err) {
        setError(`Could not read structure file: ${messageOf(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    const imageFile =
      files.find((f) => f.type.startsWith("image/") || /\.svg$/i.test(f.name)) ?? null;
    if (!imageFile) {
      setError("Drop an image (.svg, .png, .jpg) or structure file (.cdxml, .mol).");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const preparedBlob = await imageFileToPng(imageFile);
      const dataUrl = await blobToDataUrl(preparedBlob);
      onUpdateRef.current(dataUrl, undefined);
    } catch (err) {
      setError(`Could not load image: ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Handle Ctrl+V paste into this selected zone using the Dual-Stream Paste Handler:
   * - When BOTH a clipboard image (`image/png`, `image/svg+xml`, or ChemDraw's `CF_ENHMETAFILE` / `CF_DIB`)
   *   AND `CDXML` / `Molfile` / `SMILES` are present, uses the native clipboard image (trimmed at full
   *   lossless resolution) as `reactantImage` / `productImage` while saving `CDXML` to disk and
   *   auto-calculating `MW` in the background!
   * - When only `CDXML` / `Molfile` / `SMILES` is present, renders directly via `renderStructureToVectorSvg`.
   * - When only an image is present, uses the trimmed lossless image.
   */
  const handlePasteContent = useCallback(
    async (event?: ClipboardEvent) => {
      onStopWatchingRef.current();
      setBusy(true);
      setError(null);
      try {
        const extracted = await extractDualStreamClipboard(event);
        if (extracted) {
          onUpdateRef.current(
            extracted.imageDataUrl,
            extracted.cdxml || undefined,
            extracted.mw,
          );
          if (isTauri() && extracted.cdxml && /<CDXML[\s>]/i.test(extracted.cdxml)) {
            await saveSchemeCdxml(experimentId, extracted.cdxml, zone).catch(() => {});
          }
          return;
        }

        setError(
          "Clipboard does not contain a structure or image. Copy a structure in ChemDraw (Ctrl+C) and press Ctrl+V.",
        );
      } catch (err) {
        setError(`Could not paste into ${title}: ${messageOf(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [experimentId, setError, title, zone],
  );

  const handleFilesRef = useRef(handleFiles);
  const handlePasteRef = useRef(handlePasteContent);
  const activeRef = useRef(active);
  useEffect(() => {
    handleFilesRef.current = handleFiles;
    handlePasteRef.current = handlePasteContent;
    activeRef.current = active;
  });

  // Document-level paste listener when this zone is the selected zone
  useEffect(() => {
    let keyPasteTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelKeyPaste = () => {
      if (keyPasteTimer) clearTimeout(keyPasteTimer);
      keyPasteTimer = null;
    };

    const onPaste = (event: ClipboardEvent) => {
      if (!activeRef.current || event.defaultPrevented) return;
      if (isTextField(event.target) || document.querySelector("dialog[open]")) return;
      cancelKeyPaste();
      event.preventDefault();
      event.stopPropagation();
      void handlePasteRef.current(event);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current || event.defaultPrevented) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "v") {
        return;
      }
      if (isTextField(event.target) || document.querySelector("dialog[open]")) return;
      cancelKeyPaste();
      keyPasteTimer = setTimeout(() => {
        keyPasteTimer = null;
        void handlePasteRef.current(undefined);
      }, KEY_PASTE_FALLBACK_MS);
    };

    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelKeyPaste();
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      onActivate();
      void handleFilesRef.current(Array.from(e.dataTransfer.files));
    },
  };

  const hasClearableData = Boolean(
    imageDataUrl ||
      cdxml?.trim() ||
      (!captionNamePlaceholder && captionName.trim() !== "") ||
      (captionMw !== null && captionMw > 0),
  );

  const canSaveToLibrary = Boolean(
    imageDataUrl ||
      cdxml?.trim() ||
      (!captionNamePlaceholder && captionName.trim() !== "" && captionMw !== null && captionMw > 0),
  );

  const existingLibraryMatch = useMemo(() => {
    const trimmed = saveName.trim().toLowerCase();
    if (!trimmed) return null;
    return library.find((c) => c.name.trim().toLowerCase() === trimmed) ?? null;
  }, [library, saveName]);

  const distinctNewName = useMemo(
    () => suggestDistinctLibraryName(saveName.trim() || defaultLibraryName, library),
    [defaultLibraryName, library, saveName],
  );

  function openSaveToLibraryPrompt() {
    setError(null);
    setSaveName(defaultLibraryName);
    setSaveMwText(captionMw !== null && captionMw > 0 ? String(captionMw) : "");
    setSaveDensityText(
      captionDensity !== null && captionDensity > 0 ? String(captionDensity) : "",
    );
    setSavePromptOpen(true);
    setPickerOpen(false);
  }

  function buildCompoundInput(targetName: string): {
    ok: true;
    input: CompoundInput;
  } | {
    ok: false;
    error: string;
  } {
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
    return {
      ok: true,
      input: {
        name: targetName.trim(),
        mw: parsedMw,
        density: parsedDensity,
        cdxml: cdxml?.trim() || undefined,
        structure: cdxml?.trim() || undefined,
        imageDataUrl,
      },
    };
  }

  function handleSaveAsNewCompound(targetName: string) {
    setError(null);
    const built = buildCompoundInput(targetName);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const result = onAddToLibrary(built.input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavePromptOpen(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3000);
  }

  function handleUpdateExistingCompound(existingId: string) {
    setError(null);
    const built = buildCompoundInput(saveName);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const result = onUpdateInLibrary(existingId, built.input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavePromptOpen(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3000);
  }

  const filteredLibrary = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return library;
    return library.filter(
      (c) => c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q),
    );
  }, [library, pickerQuery]);

  return (
    <div
      ref={boxRef}
      onClick={onActivate}
      className="flex flex-col items-center print:w-full"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.svg,.cdxml,.mol,.rxn,.sdf"
        hidden
        onChange={(e) => {
          void handleFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {/* Zone top label + selection state + Clear × button (screen only) */}
      <div className="mb-1 flex w-full items-center justify-between gap-1 px-0.5 print:hidden">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          <span
            className={`inline-block size-2 rounded-full transition-colors ${
              active ? "bg-fume-500" : "bg-zinc-300"
            }`}
            aria-hidden
          />
          <span className={active ? "text-fume-800" : ""}>{title}</span>
          {active && (
            <span className="rounded bg-fume-50 px-1.5 py-0.2 text-[9px] font-semibold normal-case tracking-normal text-fume-700">
              Selected
            </span>
          )}
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
              fileInputRef.current?.click();
            }}
            className="rounded px-1.5 py-0.2 text-[10px] font-medium text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            title={`Upload .cdxml, .mol, .svg, or .png into ${title}`}
          >
            Upload
          </button>
          {hasClearableData && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="rounded px-1.5 py-0.2 text-[10px] font-medium text-zinc-400 hover:bg-red-50 hover:text-red-600"
              title={`Clear ${title} structure, name, and MW`}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Selectable Structure Box (click selects zone for Ctrl+V, Library, and Open in ChemDraw) */}
      {imageDataUrl ? (
        <div
          role="button"
          tabIndex={0}
          onFocus={onActivate}
          onClick={handleBoxClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleBoxClick();
            }
          }}
          title={
            active
              ? `${title} selected — press Ctrl+V to paste or click "Open in ChemDraw"`
              : `Click to select ${title}`
          }
          {...dropProps}
          className={`group/zone relative flex min-h-36 w-full cursor-pointer items-center justify-center rounded-md border bg-white p-2.5 transition-all focus:outline-none print:min-h-0 print:cursor-default print:border-0 print:bg-transparent print:p-0 ${
            dragging
              ? "border-fume-500 bg-fume-50"
              : active
                ? "border-fume-500 ring-2 ring-fume-500/20"
                : "border-zinc-200 hover:border-fume-300"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- embedded SVG or high-DPI PNG data URL */}
          <img
            src={imageDataUrl}
            alt={title}
            className="mx-auto block max-h-40 w-auto max-w-full object-contain print:mx-auto print:max-h-36"
          />

          {/* ChemDraw status pill (strictly hidden in print; auto-stops after Ctrl+S update; dismissible with ×) */}
          <div className="print:hidden">
            {(chemDrawWatching || chemDrawJustUpdated || chemDrawBusy !== null) && (
              <span className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50/95 px-2.5 py-0.5 text-[10px] font-medium text-emerald-800 shadow-xs">
                <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
                <span>
                  {chemDrawBusy === "open"
                    ? "Opening ChemDraw…"
                    : chemDrawBusy === "reload"
                      ? "Syncing from ChemDraw…"
                      : chemDrawJustUpdated
                        ? "Updated from ChemDraw ✓"
                        : "Watching ChemDraw (Ctrl+S to sync)"}
                </span>
                {chemDrawWatching && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStopWatching();
                    }}
                    title="Stop watching ChemDraw"
                    aria-label="Stop watching ChemDraw"
                    className="ml-0.5 inline-grid size-3.5 place-items-center rounded-full text-emerald-700 hover:bg-emerald-200/70 hover:text-emerald-950"
                  >
                    ×
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onFocus={onActivate}
          onClick={handleBoxClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleBoxClick();
            }
          }}
          title={
            active
              ? `${title} selected — press Ctrl+V to paste, pick from Library, or click "Open in ChemDraw"`
              : `Click to select ${title}`
          }
          {...dropProps}
          className={`group/zone relative flex min-h-36 w-full cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-4 text-center text-xs transition-all focus:outline-none print:hidden ${
            dragging
              ? "border-fume-500 bg-fume-50 text-fume-700"
              : active
                ? "border-fume-500 bg-fume-50/20 text-zinc-700 ring-2 ring-fume-500/20"
                : "border-zinc-300 bg-zinc-50/30 text-zinc-500 hover:border-fume-300 hover:bg-fume-50/15"
          }`}
        >
          <span className="font-medium text-zinc-700">
            {busy
              ? "Processing structure…"
              : active
                ? `${title} Selected`
                : `Click to select ${title}`}
          </span>
          <span className="mt-1 text-[10px] text-zinc-500">
            {active
              ? "Press Ctrl+V to paste from ChemDraw, load from Library, or click “Open in ChemDraw” above"
              : "Select this box to paste (Ctrl+V), load from Library, or open in ChemDraw"}
          </span>

          {(chemDrawWatching || chemDrawJustUpdated || chemDrawBusy !== null) && (
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50/95 px-2.5 py-0.5 text-[10px] font-medium text-emerald-800 shadow-2xs print:hidden">
              <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
              <span>
                {chemDrawBusy === "open"
                  ? "Opening ChemDraw…"
                  : chemDrawBusy === "reload"
                    ? "Syncing from ChemDraw…"
                    : chemDrawJustUpdated
                      ? "Updated from ChemDraw ✓"
                      : "Watching ChemDraw (Ctrl+S to sync)"}
              </span>
              {chemDrawWatching && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStopWatching();
                  }}
                  title="Stop watching ChemDraw"
                  aria-label="Stop watching ChemDraw"
                  className="ml-0.5 inline-grid size-3.5 place-items-center rounded-full text-emerald-700 hover:bg-emerald-200/70 hover:text-emerald-950"
                >
                  ×
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* Subtle bottom caption synced with Limiting Reagent or Product */}
      <div
        className={`mt-1 flex flex-wrap items-center justify-center gap-x-1.5 text-center text-[11px] leading-tight print:mt-0.5 print:text-[10px] ${
          !imageDataUrl && captionNamePlaceholder ? "print:hidden" : ""
        }`}
      >
        <span
          className={
            captionNamePlaceholder
              ? "italic text-zinc-400 print:hidden"
              : "font-semibold text-zinc-800"
          }
        >
          {captionName}
        </span>
        {captionMw !== null && captionMw > 0 && (
          <span className="text-zinc-500">
            · MW {formatNumber(captionMw)} g/mol
          </span>
        )}
      </div>

      {/* Compact Library Actions underneath the zone: Load from Library + "+ Save to Library" */}
      <div
        ref={pickerRef}
        className="relative mt-1 flex flex-wrap items-center justify-center gap-1.5 print:hidden"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
            setPickerQuery("");
            setPickerOpen((o) => !o);
            setSavePromptOpen(false);
          }}
          className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600 transition-colors hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
          title="Load a saved compound from your Personal Library into this box"
        >
          Load from Library
        </button>

        {canSaveToLibrary && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
              if (savePromptOpen) {
                setSavePromptOpen(false);
              } else {
                openSaveToLibraryPrompt();
              }
            }}
            className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
              savedFlash
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : savePromptOpen
                  ? "border-fume-400 bg-fume-50 text-fume-800"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-fume-300 hover:bg-fume-50 hover:text-fume-800"
            }`}
            title="Save this compound (with structure and MW) to your Personal Compound Library"
          >
            {savedFlash ? "Saved to Library ✓" : "+ Save to Library"}
          </button>
        )}

        {pickerOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-1/2 top-full z-30 mt-1 w-64 -translate-x-1/2 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl"
          >
            <input
              type="search"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Search library…"
              aria-label="Search library compounds"
              autoFocus
              className="mb-1.5 w-full rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs placeholder:text-zinc-400 focus:border-fume-500 focus:bg-white focus:outline-none"
            />
            <ul className="max-h-48 divide-y divide-zinc-100 overflow-y-auto">
              {filteredLibrary.length === 0 ? (
                <li className="px-2 py-2.5 text-center text-xs text-zinc-400">
                  {library.length === 0 ? "Your library is empty." : "No matching compounds."}
                </li>
              ) : (
                filteredLibrary.map((comp) => (
                  <li key={comp.id}>
                    <button
                      type="button"
                      onClick={async () => {
                        setPickerOpen(false);
                        setBusy(true);
                        setError(null);
                        try {
                          const problem = await onPickFromLibrary(comp);
                          if (problem) setError(problem);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-fume-50"
                    >
                      {comp.imageDataUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element -- embedded library structure thumbnail */
                        <img
                          src={comp.imageDataUrl}
                          alt=""
                          className="size-8 shrink-0 rounded border border-zinc-100 bg-white object-contain p-0.5"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-zinc-900">
                          {comp.name}
                        </span>
                        {describeProperties(comp) && (
                          <span className="block truncate text-[10px] text-zinc-500">
                            {describeProperties(comp)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="mt-1.5 border-t border-zinc-100 pt-1 text-right">
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(false);
                  onManageLibrary();
                }}
                className="text-[10px] font-medium text-fume-700 hover:underline"
              >
                Manage Library…
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Inline "+ Save to Library" prompt with duplicate-name protection */}
      {savePromptOpen && (
        <div
          ref={savePromptRef}
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 w-full rounded-md border border-fume-200 bg-zinc-50/90 p-2 text-left text-xs shadow-xs print:hidden"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Save Compound to Library
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

          <div className="space-y-1.5">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (existingLibraryMatch) {
                    handleSaveAsNewCompound(distinctNewName);
                  } else {
                    handleSaveAsNewCompound(saveName);
                  }
                }
              }}
              placeholder="Compound name"
              aria-label="Compound name for library"
              autoFocus
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
            />

            <div className="grid grid-cols-2 gap-1.5">
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
                placeholder="d (g/mL, opt.)"
                aria-label="Density (g/mL)"
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </div>

            {existingLibraryMatch ? (
              <div className="space-y-1.5 rounded border border-amber-200 bg-amber-50 p-1.5 text-[11px] text-amber-900">
                <p className="leading-snug">
                  Compound <strong>&ldquo;{existingLibraryMatch.name}&rdquo;</strong> already exists
                  in your library — Save as new name or explicitly Update existing:
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleSaveAsNewCompound(distinctNewName)}
                    className="rounded bg-fume-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-fume-700"
                  >
                    Save as &ldquo;{distinctNewName}&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUpdateExistingCompound(existingLibraryMatch.id)}
                    className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  >
                    Update existing
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => setSavePromptOpen(false)}
                  className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveAsNewCompound(saveName)}
                  className="rounded bg-fume-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-fume-700"
                >
                  Save to Library
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {notice && (
        <p className="mt-1 text-center text-[10px] text-fume-700 print:hidden">{notice}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-center text-[10px] text-red-600 print:hidden">
          {error}
        </p>
      )}
    </div>
  );
}

// --- Center Zone: Above-Arrow Reagents, Vector Arrow, Below-Arrow Conditions ---

interface CenterConditionsZoneProps {
  reagents: ReagentRow[];
  arrowReagents: ReagentRow[];
  onReagentsChange: (fn: (rows: ReagentRow[]) => ReagentRow[]) => void;
  library: readonly LibraryCompound[];
  structuredScheme?: StructuredReactionScheme;
  onPatchScheme: (patch: Partial<StructuredReactionScheme>) => void;
}

function CenterConditionsZone({
  arrowReagents,
  onReagentsChange,
  library,
  structuredScheme,
  onPatchScheme,
}: CenterConditionsZoneProps) {
  const solventListId = useId();
  const eqInputRef = useRef<HTMLInputElement>(null);

  // Quick "+ Add Reagent" inline state
  const [addingReagent, setAddingReagent] = useState(false);
  const [newReagentName, setNewReagentName] = useState("");
  const [newReagentEq, setNewReagentEq] = useState("1.0");
  const [pendingMw, setPendingMw] = useState<number | null>(null);
  const [pendingDensity, setPendingDensity] = useState<number | null>(null);
  const lastAddedRowIdRef = useRef<string | null>(null);

  function commitTemp() {
    const raw = structuredScheme?.temperature ?? "";
    const formatted = normaliseTemperatureInput(raw);
    if (formatted !== raw) {
      onPatchScheme({ temperature: formatted || undefined });
    }
  }

  function commitDuration() {
    const raw = structuredScheme?.duration ?? "";
    const formatted = normaliseDurationInput(raw);
    if (formatted !== raw) {
      onPatchScheme({ duration: formatted || undefined });
    }
  }

  /**
   * Append a new reagent row to `experiment.reagents` (or populate an existing untouched blank
   * "Reagent" row) with its `name`, `mw`, `density`, and `eq` pre-filled and stoichiometry calculated.
   */
  function commitQuickReagent(override?: {
    name?: string;
    mw?: number | null;
    density?: number | null;
  }) {
    const finalName = (override?.name ?? newReagentName).trim();
    if (!finalName) return;

    let resolvedMw = override?.mw !== undefined ? override.mw : pendingMw;
    let resolvedDensity =
      override?.density !== undefined ? override.density : pendingDensity;

    // If user typed a known abbreviation/name (e.g. "NaH", "Et3N") without clicking the dropdown, check dictionary/library
    if (resolvedMw === null) {
      const dictHit = searchDictionary(finalName, 1)[0];
      if (
        dictHit &&
        (dictHit.commonName.toLowerCase() === finalName.toLowerCase() ||
          dictHit.aliases.some((a) => a.toLowerCase() === finalName.toLowerCase()))
      ) {
        resolvedMw = dictHit.mw;
        resolvedDensity = dictHit.density ?? null;
      } else {
        const libHit = searchLibrary(library, finalName, 1)[0];
        if (libHit && libHit.name.toLowerCase() === finalName.toLowerCase()) {
          resolvedMw = libHit.mw ?? null;
          resolvedDensity = libHit.density ?? null;
        }
      }
    }

    const eqVal = looseNumber(newReagentEq);

    onReagentsChange((cur) => {
      // Find if there is an untouched blank "Reagent" placeholder row we can fill, otherwise append
      const blankIdx = cur.findIndex(
        (r) =>
          r.role === "Reagent" &&
          r.name.trim() === "" &&
          r.mw === null &&
          r.eq === null &&
          r.n === null &&
          r.mass === null &&
          r.vol === null &&
          r.density === null,
      );

      const targetRow =
        blankIdx >= 0
          ? { ...cur[blankIdx], name: finalName }
          : { ...newRow("Reagent"), name: finalName };
      lastAddedRowIdRef.current = targetRow.id;

      let next =
        blankIdx >= 0
          ? cur.map((r, i) => (i === blankIdx ? targetRow : r))
          : [...cur, targetRow];

      if (resolvedMw !== null && resolvedMw > 0) {
        next = editField(next, targetRow.id, "mw", resolvedMw);
      }
      if (resolvedDensity !== null && resolvedDensity > 0) {
        next = editField(next, targetRow.id, "density", resolvedDensity);
      }
      if (eqVal !== null && eqVal > 0) {
        next = editField(next, targetRow.id, "eq", eqVal);
      }
      return next;
    });

    setNewReagentName("");
    setNewReagentEq("1.0");
    setPendingMw(null);
    setPendingDensity(null);
    setAddingReagent(false);
  }

  function handlePickLocal(entry: ChemicalEntry) {
    setNewReagentName(entry.commonName);
    setPendingMw(entry.mw);
    setPendingDensity(entry.density ?? null);
    setTimeout(() => {
      eqInputRef.current?.focus();
      eqInputRef.current?.select();
    }, 0);
  }

  function handlePickLibrary(compound: LibraryCompound) {
    setNewReagentName(compound.name);
    setPendingMw(compound.mw ?? null);
    setPendingDensity(compound.density ?? null);
    setTimeout(() => {
      eqInputRef.current?.focus();
      eqInputRef.current?.select();
    }, 0);
  }

  function handlePubChemMw(mw: number) {
    setPendingMw(mw);
    const lastId = lastAddedRowIdRef.current;
    if (lastId) {
      onReagentsChange((cur) => editField(cur, lastId, "mw", mw));
    }
  }

  const printedBelowParts = [
    structuredScheme?.solvent?.trim(),
    structuredScheme?.temperature?.trim(),
    structuredScheme?.duration?.trim(),
    structuredScheme?.atmosphere?.trim(),
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="flex w-full flex-col items-center justify-center px-1 py-1">
      {/* ABOVE THE ARROW: Additional Reagents / Catalysts */}
      <div className="flex min-h-8 w-full flex-col items-center justify-end gap-1 pb-1">
        {arrowReagents.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-xs leading-snug text-zinc-800 print:text-[10.5px]">
            {arrowReagents.map((r, idx) => {
              const eqLabel =
                r.eq !== null && r.eq > 0 ? ` (${formatNumber(r.eq)} eq)` : "";
              const catLabel = r.role === "Catalyst" ? ", cat." : "";
              return (
                <span
                  key={r.id}
                  className="group/pill inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-medium text-zinc-800 hover:bg-zinc-100 print:p-0"
                >
                  <span>
                    {arrowReagents.length > 1 ? `${idx + 1}. ` : ""}
                    {r.name}
                    <span className="font-normal text-zinc-600">
                      {eqLabel}
                      {catLabel}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onReagentsChange((cur) => cur.filter((item) => item.id !== r.id))
                    }
                    title={`Remove ${r.name}`}
                    className="ml-0.5 hidden size-3.5 place-items-center rounded text-[10px] text-zinc-400 hover:bg-red-50 hover:text-red-600 group-hover/pill:inline-grid print:hidden"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Quick inline "+ Add Reagent" above the arrow (screen only) */}
        <div className="w-full print:hidden">
          {addingReagent ? (
            <div className="mx-auto flex max-w-xs items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50/80 p-1 shadow-xs">
              <div className="min-w-0 flex-1">
                <ReagentNameInput
                  value={newReagentName}
                  className="w-full rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
                  onNameChange={(name) => {
                    setNewReagentName(name);
                    lastAddedRowIdRef.current = null;
                  }}
                  onMolecularWeight={handlePubChemMw}
                  onPickLocal={handlePickLocal}
                  library={library}
                  onPickLibrary={(compound) => handlePickLibrary(compound)}
                />
              </div>
              <input
                ref={eqInputRef}
                type="text"
                inputMode="decimal"
                value={newReagentEq}
                onChange={(e) => setNewReagentEq(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitQuickReagent();
                  } else if (e.key === "Escape") {
                    setAddingReagent(false);
                  }
                }}
                placeholder="eq"
                aria-label="Equivalents"
                title="Equivalents relative to limiting reagent"
                className="w-12 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-right text-xs tabular-nums text-zinc-900 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
              />
              <span className="text-[10px] text-zinc-400">eq</span>
              <button
                type="button"
                onClick={() => commitQuickReagent()}
                className="rounded bg-fume-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-fume-700"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setAddingReagent(false)}
                className="px-1 text-xs text-zinc-400 hover:text-zinc-600"
                aria-label="Cancel adding reagent"
              >
                ×
              </button>
            </div>
          ) : (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  lastAddedRowIdRef.current = null;
                  setPendingMw(null);
                  setPendingDensity(null);
                  setAddingReagent(true);
                }}
                className="rounded border border-dashed border-zinc-300 bg-white/80 px-2 py-0.5 text-[10px] font-medium text-zinc-500 transition-colors hover:border-fume-400 hover:bg-fume-50 hover:text-fume-700"
              >
                + Add Reagent
              </button>
            </div>
          )}
        </div>
      </div>

      {/* THE REACTION ARROW: Crisp full-width horizontal vector SVG arrow (───►) */}
      <svg
        viewBox="0 0 240 16"
        className="my-0.5 h-4 w-full text-zinc-800 print:my-0.5 print:h-3.5"
        aria-hidden
      >
        <line
          x1="4"
          y1="8"
          x2="225"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <polygon points="237,8 222,3.5 225,8 222,12.5" fill="currentColor" />
      </svg>

      {/* BELOW THE ARROW: Solvent, Temp (°C), Time (h), Atmosphere */}
      <div className="mt-1 flex w-full flex-col items-center gap-1.5 print:hidden">
        {/* Solvent input with datalist */}
        <input
          type="text"
          list={solventListId}
          value={structuredScheme?.solvent ?? ""}
          onChange={(e) => onPatchScheme({ solvent: e.target.value || undefined })}
          placeholder="Solvent (e.g. dry THF, DCM)"
          aria-label="Reaction solvent"
          className="w-full rounded border border-zinc-200 bg-white px-2 py-0.5 text-center text-xs text-zinc-800 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
        />
        <datalist id={solventListId}>
          {REACTION_SOLVENT_SUGGESTIONS.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>

        {/* Temp & Time side-by-side */}
        <div className="grid w-full grid-cols-2 gap-1.5">
          <input
            type="text"
            value={structuredScheme?.temperature ?? ""}
            onChange={(e) => onPatchScheme({ temperature: e.target.value || undefined })}
            onBlur={commitTemp}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTemp();
              }
            }}
            placeholder="Temp (e.g. 80 °C, rt)"
            aria-label="Reaction temperature"
            title="Type a number like 80 or -78 to auto-append °C, or type rt / reflux"
            className="w-full rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-center text-xs text-zinc-800 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
          />
          <input
            type="text"
            value={structuredScheme?.duration ?? ""}
            onChange={(e) => onPatchScheme({ duration: e.target.value || undefined })}
            onBlur={commitDuration}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDuration();
              }
            }}
            placeholder="Time (e.g. 16 h)"
            aria-label="Reaction duration"
            title="Type a number like 16 to auto-append h, or type 30 min / overnight"
            className="w-full rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-center text-xs text-zinc-800 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
          />
        </div>

        {/* Atmosphere pills */}
        <div className="flex items-center justify-center gap-1">
          <span className="text-[10px] text-zinc-400">Atm:</span>
          {ATMOSPHERE_OPTIONS.map((atm) => {
            const selected = structuredScheme?.atmosphere === atm;
            return (
              <button
                key={atm}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onPatchScheme({ atmosphere: selected ? undefined : atm })
                }
                className={`rounded border px-1.5 py-0.2 text-[10px] font-medium transition-colors ${
                  selected
                    ? "border-fume-500 bg-fume-50 text-fume-800"
                    : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                }`}
              >
                {atm}
              </button>
            );
          })}
        </div>
      </div>

      {/* BELOW THE ARROW (Print only): Clean publication-style single/two-line summary */}
      {printedBelowParts.length > 0 && (
        <div className="mt-0.5 hidden text-center text-[10.5px] leading-snug text-zinc-800 print:block">
          {printedBelowParts.join(", ")}
        </div>
      )}
    </div>
  );
}
