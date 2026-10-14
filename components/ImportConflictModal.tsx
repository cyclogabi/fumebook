"use client";

import { useEffect, useId, useRef } from "react";

export interface ImportConflict {
  /** ID of the experiment in the file, which already exists in the notebook. */
  id: string;
  title: string;
  fileName: string;
}

interface Props {
  conflict: ImportConflict | null;
  /** The ID the "import as new" choice would give the experiment. */
  newId: string;
  onOverwrite: () => void;
  onImportAsNew: () => void;
  onCancel: () => void;
}

/** "GH001 already exists": replace it, or keep both by importing under a fresh ID. */
export default function ImportConflictModal(props: Props) {
  return props.conflict ? <Dialog {...props} conflict={props.conflict} /> : null;
}

function Dialog({
  conflict,
  newId,
  onOverwrite,
  onImportAsNew,
  onCancel,
}: Props & { conflict: ImportConflict }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onCancel}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-900/40 print:hidden"
    >
      <div className="p-5 sm:p-6">
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          <span className="font-mono">{conflict.id}</span> already exists
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          <span className="font-medium">{conflict.fileName}</span> contains an experiment with the same ID
          {conflict.title ? ` (“${conflict.title}”)` : ""}. What should happen?
        </p>

        <div className="mt-4 space-y-3">
          <section className="rounded-lg border border-zinc-200 p-3.5">
            <h3 className="text-sm font-semibold">Import as a new experiment</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              Keeps the existing {conflict.id} and adds the imported one as{" "}
              <span className="font-mono font-semibold">{newId}</span>.
            </p>
            <button
              type="button"
              onClick={onImportAsNew}
              className="mt-3 rounded-md bg-fume-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-600"
            >
              Import as {newId}
            </button>
          </section>

          <section className="rounded-lg border border-red-200 bg-red-50/40 p-3.5">
            <h3 className="text-sm font-semibold text-red-800">Overwrite {conflict.id}</h3>
            <p className="mt-0.5 text-xs text-zinc-600">
              Replaces the existing experiment, including its molecule picture and NMR workspace, with the
              imported one. This cannot be undone.
            </p>
            <button
              type="button"
              onClick={onOverwrite}
              className="mt-3 rounded-md border border-red-300 bg-white px-4 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"
            >
              Overwrite
            </button>
          </section>
        </div>

        <div className="mt-5 flex justify-end border-t border-zinc-100 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
