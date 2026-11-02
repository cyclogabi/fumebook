/**
 * ESI-MS (and related) mass-spectrum records stored on an experiment.
 * Keep this file as the schema for `Experiment.msSpectrum`.
 */

export interface MsPeak {
  mz: number;
  /** Normalized 0–100% relative abundance. */
  intensity: number;
  rawIntensity?: number;
}

export const MS_IONIZATION_MODES = ["ESI+", "ESI-", "APCI", "MALDI"] as const;
export type MsIonizationMode = (typeof MS_IONIZATION_MODES)[number];

export interface MsSpectrumData {
  fileName: string;
  ionizationMode?: string;
  peaks: MsPeak[];
  mzMin?: number;
  mzMax?: number;
  /** e.g. "[M+Na]+ calcd for C42H70O35Na: 1157.36" */
  targetNote?: string;
}

/**
 * Reaction record assembled for retrosynthesis / forward models (LocalRetro, LocalTransform).
 * Stored on the experiment so a saved `.fumebook.json` is training-ready without a second export.
 */
export interface AiReactionRecord {
  /** Standard `ReactantSMILES>AgentSMILES>ProductSMILES`. */
  reactionSmiles: string;
  /** Pure transformation `ReactantSMILES>>ProductSMILES` for LocalRetro / LocalTransform. */
  mappedCoreSmiles: string;
  /** Extracted from the left-zone CDXML / Molfile. */
  reactantSmiles: string;
  /** SMILES available from the reagents table or matching library compounds. */
  agentSmiles: string[];
  /** Extracted from the right-zone CDXML / Molfile. */
  productSmiles: string;
  /** Reagent names drawn above the arrow. */
  reagentNames: string[];
  solvent: string;
  temperature: string;
  time: string;
  atmosphere: string;
  /** Primary product yield. `0` is kept (negative training example); `null` when it cannot be computed. */
  yieldPercent: number | null;
  updatedAt: string;
}

/** AI reaction fields persisted on a saved experiment. */
export interface ExperimentData {
  /** Canonical SMILES of the left-zone structure, when Indigo can produce one. */
  reactantSmiles?: string;
  /** Canonical SMILES of the right-zone structure, when Indigo can produce one. */
  productSmiles?: string;
  aiReactionData?: AiReactionRecord;
  /** Opt-in lab widgets shown above this experiment. Empty or missing keeps the page clear. */
  enabledWidgets?: string[];
}
