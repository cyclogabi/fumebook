"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import BackupModal, { type ImportMode } from "./BackupModal";
import Dashboard from "./Dashboard";
import ExperimentEditor from "./ExperimentEditor";
import ImportConflictModal from "./ImportConflictModal";
import LibraryModal, { type LibraryDraft } from "./LibraryModal";
import OnboardingModal from "./OnboardingModal";
import { LabTimerEngine } from "./LabWidgetsBar";
import ParseProtocolModal from "./ParseProtocolModal";
import Sidebar, { SidebarToggleButton } from "./Sidebar";
import Toast, { type ToastMessage } from "./Toast";
import {
  backupFilename,
  buildExperimentBundle,
  buildFullBackup,
  describeMerge,
  describeReplace,
  experimentFilename,
  mergeExperiments,
  parseBackup,
  preRestoreFilename,
  restoreAttachments,
  type ExperimentAttachments,
  type ValidBackup,
} from "@/lib/backup";
import { installClipboardBridge } from "@/lib/clipboard";
import { probeLocalAi } from "@/lib/localAi";
import { pickJsonFile, saveJsonFile, saveJsonToBackupsFolder } from "@/lib/fileDialogs";
import { getLibraryCompounds, mergeLibraryCompounds } from "@/lib/library";
import { applyParsedLibrary } from "@/lib/libraryMatch";
import { toReagentRows } from "@/lib/protocol";
import type { ParsedProtocol } from "@/lib/protocolSchema";
import { readInitials, saveProfile, useSavedInitials, useSavedStartNumber } from "@/lib/initials";
import { flushPendingSaves, useExperiments } from "@/lib/storage";
import { ID_PREFIX, nextExperimentId, type Experiment, type StructuredReactionScheme } from "@/lib/types";

const SIDEBAR_KEY = "fumebook_sidebar_collapsed_v1";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Toasts that carry a file path stay long enough to read (and copy) it. */
const PATH_TOAST_MS = 20_000;

