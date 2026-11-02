import { z } from "zod";
import { ROLES } from "./types";

/**
 * Strict schema the LLM must fill in. Groq's strict structured-output mode
 * requires every field to be present, so "unknown" is expressed as `null`
 * rather than an optional key.
 *
 * Units are fixed here and converted by the model, matching the ELN's
 * canonical storage units (mass: mg, n: mmol, vol: mL).
 */
export const protocolSchema = z.object({
  title: z
    .string()
    .nullable()
    .describe("Short experiment title taken from the heading or the transformation, or null if none is given."),
  solvent: z.string().nullable().describe("Reaction solvent as written, e.g. 'dry THF', or null."),
  temperature: z.string().nullable().describe("Reaction temperature as written, e.g. '0 °C' or 'reflux', or null."),
  time: z.string().nullable().describe("Reaction time as written, e.g. '16 h', or null."),
  atmosphere: z
    .string()
    .nullable()
    .describe("Reaction atmosphere if stated. Use 'Ar', 'N2', or 'Air' when that is what the text means, otherwise null."),
  procedure: z
    .string()
    .nullable()
    .describe(
      "The full experimental procedure. When the source is a screenshot, transcribe that procedure in full rather than summarizing it. Null only when no procedure text is present.",
    ),
  characterization: z
    .string()
    .nullable()
    .describe("Characterization or analytical notes (NMR, MS, Rf, melting point), or null."),
  productName: z
    .string()
    .nullable()
    .describe("Name of the target or isolated product, or null if the source does not name it."),
  reagents: z
    .array(
      z.object({
        name: z.string().describe("Chemical name exactly as written, without the amount, e.g. 'benzyl bromide'."),
        role: z
          .enum(ROLES)
          .describe(
            "Limiting = the substrate the others are measured against (usually the first reagent listed); " +
              "Solvent = a liquid reaction medium; Catalyst = catalysts, ligands, additives used substoichiometrically; " +
              "Reagent = everything else.",
          ),
        mw: z
          .number()
          .nullable()
          .describe("Molecular weight in g/mol only when the text states it. Never calculate it. Null if it is not written."),
        massMg: z.number().nullable().describe("Mass converted to milligrams, or null if no mass is given."),
        mmol: z.number().nullable().describe("Amount of substance converted to millimoles, or null if not given."),
        volumeMl: z.number().nullable().describe("Volume converted to millilitres, or null if not given."),
        equiv: z.number().nullable().describe("Equivalents relative to the limiting reagent, or null if not given."),
      }),
    )
    .describe("Every chemical used in the experimental procedure, in order of appearance."),
});

export type ParsedProtocol = z.infer<typeof protocolSchema>;
export type ParsedReagent = ParsedProtocol["reagents"][number];
