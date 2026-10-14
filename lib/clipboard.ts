import { invoke } from "@tauri-apps/api/core";
import { readText, writeHtml, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { cleanClipboardText, isValidChemicalText } from "./chemText";
import { isTauri } from "./tauri";

/**
 * Copy plain text. Uses the Tauri clipboard plugin on desktop (the webview's own
 * clipboard API is unreliable there) and `navigator.clipboard` in a normal browser.
 * Rejects if the copy fails, so callers can show an error.
 */
export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/** The webview's own `navigator.clipboard.readText`, saved before the bridge replaces it. */
let nativeReadText: (() => Promise<string>) | null = null;

/** How long the webview's own clipboard read may take (it can wait on a permission prompt). */
const NATIVE_READ_TIMEOUT_MS = 1500;

/**
 * Read the clipboard as text for the sketcher's paste, trying in order:
 *
 * 1. The Tauri clipboard plugin's `readText()` (desktop only). Valid chemical text, such as the
 *    SMILES from ChemDraw's Ctrl+Alt+C, is returned straight away.
 * 2. The webview's own `navigator.clipboard.readText()`, in case the plugin failed.
 * 3. Only if neither produced a valid structure, the native `read_chemdraw_clipboard` command,
 *    which reads ChemDraw's custom Windows clipboard formats (a plain Ctrl+C leaves the text slot
 *    empty).
 *
 * Every step has its own try/catch: a failing step (plugin error, permission refusal, command
 * missing or erroring) just moves on to the next, and this never throws. Without a valid
 * structure it returns whatever text was found, or "".
 */
export async function readClipboardText(): Promise<string> {
  const desktop = isTauri();
  let found = "";
  const consider = (text: string | null | undefined): string | null => {
    const cleaned = cleanClipboardText(text ?? "");
    if (isValidChemicalText(cleaned)) return cleaned;
    if (found === "" && cleaned.trim() !== "") found = cleaned;
    return null;
  };

  // Step A: the Tauri plugin.
  if (desktop) {
    try {
      const valid = consider(await readText());
      if (valid) return valid;
    } catch {
      // Empty clipboard, or one that holds no text.
    }
  }

  // Step B: the webview's own clipboard API (the original, not the bridge's replacement).
  try {
    const read = nativeReadText ?? navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (read) {
      const text = await Promise.race([
        read(),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), NATIVE_READ_TIMEOUT_MS)),
      ]);
      const valid = consider(text);
      if (valid) return valid;
    }
  } catch {
    // Permission refused or no clipboard API.
  }

  // Step C: ChemDraw's own clipboard formats (Windows desktop).
  if (desktop) {
    try {
      const valid = consider(await invoke<string | null>("read_chemdraw_clipboard"));
      if (valid) return valid;
    } catch (err) {
      console.warn("ChemDraw clipboard invoke failed:", err);
    }
  }

  return found;
}

/** Copy rich text (e.g. a publication string with italics / subscripts) plus a plain-text fallback. */
export async function copyHtml(html: string, plainText?: string): Promise<void> {
  if (isTauri()) {
    await writeHtml(html, plainText ?? htmlToText(html));
    return;
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plainText ?? htmlToText(html)], { type: "text/plain" }),
    }),
  ]);
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}

let bridgeInstalled = false;

/**
 * Route `navigator.clipboard` through the Tauri clipboard plugin. The webview's own clipboard
 * API is unreliable on desktop (it can fail outright or ask for a permission), and two parts
 * of the app depend on it:
 *
 * - Copying: NMRium (via `clipboard-polyfill`) uses `write()` / `writeText()`, so its "Copy
 *   publication string" silently fell back to a preview dialog.
 * - Pasting: Ketcher's Ctrl+V calls `navigator.clipboard.read()` (and a user script might call
 *   `readText()`), so pasting a copied SMILES / CDXML into the sketcher did nothing.
 *
 * In Tauri, `writeText`, `write`, `readText` and `read` are replaced with versions that use the
 * plugin. Anything the plugin can't take when writing (e.g. NMRium's PNG export) is passed to
 * the original implementation untouched. Reading only supports text, which is all a structure
 * paste needs. No-op in a normal browser, where the real API works.
 *
 * Install this once on app load, before NMRium's first copy: the polyfill captures the methods
 * the first time it is loaded.
 */
export function installClipboardBridge() {
  if (bridgeInstalled || typeof window === "undefined" || !isTauri() || !navigator.clipboard) return;
  bridgeInstalled = true;

  const clipboard = navigator.clipboard;
  const originalWrite = clipboard.write?.bind(clipboard);
  nativeReadText = clipboard.readText?.bind(clipboard) ?? null; // kept for `readClipboardText`

  const override = (name: "writeText" | "write" | "readText" | "read", value: unknown) =>
    Object.defineProperty(clipboard, name, { value, configurable: true, writable: true });

  override("writeText", (text: string) => writeText(text));

  // The plugin rejects when the clipboard is empty or holds something that isn't text; the
  // browser API answers "" / [] in that case, so do the same instead of throwing.
  const readPlainText = async () => {
    try {
      return await readText();
    } catch {
      return "";
    }
  };
  override("readText", readPlainText);
  override("read", async () => {
    const text = await readPlainText();
    return text === ""
      ? []
      : [new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })];
  });

  override("write", async (items: ClipboardItem[]) => {
    for (const item of items) {
      const readType = async (type: string) =>
        item.types.includes(type) ? await (await item.getType(type)).text() : null;
      const html = await readType("text/html");
      const plain = await readType("text/plain");
      if (html !== null) {
        await writeHtml(html, plain ?? htmlToText(html));
        return;
      }
      if (plain !== null) {
        await writeText(plain);
        return;
      }
    }
    if (originalWrite) await originalWrite(items);
  });
}