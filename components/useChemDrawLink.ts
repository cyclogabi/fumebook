"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isFileLocked,
  loadSchemeCdxml,
  saveSchemeCdxml,
  schemeCdxmlModified,
  schemeCdxmlPath,
  type CdxmlSlot,
  type SchemeCdxmlFile,
} from "@/lib/storage";
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
  return /<(fragment|arrow|t|graphic|bioshape|curve|embeddedobject|n|b)[\s>/]/i.test(cdxml);
}

interface Options {
  experimentId: string;
  /** Which file inside `attachments/[id]/` to sync (`scheme.cdxml`, `reactant.cdxml`, or `product.cdxml`). */
  slot?: CdxmlSlot;
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
export function useChemDrawLink({
  experimentId,
  slot = "scheme",
  getCdxml,
  loadCdxml,
  onNotice,
  onError,
}: Options) {
  const supported = isTauri();
  const [busy, setBusy] = useState<"open" | "reload" | null>(null);
  const currentKey = `${experimentId}:${slot}`;
  const [watchingKey, setWatchingKey] = useState<string | null>(null);
  const [justUpdatedKey, setJustUpdatedKey] = useState<string | null>(null);
  const watching = watchingKey === currentKey;
  const justUpdated = justUpdatedKey === currentKey;
  const updatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Modification time of scheme.cdxml the last time we wrote it or read it; null = not yet this session. */
  const syncedMs = useRef<number | null>(null);
  /** Last CDXML text synced with the sketcher/zone, to avoid redundant reloads. */
  const lastText = useRef<string | null>(null);
  /** Set once ChemDraw has been opened from here: only then does regaining focus / polling check the file. */
  const linked = useRef(false);
  const working = useRef(false);

  const latest = useRef({ experimentId, slot, getCdxml, loadCdxml, onNotice, onError });
  useEffect(() => {
    latest.current = { experimentId, slot, getCdxml, loadCdxml, onNotice, onError };
  });

  useEffect(() => {
    linked.current = false;
    syncedMs.current = null;
    lastText.current = null;
    return () => {
      if (updatedTimerRef.current) {
        clearTimeout(updatedTimerRef.current);
        updatedTimerRef.current = null;
      }
    };
  }, [experimentId, slot]);

  const stopWatching = useCallback(() => {
    linked.current = false;
    setWatchingKey(null);
    setJustUpdatedKey(null);
    if (updatedTimerRef.current) {
      clearTimeout(updatedTimerRef.current);
      updatedTimerRef.current = null;
    }
  }, []);

  /** Read scheme.cdxml into the sketcher. Returns false if there was nothing (valid) to load. */
  const pull = useCallback(async (manual: boolean): Promise<boolean> => {
    const {
      experimentId: id,
      slot: s,
      loadCdxml: load,
      onNotice: notice,
      onError: fail,
    } = latest.current;
    try {
      const file = await loadSchemeCdxml(id, s);
      if (!file) {
        if (manual) {
          notice("There is no ChemDraw file for this experiment yet. Click “Open in ChemDraw” first.");
        }
        return false;
      }
      if (!/<CDXML[\s>]/i.test(file.text)) {
        syncedMs.current = file.modifiedMs;
        fail(`${file.path} is not a CDXML document, so the drawing was left as it is.`);
        return false;
      }
      syncedMs.current = file.modifiedMs;
      const changed = lastText.current === null || lastText.current.trim() !== file.text.trim();
      lastText.current = file.text;
      if (!changed && !manual) {
        return true;
      }
      await load(file.text);

      // Automatically stop watching once the updated structure has been loaded, and show a 2-second confirmation pill.
      linked.current = false;
      setWatchingKey(null);
      setJustUpdatedKey(`${id}:${s}`);
      if (updatedTimerRef.current) clearTimeout(updatedTimerRef.current);
      updatedTimerRef.current = setTimeout(() => {
        setJustUpdatedKey(null);
        updatedTimerRef.current = null;
      }, 2000);

      notice(
        manual
          ? "Reloaded the drawing from ChemDraw."
          : `Updated ${s} structure and MW from ChemDraw ✓`,
      );
      return true;
    } catch (err) {
      // If ChemDraw is still flushing the file during an automatic background poll,
      // stay quiet and let the next poll tick retry without advancing syncedMs.
      if (!manual && isFileLocked(err)) {
        return false;
      }
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
    const {
      experimentId: id,
      slot: s,
      getCdxml: read,
      onNotice: notice,
      onError: fail,
    } = latest.current;
    try {
      let target: string;

      let modified: number | null = null;
      try {
        modified = await schemeCdxmlModified(id, s);
      } catch (err) {
        if (!isFileLocked(err)) throw err;
      }

      let existing: SchemeCdxmlFile | null = null;
      let existingLockedByChemDraw = false;
      if (modified !== null) {
        try {
          existing = await loadSchemeCdxml(id, s);
        } catch (err) {
          if (isFileLocked(err)) {
            existingLockedByChemDraw = true;
          } else {
            throw err;
          }
        }
      }

      const unsynced =
        modified !== null && syncedMs.current !== null && modified > syncedMs.current;

      if (existingLockedByChemDraw) {
        // The file is already open and locked in ChemDraw: reuse its path without overwriting.
        target = await schemeCdxmlPath(id, s);
        if (modified !== null) syncedMs.current = modified;
      } else if (unsynced && existing) {
        await pull(false);
        target = existing.path;
      } else {
        const drawn = await read();
        const desiredXml = drawn.trim() === "" ? BLANK_CDXML : drawn;

        if (existing && (drawn.trim() === "" || existing.text.trim() === desiredXml.trim())) {
          // File on disk already has the structure (or we have nothing new to overwrite it with):
          // avoid touching the file so an already-open ChemDraw window never hits os error 32.
          target = existing.path;
          syncedMs.current = existing.modifiedMs;
          lastText.current = existing.text;
        } else {
          try {
            const saved = await saveSchemeCdxml(id, desiredXml, s);
            target = saved.path;
            syncedMs.current = saved.modifiedMs;
            lastText.current = desiredXml;
          } catch (err) {
            if (isFileLocked(err) && (existing || modified !== null)) {
              // ChemDraw currently holds an open handle on this file; focus/reopen the existing file.
              target = existing ? existing.path : await schemeCdxmlPath(id, s);
              syncedMs.current = existing ? existing.modifiedMs : modified;
            } else {
              throw err;
            }
          }
        }
      }

      await invoke("open_in_chemdraw", { path: target });
      linked.current = true;
      setJustUpdatedKey(null);
      setWatchingKey(`${id}:${s}`);
      notice(
        `Opened ${target} in ChemDraw. Edit and press Ctrl+S — the structure and MW update automatically.`,
      );
    } catch (err) {
      fail(`Could not open ChemDraw: ${messageOf(err)}`);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [pull]);

  // Live file watcher: check on focus, visibilitychange, and every 750ms while watching is active.
  useEffect(() => {
    if (!supported) return;
    let checking = false;
    const check = async () => {
      if (!linked.current || working.current || checking) return;
      checking = true;
      try {
        const modified = await schemeCdxmlModified(
          latest.current.experimentId,
          latest.current.slot,
        );
        if (
          modified !== null &&
          (syncedMs.current === null || modified > syncedMs.current)
        ) {
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
        if (!isFileLocked(err)) {
          console.warn("Checking scheme.cdxml failed:", err);
        }
      } finally {
        checking = false;
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const interval = watching ? window.setInterval(() => void check(), 750) : null;
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [supported, watching, pull]);

  return { supported, busy, watching, justUpdated, open, reload, stopWatching };
}
