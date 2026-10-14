"use client";

import { useEffect, useRef, useState } from "react";
import { fileToDataUrl } from "@/lib/images";

interface Props {
  images: string[];
  onAdd: (images: string[]) => void;
  onRemove: (index: number) => void;
}

/**
 * TLC plates: drop, paste (Ctrl+V anywhere on the page) or browse for images.
 * Plates are shown side by side as vertical 2:3 cards.
 */
export default function TlcDropzone({ images, onAdd, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(files: File[]) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      if (files.length > 0) setError("Only image files can be added.");
      return;
    }
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(imageFiles.map(fileToDataUrl));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length > 0) onAdd(ok);
    if (ok.length < imageFiles.length) {
      setError(`${imageFiles.length - ok.length} image(s) could not be read (unsupported format?).`);
    }
    setBusy(false);
  }

  // Paste images from the clipboard (e.g. a screenshot or copied photo).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.defaultPrevented) return; // the molecule picture box already took it
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return; // plain-text paste: leave untouched
      e.preventDefault();
      void addFiles(files);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  return (
    <section className={images.length === 0 ? "print:hidden" : ""}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        TLC
      </h3>

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-5 text-center text-sm transition-colors print:hidden ${
          dragging
            ? "border-fume-500 bg-fume-50 text-fume-700"
            : "border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50"
        }`}
      >
        <span className="font-medium">
          {busy ? "Processing images…" : "Drop TLC plate images here"}
        </span>
        <span className="text-xs text-zinc-400">
          or click to browse, or paste with Ctrl+V
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = ""; // allow re-selecting the same file
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 print:hidden">
          {error}
        </p>
      )}

      {images.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-3 print:mt-0 print:gap-2">
          {images.map((src, i) => (
            <li
              key={i}
              className="group relative aspect-[2/3] w-36 break-inside-avoid overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 print:w-32 print:rounded-none print:border-zinc-300"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- user-provided data URLs */}
              <img
                src={src}
                alt={`TLC plate ${i + 1}`}
                className="size-full object-contain"
              />
              <button
                type="button"
                aria-label={`Remove TLC plate ${i + 1}`}
                onClick={() => onRemove(i)}
                className="absolute right-1 top-1 rounded-full bg-white/90 p-1 text-zinc-500 opacity-0 shadow-sm transition-opacity hover:text-red-600 focus:opacity-100 group-hover:opacity-100 print:hidden"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
