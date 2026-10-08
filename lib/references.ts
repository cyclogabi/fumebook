import { uid, type Reference } from "./types";

/** Strip "doi:" / "https://doi.org/" prefixes and whitespace: "10.1021/ja01234a001". */
export function cleanDoi(input: string): string {
  return input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/**
 * Returns the URL only if it is a plain http(s) link. References come from user
 * input and imported backup files, so `javascript:` and similar must never
 * reach an href.
 */
export function safeHttpUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Best link for a reference: explicit URL first, else the DOI resolver. */
export function referenceHref(ref: Reference): string | null {
  const direct = safeHttpUrl(ref.url);
  if (direct) return direct;
  const doi = cleanDoi(ref.doi);
  return doi ? `https://doi.org/${encodeURI(doi)}` : null;
}

/** Build a clean Reference from raw form input, or null if there is nothing to store. */
export function buildReference(input: { title: string; doi: string; url: string }): Reference | null {
  const title = input.title.trim();
  const doi = cleanDoi(input.doi);
  const rawUrl = input.url.trim();
  if (!title && !doi && !rawUrl) return null;
  return { id: uid(), title, doi, url: rawUrl ? (safeHttpUrl(rawUrl) ?? rawUrl) : "" };
}
