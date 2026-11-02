"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { Experiment } from "@/lib/types";

interface Props {
  experiments: Experiment[];
  selectedId: string | null;
  /** Mobile drawer. Desktop uses `collapsed` instead. */
  open: boolean;
  /** Desktop icon rail. The full experiment list is hidden until this is false. */
  collapsed: boolean;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onNew: () => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onImportExperiment: () => void;
  onOpenLibrary: () => void;
}

function PanelLeftIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      {open ? <path d="M16 9l-3 3 3 3" /> : <path d="M13 9l3 3-3 3" />}
    </svg>
  );
}

/** Header and notebook toolbar control for the sidebar. */
export function SidebarToggleButton({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={expanded ? "Close sidebar" : "Open sidebar"}
      title={expanded ? "Close sidebar (Ctrl+B)" : "Open sidebar (Ctrl+B)"}
      className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100"
    >
      <PanelLeftIcon open={expanded} />
    </button>
  );
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
  collapsed,
  onSelect,
  onClose,
  onNew,
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

      <style>{`
        @media (min-width: 64rem) {
          aside[data-collapsed="true"] { width: 3.5rem; }
          aside[data-collapsed="true"] [data-sidebar-full] { display: none; }
          aside[data-collapsed="true"] [data-sidebar-rail] { display: flex; }
        }
      `}</style>
      <aside
        data-collapsed={collapsed ? "true" : "false"}
        className={`fixed bottom-0 left-0 top-14 z-30 flex w-64 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white transition-all duration-200 print:hidden lg:sticky lg:bottom-auto lg:z-0 lg:h-[calc(100dvh-3.5rem)] lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Experiments"
      >
        <div data-sidebar-rail className={`hidden w-14 flex-col items-center gap-1 px-1.5 py-2`}>
          <RailButton label="Dashboard" active={selectedId === null} onClick={() => onSelect(null)}>
            <path d="M3 10.5 8 4l5 6.5" />
            <path d="M4.2 9.2V14h7.6V9.2" />
          </RailButton>
          <RailButton label="Personal Library" onClick={onOpenLibrary}>
            <path d="M3 2.5h7a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2v-9ZM3 11.5a2 2 0 0 1 2-2h7" />
          </RailButton>
          <RailButton label="New Experiment" onClick={onNew}>
            <path d="M8 3.5v9M3.5 8h9" />
          </RailButton>
          <RailButton label="Backup" onClick={onExportBackup}>
            <path d="M8 2v8M4.5 7 8 10.5 11.5 7M3 13h10" />
          </RailButton>
        </div>

        <div data-sidebar-full className="flex min-h-0 min-w-64 flex-1 flex-col">
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
        </div>
      </aside>
    </>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid size-9 place-items-center rounded-md ${
        active ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
      }`}
    >
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
