"use client";

import { useRef, useState } from "react";
import MoleculeSection, { type MoleculeSectionHandle } from "./MoleculeSection";
import NmrRoom from "./NmrRoom";
import ProductYieldCard from "./ProductYieldCard";
import PurificationSection from "./PurificationSection";
import RichTextarea from "./RichTextarea";
import ReagentTable from "./ReagentTable";
import ReferencesSection from "./ReferencesSection";
import TlcDropzone from "./TlcDropzone";
import type { ExperimentUpdate } from "@/lib/storage";
import type { Experiment } from "@/lib/types";

interface Props {
  experiment: Experiment;
  onUpdate: (change: ExperimentUpdate) => void;
  onDelete: () => void;
  /** Save just this experiment, attachments included, as [ID]_experiment.fumebook.json (native Save dialog). */
  onExport: () => void;
  /** Open the Personal Library dialog. */
  onOpenLibrary: () => void;
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

  return (
    <div className="mx-auto w-full max-w-4xl print:max-w-none">
      {nmrOpen && <NmrRoom experimentId={experiment.id} onClose={() => setNmrOpen(false)} />}

      {/* Action bar (screen only) */}
      <div className="mb-3 flex items-center justify-between print:hidden">
        <p className="text-sm text-zinc-500">
          Notebook <span className="mx-1 text-zinc-300">/</span>
          <span className="font-mono font-medium text-zinc-800">{experiment.id}</span>
        </p>
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
            onChange={(e) => onUpdate({ title: e.target.value })}
            placeholder="Experiment title, e.g. Benzylation of 3-methylpropanol"
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
            onReactionSchemeChange={(reactionSchemeRxn) => onUpdate({ reactionSchemeRxn })}
            mode={experiment.moleculeMode}
            onModeChange={(moleculeMode) => onUpdate({ moleculeMode })}
            hasImage={experiment.moleculeImage}
            onHasImageChange={(moleculeImage) => onUpdate({ moleculeImage })}
            structuredScheme={experiment.structuredScheme}
            onStructuredSchemeChange={(structuredScheme) => onUpdate({ structuredScheme })}
            reagents={experiment.reagents}
            onReagentsChange={(fn) => onUpdate((exp) => ({ reagents: fn(exp.reagents) }))}
            product={experiment.product}
            onProductChange={(patch) =>
              onUpdate((exp) => ({ product: { ...exp.product, ...patch } }))
            }
            secondaryProducts={experiment.secondaryProducts}
            onOpenLibrary={onOpenLibrary}
          />

          <section className="print:break-inside-avoid">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:mb-1">
              Reagents &amp; stoichiometry
            </h2>
            <ReagentTable
              rows={experiment.reagents}
              units={experiment.units}
              columns={experiment.columns}
              onRows={(fn) => onUpdate((exp) => ({ reagents: fn(exp.reagents) }))}
              onUnits={(units) => onUpdate({ units })}
              onColumns={(columns) => onUpdate({ columns })}
              onInsertStructure={async (compound, preferredZone) =>
                (await moleculeRef.current?.insertCompound(compound, preferredZone)) ??
                "The sketcher is not ready yet."
              }
            />
          </section>

          <div className={!experiment.procedureText?.trim() ? "print:hidden" : ""}>
            <RichTextarea
              label="Procedure"
              value={experiment.procedureText}
              onChange={(procedureText) => onUpdate({ procedureText })}
              placeholder="Describe the experimental procedure: setup, addition order, temperature, time…"
              minRows={6}
            />
          </div>

          <div className={experiment.tlcImages.length === 0 ? "print:hidden" : ""}>
            <TlcDropzone
              images={experiment.tlcImages}
              onAdd={(added) =>
                onUpdate((exp) => ({ tlcImages: [...exp.tlcImages, ...added] }))
              }
              onRemove={(index) =>
                onUpdate((exp) => ({ tlcImages: exp.tlcImages.filter((_, i) => i !== index) }))
              }
            />
          </div>

          <PurificationSection
            experimentId={experiment.id}
            purificationText={experiment.purificationText}
            onPurificationTextChange={(purificationText) => onUpdate({ purificationText })}
            gradient={experiment.purificationGradient}
            onGradientChange={(purificationGradient) => onUpdate({ purificationGradient })}
            product={experiment.product}
            secondaryProducts={experiment.secondaryProducts}
          />

          <ProductYieldCard
            experimentId={experiment.id}
            product={experiment.product}
            rows={experiment.reagents}
            onChange={(patch) =>
              onUpdate((exp) => ({ product: { ...exp.product, ...patch } }))
            }
            secondaryProducts={experiment.secondaryProducts}
            onSecondaryChange={(fn) =>
              onUpdate((exp) => ({ secondaryProducts: fn(exp.secondaryProducts ?? []) }))
            }
            productCdxml={experiment.structuredScheme?.productCdxml}
            productImage={experiment.structuredScheme?.productImage}
          />
          <div className="print:hidden">
            <button
              type="button"
              onClick={() => setNmrOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-cyan-300 bg-[#E0FFFF] px-4 py-2 font-semibold text-zinc-900 shadow-sm hover:bg-[#C6F2F2]"
            >
              🔬 Enter NMR Room
            </button>
          </div>

          <div className={!experiment.commentsText?.trim() ? "print:hidden" : ""}>
            <RichTextarea
              label="Comments"
              value={experiment.commentsText}
              onChange={(commentsText) => onUpdate({ commentsText })}
              placeholder="Observations, deviations, ideas for next time…"
              minRows={2}
            />
          </div>

          <div className={experiment.references.length === 0 ? "print:hidden" : ""}>
            <ReferencesSection
              references={experiment.references}
              onAdd={(reference) =>
                onUpdate((exp) => ({ references: [...exp.references, reference] }))
              }
              onRemove={(id) =>
                onUpdate((exp) => ({ references: exp.references.filter((r) => r.id !== id) }))
              }
            />
          </div>
        </div>
      </article>
    </div>
  );
}
