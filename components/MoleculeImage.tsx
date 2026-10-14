"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { imageFileToPng } from "@/lib/images";
import { loadMoleculeImage, removeMoleculeImage, saveMoleculeImage } from "@/lib/storage";

interface Props {
  experimentId: string;
  /** The experiment says a picture was saved (`molecule.png`). */
  hasImage: boolean;
  onHasImageChange: (hasImage: boolean) => void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Upload Image" mode of the molecule section: drop (or browse for) a picture of the structure.
 * It is converted to PNG and saved as `attachments/[id]/molecule.png`, then shown in place of the
 * sketcher.
 */
export default function MoleculeImage({ experimentId, hasImage, onHasImageChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(hasImage);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Show `blob` (or nothing). One object URL at a time; the previous one is released. */
  function show(blob: Blob | null) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = blob ? URL.createObjectURL(blob) : null;
    setUrl(urlRef.current);
  }
  const showRef = useRef(show);
  useEffect(() => {
    showRef.current = show;
  });

  // Release the object URL when the section closes.
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  // Read the saved picture once when the section opens.
  useEffect(() => {
    if (!hasImage) return;
    let cancelled = false;
    loadMoleculeImage(experimentId)
      .then((saved) => {
        if (cancelled) return;
        showRef.current(saved);
        if (!saved) setError("The saved image could not be found. Drop it again to replace it.");
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not load the saved image: ${messageOf(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Only the initial read: later changes come from our own save / remove below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experimentId]);

  async function addFile(files: File[]) {
    const file = files.find((f) => f.type.startsWith("image/")) ?? null;
    if (!file) {
      if (files.length > 0) setError("Only image files can be used here (PNG, JPEG, SVG, ...).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const png = await imageFileToPng(file);
      await saveMoleculeImage(experimentId, png);
      show(png);
      onHasImageChange(true);
    } catch (err) {
      setError(`The image could not be saved: ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Ctrl+V of a picture copied elsewhere (ChemDraw's Ctrl+C puts a bitmap on the clipboard).
  // This section only exists in "Upload Image" mode, so the listeners live exactly as long.
  //
  // The TLC box also takes pasted pictures, so only one of the two may act. It goes to whichever
  // the user last clicked in; before any click, to this section while it is still empty.
  // Capture phase plus `preventDefault` makes us win over the TLC box's own listener.
  const addFileRef = useRef(addFile);
  const hasPictureRef = useRef(false);
  useEffect(() => {
    addFileRef.current = addFile;
    hasPictureRef.current = url !== null;
  });
  useEffect(() => {
    const sectionOf = () => rootRef.current?.closest("section") ?? null;
    let clickedHere: boolean | null = null;
    const onPointerDown = (event: PointerEvent) => {
      clickedHere = event.target instanceof Node && (sectionOf()?.contains(event.target) ?? false);
    };
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement);
      // Leave pastes into fields alone, and anything happening behind a dialog (e.g. the NMR room).
      if (typing || document.querySelector('[aria-modal="true"]')) return;
      if (!(clickedHere ?? !hasPictureRef.current)) return;
      const items = Array.from(event.clipboardData?.items ?? []).filter((i) => i.kind === "file");
      const item =
        items.find((i) => i.type === "image/png") ?? items.find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void addFileRef.current([file]); // converted to PNG and saved as molecule.png
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("paste", onPaste, true);
    };
  }, []);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await removeMoleculeImage(experimentId);
      show(null);
      onHasImageChange(false);
    } catch (err) {
      setError(`The image could not be removed: ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void addFile(Array.from(e.dataTransfer.files));
    },
  };

  const showImage = url !== null;

  return (
    <div ref={rootRef}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void addFile(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow picking the same file again
        }}
      />

      {showImage ? (
        <div
          {...dropProps}
          className={`relative flex min-h-48 items-center justify-center rounded-md border bg-white p-3 print:border-0 print:p-0 ${
            dragging ? "border-fume-500 bg-fume-50" : "border-zinc-200"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob URL */}
          <img
            src={url}
            alt="Molecule"
            className="max-h-[110mm] max-w-full object-contain print:max-h-[110mm]"
          />
          <div className="absolute right-2 top-2 flex gap-1.5 print:hidden">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-xs font-medium text-red-600 shadow-sm hover:bg-red-50 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          {...dropProps}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={`flex h-48 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm transition-colors print:hidden ${
            dragging
              ? "border-fume-500 bg-fume-50 text-fume-700"
              : "border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50"
          }`}
        >
          <span className="font-medium">
            {loading ? "Loading image…" : busy ? "Saving image…" : "Drop a picture of the molecule here"}
          </span>
          <span className="text-xs text-zinc-400">
            or click to browse (PNG, JPEG, SVG…), or paste a copied picture with Ctrl+V
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 print:hidden">
          {error}
        </p>
      )}
    </div>
  );
}
