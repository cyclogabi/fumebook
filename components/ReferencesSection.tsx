"use client";

import { useState, type FormEvent } from "react";
import { buildReference, cleanDoi, referenceHref } from "@/lib/references";
import type { Reference } from "@/lib/types";

interface Props {
  references: Reference[];
  onAdd: (reference: Reference) => void;
  onRemove: (id: string) => void;
}

const inputClass =
  "w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 " +
  "placeholder:text-zinc-300 hover:border-zinc-300 focus:border-fume-500 focus:outline-none";

/**
 * Literature references for an experiment. Stores text and links only
 * (never PDFs) so the notebook stays well inside the localStorage quota.
 */
export default function ReferencesSection({ references, onAdd, onRemove }: Props) {
  const [title, setTitle] = useState("");
  const [doi, setDoi] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const ref = buildReference({ title, doi, url });
    if (!ref) {
      setError("Enter a title, a DOI or a link.");
      return;
    }
    onAdd(ref);
    setTitle("");
    setDoi("");
    setUrl("");
    setError(null);
  }

  return (
    <section className="print:break-inside-avoid">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        References
      </h2>

      {references.length === 0 ? (
        <p className="mb-3 text-sm text-zinc-400 print:hidden">No references yet.</p>
      ) : (
        <ol className="mb-3 space-y-1.5">
          {references.map((ref, i) => {
            const href = referenceHref(ref);
            const doiText = cleanDoi(ref.doi);
            return (
              <li key={ref.id} className="group flex items-start gap-2 text-sm text-zinc-800">
                <span className="w-6 shrink-0 pt-px text-right font-mono text-xs text-zinc-400">
                  [{i + 1}]
                </span>
                <div className="min-w-0 flex-1">
                  <span className="break-words font-medium">
                    {ref.title || doiText || ref.url}
                  </span>
                  {doiText && ref.title && (
                    <span className="ml-2 font-mono text-xs text-zinc-500">DOI: {doiText}</span>
                  )}
                  {href && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-xs font-medium text-fume-700 hover:underline print:hidden"
                    >
                      Open ↗
                    </a>
                  )}
                  {/* Paper has no hyperlinks: print the address instead. */}
                  {href && (
                    <span className="hidden break-all font-mono text-[10px] text-zinc-500 print:block">
                      {href}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(ref.id)}
                  aria-label={`Remove reference ${i + 1}`}
                  title="Remove reference"
                  className="rounded p-1 text-zinc-300 hover:bg-red-50 hover:text-red-600 focus-visible:text-red-600 print:hidden"
                >
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <form
        onSubmit={handleAdd}
        className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 p-3 print:hidden"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title, e.g. Williamson ether synthesis, J. Chem. Soc. 1852"
            aria-label="Reference title"
            className={`${inputClass} sm:col-span-2`}
          />
          <input
            value={doi}
            onChange={(e) => setDoi(e.target.value)}
            placeholder="DOI, e.g. 10.1021/ja01234a001"
            aria-label="Reference DOI"
            className={`${inputClass} font-mono`}
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Link (https://…)"
            aria-label="Reference link"
            inputMode="url"
            className={inputClass}
          />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-fume-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-fume-500"
          >
            + Add reference
          </button>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <p className="ml-auto text-[11px] text-zinc-400">Text and links only, no PDFs.</p>
        </div>
      </form>
    </section>
  );
}
