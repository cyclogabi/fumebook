/**
 * Minimal PubChem PUG-REST client (free, no API key, CORS-enabled).
 * https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
 */

const BASE = "https://pubchem.ncbi.nlm.nih.gov/rest";

/** The compound name is unknown to PubChem (HTTP 404). */
export class PubChemNotFoundError extends Error {
  constructor(name: string) {
    super(`PubChem has no compound named "${name}".`);
    this.name = "PubChemNotFoundError";
  }
}

// Small per-session caches: re-typing a query or re-picking a compound costs no request.
const suggestionCache = new Map<string, string[]>();
const mwCache = new Map<string, number>();

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PubChem request failed (HTTP ${response.status}).`);
  return response.json();
}

/** Name suggestions for a partial query, e.g. "benzyl bro" -> ["BENZYL BROMIDE", ...]. */
export async function fetchSuggestions(
  query: string,
  signal?: AbortSignal,
  limit = 8,
): Promise<string[]> {
  const key = query.trim().toLowerCase();
  const cached = suggestionCache.get(key);
  if (cached) return cached;

  const data = (await getJson(
    `${BASE}/autocomplete/compound/${encodeURIComponent(query.trim())}/json?limit=${limit}`,
    signal,
  )) as { dictionary_terms?: { compound?: unknown } } | null;

  const terms = data?.dictionary_terms?.compound;
  const suggestions = Array.isArray(terms)
    ? terms.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  suggestionCache.set(key, suggestions);
  return suggestions;
}

/** Exact molecular weight (g/mol) of the compound with this name. */
export async function fetchMolecularWeight(
  name: string,
  signal?: AbortSignal,
): Promise<number> {
  const key = name.trim().toLowerCase();
  const cached = mwCache.get(key);
  if (cached !== undefined) return cached;

  const data = (await getJson(
    `${BASE}/pug/compound/name/${encodeURIComponent(name.trim())}/property/MolecularWeight/JSON`,
    signal,
  )) as { PropertyTable?: { Properties?: { MolecularWeight?: unknown }[] } } | null;

  if (data === null) throw new PubChemNotFoundError(name);

  // PubChem returns MolecularWeight as a string ("171.03"); older payloads used numbers.
  const raw = data.PropertyTable?.Properties?.[0]?.MolecularWeight;
  const mw = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(mw) || mw <= 0) {
    throw new Error(`PubChem returned no molecular weight for "${name}".`);
  }
  mwCache.set(key, mw);
  return mw;
}

export interface PubChemCompoundRecord {
  smiles: string;
  mw: number | null;
  iupacName?: string;
}

const recordCache = new Map<string, PubChemCompoundRecord | null>();

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/**
 * SMILES, molecular weight, and IUPAC name for a chemical name or CAS number.
 * `null` when PubChem has no record. Tries the current property names, then the older ones.
 */
export async function fetchPubChemCompound(
  name: string,
  signal?: AbortSignal,
): Promise<PubChemCompoundRecord | null> {
  const query = name.trim();
  if (!query) return null;
  const key = query.toLowerCase();
  if (recordCache.has(key)) return recordCache.get(key) ?? null;

  const propertySets = [
    "CanonicalSMILES,IsomericSMILES,MolecularWeight,IUPACName",
    "ConnectivitySMILES,SMILES,MolecularWeight,IUPACName",
  ];
  let record: PubChemCompoundRecord | null = null;
  for (const properties of propertySets) {
    const url = `${BASE}/pug/compound/name/${encodeURIComponent(query)}/property/${properties}/JSON`;
    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error("Could not reach PubChem.");
    }
    if (response.status === 404) break;
    if (response.status === 400) continue;
    if (!response.ok) throw new Error(`PubChem request failed (HTTP ${response.status}).`);
    const data = (await response.json()) as {
      PropertyTable?: { Properties?: Record<string, unknown>[] };
    };
    const row = data.PropertyTable?.Properties?.[0];
    if (!row) continue;
    const smiles = firstString(row, [
      "CanonicalSMILES",
      "IsomericSMILES",
      "ConnectivitySMILES",
      "SMILES",
    ]);
    if (!smiles) continue;
    const rawMw = row.MolecularWeight;
    const mw = typeof rawMw === "number" ? rawMw : parseFloat(String(rawMw ?? ""));
    const iupacName = firstString(row, ["IUPACName"]);
    record = {
      smiles,
      mw: Number.isFinite(mw) && mw > 0 ? mw : null,
      ...(iupacName ? { iupacName } : {}),
    };
    break;
  }
  recordCache.set(key, record);
  return record;
}

/** PubChem's rendered structure as a PNG data URL, or null when the name is unknown. */
export async function fetchPubChemPngDataUrl(
  name: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const query = name.trim();
  if (!query) return null;
  const url = `${BASE}/pug/compound/name/${encodeURIComponent(query)}/PNG?image_size=400x400`;
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error("Could not reach PubChem.");
  }
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.size) return null;
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => reject(new Error("Could not read the PubChem structure image."));
    reader.readAsDataURL(blob);
  });
}
