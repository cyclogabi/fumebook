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
  libraryCompoundSmiles,
  prepareForKetcher,
  searchLibrary,
  suggestDistinctLibraryName,
  useLibrary,
  type CompoundInput,
  type LibraryCompound,
} from "@/lib/library";
import { pickJsonFile, saveJsonFile } from "@/lib/fileDialogs";
import {
  draftReactionTemplate,
  formatReactionConditions,
  reactionMatchesQuery,
  useReactionLibrary,
  type ReactionTemplateDraft,
  type SavedReactionTemplate,
} from "@/lib/reactionLibrary";
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
  /** Canonical SMILES already stored on the experiment (shown until a fresh extraction finishes). */
  reactantSmiles?: string;
  productSmiles?: string;
  /** Silent background extraction result for the left and right zones. */
  onZoneSmilesChange?: (reactantSmiles: string | null, productSmiles: string | null) => void;
  /** Experiment id, e.g. GH055. Prefills the saved-reaction name. */
  experimentCode: string;
  experimentTitle: string;
  /**
   * Replace the open reaction with a saved template.
   * The parent records the current experiment on the undo stack first.
   */
  onLoadReaction: (template: SavedReactionTemplate) => void;
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
/** Indigo's standalone service is not safe to call concurrently. */
let indigoChain: Promise<unknown> = Promise.resolve();

