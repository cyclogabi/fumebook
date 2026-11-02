import { findMatchingLibraryCompound, libraryCompoundSmiles, type LibraryCompound } from "./library";
import type { ReagentRow, StructuredReactionScheme } from "./types";

export interface ParsedLibraryApply {
  reagents: ReagentRow[];
  scheme: Partial<StructuredReactionScheme>;
  reactantSmiles?: string;
  productSmiles?: string;
  matchCount: number;
}

function structureText(compound: LibraryCompound): string {
  const cdxml = compound.cdxml?.trim();
  if (cdxml) return cdxml;
  if (compound.format === "cdxml" || compound.format === "mol") return compound.structure.trim();
  return "";
}

/** Name, alias, IUPAC, CAS, then a library compound whose first token and MW agree. */
export function matchLibraryCompound(
  name: string,
  mw: number | null | undefined,
  compounds: readonly LibraryCompound[],
): LibraryCompound | null {
  return findMatchingLibraryCompound(
    name,
    undefined,
    typeof mw === "number" && Number.isFinite(mw) ? mw : undefined,
    compounds,
  );
}

function linkRow(row: ReagentRow, compound: LibraryCompound): ReagentRow {
  const smiles = libraryCompoundSmiles(compound);
  const next: ReagentRow = {
    ...row,
    name: compound.name,
    libraryMatch: compound.name,
  };
  if (smiles) next.smiles = smiles;
  if (row.role !== "Solvent") {
    if (typeof compound.mw === "number" && compound.mw > 0) next.mw = compound.mw;
    if (typeof compound.density === "number" && compound.density > 0) next.density = compound.density;
  } else if (typeof compound.density === "number" && compound.density > 0) {
    next.density = compound.density;
  }
  return next;
}

/**
 * Attach Personal Library identity, properties, and structures to a parsed experiment.
 * The limiting reagent (or the first non-solvent) fills the left zone. A named product
 * that matches fills the right zone.
 */
export function applyParsedLibrary(
  rows: ReagentRow[],
  productName: string | null | undefined,
  compounds: readonly LibraryCompound[],
): ParsedLibraryApply {
  let matchCount = 0;
  const reagents = rows.map((row) => {
    const hit = matchLibraryCompound(row.name, row.mw, compounds);
    if (!hit) return row;
    matchCount += 1;
    return linkRow(row, hit);
  });

  const scheme: Partial<StructuredReactionScheme> = {};
  let reactantSmiles: string | undefined;
  const anchor =
    reagents.find((row) => row.role === "Limiting") ?? reagents.find((row) => row.role !== "Solvent");
  if (anchor?.libraryMatch) {
    const compound = compounds.find((item) => item.name === anchor.libraryMatch);
    if (compound) {
      const image = compound.imageDataUrl?.trim();
      const cdxml = structureText(compound);
      const smiles = libraryCompoundSmiles(compound);
      if (image) scheme.reactantImage = image;
      if (cdxml) scheme.reactantCdxml = cdxml;
      if (smiles) reactantSmiles = smiles;
    }
  }

  let productSmiles: string | undefined;
  const named = productName?.trim();
  if (named) {
    scheme.productLabel = named;
    const hit = matchLibraryCompound(named, null, compounds);
    if (hit) {
      matchCount += 1;
      scheme.productLabel = hit.name;
      if (typeof hit.mw === "number" && hit.mw > 0) scheme.productMw = hit.mw;
      const image = hit.imageDataUrl?.trim();
      const cdxml = structureText(hit);
      const smiles = libraryCompoundSmiles(hit);
      if (image) scheme.productImage = image;
      if (cdxml) scheme.productCdxml = cdxml;
      if (smiles) productSmiles = smiles;
    }
  }

  return { reagents, scheme, reactantSmiles, productSmiles, matchCount };
}