/** "2 TLC photos, a molecule picture and an NMR workspace", for the confirmation toasts. */
function describeAttachments(
  tlc: number,
  attachments: { moleculeImageBase64: string | null; nmrWorkspace: string | null } | null,
): string {
  const parts: string[] = [];
  if (tlc > 0) parts.push(plural(tlc, "TLC photo"));
  if (attachments?.moleculeImageBase64) parts.push("a molecule picture");
  if (attachments?.nmrWorkspace) parts.push("an NMR workspace");
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** An experiment file chosen in "Import Experiment" whose ID is already in the notebook. */
interface PendingImport {
  experiment: Experiment;
  attachments: ExperimentAttachments | null;
  fileName: string;
}

export default function ElnApp() {
  const { experiments, storageError, create, update, remove, replaceAll } = useExperiments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [wideScreen, setWideScreen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [parseOpen, setParseOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryDraft, setLibraryDraft] = useState<LibraryDraft | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  /** Bumped after an import so an open editor reloads the pictures / NMR / scheme it read earlier. */
  const [importEpoch, setImportEpoch] = useState(0);
  /** One export / import at a time: a second click while a dialog is open does nothing. */
  const busyRef = useRef(false);

  const initials = useSavedInitials();

  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
    const media = window.matchMedia("(min-width: 1024px)");
    const apply = () => setWideScreen(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const sidebarExpanded = wideScreen ? !sidebarCollapsed : drawerOpen;

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setSidebarCollapsed((collapsed) => {
        const next = !collapsed;
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
        return next;
      });
      return;
    }
    setDrawerOpen((open) => !open);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      // Cmd+S / Ctrl+S: the notebook is already autosaved. Stop WebKit's "Save Page" dialog
      // and write anything still waiting on the short persist timer.
      if (key === "s" || event.code === "KeyS") {
        event.preventDefault();
        void flushPendingSaves().catch(() => {});
        return;
      }
      // Cmd+P / Ctrl+P: the system print sheet (Save as PDF on macOS).
      if (!event.shiftKey && (key === "p" || event.code === "KeyP")) {
        event.preventDefault();
        window.print();
        return;
      }
      if (event.shiftKey) return;
      const toggle = key === "b" || key === "\\" || event.code === "Backslash";
      if (!toggle) return;
      const target = event.target;
      if (target instanceof Element && target.closest("dialog, [role='dialog']")) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);
  const startNumber = useSavedStartNumber();
  const needsInitials = initials === "";

  // Desktop: send every navigator.clipboard call (Ketcher paste, NMRium copy) through Tauri.
  useEffect(() => {
    installClipboardBridge();
  }, []);

  // A standalone Mac install often has no local Python helper. The probe must not reject.
  useEffect(() => {
    probeLocalAi();
  }, []);

  const loaded = experiments !== null;
  const selected = experiments?.find((e) => e.id === selectedId) ?? null;

  // The experiments as they are right now, for handlers that wait on a dialog or the disk first.
  const experimentsRef = useRef<Experiment[]>([]);
  useEffect(() => {
    experimentsRef.current = experiments ?? [];
  }, [experiments]);

  const notify = useCallback((kind: ToastMessage["kind"], message: string, durationMs?: number) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, kind, message, durationMs });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // --- Export / import (experiments + molecule pictures + TLC photos + NMR + library) ----------

  /** Run `task` unless another export / import is in progress. */
  async function exclusively(task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await task();
    } finally {
      busyRef.current = false;
    }
  }

  /** Export Full Backup: native "Save As" dialog, then every experiment + attachments + library + profile. */
  function handleExportAll() {
    const current = experimentsRef.current;
    if (current.length === 0) return;
    void exclusively(async () => {
      try {
        const backup = await buildFullBackup(current);
        const saved = await saveJsonFile(backupFilename(), JSON.stringify(backup, null, 2));
        if (!saved) return; // cancelled in the dialog
        notify(
          "success",
          `Exported ${plural(current.length, "experiment")} and ${plural(backup.library.length, "library compound")} to ${saved.path}`,
          PATH_TOAST_MS,
        );
      } catch (err) {
        notify("error", `The backup could not be saved: ${messageOf(err)}`);
      }
    });
  }

  /** Export Experiment: native "Save As" dialog, then the complete ExperimentBundle. */
  function handleExportOne() {
    if (!selected) return;
    const experiment = selected;
    void exclusively(async () => {
      try {
        const bundle = await buildExperimentBundle(experiment);
        const saved = await saveJsonFile(experimentFilename(experiment), JSON.stringify(bundle, null, 2));
        if (!saved) return;
        const contents = describeAttachments(bundle.tlcImages.length, bundle);
        notify(
          "success",
          `Exported ${experiment.id}${contents ? ` with ${contents}` : ""} to ${saved.path}`,
          PATH_TOAST_MS,
        );
      } catch (err) {
        notify("error", `${experiment.id} could not be exported: ${messageOf(err)}`);
      }
    });
  }

  /** Import Experiment: pick a .json (bundle or plain experiment); ask first if the ID is taken. */
  function handleImportExperiment() {
    setDrawerOpen(false);
    void exclusively(async () => {
      try {
        const picked = await pickJsonFile();
        if (!picked) return;
        const parsed = parseBackup(picked.text);
        if (!parsed.ok) {
          notify("error", `${picked.name}: ${parsed.error}`);
          return;
        }
        const isFullBackup =
          parsed.kind === "backup" &&
          (parsed.experiments.length > 1 || (parsed.library?.length ?? 0) > 0 || parsed.profile !== null);
        if (isFullBackup) {
          notify(
            "error",
            `${picked.name} is a full backup (${plural(parsed.experiments.length, "experiment")}). Use “Import Full Backup” to restore it.`,
          );
          return;
        }
        const [experiment] = parsed.experiments;
        if (!experiment) {
          const why = parsed.skipped[0]?.reason;
          notify("error", `${picked.name} has no valid experiment${why ? `: ${why}` : "."}`);
          return;
        }
        const attachments = parsed.attachments[experiment.id] ?? null;
        const taken = experimentsRef.current.some(
          (e) => e.id.toUpperCase() === experiment.id.toUpperCase(),
        );
        if (taken) {
          setPendingImport({ experiment, attachments, fileName: picked.name });
          return;
        }
        await addImportedExperiment(experiment, attachments, "add", picked.name);
      } catch (err) {
        notify("error", `The experiment could not be imported: ${messageOf(err)}`);
      }
    });
  }

  /**
   * Put one imported experiment into the notebook and its files on disk: the experiment JSON
   * (TLC photos included), `molecule.png` and the NMR workspace in `attachments/[id]/`.
   * "overwrite" replaces the experiment with the same ID, "new-id" adds it under a fresh ID.
   */
  async function addImportedExperiment(
    incoming: Experiment,
    attachments: ExperimentAttachments | null,
    how: "add" | "overwrite" | "new-id",
    fileName: string,
  ) {
    const current = experimentsRef.current;
    const existing = current.find((e) => e.id.toUpperCase() === incoming.id.toUpperCase());
    const targetId =
      how === "new-id"
        ? nextExperimentId(current, readInitials() ?? ID_PREFIX)
        : (existing?.id ?? incoming.id);
    const experiment: Experiment = { ...incoming, id: targetId };

    try {
      if (attachments) await restoreAttachments(targetId, attachments, how === "overwrite");
    } catch (err) {
      notify("error", `${targetId} was not imported: its pictures / NMR data could not be written (${messageOf(err)}).`);
      return;
    }

    const saved = await replaceAll((cur) =>
      how === "overwrite"
        ? cur.map((e) => (e.id.toUpperCase() === targetId.toUpperCase() ? experiment : e))
        : [...cur, experiment],
    );
    setImportEpoch((n) => n + 1);
    select(targetId);

    const contents = describeAttachments(experiment.tlcImages.length, attachments);
    const what = `${how === "overwrite" ? "Overwrote" : "Imported"} ${targetId}${
      how === "new-id" ? ` (from ${incoming.id})` : ""
    }${contents ? ` with ${contents}` : ""} from ${fileName}.`;
    notify(
      saved ? "success" : "error",
      saved
        ? what
        : `${what} But it could not be written to storage, so it is NOT saved. Export it again or free some disk space.`,
    );
  }

  function resolveImportConflict(how: "overwrite" | "new-id" | null) {
    const pending = pendingImport;
    setPendingImport(null);
    if (!pending || !how) return;
    void exclusively(async () => {
      try {
        await addImportedExperiment(pending.experiment, pending.attachments, how, pending.fileName);
      } catch (err) {
        notify("error", `The experiment could not be imported: ${messageOf(err)}`);
      }
    });
  }

  function openImport() {
    setDrawerOpen(false);
    setImportOpen(true);
  }

  function openLibrary(draft?: LibraryDraft) {
    setDrawerOpen(false);
    setLibraryDraft(draft ?? null);
    setLibraryOpen(true);
  }

  /**
   * Import Full Backup: restore the experiments, write every `molecule.png` and NMR workspace back
   * to `attachments/[id]/`, merge the Personal Library into `library.json` and restore the profile.
   * A "Replace All" first saves a safety copy of the current notebook and stops if that fails.
   */
  async function handleImport(mode: ImportMode, parsed: ValidBackup, options: { safetyBackup: boolean }) {
    await exclusively(async () => {
      const current = experimentsRef.current;
      const notes: string[] = [];

      if (mode === "replace" && options.safetyBackup && current.length > 0) {
        try {
          const safety = await buildFullBackup(current);
          const saved = await saveJsonToBackupsFolder(preRestoreFilename(), JSON.stringify(safety, null, 2));
          notes.push(`Safety copy of the previous notebook: ${saved.path}`);
        } catch (err) {
          notify(
            "error",
            `Nothing was imported: the safety copy could not be saved (${messageOf(err)}). Untick the safety copy to continue without it.`,
          );
          return;
        }
      }

      // Molecule pictures and NMR workspaces go to disk first; the experiment list follows.
      const existingIds = new Map(current.map((e) => [e.id.toUpperCase(), e.id]));
      try {
        for (const experiment of parsed.experiments) {
          const attachments = parsed.attachments[experiment.id];
          if (!attachments) continue;
          const targetId = existingIds.get(experiment.id.toUpperCase()) ?? experiment.id;
          await restoreAttachments(targetId, attachments, mode === "replace");
        }
      } catch (err) {
        notify("error", `The import stopped: pictures / NMR data could not be written (${messageOf(err)}).`);
        return;
      }

      let message = "";
      const saving = replaceAll((cur) => {
        if (mode === "merge") {
          const result = mergeExperiments(cur, parsed.experiments);
          message = describeMerge(result);
          return result.experiments;
        }
        message = describeReplace(parsed.experiments.length, cur.length);
        return parsed.experiments;
      });
      setImportOpen(false);
      setImportEpoch((n) => n + 1);
      // The open experiment may no longer exist after a replace.
      if (mode === "replace" && selectedId && !parsed.experiments.some((e) => e.id === selectedId)) {
        setSelectedId(null);
      }

      const tlc = parsed.experiments.reduce((sum, e) => sum + e.tlcImages.length, 0);
      const pictures = Object.values(parsed.attachments).filter((a) => a.moleculeImageBase64).length;
      const nmr = Object.values(parsed.attachments).filter((a) => a.nmrWorkspace).length;
      const restored = [
        tlc > 0 ? plural(tlc, "TLC photo") : "",
        pictures > 0 ? plural(pictures, "molecule picture") : "",
        nmr > 0 ? plural(nmr, "NMR workspace") : "",
      ].filter(Boolean);
      if (restored.length > 0) notes.push(`Restored ${restored.join(", ")}.`);

      let failed = false;
      if (parsed.library && parsed.library.length > 0) {
        try {
          const { added } = await mergeLibraryCompounds(parsed.library);
          notes.push(`Library: ${plural(added, "compound")} added.`);
        } catch (err) {
          failed = true;
          notes.push(`The Personal Library could not be restored: ${messageOf(err)}`);
        }
      }
      if (parsed.profile && (mode === "replace" || !readInitials())) {
        if (saveProfile(parsed.profile.initials ?? "", parsed.profile.startNumber)) {
          notes.push(`Profile restored (${parsed.profile.initials}, numbering from ${parsed.profile.startNumber}).`);
        }
      }

      const saved = await saving;
      const text = [message, ...notes].join(" ");
      notify(
        saved && !failed ? "success" : "error",
        saved
          ? text
          : `${text} But the experiments could not be written to storage, so they are NOT saved and will be lost on reload. Export a backup now.`,
        PATH_TOAST_MS,
      );
    });
  }

  function select(id: string | null) {
    setSelectedId(id);
    setDrawerOpen(false);
  }

  function handleNew() {
    const created = create();
    select(created.id);
  }

  /** The scheme pills store Ar, N₂, and Air. Models usually write N2. */
  function notebookAtmosphere(value: string | null | undefined): string | undefined {
    const raw = value?.trim();
    if (!raw) return undefined;
    const key = raw.toLowerCase().replace(/₂/g, "2").replace(/[^a-z0-9]/g, "");
    if (key === "ar" || key === "argon") return "Ar";
    if (key === "n2" || key === "nitrogen" || key === "dinitrogen") return "N₂";
    if (key === "air") return "Air";
    return raw;
  }

  async function handleParsed(parsed: ParsedProtocol, sourceText: string) {
    const reagents = toReagentRows(parsed);
    if (reagents.length === 0) {
      notify("error", "No usable reagents were found in that text.");
      return;
    }
    const created = create();
    const linked = applyParsedLibrary(reagents, parsed.productName, getLibraryCompounds());
    const modelProcedure = parsed.procedure?.trim() ?? "";
    const pasted = sourceText.trim();
    const procedureText = modelProcedure || pasted;
    const title = parsed.title?.trim() ?? "";
    const characterization = parsed.characterization?.trim() ?? "";
    const scheme: StructuredReactionScheme = { ...linked.scheme };
    const solvent = parsed.solvent?.trim();
    const temperature = parsed.temperature?.trim();
    const duration = parsed.time?.trim();
    const atmosphere = notebookAtmosphere(parsed.atmosphere);
    if (solvent) scheme.solvent = solvent;
    if (temperature) scheme.temperature = temperature;
    if (duration) scheme.duration = duration;
    if (atmosphere) scheme.atmosphere = atmosphere;

    let reactantSmiles = linked.reactantSmiles;
    let productSmiles = linked.productSmiles;
    const nextReagents = linked.reagents.map((row) => ({ ...row }));
    let drawnFromPubChem = 0;
    try {
      const { drawFromNameOrSmiles, renderStructureToVectorSvg } = await import("@/components/MoleculeSection");
      const paintSaved = async (structure: string | undefined) => {
        const saved = structure?.trim();
        if (!saved) return null;
        try {
          const rendered = await renderStructureToVectorSvg(saved);
          return rendered.svgDataUrl;
        } catch {
          return null;
        }
      };
      const limiting =
        nextReagents.find((row) => row.role === "Limiting") ??
        nextReagents.find((row) => row.role !== "Solvent");
      if (limiting && !scheme.reactantImage) {
        const painted = await paintSaved(scheme.reactantCdxml);
        if (painted) {
          scheme.reactantImage = painted;
        } else if (!scheme.reactantCdxml) {
          const drawn = await drawFromNameOrSmiles(limiting.smiles?.trim() || limiting.name);
          if (drawn) {
            scheme.reactantImage = drawn.imageDataUrl;
            if (drawn.structureText) scheme.reactantCdxml = drawn.structureText;
            reactantSmiles = drawn.smiles;
            limiting.smiles = drawn.smiles;
            if ((limiting.mw === null || limiting.mw <= 0) && drawn.mw) limiting.mw = drawn.mw;
            drawnFromPubChem += 1;
          }
        }
      }
      const productName = (scheme.productLabel || parsed.productName || "").trim();
      if (productName && !scheme.productLabel) scheme.productLabel = productName;
      if (productName && !scheme.productImage) {
        const painted = await paintSaved(scheme.productCdxml);
        if (painted) {
          scheme.productImage = painted;
        } else if (!scheme.productCdxml) {
          const drawn = await drawFromNameOrSmiles(productSmiles?.trim() || productName);
          if (drawn) {
            scheme.productImage = drawn.imageDataUrl;
            if (drawn.structureText) scheme.productCdxml = drawn.structureText;
            productSmiles = drawn.smiles;
            if (
              (scheme.productMw === undefined || scheme.productMw === null || scheme.productMw <= 0) &&
              drawn.mw
            ) {
              scheme.productMw = drawn.mw;
            }
            drawnFromPubChem += 1;
          }
        }
      }
    } catch (err) {
      console.warn("Structure drawing after parse failed:", err);
    }

    update(created.id, {
      reagents: nextReagents,
      procedureText,
      ...(title ? { title } : {}),
      ...(characterization ? { commentsText: characterization } : {}),
      ...(reactantSmiles ? { reactantSmiles } : {}),
      ...(productSmiles ? { productSmiles } : {}),
      ...(Object.keys(scheme).length > 0 ? { structuredScheme: scheme } : {}),
    });
    setParseOpen(false);
    select(created.id);
    const matched = linked.matchCount > 0 ? ` ${linked.matchCount} matched the Personal Library.` : "";
    const drawn = drawnFromPubChem > 0 ? " Structures were drawn from PubChem." : "";
    notify(
      "success",
      `Created ${created.id} with ${plural(nextReagents.length, "reagent")}.${matched}${drawn} Please check the values.`,
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
    <>
      {/* `inert` while the profile dialog is up: no clicks, no Tab, no shortcuts reach the app behind it. */}
      <div
        inert={needsInitials || profileOpen}
        className="flex min-h-screen flex-col bg-zinc-100 text-zinc-900 print:block print:min-h-0 print:bg-white"
      >
        {/* Header */}
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 print:hidden">
          <SidebarToggleButton expanded={sidebarExpanded} onClick={toggleSidebar} />

          <button
            type="button"
            onClick={() => select(null)}
            className="flex items-center gap-2.5 text-left"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt="Fumebook Logo"
              className="w-7 h-7 rounded-md object-contain"
            />
            <span className="text-base font-semibold tracking-tight text-zinc-900">
              Fumebook
            </span>
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              disabled={!initials}
              aria-label="Profile and settings"
              title={`Profile & settings: ${initials || "…"}, numbering from ${startNumber}`}
              className="grid size-9 shrink-0 place-items-center rounded-full border border-zinc-300 bg-white font-mono text-xs font-bold tracking-wide text-zinc-700 shadow-sm hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fume-500 disabled:opacity-50"
            >
              {initials || "··"}
            </button>
            <button
              type="button"
              onClick={() => setParseOpen(true)}
              disabled={!loaded}
              title="Paste experimental text from a paper and fill in the reagents automatically"
              className="shrink-0 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fume-500 disabled:opacity-50"
            >
              ✨ Parse Protocol
            </button>
            <button
              type="button"
              onClick={handleNew}
              disabled={!loaded}
              className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-fume-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-fume-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fume-500 disabled:opacity-50"
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
              collapsed={sidebarCollapsed}
              onSelect={select}
              onClose={() => setDrawerOpen(false)}
              onNew={handleNew}
              onExportBackup={handleExportAll}
              onImportBackup={openImport}
              onImportExperiment={handleImportExperiment}
              onOpenLibrary={openLibrary}
            />
          )}

          <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8 print:p-0">
            {loaded && <LabTimerEngine />}
            {!loaded ? (
              <p className="text-sm text-zinc-400">Loading notebook…</p>
            ) : selected ? (
              <ExperimentEditor
                key={`${selected.id}:${importEpoch}`}
                experiment={selected}
                onUpdate={(change) => update(selected.id, change)}
                onDelete={handleDelete}
                onExport={handleExportOne}
                onOpenLibrary={openLibrary}
                sidebarExpanded={sidebarExpanded}
                onToggleSidebar={toggleSidebar}
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
        <ImportConflictModal
          conflict={
            pendingImport && {
              id: pendingImport.experiment.id,
              title: pendingImport.experiment.title,
              fileName: pendingImport.fileName,
            }
          }
          newId={nextExperimentId(experiments ?? [], initials || ID_PREFIX)}
          onOverwrite={() => resolveImportConflict("overwrite")}
          onImportAsNew={() => resolveImportConflict("new-id")}
          onCancel={() => resolveImportConflict(null)}
        />
        <LibraryModal
          open={libraryOpen}
          initialDraft={libraryDraft}
          onClose={() => {
            setLibraryOpen(false);
            setLibraryDraft(null);
          }}
        />
        <ParseProtocolModal
          open={parseOpen}
          onClose={() => setParseOpen(false)}
          onParsed={handleParsed}
        />
        <Toast toast={toast} onDismiss={dismissToast} />
      </div>
      {/* Above everything: blocks the app until the profile (initials + starting number) exists,
          and doubles as the profile / settings dialog. */}
      <OnboardingModal editing={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