function withIndigoLock<T>(task: () => Promise<T>): Promise<T> {
  const run = indigoChain.then(task, task);
  indigoChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * ChemDraw's clipboard Molfile is not a strict V2000 file: the comment header line is
 * often missing, and unused bond-block integers are spaces (`   `) instead of `  0`.
 * Indigo rejects both (`bad header ChemDraw…`, `readIntFix(3): "   "`), so a drawing
 * never becomes SMILES. This rewrites only those defects and keeps wedge stereo.
 */
function normaliseV2000Molfile(molfile: string): string {
  if (!/V2000/i.test(molfile) || /<CDXML[\s>]/i.test(molfile)) return molfile;
  const lines = molfile.replace(/\r\n?/g, "\n").split("\n");
  const countsIdx = lines.findIndex((line) => /V2000\s*$/i.test(line));
  if (countsIdx < 0) return molfile;
  const header = lines.slice(0, countsIdx);
  while (header.length < 3) header.push("");
  if (header.length > 3) header.splice(0, header.length - 3);
  const countsLine = lines[countsIdx];
  const nAtoms = parseInt(countsLine.slice(0, 3).trim(), 10);
  const nBonds = parseInt(countsLine.slice(3, 6).trim(), 10);
  const body = lines.slice(countsIdx + 1);
  if (!Number.isFinite(nAtoms) || !Number.isFinite(nBonds) || nAtoms < 0 || nBonds < 0) {
    return [...header, ...lines.slice(countsIdx)].join("\n");
  }
  const bonds = body.slice(nAtoms, nAtoms + nBonds).map(fixV2000BondLine);
  return [
    ...header,
    countsLine.trimEnd(),
    ...body.slice(0, nAtoms),
    ...bonds,
    ...body.slice(nAtoms + nBonds),
  ].join("\n");
}

/** Blank 3-character bond fields (`   `) become `  0`. A real stereo flag (`  1`, `  6`) is kept. */
function fixV2000BondLine(line: string): string {
  if (!line || line.startsWith("M  ")) return line;
  let next = line.trimEnd();
  if (next.length < 21) next = next.padEnd(21, " ");
  for (const start of [9, 12, 15, 18]) {
    if (next.length < start + 3) next = next.padEnd(start + 3, " ");
    const field = next.slice(start, start + 3);
    if (field.trim() === "" || !/^[+-]?\d+$/.test(field.trim())) {
      next = `${next.slice(0, start)}  0${next.slice(start + 3)}`;
    }
  }
  return next;
}

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
      const service = provider.createStructService({});
      // Prevent IndigoService.getStandardServerOptions from throwing
      // "Cannot getting options because there are no ketcherId" when no <Editor> is mounted.
      const internal = service as unknown as {
        defaultOptions?: Record<string, unknown>;
        getStandardServerOptions?: (opts?: Record<string, unknown>) => Record<string, unknown>;
      };
      if (typeof internal.getStandardServerOptions === "function") {
        internal.getStandardServerOptions = (opts?: Record<string, unknown>) => ({
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

  let structForRender = format === "mol" ? normaliseV2000Molfile(prepared) : prepared;
  if (format === "smiles") {
    const laidOut = await service.layout(
      {
        struct: prepared.trim(),
        output_format: "chemical/x-mdl-molfile" as never,
      },
      {},
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
    });
  } catch (err) {
    if (format === "mol") {
      const stripped = stripMolfileBondStereo(structForRender);
      b64 = await service.generateImageAsBase64(stripped, {
        outputFormat: "svg",
        backgroundColor: "255, 255, 255",
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
        {},
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

/**
 * Convert CDXML / Molfile / SMILES to a daylight SMILES string.
 * Perspective structures that Indigo rejects (wedged 3D stereocenters, e.g. cyclodextrins)
 * are retried with bond stereo stripped so a flat connectivity SMILES is still produced.
 * Failures are logged and return null — pasting and saving are never blocked.
 */
export function extractCanonicalSmilesFailSafe(structureText: string): Promise<string | null> {
  const text = structureText.trim();
  if (!text) return Promise.resolve(null);
  if (detectFormat(text) === "smiles") return Promise.resolve(text);
  return withIndigoLock(() => convertStructureToSmiles(text));
}

async function convertStructureToSmiles(text: string): Promise<string | null> {
  const prepared = normaliseV2000Molfile(text);
  try {

    const service = await getStandaloneStructService();
    const outputFormat = "chemical/x-daylight-smiles";
    const readSmiles = (struct: string | undefined) => {
      const line = struct
        ?.split(/\r?\n/)
        .map((row) => row.trim())
        .find((row) => row !== "" && !row.startsWith("#") && !row.startsWith("<"));
      return line || null;
    };
    const convertToSmiles = async (struct: string) => {
      const converted = await service.convert(
        { struct, output_format: outputFormat as never },
        {},
      );
      return readSmiles(converted?.struct);
    };

    try {
      const smiles = await convertToSmiles(prepared);
      if (smiles) return smiles;
    } catch (err) {
      const stripped = stripMolfileBondStereo(prepared);
      if (stripped === prepared) throw err;
      const smiles = await convertToSmiles(stripped);
      if (smiles) return smiles;
      throw err;
    }

    const stripped = stripMolfileBondStereo(prepared);
    if (stripped !== prepared) {
      const smiles = await convertToSmiles(stripped);
      if (smiles) return smiles;
    }
    console.warn("SMILES extraction skipped: Indigo returned no SMILES");
    return null;
  } catch (err) {
    console.warn("SMILES extraction skipped:", err);
    return null;
  }
}

async function calculateMwWithIndigoFallback(struct: string): Promise<number | null> {
  const prepared = normaliseV2000Molfile(struct);
  try {
    const service = await getStandaloneStructService();
    let res;
    try {
      res = await service.calculate(
        {
          struct: prepared,
          properties: ["molecular-weight"],
        },
        {},
      );
    } catch (innerErr) {
      if (detectFormat(prepared) === "mol") {
        const stripped = stripMolfileBondStereo(prepared);
        res = await service.calculate(
          {
            struct: stripped,
            properties: ["molecular-weight"],
          },
          {},
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
            {},
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
  reactantSmiles,
  productSmiles,
  onZoneSmilesChange,
  experimentCode,
  experimentTitle,
  onLoadReaction,
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
  const [extractedSmiles, setExtractedSmiles] = useState<{
    reactant: string | null;
    product: string | null;
  } | null>(null);
  const [smilesCopied, setSmilesCopied] = useState(false);
  const [saveReactionOpen, setSaveReactionOpen] = useState(false);
  const [loadReactionOpen, setLoadReactionOpen] = useState(false);
  const [reactionSavedFlash, setReactionSavedFlash] = useState(false);

  const schemeRef = useRef(structuredScheme);
  const onSchemeChangeRef = useRef(onStructuredSchemeChange);
  const onReagentsChangeRef = useRef(onReagentsChange);
  const onProductChangeRef = useRef(onProductChange);
  const onZoneSmilesChangeRef = useRef(onZoneSmilesChange);
  useEffect(() => {
    schemeRef.current = structuredScheme;
    onSchemeChangeRef.current = onStructuredSchemeChange;
    onReagentsChangeRef.current = onReagentsChange;
    onProductChangeRef.current = onProductChange;
    onZoneSmilesChangeRef.current = onZoneSmilesChange;
  });

  // Paste, library load, and the ChemDraw file watcher all write zone CDXML.
  // Extract SMILES after that write so the paste itself never waits on Indigo.
  useEffect(() => {
    let cancelled = false;
    const reactantSrc = (structuredScheme?.reactantCdxml ?? "").trim();
    const productSrc = (structuredScheme?.productCdxml ?? "").trim();
    void (async () => {
      const reactant = reactantSrc ? await extractCanonicalSmilesFailSafe(reactantSrc) : null;
      const product = productSrc ? await extractCanonicalSmilesFailSafe(productSrc) : null;
      if (cancelled) return;
      setExtractedSmiles({ reactant, product });
      onZoneSmilesChangeRef.current?.(reactant, product);
    })();
    return () => {
      cancelled = true;
    };
  }, [structuredScheme?.reactantCdxml, structuredScheme?.productCdxml]);

  useEffect(() => {
    if (!reactionSavedFlash) return;
    const timer = window.setTimeout(() => setReactionSavedFlash(false), 1600);
    return () => window.clearTimeout(timer);
  }, [reactionSavedFlash]);

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
      try {
        const { svgDataUrl, cdxml: normalizedCdxml, mw } =
          await renderStructureToVectorSvg(incomingCdxml);
        patchStructured({ reactantImage: svgDataUrl, reactantCdxml: normalizedCdxml });
        if (mw !== null && mw > 0) {
          syncZoneMetadata("reactant", { mw });
        }
      } catch (err) {
        console.warn("Indigo reactant CDXML render failed, keeping raw CDXML:", err);
        patchStructured({ reactantCdxml: incomingCdxml });
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
      try {
        const { svgDataUrl, cdxml: normalizedCdxml, mw } =
          await renderStructureToVectorSvg(incomingCdxml);
        patchStructured({ productImage: svgDataUrl, productCdxml: normalizedCdxml });
        if (mw !== null && mw > 0) {
          syncZoneMetadata("product", { mw });
        }
      } catch (err) {
        console.warn("Indigo product CDXML render failed, keeping raw CDXML:", err);
        patchStructured({ productCdxml: incomingCdxml });
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
        let cdxml = (compound.cdxml || compound.structure || "").trim();
        let computedMw: number | null = compound.mw ?? null;

        // If `compound.imageDataUrl` already exists, do NOT call Indigo to re-render the SVG
        // (avoids Indigo crashing on 3D perspective structures such as cyclodextrins).
        // Only invoke Indigo as a fallback when no pre-rendered `imageDataUrl` exists.
        if (!svgDataUrl && cdxml) {
          try {
            const rendered = await renderStructureToVectorSvg(cdxml);
            svgDataUrl = rendered.svgDataUrl;
            if (!compound.cdxml && rendered.cdxml) {
              cdxml = rendered.cdxml;
            }
            if (computedMw === null) {
              computedMw = rendered.mw;
            }
          } catch (err) {
            console.warn(
              "Indigo structure rendering failed when loading library compound, skipping SVG render:",
              err,
            );
          }
        }

        if (!svgDataUrl && !cdxml && computedMw === null) {
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
  const shownReactantSmiles = extractedSmiles
    ? (extractedSmiles.reactant ?? "")
    : (reactantSmiles ?? "");
  const shownProductSmiles = extractedSmiles
    ? (extractedSmiles.product ?? "")
    : (productSmiles ?? "");
  const aiReadySmiles = Boolean(shownReactantSmiles && shownProductSmiles);
  const mappedCoreSmiles = `${shownReactantSmiles}>>${shownProductSmiles}`;
  const reactionDraft = useMemo(
    () =>
      draftReactionTemplate({
        experimentCode,
        reactantName: limitingRow?.name,
        reactantMw: limitingRow?.mw,
        reactantImage: structuredScheme?.reactantImage,
        reactantCdxml: structuredScheme?.reactantCdxml,
        reactantSmiles: shownReactantSmiles,
        productName: product.name,
        productMw: product.mw,
        productImage: structuredScheme?.productImage,
        productCdxml: structuredScheme?.productCdxml,
        productSmiles: shownProductSmiles,
        solvent: structuredScheme?.solvent,
        temperature: structuredScheme?.temperature,
        time: structuredScheme?.duration,
        atmosphere: structuredScheme?.atmosphere,
        reagents,
        library: library ?? [],
      }),
    [
      experimentCode,
      library,
      limitingRow?.mw,
      limitingRow?.name,
      product.mw,
      product.name,
      reagents,
      shownProductSmiles,
      shownReactantSmiles,
      structuredScheme,
    ],
  );
  const defaultReactionName = `${experimentCode} ${experimentTitle}`.replace(/\s+/g, " ").trim();

  function handleLoadReaction(template: SavedReactionTemplate) {
    reactantChemDraw.stopWatching();
    productChemDraw.stopWatching();
    setReactantError(null);
    setProductError(null);
    setLoadReactionOpen(false);
    onLoadReaction(template);
  }

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
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Reaction scheme
          </h2>
          {aiReadySmiles && (
            <div className="flex items-center gap-1.5 print:hidden">
              <span
                title={mappedCoreSmiles}
                className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
              >
                AI-Ready SMILES ✓
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(mappedCoreSmiles).then(() => {
                    setSmilesCopied(true);
                    window.setTimeout(() => setSmilesCopied(false), 1500);
                  });
                }}
                className="text-[10px] font-medium text-emerald-700 underline-offset-2 hover:underline"
              >
                {smilesCopied ? "Copied" : "Copy Reaction SMILES"}
              </button>
            </div>
          )}
        </div>

        {/* Central Hybrid Selection & ChemDraw Toolbar (screen only, hidden in print) */}
        <div className="flex flex-wrap items-center gap-2 print:hidden">
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

          <button
            type="button"
            onClick={() => {
              setLoadReactionOpen(false);
              setSaveReactionOpen(true);
            }}
            className="rounded-md bg-fume-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-fume-700"
            title="Save this reaction — structures, conditions, equivalents, and Reaction SMILES — as a reusable template"
          >
            {reactionSavedFlash ? "Saved ✓" : "Save Reaction"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSaveReactionOpen(false);
              setLoadReactionOpen(true);
            }}
            className="rounded-md bg-fume-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-fume-700"
            title="Load a saved reaction template into this experiment"
          >
            Load Reaction
          </button>
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

      {saveReactionOpen && (
        <SaveReactionDialog
          initialName={defaultReactionName}
          draft={reactionDraft}
          onClose={() => setSaveReactionOpen(false)}
          onSaved={() => {
            setSaveReactionOpen(false);
            setReactionSavedFlash(true);
          }}
        />
      )}
      {loadReactionOpen && (
        <LoadReactionDialog onClose={() => setLoadReactionOpen(false)} onLoad={handleLoadReaction} />
      )}
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

  async function handleSaveAsNewCompound(targetName: string) {
    setError(null);
    const built = buildCompoundInput(targetName);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const source = (built.input.cdxml || built.input.structure || "").trim();
    const smiles = source ? await extractCanonicalSmilesFailSafe(source) : null;
    const result = onAddToLibrary({ ...built.input, smiles: smiles ?? null });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavePromptOpen(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3000);
  }

  async function handleUpdateExistingCompound(existingId: string) {
    setError(null);
    const built = buildCompoundInput(saveName);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const source = (built.input.cdxml || built.input.structure || "").trim();
    const smiles = source ? await extractCanonicalSmilesFailSafe(source) : null;
    const result = onUpdateInLibrary(existingId, { ...built.input, smiles: smiles ?? null });
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
              active ? "bg-fume-600" : "bg-zinc-300"
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
          className={`group/zone relative flex min-h-36 w-full cursor-pointer items-center justify-center rounded-md border bg-white p-2.5 transition-all focus:outline-none print:min-h-0 print:cursor-default print:border-0 print:border-gray-300 print:bg-transparent print:p-0 print:text-black print:ring-0 print:ring-transparent print:shadow-none ${
            dragging
              ? "border-fume-500 bg-fume-50 print:border-0 print:bg-transparent print:ring-0"
              : active
                ? "border-fume-500 ring-2 ring-fume-500/20 print:border-0 print:border-gray-300 print:bg-transparent print:text-black print:ring-0 print:ring-transparent print:shadow-none"
                : "border-zinc-200 hover:border-fume-300 print:border-0"
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
          className={`group/zone relative flex min-h-36 w-full cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-4 text-center text-xs transition-all focus:outline-none print:hidden print:border-gray-300 print:bg-transparent print:text-black print:ring-0 print:ring-transparent print:shadow-none ${
            dragging
              ? "border-fume-500 bg-fume-50 text-fume-700"
              : active
                ? "border-fume-500 bg-fume-50/20 text-zinc-700 ring-2 ring-fume-500/20 print:border-gray-300 print:bg-transparent print:text-black print:ring-0 print:ring-transparent print:shadow-none"
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
              placeholder="Name"
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
                placeholder="Density (g/mL)"
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
  const [pendingSmiles, setPendingSmiles] = useState<string | undefined>();
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
    let resolvedSmiles = pendingSmiles;

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
          resolvedSmiles = resolvedSmiles ?? libraryCompoundSmiles(libHit);
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
          ? {
              ...cur[blankIdx],
              name: finalName,
              ...(resolvedSmiles ? { smiles: resolvedSmiles } : {}),
            }
          : {
              ...newRow("Reagent"),
              name: finalName,
              ...(resolvedSmiles ? { smiles: resolvedSmiles } : {}),
            };
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
    setPendingSmiles(libraryCompoundSmiles(compound));
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

  const rawAtmosphere = structuredScheme?.atmosphere?.trim();
  const formattedAtmosphere = rawAtmosphere
    ? /^under\s+/i.test(rawAtmosphere)
      ? rawAtmosphere
      : `under ${rawAtmosphere}`
    : undefined;

  const printedBelowParts = [
    structuredScheme?.solvent?.trim(),
    structuredScheme?.temperature?.trim(),
    structuredScheme?.duration?.trim(),
    formattedAtmosphere,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="flex flex-col items-stretch w-max min-w-[120px] max-w-full mx-auto px-1 py-1">
      {/* ABOVE THE ARROW: Additional Reagents / Catalysts */}
      <div className="flex min-h-8 w-full flex-col items-center justify-end gap-1 pb-1 text-center">
        {arrowReagents.length > 0 && (
          <div className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-xs leading-snug text-zinc-800 print:text-[10.5px]">
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
        <div className="w-full text-center print:hidden">
          {addingReagent ? (
            <div className="mx-auto flex max-w-xs items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50/80 p-1 shadow-xs">
              <div className="min-w-0 flex-1">
                <ReagentNameInput
                  value={newReagentName}
                  className="w-full rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
                  onNameChange={(name) => {
                    setNewReagentName(name);
                    lastAddedRowIdRef.current = null;
                    setPendingSmiles(undefined);
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
        width="120"
        viewBox="0 0 240 16"
        className="my-0.5 w-full h-auto text-zinc-800 print:my-0.5"
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

      {/* BELOW THE ARROW: Formatted conditions summary + interactive inputs */}
      <div className="mt-0.5 flex w-full flex-col items-center gap-1.5 text-center">
        {printedBelowParts.length > 0 && (
          <div className="w-full text-center text-xs leading-snug text-zinc-800 print:text-[10.5px]">
            {printedBelowParts.join(", ")}
          </div>
        )}

        <div className="flex w-full flex-col items-center gap-1.5 text-center print:hidden">
          {/* Solvent input with datalist */}
          <input
            type="text"
            list={solventListId}
            size={Math.max(14, (structuredScheme?.solvent ?? "").length + 2)}
            value={structuredScheme?.solvent ?? ""}
            onChange={(e) => onPatchScheme({ solvent: e.target.value || undefined })}
            placeholder="Solvent"
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
              size={Math.max(8, (structuredScheme?.temperature ?? "").length + 1)}
              value={structuredScheme?.temperature ?? ""}
              onChange={(e) => onPatchScheme({ temperature: e.target.value || undefined })}
              onBlur={commitTemp}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTemp();
                }
              }}
              placeholder="Temperature"
              aria-label="Reaction temperature"
              title="Reaction temperature"
              className="w-full rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-center text-xs text-zinc-800 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
            />
            <input
              type="text"
              size={Math.max(8, (structuredScheme?.duration ?? "").length + 1)}
              value={structuredScheme?.duration ?? ""}
              onChange={(e) => onPatchScheme({ duration: e.target.value || undefined })}
              onBlur={commitDuration}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDuration();
                }
              }}
              placeholder="Time"
              aria-label="Reaction duration"
              title="Reaction duration"
              className="w-full rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-center text-xs text-zinc-800 placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none"
            />
          </div>

          {/* Atmosphere pills */}
          <div className="flex items-center justify-center gap-1">
            <span className="text-[10px] text-zinc-400">under</span>
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
      </div>
    </div>
  );
}

function formatTemplateDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function reagentRecipeLabel(reagent: SavedReactionTemplate["reagentsTemplate"][number]): string {
  if (reagent.isLimiting || reagent.role === "Limiting") return "limiting · 1 eq";
  if (reagent.role === "Solvent") return "solvent";
  const eq = reagent.equivalents > 0 ? `${formatNumber(reagent.equivalents)} eq` : "";
  if (reagent.role === "Catalyst") return eq ? `catalyst · ${eq}` : "catalyst";
  return eq || "eq not set";
}

function StructureThumb({ src, label }: { src?: string | null; label: string }) {
  return (
    <div className="flex h-16 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded border border-zinc-200 bg-white">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- saved SVG or PNG data URL
        <img src={src} alt={label} className="max-h-14 max-w-[4.25rem] object-contain" />
      ) : (
        <span className="px-1 text-center text-[9px] leading-tight text-zinc-400">{label}</span>
      )}
    </div>
  );
}

function MiniReactionScheme({
  reactantImage,
  reactantLabel,
  productImage,
  productLabel,
  conditions,
}: {
  reactantImage?: string | null;
  reactantLabel: string;
  productImage?: string | null;
  productLabel: string;
  conditions: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <StructureThumb src={reactantImage} label={reactantLabel || "Reactant"} />
      <div className="flex w-16 shrink-0 flex-col items-center gap-0.5">
        <span aria-hidden className="text-base leading-none text-emerald-800">
          ⟶
        </span>
        {conditions ? (
          <span className="line-clamp-3 text-center text-[9px] leading-tight text-zinc-500">
            {conditions}
          </span>
        ) : (
          <span className="text-[9px] text-zinc-300">conditions</span>
        )}
      </div>
      <StructureThumb src={productImage} label={productLabel || "Product"} />
    </div>
  );
}

function ReactionSmilesBox({
  reactionSmiles,
  mappedCoreSmiles,
}: {
  reactionSmiles: string;
  mappedCoreSmiles: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  function copySmiles() {
    const text = `${reactionSmiles}\n${mappedCoreSmiles}`;
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopyError(null);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopyError("Could not copy SMILES."),
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
          Encoded Reaction SMILES
        </span>
        <button
          type="button"
          onClick={copySmiles}
          className="text-[10px] font-semibold text-emerald-800 underline-offset-2 hover:underline"
        >
          {copied ? "Copied" : "Copy SMILES"}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-emerald-200 bg-emerald-50/70 p-2 font-mono text-[11px] leading-relaxed text-emerald-950">
        {`Reactant>Agents>Product\n${reactionSmiles}\n\nReactant>>Product\n${mappedCoreSmiles}`}
      </pre>
      {copyError && <p className="mt-1 text-[11px] text-red-600">{copyError}</p>}
    </div>
  );
}

function HazmatStripe() {
  return (
    <div
      aria-hidden
      className="h-2 w-full bg-[repeating-linear-gradient(-45deg,#111827_0_7px,#facc15_7px_14px)]"
    />
  );
}

function SaveReactionDialog({
  initialName,
  draft,
  onClose,
  onSaved,
}: {
  initialName: string;
  draft: ReactionTemplateDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { reactions, saveReactionTemplate } = useReactionLibrary();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const conditions = formatReactionConditions(draft);
  const duplicate = reactions.some(
    (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  function commit() {
    try {
      saveReactionTemplate({ ...draft, name });
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-emerald-900 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-900/40 print:hidden"
    >
      <HazmatStripe />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-emerald-950">
              Save Reaction
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Structures, conditions, equivalents, and the encoded Reaction SMILES.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            ×
          </button>
        </div>

        <label className="mt-4 block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Template name
          </span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            placeholder="GH055 Benzylation of alpha-CD"
            aria-label="Reaction template name"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-600 focus:outline-none"
          />
        </label>
        {duplicate && (
          <p className="mt-1.5 text-[11px] text-emerald-800">
            A template with this name will be updated.
          </p>
        )}

        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
          <MiniReactionScheme
            reactantImage={draft.reactantImage}
            reactantLabel={draft.reactantName || "Reactant"}
            productImage={draft.productImage}
            productLabel={draft.productName || "Product"}
            conditions={conditions}
          />
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Reagents
            </p>
            {draft.reagentsTemplate.length === 0 ? (
              <p className="mt-1 text-xs text-zinc-400">No named reagents yet.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {draft.reagentsTemplate.map((reagent, index) => (
                  <li
                    key={`${reagent.name}-${index}`}
                    className="flex items-baseline justify-between gap-3 text-xs text-zinc-800"
                  >
                    <span className="min-w-0 truncate">{reagent.name}</span>
                    <span className="shrink-0 font-medium text-emerald-900">
                      {reagentRecipeLabel(reagent)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-3">
            <ReactionSmilesBox
              reactionSmiles={draft.reactionSmiles}
              mappedCoreSmiles={draft.mappedCoreSmiles}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={!name.trim()}
            className="rounded-md bg-fume-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {duplicate ? "Update template" : "Save"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function LoadReactionDialog({
  onClose,
  onLoad,
}: {
  onClose: () => void;
  onLoad: (template: SavedReactionTemplate) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { reactions, deleteReactionTemplate, exportReactionLibraryJson, importReactionLibraryJson } =
    useReactionLibrary();
  const [query, setQuery] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const visible = reactions.filter((template) => reactionMatchesQuery(template, query));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    searchRef.current?.focus();
  }, []);

  async function handleExport() {
    setTransferBusy(true);
    setTransferError(null);
    setTransferNote(null);
    try {
      const saved = await saveJsonFile(
        "fumebook_reaction_library.json",
        exportReactionLibraryJson(),
      );
      if (saved) setTransferNote("Reaction library exported.");
    } catch (err) {
      setTransferError(messageOf(err));
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleImport() {
    setTransferBusy(true);
    setTransferError(null);
    setTransferNote(null);
    try {
      const picked = await pickJsonFile();
      if (!picked) return;
      const result = importReactionLibraryJson(picked.text, "merge");
      const parts = [
        result.added ? `${result.added} added` : "",
        result.updated ? `${result.updated} updated` : "",
      ].filter(Boolean);
      setTransferNote(parts.join(", ") + ".");
    } catch (err) {
      setTransferError(messageOf(err));
    } finally {
      setTransferBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto w-[min(44rem,calc(100vw-2rem))] rounded-xl border border-emerald-900 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-900/40 print:hidden"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
      <HazmatStripe />
      <div className="border-b border-zinc-200 p-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-emerald-950">
              Load Reaction
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Loads structures, conditions, and equivalents. Masses stay blank for a new scale.
              Ctrl+Z restores this experiment.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            ×
          </button>
        </div>
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setConfirmDeleteId(null);
          }}
          placeholder="Search code, name, reagent, or SMILES"
          aria-label="Search saved reactions"
          className="mt-3 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-emerald-600 focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {reactions.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">
            No reactions saved yet. Use Save Reaction to store one.
          </p>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">No reactions match that search.</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((template) => {
              const conditions = formatReactionConditions(template);
              return (
                <li
                  key={template.id}
                  className="rounded-lg border border-zinc-200 p-2.5 hover:border-emerald-300"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <MiniReactionScheme
                      reactantImage={template.reactantImage}
                      reactantLabel={template.reactantName || "Reactant"}
                      productImage={template.productImage}
                      productLabel={template.productName || "Product"}
                      conditions={conditions}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-zinc-900">
                            {template.name}
                          </p>
                          <p className="text-[10px] text-zinc-500">
                            {[template.experimentCode, formatTemplateDate(template.createdAt)]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onLoad(template)}
                            className="rounded-md bg-fume-600 px-2 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-fume-700"
                          >
                            Load
                          </button>
                          {confirmDeleteId === template.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  deleteReactionTemplate(template.id);
                                  setConfirmDeleteId(null);
                                }}
                                className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50"
                              >
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(template.id)}
                              aria-label={`Delete ${template.name}`}
                              title={`Delete ${template.name}`}
                              className="grid size-7 place-items-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600"
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
                                <path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.6 4.5l.4 8.2h6l.4-8.2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                      {conditions && (
                        <span className="mt-1 inline-block max-w-full truncate rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 ring-1 ring-emerald-200">
                          {conditions}
                        </span>
                      )}
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-zinc-600"
                        title={template.reactionSmiles}
                      >
                        {template.reactionSmiles || "—"}
                      </p>
                      <p
                        className="truncate font-mono text-[10px] text-zinc-400"
                        title={template.mappedCoreSmiles}
                      >
                        {template.mappedCoreSmiles || "—"}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-5 py-3">
        <p className="text-[11px] text-zinc-500">
          {reactions.length} saved
          {transferNote ? ` · ${transferNote}` : ""}
          {transferError ? ` · ${transferError}` : ""}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={transferBusy}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={transferBusy}
            className="rounded-md border border-emerald-800 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-950 hover:bg-emerald-100 disabled:opacity-50"
          >
            Import JSON
          </button>
        </div>
      </div>
      </div>
    </dialog>
  );
}
