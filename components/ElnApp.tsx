"use client";

import { useCallback, useRef, useState } from "react";
import BackupModal, { type ImportMode } from "./BackupModal";
import Dashboard from "./Dashboard";
import ExperimentEditor from "./ExperimentEditor";
import FumebookLogo from "./FumebookLogo";
import ParseProtocolModal from "./ParseProtocolModal";
import Sidebar from "./Sidebar";
import Toast, { type ToastMessage } from "./Toast";
import {
  describeMerge,
  describeReplace,
  downloadBackup,
  downloadExperiment,
  mergeExperiments,
} from "@/lib/backup";
import { toReagentRows } from "@/lib/protocol";
import type { ParsedProtocol } from "@/lib/protocolSchema";
import { useExperiments } from "@/lib/storage";
import type { Experiment } from "@/lib/types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function ElnApp() {
  const { experiments, storageError, create, update, remove, replaceAll } = useExperiments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [parseOpen, setParseOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const loaded = experiments !== null;
  const selected = experiments?.find((e) => e.id === selectedId) ?? null;

  const notify = useCallback((kind: ToastMessage["kind"], message: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, kind, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // --- Backup / restore -------------------------------------------------------

  function handleExportAll() {
    if (!experiments || experiments.length === 0) return;
    try {
      const filename = downloadBackup(experiments);
      notify("success", `Exported ${plural(experiments.length, "experiment")} to ${filename}.`);
    } catch {
      notify("error", "The backup could not be created.");
    }
  }

  function handleExportOne() {
    if (!selected) return;
    try {
      const filename = downloadExperiment(selected);
      notify("success", `Exported ${selected.id} to ${filename}.`);
    } catch {
      notify("error", `${selected.id} could not be exported.`);
    }
  }

  function openImport() {
    setDrawerOpen(false);
    setImportOpen(true);
  }

  function handleImport(mode: ImportMode, incoming: Experiment[]) {
    const current = experiments ?? [];
    let next: Experiment[];
    let message: string;

    if (mode === "merge") {
      const result = mergeExperiments(current, incoming);
      next = result.experiments;
      message = describeMerge(result);
    } else {
      next = incoming;
      message = describeReplace(incoming.length, current.length);
    }

    const saved = replaceAll(next);
    setImportOpen(false);
    // The open experiment may no longer exist after a replace.
    if (selectedId && !next.some((e) => e.id === selectedId)) setSelectedId(null);

    notify(
      saved ? "success" : "error",
      saved
        ? message
        : `${message} But browser storage is full, so they are NOT saved and will be lost on reload. Export a backup now.`,
    );
  }

  function select(id: string | null) {
    setSelectedId(id);
    setDrawerOpen(false);
  }

  function handleNew() {
    const created = create();
    select(created.id);
  }

  function handleParsed(parsed: ParsedProtocol, sourceText: string) {
    const reagents = toReagentRows(parsed);
    if (reagents.length === 0) {
      notify("error", "No usable reagents were found in that text.");
      return;
    }
    const created = create();
    // Keep the source text in the Procedure so the extracted values can be checked against it.
    update(created.id, { reagents, procedureText: sourceText });
    setParseOpen(false);
    select(created.id);
    notify(
      "success",
      `Created ${created.id} with ${plural(reagents.length, "reagent")}. Please check the values.`,
    );
  }

  function handleDelete() {
    if (!selected) return;
    const label = selected.title ? `${selected.id} - ${selected.title}` : selected.id;
    if (!window.confirm(`Delete experiment ${label}? This cannot be undone.`)) return;
    remove(selected.id);
    select(null);
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-100 text-zinc-900 print:block print:min-h-0 print:bg-white">
      {/* Header */}
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 print:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen((o) => !o)}
          aria-label="Toggle experiment list"
          className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 lg:hidden"
        >
          <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => select(null)}
          className="flex items-center gap-2 text-left"
        >
          <FumebookLogo className="size-8" />
          <span className="text-base font-bold tracking-tight text-fume-600">Fumebook</span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setParseOpen(true)}
            disabled={!loaded}
            title="Paste experimental text from a paper and fill in the reagents automatically"
            className="rounded-md border border-fume-300 bg-fume-50 px-4 py-2 text-sm font-semibold text-fume-700 shadow-sm transition-colors hover:bg-fume-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fume-500 disabled:opacity-50"
          >
            ✨ Parse Protocol
          </button>
          <button
            type="button"
            onClick={handleNew}
            disabled={!loaded}
            className="flex items-center justify-center gap-2 rounded-lg border border-cyan-300 bg-[#E0FFFF] px-4 py-2 font-medium text-zinc-900 shadow-sm hover:bg-[#C6F2F2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:opacity-50"
          >
            + New Experiment
          </button>
        </div>
      </header>

      {storageError && (
        <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 print:hidden">
          {storageError}
        </div>
      )}

      <div className="flex flex-1 print:block">
        {loaded && (
          <Sidebar
            experiments={experiments}
            selectedId={selected?.id ?? null}
            open={drawerOpen}
            onSelect={select}
            onClose={() => setDrawerOpen(false)}
            onExportBackup={handleExportAll}
            onImportBackup={openImport}
          />
        )}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8 print:p-0">
          {!loaded ? (
            <p className="text-sm text-zinc-400">Loading notebook…</p>
          ) : selected ? (
            // key: reset editor-local state (focus, drafts) when switching experiments
            <ExperimentEditor
              key={selected.id}
              experiment={selected}
              onUpdate={(change) => update(selected.id, change)}
              onDelete={handleDelete}
              onExport={handleExportOne}
            />
          ) : (
            <Dashboard
              experiments={experiments}
              onOpen={select}
              onNew={handleNew}
              onParse={() => setParseOpen(true)}
              onImportBackup={openImport}
            />
          )}
        </main>
      </div>

      <BackupModal
        open={importOpen}
        experiments={experiments ?? []}
        onClose={() => setImportOpen(false)}
        onImport={handleImport}
      />
      <ParseProtocolModal
        open={parseOpen}
        onClose={() => setParseOpen(false)}
        onParsed={handleParsed}
      />
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
