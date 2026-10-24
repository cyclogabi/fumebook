import type { AiReactionRecord } from "@/types/experiment";
import { libraryCompoundSmiles, type LibraryCompound } from "./library";
import { limitingN, productMetrics, stoichRatioOf } from "./stoich";
import type { Experiment, ReagentRow } from "./types";

/** The reaction-SMILES assembler only reads these fields, so a template draft can use it too. */
type AiReactionSource = Pick<
  Experiment,
  "reactantSmiles" | "productSmiles" | "reagents" | "structuredScheme" | "product"
>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** Reagents drawn above the arrow: everything except the limiting reagent and solvents. */
function arrowReagents(rows: readonly ReagentRow[]): ReagentRow[] {
  return rows.filter((row) => row.role !== "Limiting" && row.role !== "Solvent" && row.name.trim() !== "");
}

function agentSmilesFor(rows: readonly ReagentRow[], library: readonly LibraryCompound[]): string[] {
  const smiles: string[] = [];
  for (const row of arrowReagents(rows)) {
    const direct = row.smiles?.trim();
    if (direct) {
      smiles.push(direct);
      continue;
    }
    const name = row.name.trim().toLowerCase();
    const hit = library.find((compound) => compound.name.trim().toLowerCase() === name);
    const fromLibrary = hit ? libraryCompoundSmiles(hit) : undefined;
    if (fromLibrary) smiles.push(fromLibrary);
  }
  return smiles;
}

function primaryYieldPercent(experiment: AiReactionSource): number | null {
  const metrics = productMetrics(
    experiment.product.isolatedMass,
    experiment.product.mw,
    stoichRatioOf(experiment.product),
    limitingN(experiment.reagents),
  );
  if (metrics.percent === null || !Number.isFinite(metrics.percent)) return null;
  return Math.round(metrics.percent * 100) / 100;
}

/** Build the training record from the experiment's current structures, reagents, and conditions. */
export function assembleAiReactionRecord(
  experiment: AiReactionSource,
  library: readonly LibraryCompound[] = [],
): AiReactionRecord {
  const reactantSmiles = clean(experiment.reactantSmiles);
  const productSmiles = clean(experiment.productSmiles);
  const agents = agentSmilesFor(experiment.reagents, library);
  const scheme = experiment.structuredScheme;
  const solventFromRows = experiment.reagents
    .filter((row) => row.role === "Solvent" && row.name.trim() !== "")
    .map((row) => row.name.trim());

  return {
    reactantSmiles,
    productSmiles,
    agentSmiles: agents,
    reagentNames: arrowReagents(experiment.reagents).map((row) => row.name.trim()),
    mappedCoreSmiles: `${reactantSmiles}>>${productSmiles}`,
    reactionSmiles: `${reactantSmiles}>${agents.join(".")}>${productSmiles}`,
    solvent: clean(scheme?.solvent) || solventFromRows.join(" / "),
    temperature: clean(scheme?.temperature),
    time: clean(scheme?.duration),
    atmosphere: clean(scheme?.atmosphere),
    yieldPercent: primaryYieldPercent(experiment),
    updatedAt: new Date().toISOString(),
  };
}

function hasAiSignal(record: AiReactionRecord): boolean {
  return Boolean(
    record.reactantSmiles ||
      record.productSmiles ||
      record.agentSmiles.length ||
      record.reagentNames.length ||
      record.solvent ||
      record.temperature ||
      record.time ||
      record.atmosphere ||
      record.yieldPercent !== null,
  );
}

/** Compare two records aside from `updatedAt`, which changes on every rebuild. */
export function aiReactionRecordsMatch(a: AiReactionRecord, b: AiReactionRecord): boolean {
  return (
    a.reactionSmiles === b.reactionSmiles &&
    a.mappedCoreSmiles === b.mappedCoreSmiles &&
    a.reactantSmiles === b.reactantSmiles &&
    a.productSmiles === b.productSmiles &&
    a.solvent === b.solvent &&
    a.temperature === b.temperature &&
    a.time === b.time &&
    a.atmosphere === b.atmosphere &&
    a.yieldPercent === b.yieldPercent &&
    a.agentSmiles.join("\0") === b.agentSmiles.join("\0") &&
    a.reagentNames.join("\0") === b.reagentNames.join("\0")
  );
}

/**
 * Attach a fresh `aiReactionData` when the training fields changed.
 * Returns the same object when nothing meaningful changed, so a save does not rewrite the file.
 */
export function withAiReactionData(
  experiment: Experiment,
  library: readonly LibraryCompound[] = [],
): Experiment {
  const aiReactionData = assembleAiReactionRecord(experiment, library);
  const prev = experiment.aiReactionData;
  if (
    !hasAiSignal(aiReactionData) &&
    !prev &&
    !clean(experiment.reactantSmiles) &&
    !clean(experiment.productSmiles)
  ) {
    return experiment;
  }
  const smilesSame =
    clean(experiment.reactantSmiles) === aiReactionData.reactantSmiles &&
    clean(experiment.productSmiles) === aiReactionData.productSmiles;
  if (smilesSame && prev && aiReactionRecordsMatch(prev, aiReactionData)) return experiment;
  return {
    ...experiment,
    reactantSmiles: aiReactionData.reactantSmiles || undefined,
    productSmiles: aiReactionData.productSmiles || undefined,
    aiReactionData,
  };
}
