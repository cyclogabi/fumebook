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
