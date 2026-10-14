"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MAX_BACKUP_BYTES, parseBackup, type ValidBackup } from "@/lib/backup";
import { pickJsonFile } from "@/lib/fileDialogs";
import type { Experiment } from "@/lib/types";

export type ImportMode = "merge" | "replace";

interface Props {
  open: boolean;
  /** Experiments currently in this notebook. */
  experiments: Experiment[];
  onClose: () => void;
  /**
   * Apply the chosen import (experiments, their molecule pictures / TLC photos / NMR workspaces, the
   * Personal Library and profile). The parent takes the safety copy when asked to, updates storage
   * and shows the confirmation toast.
   */
  onImport: (mode: ImportMode, parsed: ValidBackup, options: { safetyBackup: boolean }) => void;
}

/**
 * Import-backup dialog: pick (or drop) a backup .json, review what it contains,
 * then Merge or Replace All. The content is only mounted while open, so every
 * opening starts fresh.
 */
export default function BackupModal(props: Props) {
  return props.open ? <ImportDialog {...props} /> : null;
}

function ImportDialog({ experiments: current, onClose, onImport }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ValidBackup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [safetyBackup, setSafetyBackup] = useState(true);

  // Native <dialog>: focus trap, Esc to close and the backdrop come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const hasExisting = current.length > 0;

  const rows = useMemo(() => {
    if (!parsed) return [];
    const existing = new Set(current.map((e) => e.id.toUpperCase()));
    return parsed.experiments.map((exp) => ({ exp, exists: existing.has(exp.id.toUpperCase()) }));
  }, [parsed, current]);
  const existingCount = rows.filter((r) => r.exists).length;
  const newCount = rows.length - existingCount;

  /** Review the text of a chosen file (the same for the native Open dialog and a dropped file). */
  function review(name: string, text: string) {
    setFileName(name);
    if (text.length > MAX_BACKUP_BYTES) {
      setError("This file is too large to be a Fumebook backup.");
      return;
    }
    const result = parseBackup(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setParsed(result);
  }

  function reset() {
    setError(null);
    setParsed(null);
    setConfirmReplace(false);
  }

  /** A file dropped onto the dialog (plain browser; the desktop window does not receive drops). */
  async function handleFile(file: File | undefined) {
    if (!file) return;
    reset();
    setFileName(file.name);

    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      setError("Please choose a .json backup file.");
      return;
    }
    setReading(true);
    try {
      review(file.name, await file.text());
    } catch {
      setError("The file could not be read.");
    } finally {
      setReading(false);
    }
  }

  /** The native Windows "Open" dialog on the desktop, the browser's file picker otherwise. */
  async function chooseFile() {
    setReading(true);
    try {
      const picked = await pickJsonFile();
      if (picked) {
        reset();
        review(picked.name, picked.text);
      }
    } catch (err) {
      reset();
      setError(err instanceof Error ? err.message : "The file could not be read.");
    } finally {
      setReading(false);
    }
  }

  function runMerge() {
    if (parsed) onImport("merge", parsed, { safetyBackup: false });
  }

  function runReplace() {
    if (!parsed) return;
    // The parent takes the safety copy of what is about to be wiped, and stops if it cannot.
    onImport("replace", parsed, { safetyBackup: safetyBackup && hasExisting });
  }

  const importable = parsed?.experiments.length ?? 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-900/40 print:hidden"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              Import backup
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Restore experiments from an ELN backup file (full backup or a single experiment).
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

        {/* Step 1: choose a file */}
        {!parsed && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void handleFile(e.dataTransfer.files[0]);
            }}
            className={`mt-5 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging ? "border-fume-400 bg-fume-50" : "border-zinc-300 bg-zinc-50/60"
            }`}
          >
            <p className="text-sm text-zinc-600">
              {reading ? "Reading file…" : "Choose a Fumebook backup .json file"}
            </p>
            <button
              type="button"
              onClick={() => void chooseFile()}
              disabled={reading}
              className="mt-3 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
            >
              Choose file…
            </button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {fileName && <span className="font-medium">{fileName}: </span>}
            {error}
          </div>
        )}

        {/* Step 2: review */}
        {parsed && (
          <div className="mt-5 space-y-4">
            <div className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-zinc-900">{fileName}</p>
                <p className="text-xs text-zinc-500">
                  Backup format v{parsed.version}
                  {parsed.exportedAt && ` · exported ${formatExported(parsed.exportedAt)}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void chooseFile()}
                className="shrink-0 text-xs font-medium text-fume-700 hover:underline"
              >
                Choose another file
              </button>
            </div>

            <p className="text-sm text-zinc-700">
              <span className="font-semibold">
                {importable} experiment{importable === 1 ? "" : "s"}
              </span>{" "}
              found
              {hasExisting && importable > 0 && (
                <span className="text-zinc-500">
                  {" "}
                  - {newCount} new, {existingCount} already here (matched by ID)
                </span>
              )}
              .
            </p>
            {importable > 0 && <p className="-mt-2 text-xs text-zinc-500">{describeContents(parsed)}</p>}

            {importable > 0 && (
              <ul className="max-h-40 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
                {rows.map(({ exp, exists }) => (
                  <li key={exp.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className="w-20 shrink-0 font-mono text-xs font-semibold">{exp.id}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-600">
                      {exp.title || <span className="italic text-zinc-400">Untitled</span>}
                    </span>
                    {hasExisting && (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          exists ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {exists ? "Exists" : "New"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {(parsed.skipped.length > 0 || parsed.duplicatesInFile > 0) && (
              <details open={importable === 0} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <summary className="cursor-pointer font-medium">
                  {parsed.skipped.length > 0
                    ? `${parsed.skipped.length} invalid entr${parsed.skipped.length === 1 ? "y was" : "ies were"} skipped`
                    : "Duplicate IDs in the file"}
                </summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs">
                  {parsed.skipped.slice(0, 20).map((s) => (
                    <li key={s.label}>
                      {s.label}: {s.reason}
                    </li>
                  ))}
                  {parsed.skipped.length > 20 && <li>…and {parsed.skipped.length - 20} more</li>}
                  {parsed.duplicatesInFile > 0 && (
                    <li>
                      {parsed.duplicatesInFile} duplicate ID{parsed.duplicatesInFile === 1 ? "" : "s"} in the
                      file - only the last copy of each is used
                    </li>
                  )}
                </ul>
              </details>
            )}

            {/* Step 3: choose how to import */}
            {importable === 0 ? (
              <p className="text-sm text-zinc-500">There is nothing valid to import from this file.</p>
            ) : !hasExisting ? (
              <button
                type="button"
                onClick={runMerge}
                className="w-full rounded-md bg-fume-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-fume-600"
              >
                Import {importable} experiment{importable === 1 ? "" : "s"}
              </button>
            ) : (
              <div className="space-y-3">
                <section className="rounded-lg border border-zinc-200 p-3.5">
                  <h3 className="text-sm font-semibold">Merge</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Adds new experiments and updates existing ones with the same ID. Experiments that are not
                    in the file are kept.
                  </p>
                  <button
                    type="button"
                    onClick={runMerge}
                    className="mt-3 rounded-md bg-fume-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-600"
                  >
                    Merge
                  </button>
                </section>

                <section className="rounded-lg border border-red-200 bg-red-50/40 p-3.5">
                  <h3 className="text-sm font-semibold text-red-800">Replace All</h3>
                  <p className="mt-0.5 text-xs text-zinc-600">
                    Deletes all {current.length} experiment{current.length === 1 ? "" : "s"} currently in this
                    browser and restores the backup instead.
                  </p>
                  <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-zinc-700">
                    <input
                      type="checkbox"
                      checked={safetyBackup}
                      onChange={(e) => setSafetyBackup(e.target.checked)}
                      className="size-3.5 rounded border-zinc-300 accent-fume-600"
                    />
                    Save a safety copy of my current data first (Documents/Fumebook/backups; recommended)
                  </label>
                  {confirmReplace ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={runReplace}
                        className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
                      >
                        Yes, replace everything
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmReplace(false)}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
                      >
                        Cancel
                      </button>
                      <span className="text-xs text-red-700">This cannot be undone.</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmReplace(true)}
                      className="mt-3 rounded-md border border-red-300 bg-white px-4 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"
                    >
                      Replace All
                    </button>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end border-t border-zinc-100 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** What besides the experiment texts the file carries, e.g. "Includes 3 TLC photos, 2 molecule pictures, 1 NMR workspace and 12 library compounds." */
function describeContents(parsed: ValidBackup): string {
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tlc = parsed.experiments.reduce((sum, e) => sum + e.tlcImages.length, 0);
  const attachments = Object.values(parsed.attachments);
  const pictures = attachments.filter((a) => a.moleculeImageBase64).length;
  const nmr = attachments.filter((a) => a.nmrWorkspace).length;
  const parts: string[] = [];
  if (tlc > 0) parts.push(count(tlc, "TLC photo"));
  if (pictures > 0) parts.push(count(pictures, "molecule picture"));
  if (nmr > 0) parts.push(count(nmr, "NMR workspace"));
  if (parsed.library && parsed.library.length > 0) parts.push(count(parsed.library.length, "library compound"));
  if (parts.length === 0) return "No attachments in this file.";
  return `Includes ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`;
}

function formatExported(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
