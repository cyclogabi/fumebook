"use client";

import { useEffect, useRef, useState } from "react";
import MoleculeSection, { type MoleculeSectionHandle } from "./MoleculeSection";
import { withAiReactionData } from "@/lib/aiReaction";
import { applySavedReaction } from "@/lib/reactionLibrary";
import { useLibrary } from "@/lib/library";
import type { LibraryDraft } from "./LibraryModal";
import MassSpecViewer from "./MassSpecViewer";
import NmrRoom from "./NmrRoom";
import ProductYieldCard from "./ProductYieldCard";
import PurificationSection from "./PurificationSection";
import RichTextarea from "./RichTextarea";
import ReagentTable from "./ReagentTable";
import ReferencesSection from "./ReferencesSection";
import TlcDropzone from "./TlcDropzone";
import { useExperimentUndo } from "@/lib/experimentUndo";
import type { ExperimentUpdate } from "@/lib/storage";
import type { Experiment } from "@/lib/types";

interface Props {
  experiment: Experiment;
  onUpdate: (change: ExperimentUpdate) => void;
  onDelete: () => void;
  /** Save just this experiment, attachments included, as [ID]_experiment.fumebook.json (native Save dialog). */
  onExport: () => void;
  /** Open the Personal Library dialog, optionally pre-filled with a reagent row's name/MW/density. */
  onOpenLibrary: (draft?: LibraryDraft) => void;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function ExperimentEditor({
  experiment,
  onUpdate,
  onDelete,
  onExport,
  onOpenLibrary,
}: Props) {
  // Only whether the room is open lives here; its workspace is autosaved separately
  // (Documents/Fumebook/attachments/<id>/workspace.nmrium), not in the experiment JSON.
  const [nmrOpen, setNmrOpen] = useState(false);
  // Lets the reagent table drop a library compound's structure into the sketcher.
  const moleculeRef = useRef<MoleculeSectionHandle>(null);
  const { compounds: library } = useLibrary();
  const { update, undo, redo, canUndo, canRedo } = useExperimentUndo(experiment, onUpdate);
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  const onUpdateRef = useRef(onUpdate);
  const experimentRef = useRef(experiment);
  undoRef.current = undo;
  redoRef.current = redo;
  onUpdateRef.current = onUpdate;
  experimentRef.current = experiment;

  useEffect(() => {
    if (nmrOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = (e.key || "").toLowerCase();
      const undoKey = key === "z" || e.code === "KeyZ";
      const redoKey = key === "y" || e.code === "KeyY";
      const isUndo = undoKey && !e.shiftKey;
      const isRedo = redoKey || (undoKey && e.shiftKey);
      if (!isUndo && !isRedo) return;
      // A modal (library, confirm) keeps its own text editing. The sheet behind it still undoes
      // from the toolbar; the shortcut stays with whichever field is focused inside the dialog.
      const target = e.target;
      if (target instanceof Element && target.closest("dialog, [role='dialog']")) return;

      e.preventDefault();
      e.stopPropagation();
      if (isUndo) undoRef.current();
      else redoRef.current();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [nmrOpen]);

  useEffect(() => {
    const current = experimentRef.current;
    const next = withAiReactionData(current, library ?? []);
    if (next === current) return;
    onUpdateRef.current({
      reactantSmiles: next.reactantSmiles,
      productSmiles: next.productSmiles,
      aiReactionData: next.aiReactionData,
    });
  }, [experiment, library]);

  function handleZoneSmiles(reactantSmiles: string | null, productSmiles: string | null) {
    const current = experimentRef.current;
    const nextReactant = reactantSmiles ?? "";
    const nextProduct = productSmiles ?? "";
    if (
      (current.reactantSmiles ?? "") === nextReactant &&
      (current.productSmiles ?? "") === nextProduct
    ) {
      return;
    }
    onUpdateRef.current({
      reactantSmiles: nextReactant || undefined,
      productSmiles: nextProduct || undefined,
    });
  }

  return (
    <div className="mx-auto w-full max-w-4xl print:max-w-none">
      {nmrOpen && <NmrRoom experimentId={experiment.id} onClose={() => setNmrOpen(false)} />}

      {/* Action bar (screen only) */}
      <div className="mb-3 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-3">
          <p className="text-sm text-zinc-500">
            Notebook <span className="mx-1 text-zinc-300">/</span>
            <span className="font-mono font-medium text-zinc-800">{experiment.id}</span>
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo (Ctrl+Z)"
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo (↶)
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
              aria-label="Redo (Ctrl+Y)"
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Redo (↷)
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            Print / Save PDF
          </button>
          <button
            type="button"
            onClick={onExport}
            title={`Save ${experiment.id} (with its molecule picture, TLC photos and NMR spectra) as a .json file`}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            Export Experiment (.json)
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>

      {/* A4 sheet */}
      <article className="min-h-[297mm] rounded-sm border border-zinc-200 bg-white px-8 py-10 shadow-md sm:px-14 sm:py-14 print:min-h-0 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="mb-8 border-b border-zinc-300 pb-4 print:mb-2.5 print:pb-1.5">
          <div className="mb-2 flex items-baseline justify-between text-xs text-zinc-500 print:mb-0.5">
            <span className="font-mono text-sm font-semibold tracking-wide text-zinc-900 print:text-xs">
              {experiment.id}
            </span>
            <span>{formatDate(experiment.dateCreated)}</span>
          </div>

          <input
            value={experiment.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Experiment title"
            aria-label="Experiment title"
            className="-mx-2 w-[calc(100%+1rem)] rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight text-zinc-900 placeholder:text-zinc-300 hover:border-zinc-200 focus:border-fume-500 focus:outline-none print:hidden"
          />
          <h1 className="hidden break-words text-base font-semibold leading-tight tracking-tight print:block">
            {experiment.title || "Untitled experiment"}
          </h1>
        </header>

        <div className="flex flex-col gap-6 print:gap-2">
          <MoleculeSection
            ref={moleculeRef}
            experimentId={experiment.id}
            reactionScheme={experiment.reactionSchemeRxn}
            onReactionSchemeChange={(reactionSchemeRxn) => update({ reactionSchemeRxn })}
            mode={experiment.moleculeMode}
            onModeChange={(moleculeMode) => update({ moleculeMode })}
            hasImage={experiment.moleculeImage}
            onHasImageChange={(moleculeImage) => update({ moleculeImage })}
            structuredScheme={experiment.structuredScheme}
            onStructuredSchemeChange={(structuredScheme) => update({ structuredScheme })}
            reagents={experiment.reagents}
            onReagentsChange={(fn) => update((exp) => ({ reagents: fn(exp.reagents) }))}
            product={experiment.product}
            onProductChange={(patch) =>
              update((exp) => ({ product: { ...exp.product, ...patch } }))
            }
            secondaryProducts={experiment.secondaryProducts}
            onOpenLibrary={onOpenLibrary}
            reactantSmiles={experiment.reactantSmiles}
            productSmiles={experiment.productSmiles}
            onZoneSmilesChange={handleZoneSmiles}
            experimentCode={experiment.id}
            experimentTitle={experiment.title}
            onLoadReaction={(template) => {
              // `update` pushes the open experiment onto the Ctrl+Z stack before replacing it.
              update((exp) => applySavedReaction(exp, template));
            }}
          />

          <section className="print:break-inside-avoid">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:mb-1">
              Reagents &amp; stoichiometry
            </h2>
            <ReagentTable
              rows={experiment.reagents}
              units={experiment.units}
              columns={experiment.columns}
              onRows={(fn) => update((exp) => ({ reagents: fn(exp.reagents) }))}
              onUnits={(units) => update({ units })}
              onColumns={(columns) => update({ columns })}
              onInsertStructure={async (compound, preferredZone) =>
                (await moleculeRef.current?.insertCompound(compound, preferredZone)) ??
                "The sketcher is not ready yet."
              }
              onSaveToLibrary={(reagent) => onOpenLibrary(reagent)}
            />
          </section>

          <div className={!experiment.procedureText?.trim() ? "print:hidden" : ""}>
            <RichTextarea
              label="Procedure"
              value={experiment.procedureText}
              onChange={(procedureText) => update({ procedureText })}
              placeholder="Experimental procedure"
              minRows={6}
            />
          </div>

          <div className={experiment.tlcImages.length === 0 ? "print:hidden" : ""}>
            <TlcDropzone
              images={experiment.tlcImages}
              onAdd={(added) =>
                update((exp) => ({ tlcImages: [...exp.tlcImages, ...added] }))
              }
              onRemove={(index) =>
                update((exp) => ({ tlcImages: exp.tlcImages.filter((_, i) => i !== index) }))
              }
            />
          </div>

          <PurificationSection
            experimentId={experiment.id}
            purificationText={experiment.purificationText}
            onPurificationTextChange={(purificationText) => update({ purificationText })}
            gradient={experiment.purificationGradient}
            onGradientChange={(purificationGradient) => update({ purificationGradient })}
            product={experiment.product}
            secondaryProducts={experiment.secondaryProducts}
          />

          <ProductYieldCard
            experimentId={experiment.id}
            product={experiment.product}
            rows={experiment.reagents}
            onChange={(patch) =>
              update((exp) => ({ product: { ...exp.product, ...patch } }))
            }
            secondaryProducts={experiment.secondaryProducts}
            onSecondaryChange={(fn) =>
              update((exp) => ({ secondaryProducts: fn(exp.secondaryProducts ?? []) }))
            }
            productCdxml={experiment.structuredScheme?.productCdxml}
            productImage={experiment.structuredScheme?.productImage}
          />
          <section
            className={
              experiment.msSpectrum?.peaks.length
                ? "print:break-inside-avoid"
                : "print:hidden"
            }
          >
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:hidden">
              Characterization
            </h2>
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2 print:grid-cols-1 print:gap-2">
              <div className="print:hidden">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 xl:hidden">
                  NMR
                </p>
                <button
                  type="button"
                  onClick={() => setNmrOpen(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 shadow-sm hover:bg-zinc-50 xl:min-h-[8rem]"
                >
                  🔬 Enter NMR Room
                </button>
              </div>
              <MassSpecViewer
                spectrum={experiment.msSpectrum}
                onChange={(msSpectrum) => update({ msSpectrum })}
              />
            </div>
          </section>

          <div className={!experiment.commentsText?.trim() ? "print:hidden" : ""}>
            <RichTextarea
              label="Comments"
              value={experiment.commentsText}
              onChange={(commentsText) => update({ commentsText })}
              placeholder="Observations"
              minRows={2}
            />
          </div>

          <div className={experiment.references.length === 0 ? "print:hidden" : ""}>
            <ReferencesSection
              references={experiment.references}
              onAdd={(reference) =>
                update((exp) => ({ references: [...exp.references, reference] }))
              }
              onRemove={(id) =>
                update((exp) => ({ references: exp.references.filter((r) => r.id !== id) }))
              }
            />
          </div>
        </div>
      </article>
    </div>
  );
}
