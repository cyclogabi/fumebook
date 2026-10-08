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
