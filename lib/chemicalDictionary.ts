/**
 * Local dictionary of common organic-chemistry reagents and solvents.
 *
 * Used by the reagent-name combobox as an instant, offline "quick pick" that
 * is shown ahead of the PubChem results. Values are canonical ELN units:
 * MW in g/mol, density in g/mL (room temperature; omitted for solids).
 */

export type DictionaryRole = "Solvent" | "Reagent";

export interface ChemicalEntry {
  /** Display name, written in clean Title Case. */
  commonName: string;
  /** Abbreviations / formulas / synonyms that should also find this entry. */
  aliases: string[];
  /** g/mol */
  mw: number;
  /** g/mL - optional, left out for solids */
  density?: number;
  defaultRole: DictionaryRole;
}

export const CHEMICAL_DICTIONARY: readonly ChemicalEntry[] = [
  // --- Solvents ---------------------------------------------------------
  { commonName: "Dichloromethane", aliases: ["DCM", "CH2Cl2", "Methylene chloride"], mw: 84.93, density: 1.325, defaultRole: "Solvent" },
  { commonName: "Tetrahydrofuran", aliases: ["THF"], mw: 72.11, density: 0.889, defaultRole: "Solvent" },
  { commonName: "N,N-Dimethylformamide", aliases: ["DMF"], mw: 73.09, density: 0.944, defaultRole: "Solvent" },
  { commonName: "Diethyl Ether", aliases: ["Et2O", "Ether", "Ethyl ether"], mw: 74.12, density: 0.713, defaultRole: "Solvent" },
  { commonName: "Ethyl Acetate", aliases: ["EtOAc", "EA", "AcOEt"], mw: 88.11, density: 0.902, defaultRole: "Solvent" },
  { commonName: "Methanol", aliases: ["MeOH"], mw: 32.04, density: 0.792, defaultRole: "Solvent" },
  { commonName: "Ethanol", aliases: ["EtOH"], mw: 46.07, density: 0.789, defaultRole: "Solvent" },
  { commonName: "Isopropanol", aliases: ["IPA", "iPrOH", "2-Propanol"], mw: 60.1, density: 0.786, defaultRole: "Solvent" },
  { commonName: "Acetone", aliases: ["Propanone", "Me2CO"], mw: 58.08, density: 0.791, defaultRole: "Solvent" },
  { commonName: "Acetonitrile", aliases: ["MeCN", "ACN", "CH3CN"], mw: 41.05, density: 0.786, defaultRole: "Solvent" },
  { commonName: "Hexanes", aliases: ["Hexane", "n-Hexane"], mw: 86.18, density: 0.659, defaultRole: "Solvent" },
  { commonName: "Toluene", aliases: ["PhMe", "Methylbenzene"], mw: 92.14, density: 0.867, defaultRole: "Solvent" },
  { commonName: "Chloroform", aliases: ["CHCl3"], mw: 119.38, density: 1.489, defaultRole: "Solvent" },
  { commonName: "1,4-Dioxane", aliases: ["Dioxane"], mw: 88.11, density: 1.034, defaultRole: "Solvent" },
  { commonName: "Dimethyl Sulfoxide", aliases: ["DMSO"], mw: 78.13, density: 1.1, defaultRole: "Solvent" },
  { commonName: "Water", aliases: ["H2O"], mw: 18.02, density: 0.997, defaultRole: "Solvent" },

  // --- Reagents ---------------------------------------------------------
  { commonName: "Triethylamine", aliases: ["TEA", "Et3N", "NEt3"], mw: 101.19, density: 0.726, defaultRole: "Reagent" },
  { commonName: "N,N-Diisopropylethylamine", aliases: ["DIPEA", "DIEA", "Hünig's base", "iPr2NEt"], mw: 129.24, density: 0.742, defaultRole: "Reagent" },
  { commonName: "Pyridine", aliases: ["Py"], mw: 79.1, density: 0.982, defaultRole: "Reagent" },
  { commonName: "Acetic Acid", aliases: ["AcOH", "HOAc"], mw: 60.05, density: 1.049, defaultRole: "Reagent" },
  { commonName: "Trifluoroacetic Acid", aliases: ["TFA"], mw: 114.02, density: 1.489, defaultRole: "Reagent" },
  { commonName: "Thionyl Chloride", aliases: ["SOCl2"], mw: 118.97, density: 1.638, defaultRole: "Reagent" },
  { commonName: "Benzyl Bromide", aliases: ["BnBr"], mw: 171.03, density: 1.438, defaultRole: "Reagent" },
  { commonName: "Di-tert-butyl Dicarbonate", aliases: ["Boc2O", "(Boc)2O", "Boc anhydride"], mw: 218.25, density: 0.95, defaultRole: "Reagent" },
  { commonName: "Sodium Hydride", aliases: ["NaH"], mw: 24.0, defaultRole: "Reagent" },
  { commonName: "N-Bromosuccinimide", aliases: ["NBS"], mw: 177.98, defaultRole: "Reagent" },
  { commonName: "4-Dimethylaminopyridine", aliases: ["DMAP"], mw: 122.17, defaultRole: "Reagent" },
  { commonName: "Potassium Carbonate", aliases: ["K2CO3"], mw: 138.21, defaultRole: "Reagent" },
  { commonName: "Sodium Borohydride", aliases: ["NaBH4"], mw: 37.83, defaultRole: "Reagent" },
];

