/**
 * Cheap checks on clipboard text, used to decide whether a paste into the sketcher is worth
 * handing to Ketcher at all (its own paste handler throws on text it can't parse).
 * No dependencies, so it is trivial to test.
 */

/** Longest single-line SMILES we'll consider (a big cyclodextrin is a few hundred characters). */
const MAX_SMILES_LENGTH = 5000;

/** The organic subset, aromatic atoms and the wildcard: atoms that may appear without brackets. */
const ORGANIC_ATOM = /^(?:Cl|Br|[BCNOPSFIbcnops*])/;

/** `[13CH4]`, `[C@@H]`, `[NH4+]`, `[Fe+2]`, `[nH]`, `[*:1]`: isotope, symbol, chirality, H count, charge, class. */
const BRACKET_ATOM = /^\d*(?:[A-Z][a-z]?|se|as|[bcnops]|\*)(?:@{1,2})?(?:H\d*)?(?:[+-]+\d*)?(?::\d+)?$/;

/**
 * Is `token` a plausible SMILES string? Plain words fail (the letter "e" or "l" is not an atom),
 * "CCO" and "c1ccccc1" pass. This checks the grammar's shape (atoms, bonds, rings, branches),
 * not chemistry: Ketcher still decides whether the structure is sensible.
 */
export function isSmilesToken(token: string): boolean {
  if (token.length === 0 || token.length > MAX_SMILES_LENGTH || /\s/.test(token)) return false;
  let depth = 0;
  let atoms = 0;
  let i = 0;
  while (i < token.length) {
    const ch = token[i];
    if (ch === "[") {
      const end = token.indexOf("]", i + 1);
      if (end === -1 || !BRACKET_ATOM.test(token.slice(i + 1, end))) return false;
      atoms += 1;
      i = end + 1;
    } else if (ch === "(") {
      depth += 1;
      i += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
      i += 1;
    } else if (ch === "%") {
      if (!/^\d\d$/.test(token.slice(i + 1, i + 3))) return false;
      i += 3;
    } else if (/[-=#$:/\\.>\d]/.test(ch)) {
      i += 1; // bond symbol, ring-closure digit, or the ">" of a reaction SMILES (A.B>C>D)
    } else {
      const atom = ORGANIC_ATOM.exec(token.slice(i));
      if (!atom) return false;
      atoms += 1;
      i += atom[0].length;
    }
  }
  return depth === 0 && atoms > 0;
}

/** Clipboard text without a byte-order mark or the NUL padding some Windows apps append. */
export function cleanClipboardText(raw: string): string {
  return raw.replace(/\0/g, "").replace(/^\uFEFF/, "");
}

/**
 * Does this text look like a chemical structure Ketcher can read? True for ChemDraw CDXML,
 * MOLfile / RXN / SDF (an "M  END" line or a V2000 / V3000 counts line), InChI, Ketcher's own
 * KET JSON, or one SMILES token (reaction SMILES and a trailing `|...|` CXSMILES block included).
 * Empty text, prose and other markup are not.
 */
export function isValidChemicalText(raw: string): boolean {
  const text = cleanClipboardText(raw).trim();
  if (text === "") return false;
  if (/<CDXML[\s>]/i.test(text)) return true;
  if (/M {2}END/.test(text) || /\bV[23]000\b/.test(text)) return true;
  if (/^InChI=/.test(text)) return true;
  if (/^\{[\s\S]*"root"\s*:/.test(text)) return true;
  const [smiles, ...extension] = text.split(/\s+/);
  if (extension.length > 0 && !/^\|.*\|$/.test(extension.join(" "))) return false;
  return isSmilesToken(smiles);
}