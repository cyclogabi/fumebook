"use client";

import { useMemo, useState } from "react";
import type { Experiment } from "@/lib/types";

interface Props {
  experiments: Experiment[];
  selectedId: string | null;
  open: boolean;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onImportExperiment: () => void;
  onOpenLibrary: () => void;
}

/** Sort GH experiments newest first by their numeric suffix. */
export function sortExperiments(list: Experiment[]): Experiment[] {
  const key = (e: Experiment) => parseInt(e.id.replace(/\D/g, ""), 10) || 0;
  return [...list].sort((a, b) => key(b) - key(a) || b.dateCreated.localeCompare(a.dateCreated));
}

export default function Sidebar({
  experiments,
  selectedId,
  open,
  onSelect,
  onClose,
  onExportBackup,
  onImportBackup,
  onImportExperiment,
  onOpenLibrary,
}: Props) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = sortExperiments(experiments);
    return q
      ? sorted.filter((e) => e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
      : sorted;
  }, [experiments, query]);

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 top-14 z-20 bg-zinc-900/30 lg:hidden print:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={`fixed bottom-0 left-0 top-14 z-30 flex w-72 flex-col border-r border-zinc-200 bg-white transition-transform lg:sticky lg:bottom-auto lg:z-0 lg:h-[calc(100dvh-3.5rem)] lg:translate-x-0 print:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Experiments"
      >
        <div className="space-y-2 border-b border-zinc-200 p-3">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm font-medium ${
              selectedId === null ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            Dashboard
          </button>
          <button
            type="button"
            onClick={() => onOpenLibrary()}
            title="Your saved compounds (SMILES / MOLfile / CDXML)"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-zinc-600 hover:bg-zinc-50"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 2.5h7a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2v-9ZM3 11.5a2 2 0 0 1 2-2h7" />
            </svg>
            Personal Library
          </button>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ID or title…"
            aria-label="Search experiments"
            className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:bg-white focus:outline-none"
          />
        </div>

        <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Experiments ({experiments.length})
        </p>

        <ul className="flex-1 overflow-y-auto px-2 pb-3">
          {visible.length === 0 && (
            <li className="px-2 py-4 text-sm text-zinc-400">
              {experiments.length === 0 ? "No experiments yet." : "No matches."}
            </li>
          )}
          {visible.map((exp) => {
            const active = exp.id === selectedId;
            return (
              <li key={exp.id}>
                <button
                  type="button"
                  onClick={() => onSelect(exp.id)}
                  aria-current={active ? "page" : undefined}
                  className={`block w-full rounded-md px-2.5 py-2 text-left ${
                    active ? "bg-fume-50 ring-1 ring-fume-200" : "hover:bg-zinc-50"
                  }`}
                >
                  <span className="block font-mono text-xs font-semibold text-zinc-900">
                    {exp.id}
                  </span>
                  <span className="block truncate text-sm text-zinc-600">
                    {exp.title || <span className="italic text-zinc-400">Untitled</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Data safety */}
        <div className="border-t border-zinc-200 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Backup
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onImportExperiment}
              title="Import one experiment (.json) with its molecule picture, TLC photos and NMR spectra"
              className="col-span-2 flex items-center justify-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13h10" />
              </svg>
              Import Experiment (.json)
            </button>
            <button
              type="button"
              onClick={onExportBackup}
              disabled={experiments.length === 0}
              title="Save all experiments, pictures, TLC photos, NMR data and your library to one JSON file"
              className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 2v8M4.5 7 8 10.5 11.5 7M3 13h10" />
              </svg>
              Export Full Backup
            </button>
            <button
              type="button"
              onClick={onImportBackup}
              title="Restore experiments, pictures, NMR data and the library from a full backup"
              className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13h10" />
              </svg>
              Import Full Backup
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
