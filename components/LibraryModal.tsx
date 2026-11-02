"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  extractCanonicalSmilesFailSafe,
  extractDualStreamClipboard,
  renderStructureToVectorSvg,
} from "@/components/MoleculeSection";
import { imageFileToPng } from "@/lib/images";
import {
  compoundMatchesQuery,
  describeProperties,
  detectFormat,
  structureFromFile,
  useLibrary,
  type LibraryCompound,
  type StructureFormat,
} from "@/lib/library";
import { blobToDataUrl } from "@/lib/storage";

const FORMAT_LABELS: Record<StructureFormat, string> = {
  smiles: "SMILES",
  mol: "MOL",
  cdxml: "CDXML",
};

/**
 * A typed number ("46.07", also "0,789" with a decimal comma) -> the number, `undefined` when
 * the field is empty, `null` when it is not a positive number.
 */
/** SMILES for a structure about to be saved. Never throws — a failed conversion just omits SMILES. */
async function smilesForSavedStructure(text: string, fileName?: string): Promise<string | undefined> {
  const source = text.trim();
  if (!source) return undefined;
  if (detectFormat(source, fileName) === "smiles") return source;
  return (await extractCanonicalSmilesFailSafe(source)) ?? undefined;
}

function parseOptionalNumber(text: string): number | undefined | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return undefined;
  const value = Number(t);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface LibraryDraft {
  name: string;
  mw?: number | null;
  density?: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialDraft?: LibraryDraft | null;
}

/**
 * "Personal Library": browse, add and delete your own compounds (stored in
 * Documents/Fumebook/library.json). Mounted only while open, so every opening starts fresh.
 */
export default function LibraryModal(props: Props) {
  return props.open ? (
    <LibraryDialog onClose={props.onClose} initialDraft={props.initialDraft} />
  ) : null;
}

const MAX_STRUCTURE_FILE_BYTES = 1_000_000;
const KEY_PASTE_FALLBACK_MS = 150;

function isPlainTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function LibraryDialog({
  onClose,
  initialDraft,
}: {
  onClose: () => void;
  initialDraft?: LibraryDraft | null;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);
  const addPasteZoneRef = useRef<HTMLDivElement>(null);
  const draftHydratedRef = useRef(false);
  const { compounds, error: libraryError, add, update, upsert, remove } = useLibrary();

  const [query, setQuery] = useState("");
  const [name, setName] = useState(() => initialDraft?.name?.trim() ?? "");
  const [structure, setStructure] = useState("");
  const [addCdxml, setAddCdxml] = useState<string | undefined>(undefined);
  const [addImageDataUrl, setAddImageDataUrl] = useState<string | undefined>(undefined);
  /** Name of the file the structure came from (a `.cdxml` name marks the text as CDXML). */
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [mwText, setMwText] = useState(() =>
    initialDraft?.mw !== undefined && initialDraft?.mw !== null && initialDraft.mw > 0
      ? String(initialDraft.mw)
      : "",
  );
  const [densityText, setDensityText] = useState(() =>
    initialDraft?.density !== undefined &&
    initialDraft?.density !== null &&
    initialDraft.density > 0
      ? String(initialDraft.density)
      : "",
  );
  const [notes, setNotes] = useState("");
  const [aliases, setAliases] = useState("");
  const [iupacName, setIupacName] = useState("");
  const [casNumber, setCasNumber] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addDragging, setAddDragging] = useState(false);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Id of the compound whose delete button was pressed once ("Sure?" state). */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // In-place Edit state for any compound row
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMwText, setEditMwText] = useState("");
  const [editDensityText, setEditDensityText] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editAliases, setEditAliases] = useState("");
  const [editIupac, setEditIupac] = useState("");
  const [editCas, setEditCas] = useState("");
  const [editStructure, setEditStructure] = useState("");
  const [editCdxml, setEditCdxml] = useState<string | undefined>(undefined);
  const [editImageDataUrl, setEditImageDataUrl] = useState<string | undefined>(undefined);
  const [editFileName, setEditFileName] = useState<string | undefined>(undefined);
  const [editClearStructure, setEditClearStructure] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Native <dialog>: focus trap, Esc to close and the backdrop come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (initialDraft) {
      requestAnimationFrame(() => addPasteZoneRef.current?.focus());
    }
  }, [initialDraft]);

  // If opened from a Reagents Table row whose compound already exists in the library,
  // hydrate existing structure/notes so saving updates it in-place without losing anything.
  useEffect(() => {
    if (draftHydratedRef.current || !initialDraft?.name?.trim() || !compounds) return;
    draftHydratedRef.current = true;
    const key = initialDraft.name.trim().toLowerCase();
    const existing = compounds.find((c) => c.name.trim().toLowerCase() === key);
    if (!existing) return;
    if (existing.structure || existing.cdxml) {
      setStructure(existing.structure || existing.cdxml || "");
    }
    if (existing.cdxml) setAddCdxml(existing.cdxml);
    if (existing.imageDataUrl) setAddImageDataUrl(existing.imageDataUrl);
    if (existing.notes) setNotes(existing.notes);
    setAliases(existing.aliases?.join(", ") ?? "");
    setIupacName(existing.iupacName ?? "");
    setCasNumber(existing.casNumber ?? "");
    if (!mwText && existing.mw !== undefined) setMwText(String(existing.mw));
    if (!densityText && existing.density !== undefined) setDensityText(String(existing.density));
  }, [compounds, densityText, initialDraft, mwText]);

  // Global Ctrl+V / paste handler inside the Library modal when not typing into a plain text input
  useEffect(() => {
    let pasteHandledAt = 0;

    function onPaste(e: ClipboardEvent) {
      if (isPlainTextInput(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      pasteHandledAt = Date.now();
      if (editingId) {
        void handlePasteStructureForEdit();
      } else {
        void handlePasteStructureForAdd();
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "v") return;
      if (isPlainTextInput(e.target)) return;
      window.setTimeout(() => {
        if (Date.now() - pasteHandledAt < KEY_PASTE_FALLBACK_MS) return;
        if (editingId) {
          void handlePasteStructureForEdit();
        } else {
          void handlePasteStructureForAdd();
        }
      }, 30);
    }

    window.addEventListener("paste", onPaste, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!compounds) return [];
    return q ? compounds.filter((c) => compoundMatchesQuery(c, q)) : compounds;
  }, [compounds, query]);

  const detected = structure.trim() ? detectFormat(structure, fileName) : null;

  function startEditing(c: LibraryCompound) {
    setConfirmId(null);
    setEditingId(c.id);
    setEditName(c.name);
    setEditMwText(c.mw !== undefined ? String(c.mw) : "");
    setEditDensityText(c.density !== undefined ? String(c.density) : "");
    setEditNotes(c.notes ?? "");
    setEditAliases(c.aliases?.join(", ") ?? "");
    setEditIupac(c.iupacName ?? "");
    setEditCas(c.casNumber ?? "");
    setEditStructure(c.structure ?? c.cdxml ?? "");
    setEditCdxml(c.cdxml);
    setEditImageDataUrl(c.imageDataUrl);
    setEditFileName(c.format === "cdxml" ? "structure.cdxml" : undefined);
    setEditClearStructure(false);
    setEditError(null);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditError(null);
    setEditBusy(false);
  }

  async function handlePasteStructureForEdit() {
    setEditBusy(true);
    setEditError(null);
    try {
      const extracted = await extractDualStreamClipboard();
      if (!extracted) {
        setEditError(
          "Clipboard does not contain a structure or image. Copy a structure in ChemDraw (Ctrl+C) first.",
        );
        return;
      }
      setEditStructure(extracted.cdxml || extracted.structureText);
      setEditCdxml(extracted.cdxml || undefined);
      setEditImageDataUrl(extracted.imageDataUrl);
      setEditFileName(extracted.cdxml ? "clipboard.cdxml" : undefined);
      setEditClearStructure(false);
      if (extracted.mw !== null && extracted.mw > 0) {
        setEditMwText(String(extracted.mw));
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not paste structure.");
    } finally {
      setEditBusy(false);
    }
  }

  async function handleEditStructureFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_STRUCTURE_FILE_BYTES) {
      setEditError("That file is too large to be a single structure.");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      if (file.type.startsWith("image/") || /\.svg$/i.test(file.name)) {
        const prepared = await imageFileToPng(file);
        const dataUrl = await blobToDataUrl(prepared);
        setEditImageDataUrl(dataUrl);
        setEditClearStructure(false);
        return;
      }
      const { structure: text, note } = structureFromFile(file.name, await file.text());
      setEditStructure(text);
      setEditFileName(file.name);
      setEditClearStructure(false);
      if (note) setEditError(note);
      try {
        const rendered = await renderStructureToVectorSvg(text);
        setEditCdxml(rendered.cdxml);
        setEditImageDataUrl(rendered.svgDataUrl);
        if (rendered.mw !== null && rendered.mw > 0 && !editMwText.trim()) {
          setEditMwText(String(rendered.mw));
        }
      } catch {
        // Keep raw structure text even if SVG preview fails
      }
    } catch {
      setEditError("The file could not be read.");
    } finally {
      setEditBusy(false);
    }
  }

  async function handleSaveEdit(id: string) {
    const mw = parseOptionalNumber(editMwText);
    const density = parseOptionalNumber(editDensityText);
    if (mw === null) {
      setEditError("Molecular weight must be a positive number.");
      return;
    }
    if (density === null) {
      setEditError("Density must be a positive number.");
      return;
    }

    setEditBusy(true);
    setEditError(null);
    try {
      let nextCdxml = editCdxml;
      let nextImage = editImageDataUrl;
      let nextMw = mw;

      const trimmedStruct = editStructure.trim();
      if (!editClearStructure && trimmedStruct && !nextImage) {
        try {
          const rendered = await renderStructureToVectorSvg(trimmedStruct);
          nextCdxml = rendered.cdxml;
          nextImage = rendered.svgDataUrl;
          if (nextMw === undefined && rendered.mw !== null && rendered.mw > 0) {
            nextMw = rendered.mw;
          }
        } catch {
          // Allow saving SMILES/MOL text even if offline preview renderer didn't produce an SVG
        }
      }

      const smiles = editClearStructure
        ? null
        : ((await smilesForSavedStructure(nextCdxml || trimmedStruct, editFileName)) ?? null);
      const result = update(id, {
        name: editName,
        mw: nextMw ?? null,
        density: density ?? null,
        notes: editNotes,
        aliases: editAliases,
        iupacName: editIupac,
        casNumber: editCas,
        structure: editClearStructure ? "" : trimmedStruct,
        cdxml: editClearStructure ? undefined : nextCdxml,
        imageDataUrl: editClearStructure ? undefined : nextImage,
        fileName: editFileName,
        clearStructure: editClearStructure,
        smiles,
      });

      if (!result.ok) {
        setEditError(result.error);
        return;
      }
      setEditingId(null);
    } finally {
      setEditBusy(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const mw = parseOptionalNumber(mwText);
    const density = parseOptionalNumber(densityText);
    if (mw === null) return setFormError("Molecular weight must be a positive number.");
    if (density === null) return setFormError("Density must be a positive number.");

    let nextCdxml = addCdxml;
    let nextImage = addImageDataUrl;
    let nextMw = mw;
    if (structure.trim() && !nextImage) {
      try {
        const rendered = await renderStructureToVectorSvg(structure.trim());
        nextCdxml = rendered.cdxml;
        nextImage = rendered.svgDataUrl;
        if (nextMw === undefined && rendered.mw !== null && rendered.mw > 0) {
          nextMw = rendered.mw;
        }
      } catch {
        // Keep text structure if vector render is skipped
      }
    }

    const smiles = await smilesForSavedStructure(nextCdxml || structure, fileName);
    const result = upsert({
      name,
      structure,
      cdxml: nextCdxml,
      imageDataUrl: nextImage,
      notes,
      aliases,
      iupacName,
      casNumber,
      mw: nextMw,
      density,
      fileName,
      smiles: smiles ?? null,
    });
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormError(null);
    setSavedBanner(`Saved "${result.compound.name}" to Personal Library.`);
    setName("");
    setStructure("");
    setAddCdxml(undefined);
    setAddImageDataUrl(undefined);
    setFileName(undefined);
    setMwText("");
    setDensityText("");
    setNotes("");
    setAliases("");
    setIupacName("");
    setCasNumber("");
  }

  async function handlePasteStructureForAdd() {
    setAddBusy(true);
    setFormError(null);
    setSavedBanner(null);
    try {
      const extracted = await extractDualStreamClipboard();
      if (!extracted) {
        setFormError(
          "Clipboard does not contain a structure or image. Copy a structure in ChemDraw (Ctrl+C) first.",
        );
        return;
      }
      setStructure(extracted.cdxml || extracted.structureText);
      setAddCdxml(extracted.cdxml || undefined);
      setAddImageDataUrl(extracted.imageDataUrl);
      setFileName(extracted.cdxml ? "clipboard.cdxml" : undefined);
      if (extracted.mw !== null && extracted.mw > 0 && !mwText.trim()) {
        setMwText(String(extracted.mw));
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not paste structure.");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleStructureFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_STRUCTURE_FILE_BYTES) {
      setFormError("That file is too large to be a single structure.");
      return;
    }
    setAddBusy(true);
    setFormError(null);
    setSavedBanner(null);
    try {
      if (file.type.startsWith("image/") || /\.svg$/i.test(file.name)) {
        const prepared = await imageFileToPng(file);
        const dataUrl = await blobToDataUrl(prepared);
        setAddImageDataUrl(dataUrl);
        return;
      }
      const { structure: text, note } = structureFromFile(file.name, await file.text());
      setStructure(text);
      setFileName(file.name);
      // Name the compound after the file when no name was typed yet.
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
      setFormError(note ?? null);
      try {
        const rendered = await renderStructureToVectorSvg(text);
        setAddCdxml(rendered.cdxml);
        setAddImageDataUrl(rendered.svgDataUrl);
        if (rendered.mw !== null && rendered.mw > 0 && !mwText.trim()) {
          setMwText(String(rendered.mw));
        }
      } catch {
        // Ignore preview error
      }
    } catch {
      setFormError("The file could not be read.");
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-900/40 print:hidden"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              Personal Library
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Your own compounds as SMILES, MOLfile or CDXML, with their molecular weight and
              density. Use <em>Load from Library</em> above the sketcher to drop a structure in, or
              the book button in the reagent table to fill a row.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {libraryError && (
          <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {libraryError}
          </p>
        )}

        {/* Add / Save a compound */}
        <form onSubmit={handleAdd} className="mt-4 space-y-2.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
              {initialDraft?.name ? "Save Reagent to Library" : "Add a compound"}
            </p>
            {savedBanner && (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                {savedBanner}
              </span>
            )}
          </div>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSavedBanner(null);
            }}
            placeholder="Display name / nickname, e.g. α-CD"
            aria-label="Display name or nickname"
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Synonyms / aliases, comma-separated"
            aria-label="Synonyms and aliases"
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <input
            value={iupacName}
            onChange={(e) => setIupacName(e.target.value)}
            placeholder="IUPAC / systematic name"
            aria-label="IUPAC or systematic name"
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <input
            value={casNumber}
            onChange={(e) => setCasNumber(e.target.value)}
            placeholder="CAS number, e.g. 10016-20-3"
            aria-label="CAS number"
            spellCheck={false}
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />

          {/* Interactive ChemDraw Structure Ctrl+V Paste & Drop Target Zone */}
          <div
            ref={addPasteZoneRef}
            tabIndex={0}
            role="button"
            aria-label="ChemDraw Structure Paste Target Zone"
            onClick={() => addPasteZoneRef.current?.focus()}
            onDragOver={(e) => {
              e.preventDefault();
              setAddDragging(true);
            }}
            onDragLeave={() => setAddDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setAddDragging(false);
              void handleStructureFile(e.dataTransfer.files?.[0]);
            }}
            className={`relative flex min-h-[110px] flex-col items-center justify-center rounded-md border-2 border-dashed bg-white p-3 text-center transition focus:outline-none ${
              addDragging
                ? "border-fume-500 bg-fume-50/40 ring-2 ring-fume-500/20"
                : "border-zinc-300 hover:border-fume-400 focus:border-fume-500 focus:ring-2 focus:ring-fume-500/20"
            }`}
          >
            {addImageDataUrl ? (
              <div className="flex w-full flex-col items-center gap-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={addImageDataUrl}
                  alt={name || "Pasted structure"}
                  className="max-h-28 max-w-full object-contain"
                />
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="font-medium text-emerald-800">
                    {addCdxml ? "ChemDraw CDXML + image attached" : "Structure image attached"}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddImageDataUrl(undefined);
                      setAddCdxml(undefined);
                      setStructure("");
                      setFileName(undefined);
                    }}
                    className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                  >
                    Clear structure
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs font-medium text-zinc-700">
                  {addBusy
                    ? "Reading structure from clipboard…"
                    : "Click here and press Ctrl+V or Cmd+V to paste structure from ChemDraw"}
                </p>
                <p className="text-[11px] text-zinc-400">
                  Captures editable CDXML + crisp structure image, or drop a .cdxml / .mol / image file
                </p>
              </div>
            )}
          </div>

          <textarea
            value={structure}
            onChange={(e) => setStructure(e.target.value)}
            placeholder="SMILES, MOLfile, or CDXML"
            aria-label="Structure (SMILES, MOLfile or CDXML)"
            rows={structure.includes("\n") ? 4 : 2}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs placeholder:font-sans placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <input
              ref={fileRef}
              type="file"
              accept=".mol,.sdf,.cdxml,.smi,.smiles,.txt,.png,.jpg,.jpeg,.svg,chemical/x-mdl-molfile,image/*"
              hidden
              onChange={(e) => {
                void handleStructureFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => void handlePasteStructureForAdd()}
              disabled={addBusy}
              className="rounded-md border border-fume-300 bg-white px-2.5 py-1 font-medium text-fume-800 hover:bg-fume-50 disabled:opacity-50"
            >
              {addBusy ? "Pasting…" : "Paste from ChemDraw (Ctrl+V or Cmd+V)"}
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Choose file (.cdxml, .mol, .sdf)…
            </button>
            {detected && <span>Detected: {FORMAT_LABELS[detected]}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-zinc-500">
              Molecular weight (g/mol)
              <input
                value={mwText}
                onChange={(e) => setMwText(e.target.value)}
                inputMode="decimal"
                placeholder="MW (g/mol)"
                aria-label="Molecular weight (g/mol)"
                className="mt-0.5 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </label>
            <label className="block text-xs text-zinc-500">
              Density (g/mL), optional
              <input
                value={densityText}
                onChange={(e) => setDensityText(e.target.value)}
                inputMode="decimal"
                placeholder="Density (g/mL)"
                aria-label="Density (g/mL), optional"
                className="mt-0.5 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </label>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes"
            aria-label="Notes"
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="min-h-4 text-xs text-red-600">
              {formError}
            </p>
            <button
              type="submit"
              disabled={compounds === null}
              className="shrink-0 rounded-md bg-fume-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-700 disabled:opacity-50"
            >
              Save to Library
            </button>
          </div>
        </form>

        {/* The list */}
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Compounds ({compounds?.length ?? 0})
            </p>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, alias, IUPAC, CAS"
              aria-label="Search the library by name, alias, IUPAC, or CAS"
              className="w-44 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:bg-white focus:outline-none"
            />
          </div>

          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {compounds === null && <li className="px-3 py-4 text-sm text-zinc-400">Loading…</li>}
            {compounds !== null && visible.length === 0 && (
              <li className="px-3 py-4 text-sm text-zinc-400">
                {compounds.length === 0 ? "No compounds yet. Add your first one above." : "No matches."}
              </li>
            )}
            {visible.map((c) => {
              const expanded = expandedId === c.id;
              const isEditing = editingId === c.id;
              return (
                <li key={c.id} className="px-3 py-2.5">
                  {isEditing ? (
                    <div className="space-y-2.5 rounded-lg border border-fume-200 bg-fume-50/30 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-fume-800">
                          Editing Compound
                        </span>
                        <button
                          type="button"
                          onClick={cancelEditing}
                          className="text-xs text-zinc-400 hover:text-zinc-700"
                        >
                          Cancel
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <label className="block text-xs text-zinc-600 sm:col-span-1">
                          Display name / nickname
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            aria-label="Edit display name"
                            placeholder="α-CD"
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                          />
                        </label>
                        <label className="block text-xs text-zinc-600">
                          MW (g/mol)
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editMwText}
                            onChange={(e) => setEditMwText(e.target.value)}
                            placeholder="MW (g/mol)"
                            aria-label="Edit molecular weight (g/mol)"
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                          />
                        </label>
                        <label className="block text-xs text-zinc-600">
                          Density d (g/mL)
                          <input
                            type="text"
                            inputMode="decimal"
                            value={editDensityText}
                            onChange={(e) => setEditDensityText(e.target.value)}
                            placeholder="Density (g/mL)"
                            aria-label="Edit density (g/mL)"
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                          />
                        </label>
                      </div>

                      <label className="block text-xs text-zinc-600">
                        Synonyms / aliases
                        <input
                          type="text"
                          value={editAliases}
                          onChange={(e) => setEditAliases(e.target.value)}
                          placeholder="alpha-cyclodextrin, a-CD, cyclohexaamylose"
                          aria-label="Edit synonyms and aliases"
                          className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                        />
                      </label>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="block text-xs text-zinc-600">
                          IUPAC / systematic name
                          <input
                            type="text"
                            value={editIupac}
                            onChange={(e) => setEditIupac(e.target.value)}
                            placeholder="Cyclohexaamylose"
                            aria-label="Edit IUPAC name"
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                          />
                        </label>
                        <label className="block text-xs text-zinc-600">
                          CAS number
                          <input
                            type="text"
                            value={editCas}
                            onChange={(e) => setEditCas(e.target.value)}
                            placeholder="10016-20-3"
                            aria-label="Edit CAS number"
                            spellCheck={false}
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                          />
                        </label>
                      </div>

                      <label className="block text-xs text-zinc-600">
                        Molecular Formula / Notes
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="Notes"
                          aria-label="Edit molecular formula or notes"
                          className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-fume-500 focus:outline-none"
                        />
                      </label>

                      {/* Structure preview + Paste / Upload / Clear controls */}
                      <div className="rounded border border-zinc-200 bg-white p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            {editImageDataUrl && !editClearStructure ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={editImageDataUrl}
                                alt=""
                                className="h-12 w-16 shrink-0 rounded border border-zinc-200 bg-white object-contain p-0.5"
                              />
                            ) : (
                              <span className="inline-flex h-10 items-center rounded border border-dashed border-zinc-200 px-2.5 text-[11px] text-zinc-400">
                                No structure saved
                              </span>
                            )}
                            <div className="text-xs text-zinc-600">
                              <span className="font-medium text-zinc-800">Saved Structure</span>
                              <span className="block text-[11px] text-zinc-400">
                                Paste from ChemDraw, upload a file, or edit SMILES/CDXML below
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            <input
                              ref={editFileRef}
                              type="file"
                              accept=".mol,.sdf,.cdxml,.smi,.smiles,.svg,.png,.jpg,image/*"
                              hidden
                              onChange={(e) => {
                                void handleEditStructureFile(e.target.files?.[0]);
                                e.target.value = "";
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => void handlePasteStructureForEdit()}
                              disabled={editBusy}
                              className="rounded border border-fume-300 bg-fume-50 px-2 py-1 text-[11px] font-medium text-fume-800 hover:bg-fume-100 disabled:opacity-50"
                              title="Paste structure from ChemDraw clipboard and recalculate MW"
                            >
                              Paste Structure
                            </button>
                            <button
                              type="button"
                              onClick={() => editFileRef.current?.click()}
                              disabled={editBusy}
                              className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                            >
                              Upload…
                            </button>
                            {(editImageDataUrl || editStructure.trim() || editCdxml) &&
                              !editClearStructure && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditClearStructure(true);
                                    setEditStructure("");
                                    setEditCdxml(undefined);
                                    setEditImageDataUrl(undefined);
                                  }}
                                  className="rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50"
                                >
                                  Clear Structure ×
                                </button>
                              )}
                          </div>
                        </div>

                        <textarea
                          value={editClearStructure ? "" : editStructure}
                          onChange={(e) => {
                            setEditClearStructure(false);
                            setEditStructure(e.target.value);
                            setEditImageDataUrl(undefined);
                            setEditCdxml(undefined);
                          }}
                          placeholder="SMILES, MOLfile, or CDXML"
                          aria-label="Edit structure text"
                          rows={2}
                          spellCheck={false}
                          className="mt-2 w-full resize-y rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px] text-zinc-700 placeholder:font-sans placeholder:text-zinc-400 focus:border-fume-500 focus:bg-white focus:outline-none"
                        />
                      </div>

                      {editError && (
                        <p role="alert" className="text-xs text-red-600">
                          {editError}
                        </p>
                      )}

                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEditing}
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={editBusy}
                          onClick={() => void handleSaveEdit(c.id)}
                          className="rounded-md bg-fume-600 px-3 py-1 text-xs font-semibold text-white shadow-2xs hover:bg-fume-700 disabled:opacity-50"
                        >
                          {editBusy ? "Saving…" : "Save Changes"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start gap-2.5">
                        {c.imageDataUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.imageDataUrl}
                            alt=""
                            className="mt-0.5 h-9 w-12 shrink-0 rounded border border-zinc-200/80 bg-white object-contain p-0.5"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : c.id)}
                          aria-expanded={expanded}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-zinc-900">
                              {c.name}
                            </span>
                            {c.structure && (
                              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                                {FORMAT_LABELS[c.format]}
                              </span>
                            )}
                            {(c.casNumber || (c.aliases && c.aliases.length > 0)) && (
                              <span className="shrink-0 rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-zinc-200">
                                {c.casNumber ? `CAS ${c.casNumber}` : ""}
                                {c.casNumber && c.aliases && c.aliases.length > 0 ? " · " : ""}
                                {c.aliases && c.aliases.length > 0
                                  ? `${c.aliases.length} ${c.aliases.length === 1 ? "alias" : "aliases"}`
                                  : ""}
                              </span>
                            )}
                          </span>
                          {describeProperties(c) && (
                            <span className="block truncate text-xs text-zinc-500">
                              {describeProperties(c)}
                            </span>
                          )}
                          {c.notes && (
                            <span className="block truncate text-xs text-zinc-500">
                              {c.notes}
                            </span>
                          )}
                          {c.format === "smiles" && c.structure && (
                            <span className="block truncate font-mono text-xs text-zinc-400">
                              {c.structure}
                            </span>
                          )}
                        </button>

                        {confirmId === c.id ? (
                          <span className="flex shrink-0 items-center gap-1.5 text-xs">
                            <button
                              type="button"
                              onClick={() => {
                                remove(c.id);
                                setConfirmId(null);
                              }}
                              className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmId(null)}
                              className="rounded-md border border-zinc-300 px-2 py-1 font-medium text-zinc-600 hover:bg-zinc-50"
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => startEditing(c)}
                              aria-label={`Edit ${c.name}`}
                              title={`Edit ${c.name}`}
                              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-fume-50 hover:text-fume-800"
                            >
                              ✎ Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmId(c.id)}
                              aria-label={`Delete ${c.name}`}
                              title={`Delete ${c.name}`}
                              className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                            >
                              <svg
                                viewBox="0 0 16 16"
                                className="size-4"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden
                              >
                                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                      {expanded && c.structure && (
                        <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-zinc-50 p-2 font-mono text-[11px] leading-snug text-zinc-600">
                          {c.structure}
                        </pre>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </dialog>
  );
}
