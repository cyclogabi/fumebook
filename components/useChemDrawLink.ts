"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadSchemeCdxml, saveSchemeCdxml, schemeCdxmlModified } from "@/lib/storage";
import { isTauri } from "@/lib/tauri";

/**
 * A valid, empty ChemDraw document: ChemDraw opens it as a blank page. Used when there is nothing
 * drawn yet and no earlier `scheme.cdxml`.
 */
export const BLANK_CDXML = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >
<CDXML
 CreationProgram="Fumebook"
 BoundingBox="0 0 540 720"
 BondLength="14.4"
 BoldWidth="2"
 LineWidth="0.6"
 MarginWidth="1.6"
 HashSpacing="2.5"
 LabelFont="3"
 LabelSize="10"
 LabelFace="96"
 CaptionFont="4"
 CaptionSize="10"
 PrintMargins="36 36 36 36"
 ><colortable>
<color r="1" g="1" b="1"/>
<color r="0" g="0" b="0"/>
</colortable><fonttable>
<font id="3" charset="iso-8859-1" name="Arial"/>
<font id="4" charset="iso-8859-1" name="Times New Roman"/>
</fonttable><page
 id="1"
 BoundingBox="0 0 540 720"
 HeightPages="1"
 WidthPages="1"
 /></CDXML>
`;

/** Whether a CDXML document has anything on its page (a blank one is how ChemDraw shows "cleared"). */
export function hasCdxmlContent(cdxml: string): boolean {
  return /<(fragment|arrow|t|graphic|bioshape|curve|embeddedobject)[\s>/]/.test(cdxml);
}

interface Options {
  experimentId: string;
  /** The drawing as CDXML, or "" when the canvas is blank. */
  getCdxml: () => Promise<string>;
  /** Replace the drawing with this CDXML (a blank document clears the canvas). */
  loadCdxml: (cdxml: string) => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Edit in ChemDraw": the drawing goes to `Documents/Fumebook/attachments/[id]/scheme.cdxml`, the
 * default app for .cdxml files opens it (the Rust command `open_in_chemdraw`), and when the window
 * regains focus after ChemDraw saved the file (Ctrl+S) the sketcher is updated from it.
 *
 * Only on the desktop app; `supported` is false in a plain browser.
 */
export function useChemDrawLink({ experimentId, getCdxml, loadCdxml, onNotice, onError }: Options) {
  const supported = isTauri();
  const [busy, setBusy] = useState<"open" | "reload" | null>(null);

  /** Modification time of scheme.cdxml the last time we wrote it or read it; null = not yet this session. */
  const syncedMs = useRef<number | null>(null);
  /** Set once ChemDraw has been opened from here: only then does regaining focus check the file. */
  const linked = useRef(false);
  const working = useRef(false);

  const latest = useRef({ experimentId, getCdxml, loadCdxml, onNotice, onError });
  useEffect(() => {
    latest.current = { experimentId, getCdxml, loadCdxml, onNotice, onError };
  });

  /** Read scheme.cdxml into the sketcher. Returns false if there was nothing (valid) to load. */
  const pull = useCallback(async (manual: boolean): Promise<boolean> => {
    const { experimentId: id, loadCdxml: load, onNotice: notice, onError: fail } = latest.current;
    try {
      const file = await loadSchemeCdxml(id);
      if (!file) {
        if (manual) notice("There is no ChemDraw file for this experiment yet. Click “Open in ChemDraw” first.");
        return false;
      }
      // Remember the version we are reading, so a failure below is not retried on every focus.
      syncedMs.current = file.modifiedMs;
      if (!/<CDXML[\s>]/.test(file.text)) {
        fail(`${file.path} is not a CDXML document, so the drawing was left as it is.`);
        return false;
      }
      await load(file.text);
      notice(
        manual
          ? "Reloaded the drawing from ChemDraw."
          : "The drawing was updated from ChemDraw (the saved scheme.cdxml).",
      );
      return true;
    } catch (err) {
      fail(`Could not read the drawing from ChemDraw: ${messageOf(err)}`);
      return false;
    }
  }, []);

  const reload = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    setBusy("reload");
    try {
      await pull(true);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [pull]);

  const open = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    setBusy("open");
    const { experimentId: id, getCdxml: read, onNotice: notice, onError: fail } = latest.current;
    try {
      let target: string;

      // ChemDraw edits that were saved but not brought in yet win: never overwrite them.
      const modified = await schemeCdxmlModified(id);
      const unsynced = modified !== null && syncedMs.current !== null && modified > syncedMs.current;
      const existing = modified === null ? null : await loadSchemeCdxml(id);

      if (unsynced && existing) {
        await pull(false);
        target = existing.path;
      } else {
        const drawn = await read();
        if (drawn.trim() === "" && existing) {
          // Nothing drawn here: reopen what ChemDraw saved last time, untouched.
          target = existing.path;
          syncedMs.current = existing.modifiedMs;
        } else {
          const saved = await saveSchemeCdxml(id, drawn.trim() === "" ? BLANK_CDXML : drawn);
          target = saved.path;
          syncedMs.current = saved.modifiedMs;
        }
      }

      await invoke("open_in_chemdraw", { path: target });
      linked.current = true;
      notice(
        `Opened ${target} in ChemDraw. Edit, press Ctrl+S, then come back: the drawing updates here by itself (or use “Reload from ChemDraw”).`,
      );
    } catch (err) {
      fail(`Could not open ChemDraw: ${messageOf(err)}`);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [pull]);

  // Back in Fumebook after ChemDraw saved: pick the change up.
  useEffect(() => {
    if (!supported) return;
    let checking = false;
    const check = async () => {
      if (!linked.current || working.current || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const modified = await schemeCdxmlModified(latest.current.experimentId);
        if (modified !== null && syncedMs.current !== null && modified > syncedMs.current) {
          working.current = true;
          setBusy("reload");
          try {
            await pull(false);
          } finally {
            working.current = false;
            setBusy(null);
          }
        }
      } catch (err) {
        console.warn("Checking scheme.cdxml failed:", err);
      } finally {
        checking = false;
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [supported, pull]);

  return { supported, busy, open, reload };
}
