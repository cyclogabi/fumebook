"use client";

import { useImperativeHandle, useRef, type Ref } from "react";
import LibraryMenu from "./LibraryMenu";
import MoleculeImage from "./MoleculeImage";
import ReactionCanvas, { type ReactionCanvasHandle } from "./ReactionCanvas";
import { useLibrary, type LibraryCompound } from "@/lib/library";
import type { MoleculeMode } from "@/lib/types";

interface Props {
  experimentId: string;
  /** Saved Rxnfile/Molfile of the drawing. */
  reactionScheme: string;
  onReactionSchemeChange: (rxn: string) => void;
  mode: MoleculeMode;
  onModeChange: (mode: MoleculeMode) => void;
  /** A picture was saved as `molecule.png`. */
  hasImage: boolean;
  onHasImageChange: (hasImage: boolean) => void;
  /** Open the Personal Library dialog. */
  onOpenLibrary: () => void;
  ref?: Ref<MoleculeSectionHandle>;
}

/** What the rest of the page (the reagent table) can ask of this section. */
export interface MoleculeSectionHandle {
  /** Add a library compound's structure to the sketcher. Resolves to an error message, or null when it was added. */
  insertCompound: (compound: LibraryCompound) => Promise<string | null>;
}

const MODES: { value: MoleculeMode; label: string }[] = [
  { value: "draw", label: "Draw (Ketcher)" },
  { value: "image", label: "Upload Image" },
];

function ModeToggle({ mode, onChange }: { mode: MoleculeMode; onChange: (m: MoleculeMode) => void }) {
  return (
    <div
      role="group"
      aria-label="How to add the molecule"
      className="inline-flex rounded-md border border-zinc-300 bg-zinc-100 p-0.5 print:hidden"
    >
      {MODES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            mode === value ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The molecule / reaction scheme section. A toggle picks between drawing in Ketcher and showing an
 * uploaded picture; in drawing mode a "Load from Library" menu drops saved compounds into the
 * sketcher. The drawing is kept when switching to the picture and back.
 */
export default function MoleculeSection({
  experimentId,
  reactionScheme,
  onReactionSchemeChange,
  mode,
  onModeChange,
  hasImage,
  onHasImageChange,
  onOpenLibrary,
  ref,
}: Props) {
  const canvasRef = useRef<ReactionCanvasHandle>(null);
  const { add } = useLibrary();

  useImperativeHandle(
    ref,
    () => ({
      async insertCompound(compound) {
        if (mode !== "draw") {
          return "Switch the reaction scheme to Draw (Ketcher) to add a structure to the sketcher.";
        }
        const canvas = canvasRef.current;
        if (!canvas) return "The drawing tools are not ready yet.";
        try {
          await canvas.insertStructure(compound.structure);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    }),
    [mode],
  );

  async function loadCompound(compound: LibraryCompound) {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("The drawing tools are not ready yet.");
    await canvas.insertStructure(compound.structure);
  }

  /** Returns an error message, or null when the drawing was saved. */
  async function saveDrawing(name: string): Promise<string | null> {
    const canvas = canvasRef.current;
    if (!canvas) return "The drawing tools are not ready yet.";
    let molfile: string;
    try {
      molfile = await canvas.getMolfile();
    } catch (err) {
      return `Could not read the drawing: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!molfile) return "Draw a structure first.";
    const result = add({ name, structure: molfile });
    return result.ok ? null : result.error;
  }

  const toggle = <ModeToggle mode={mode} onChange={onModeChange} />;

  if (mode === "image") {
    return (
      <section className={hasImage ? "" : "print:hidden"}>
        <div className="mb-2 flex items-center justify-between gap-2 print:mb-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Reaction scheme
          </h2>
          {toggle}
        </div>
        <MoleculeImage
          experimentId={experimentId}
          hasImage={hasImage}
          onHasImageChange={onHasImageChange}
        />
      </section>
    );
  }

  return (
    <ReactionCanvas
      ref={canvasRef}
      value={reactionScheme}
      onChange={onReactionSchemeChange}
      fileName={experimentId}
      experimentId={experimentId}
      toolbar={
        <>
          {toggle}
          <LibraryMenu onPick={loadCompound} onSaveDrawing={saveDrawing} onManage={onOpenLibrary} />
        </>
      }
    />
  );
}