// --- Search ---------------------------------------------------------------

/** Lower-case, strip accents. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Letters and digits only, so "N,N-DMF" / "et 2 o" style punctuation never matters. */
const squash = (text: string) => fold(text).replace(/[^a-z0-9]/g, "");

interface Term {
  squashed: string;
  words: string[];
}

interface IndexedEntry {
  entry: ChemicalEntry;
  terms: Term[];
}

const toTerm = (text: string): Term => ({
  squashed: squash(text),
  words: fold(text).split(/[^a-z0-9]+/).filter(Boolean),
});

const INDEX: readonly IndexedEntry[] = CHEMICAL_DICTIONARY.map((entry) => ({
  entry,
  terms: [entry.commonName, ...entry.aliases].map(toTerm),
}));

/** Every name/alias in the dictionary, squashed - used to hide duplicate PubChem hits. */
const KNOWN_NAMES = new Set(INDEX.flatMap((i) => i.terms.map((t) => t.squashed)));

export function isDictionaryName(name: string): boolean {
  return KNOWN_NAMES.has(squash(name));
}

/** Lower is better; Infinity = no match. */
function scoreTerm(query: string, term: Term): number {
  if (term.squashed === query) return 0; // exact: "DCM", "thf"
  if (term.squashed.startsWith(query)) return 1; // prefix: "dichlor"
  if (term.words.some((w) => w.startsWith(query))) return 2; // word start: "ether" -> Diethyl Ether
  return Infinity;
}

/**
 * Find local entries for what the user typed, best matches first.
 * Matches the common name and every alias; a single typed character only
 * matches the start of a name so the list stays short.
 */
export function searchDictionary(query: string, limit = 5): ChemicalEntry[] {
  const q = squash(query);
  if (q.length === 0) return [];
  const maxScore = q.length === 1 ? 1 : 2;

  const hits: { entry: ChemicalEntry; score: number; order: number }[] = [];
  INDEX.forEach(({ entry, terms }, order) => {
    const score = Math.min(...terms.map((t) => scoreTerm(q, t)));
    if (score <= maxScore) hits.push({ entry, score, order });
  });

  return hits
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((h) => h.entry);
}

// --- Name formatting --------------------------------------------------------

/** Structural prefixes that conventionally stay lower-case: tert-Butyl, p-Toluenesulfonic ... */
const LOWERCASE_PREFIX = /^(?:tert|sec|cis|trans|rac|meso|endo|exo|syn|anti|o|m|p)-/;

/** Upper-case the first letter of a word, leaving any leading locants / prefixes alone. */
function capitaliseWord(word: string, extraPrefix = false): string {
  // dCMP, iPr2NEt, tBu ... a lower-case letter followed by a capital is deliberate.
  if (/^[a-z][A-Z]/.test(word)) return word;

  let start = 0;
  const prefix = LOWERCASE_PREFIX.exec(word) ?? (extraPrefix ? /^n-/.exec(word) : null);
  if (prefix) start = prefix[0].length;

  const rest = word.slice(start);
  const at = rest.search(/[a-z]/i);
  if (at < 0) return word;
  return word.slice(0, start) + rest.slice(0, at) + rest[at].toUpperCase() + rest.slice(at + 1);
}

/**
 * Clean Title Case for chemical names.
 *
 * PubChem often returns names in ALL CAPS ("BENZYL BROMIDE") or all lower
 * case. Those are re-cased word by word: "Benzyl Bromide", "N,N-Dimethylformamide",
 * "tert-Butyl Alcohol", "Di-tert-butyl Dicarbonate". Names that already mix
 * upper and lower case are treated as deliberately written and only get each
 * word's first letter capitalised, so IUPAC-style casing such as
 * "2-(4-Aminophenyl)ethanol" is never mangled.
 */
export function formatChemicalName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean === "") return "";

  const hasUpper = /[A-Z]/.test(clean);
  const hasLower = /[a-z]/.test(clean);

  if (hasUpper && hasLower) {
    return clean.split(" ").map((w) => capitaliseWord(w)).join(" ");
  }

  // ALL CAPS: "N-" / "N,N-" are element locants and stay upper case.
  // all lower: a leading "n-" is the normal-chain prefix (n-butanol) and stays lower case.
  const allCaps = hasUpper;
  return clean
    .toLowerCase()
    .split(" ")
    .map((word) => {
      const locant = allCaps ? /^n(?:,n)*-/.exec(word) : null;
      if (locant) {
        const upper = locant[0].toUpperCase();
        return upper + capitaliseWord(word.slice(locant[0].length));
      }
      return capitaliseWord(word, !allCaps);
    })
    .join(" ");
}
