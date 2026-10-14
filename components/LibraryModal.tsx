"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  describeProperties,
  detectFormat,
  structureFromFile,
  useLibrary,
  type StructureFormat,
} from "@/lib/library";

const FORMAT_LABELS: Record<StructureFormat, string> = {
  smiles: "SMILES",
  mol: "MOL",
  cdxml: "CDXML",
};

/**
 * A typed number ("46.07", also "0,789" with a decimal comma) -> the number, `undefined` when
 * the field is empty, `null` when it is not a positive number.
 */
function parseOptionalNumber(text: string): number | undefined | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return undefined;
  const value = Number(t);
  return Number.isFinite(value) && value > 0 ? value : null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * "Personal Library": browse, add and delete your own compounds (stored in
 * Documents/Fumebook/library.json). Mounted only while open, so every opening starts fresh.
 */
export default function LibraryModal(props: Props) {
  return props.open ? <LibraryDialog onClose={props.onClose} /> : null;
}

const MAX_STRUCTURE_FILE_BYTES = 1_000_000;

function LibraryDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { compounds, error: libraryError, add, remove } = useLibrary();

  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [structure, setStructure] = useState("");
  /** Name of the file the structure came from (a `.cdxml` name marks the text as CDXML). */
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [mwText, setMwText] = useState("");
  const [densityText, setDensityText] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  /** Id of the compound whose delete button was pressed once ("Sure?" state). */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Native <dialog>: focus trap, Esc to close and the backdrop come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!compounds) return [];
    return q
      ? compounds.filter((c) => c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q))
      : compounds;
  }, [compounds, query]);

  const detected = structure.trim() ? detectFormat(structure, fileName) : null;

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const mw = parseOptionalNumber(mwText);
    const density = parseOptionalNumber(densityText);
    if (mw === null) return setFormError("Molecular weight must be a positive number, e.g. 46.07.");
    if (density === null) return setFormError("Density must be a positive number, e.g. 0.789.");

    const result = add({ name, structure, notes, mw, density, fileName });
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormError(null);
    setName("");
    setStructure("");
    setFileName(undefined);
    setMwText("");
    setDensityText("");
    setNotes("");
  }

  async function handleStructureFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_STRUCTURE_FILE_BYTES) {
      setFormError("That file is too large to be a single structure.");
      return;
    }
    try {
      const { structure: text, note } = structureFromFile(file.name, await file.text());
      setStructure(text);
      setFileName(file.name);
      // Name the compound after the file when no name was typed yet.
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
      setFormError(note ?? null);
    } catch {
      setFormError("The file could not be read.");
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

        {/* Add a compound */}
        <form onSubmit={handleAdd} className="mt-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Add a compound
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. 3-methylpropanol"
            aria-label="Compound name"
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <textarea
            value={structure}
            onChange={(e) => setStructure(e.target.value)}
            placeholder="SMILES (e.g. CC(C)CO), or paste a MOLfile or CDXML"
            aria-label="Structure (SMILES, MOLfile or CDXML)"
            rows={structure.includes("\n") ? 6 : 2}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs placeholder:font-sans placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <input
              ref={fileRef}
              type="file"
              accept=".mol,.sdf,.cdxml,.smi,.smiles,.txt,chemical/x-mdl-molfile"
              hidden
              onChange={(e) => {
                void handleStructureFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Choose file (.mol, .sdf, .cdxml)…
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
                placeholder="e.g. 46.07"
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
                placeholder="liquids, e.g. 0.789"
                aria-label="Density (g/mL), optional"
                className="mt-0.5 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
            </label>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional): supplier, CAS, hazards…"
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
              className="shrink-0 rounded-md bg-fume-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-700 disabled:opacity-50"
            >
              Add to library
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
              placeholder="Search…"
              aria-label="Search the library"
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
              return (
                <li key={c.id} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : c.id)}
                      aria-expanded={expanded}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-900">{c.name}</span>
                        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                          {FORMAT_LABELS[c.format]}
                        </span>
                      </span>
                      {describeProperties(c) && (
                        <span className="block truncate text-xs text-zinc-500">{describeProperties(c)}</span>
                      )}
                      {c.notes && <span className="block truncate text-xs text-zinc-500">{c.notes}</span>}
                      {c.format === "smiles" && (
                        <span className="block truncate font-mono text-xs text-zinc-400">{c.structure}</span>
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
                      <button
                        type="button"
                        onClick={() => setConfirmId(c.id)}
                        aria-label={`Delete ${c.name}`}
                        className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-zinc-50 p-2 font-mono text-[11px] leading-snug text-zinc-600">
                      {c.structure}
                    </pre>
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
