"use client";

import { init } from "@zakodium/nmrium-core-plugins";
import { NMRium, type NMRiumChangeCb, type NMRiumProps, type NMRiumRefAPI } from "nmrium";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import { installClipboardBridge } from "@/lib/clipboard";
import { collectDroppedFiles, dragHasFiles } from "@/lib/dropFolders";
import { autoPhaseAndBaselinePlugin } from "@/lib/nmrAutoProcessing";
import { loadNmrState, saveNmrState } from "@/lib/storage";
import "./nmr-room.css";

/**
 * Lives in its own module so that NMRium *and* its stylesheets (Blueprint +
 * preflight isolation, see nmr-room.css) are one lazily loaded chunk, only
 * fetched when the NMR room is opened. Import it via `next/dynamic` only.
 *
 * Persistence: the workspace (spectra, peak picks, integrals, assignments,
 * molecules, view) is serialized to NMRium's JSON format and autosaved through
 * `saveNmrState` (debounced), then restored through `loadNmrState` on mount.
 */

/**
 * One core instance, shared by NMRium and our (de)serialisation so versions always match.
 * Raw FIDs (Bruker / TopSpin, JEOL...) are opened with NMRium's standard auto-processing plus
 * automatic phasing and a baseline correction (see lib/nmrAutoProcessing.ts).
 */
const core = init([autoPhaseAndBaselinePlugin()]);

// NMRium copies through `navigator.clipboard`, which the desktop webview blocks. Route it
// through the Tauri clipboard plugin. Must run before NMRium first copies (it loads its
// clipboard helper lazily on first use), so do it as soon as this chunk is evaluated.
// Also installed on app load (ElnApp); this is idempotent and guarantees it before NMRium's first copy.
installClipboardBridge();

const SAVE_DEBOUNCE_MS = 1000;

/**
 * Ketcher (the reaction editor behind this room) also listens for keys on `document` and, for
 * every key it knows (P, R, I, ... are all amino-acid codes to it), calls
 * stopImmediatePropagation() so NMRium's own document listener never fires; its hidden
 * sequence editor even throws `AssertionError: undefined == true`. Ketcher skips keys whose
 * target is an <input>, while NMRium only skips *text* inputs (see ignoreElement in its
 * KeysListenerTracker).
 *
 * So, as a callback ref on the wrapper: catch keydowns natively before they reach `document`
 * (React's own listener sits there too, so a React handler cannot keep them from Ketcher),
 * swallow the original and replay a copy from a hidden checkbox. Ketcher ignores the copy,
 * NMRium handles it.
 */
function shieldKeysFromKetcher(
  wrapper: HTMLDivElement | null,
  ownShortcut: { current: ((e: KeyboardEvent) => boolean) | null },
  pointerInside: { current: boolean },
) {
  if (!wrapper) return;

  const onKeyDown = (e: KeyboardEvent) => {
    const sink = wrapper.querySelector<HTMLInputElement>("input[data-key-sink]");
    const target = e.target;
    if (!sink || !(target instanceof HTMLElement) || target === sink) return; // already the copy
    // NMRium reacts to keys while the pointer is over it, whatever has focus (clicking the
    // spectrum can leave focus on <body>), so "in the workspace" means focus OR pointer.
    if (!wrapper.contains(target) && !pointerInside.current) return;

    const isTextField =
      target.isContentEditable ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      (target instanceof HTMLInputElement && !["checkbox", "radio"].includes(target.type));
    if (isTextField) return; // typing into a field: neither library reacts to it

    // Shortcuts NMRium doesn't have (Undo / Redo): handled by the workspace itself.
    if (ownShortcut.current?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const { key, code, location, repeat, ctrlKey, shiftKey, altKey, metaKey } = e;
    const replay = new KeyboardEvent("keydown", {
      key,
      code,
      location,
      repeat,
      ctrlKey,
      shiftKey,
      altKey,
      metaKey,
      bubbles: true,
      cancelable: true,
    });
    e.stopPropagation(); // the original stops here, so Ketcher never sees it
    sink.dispatchEvent(replay);
    if (replay.defaultPrevented) e.preventDefault(); // e.g. NMRium claimed Ctrl+Z
  };

  // Capture phase on `window`: runs before every document-level listener, Ketcher's included.
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}

export type NmrSaveStatus =
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

interface Props {
  experimentId: string;
  onSaveStatus?: (status: NmrSaveStatus) => void;
}

type NmriumState = Parameters<NMRiumChangeCb>[0];
type InitialWorkspace = Pick<NMRiumProps, "state" | "aggregator">;

/** Typed arrays (spectra data) don't survive JSON.stringify, so turn them into plain arrays. */
function jsonReplacer(_key: string, value: unknown) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return value;
}

function serialize(state: NmriumState): string {
  // `actionType` is only meant for onChange consumers, not for the saved file.
  const { actionType: _actionType, ...data } = state.data as NmriumState["data"] & {
    actionType?: string;
  };
  void _actionType;
  const serialized = core.serializeNmriumState(
    { ...state, data },
    { includeData: "rawData", includeView: true, includeSettings: true },
  );
  return JSON.stringify(serialized, jsonReplacer);
}

/**
 * The part of the workspace Undo / Redo works on: spectra, peaks, integrals, ranges,
 * assignments, molecules. View (zoom, panels) and settings are deliberately left out, so
 * undoing a peak pick doesn't also reset the zoom; they are taken from the live state instead.
 */
function serializeData(state: NmriumState): string {
  const { actionType: _actionType, ...data } = state.data as NmriumState["data"] & {
    actionType?: string;
  };
  void _actionType;
  const serialized = core.serializeNmriumState(
    { ...state, data },
    { includeData: "rawData", includeView: false, includeSettings: false },
  );
  return JSON.stringify(serialized, jsonReplacer);
}

const MAX_HISTORY = 30;
/** Ignore "data" events this long after an Undo / Redo: NMRium re-reports the state it was just given. */
const HISTORY_SETTLE_MS = 600;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function NmrWorkspace({ experimentId, onSaveStatus }: Props) {
  const apiRef = useRef<NMRiumRefAPI>(null);
  /** `null` while the saved workspace is being read; NMRium mounts only afterwards. */
  const [initial, setInitial] = useState<InitialWorkspace | null>(null);
  const [dragging, setDragging] = useState(false);

  const statusRef = useRef(onSaveStatus);
  useEffect(() => {
    statusRef.current = onSaveStatus;
  });

  // --- Restore -------------------------------------------------------------------

  /** Whether this experiment already has a workspace on disk (decides if "empty" is worth saving). */
  const hasSavedRef = useRef(false);
  /** True if this session started from a saved workspace... */
  const restoredRef = useRef(false);
  /** ...and whether NMRium has since reported those restored spectra (see handleChange). */
  const restoreSeenRef = useRef(false);
  /** Last text written to (or read from) storage, so an unchanged state doesn't rewrite the file. */
  const lastSavedTextRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text = await loadNmrState(experimentId);
        if (text) {
          // readNMRiumObject migrates old versions and rebuilds spectra / molecules.
          const { state, aggregator } = await core.readNMRiumObject(JSON.parse(text));
          if (cancelled) return;
          hasSavedRef.current = true;
          restoredRef.current = true;
          lastSavedTextRef.current = text;
          // A saved workspace that is genuinely empty has nothing to wait for.
          restoreSeenRef.current = (state.data?.spectra?.length ?? 0) === 0;
          setInitial({ state, aggregator });
          return;
        }
      } catch (err) {
        console.error("Could not restore the NMR workspace:", err);
        statusRef.current?.({
          kind: "error",
          message: `Could not restore the saved NMR workspace: ${messageOf(err)}`,
        });
      }
      if (!cancelled) setInitial({});
    })();
    return () => {
      cancelled = true;
    };
  }, [experimentId]);

  // --- Autosave (debounced) -----------------------------------------------------

  const pendingRef = useRef<NmriumState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  /** Write the latest pending state now. Writes are queued so they can't land out of order. */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const state = pendingRef.current;
    pendingRef.current = null;
    if (!state) return;

    queueRef.current = queueRef.current.then(async () => {
      try {
        const text = serialize(state);
        if (text === lastSavedTextRef.current) return; // nothing actually changed
        await saveNmrState(experimentId, text);
        lastSavedTextRef.current = text;
        hasSavedRef.current = true;
        statusRef.current?.({ kind: "saved", at: new Date() });
      } catch (err) {
        console.error("Could not save the NMR workspace:", err);
        statusRef.current?.({
          kind: "error",
          message: `NMR workspace not saved: ${messageOf(err)}`,
        });
      }
    });
  }, [experimentId]);

  // --- Undo / Redo ----------------------------------------------------------------
  //
  // NMRium 3 has no undo of its own (its `history` slice is an unimplemented @todo), so Ctrl+Z
  // did nothing. We keep snapshots of the data after every "data" change and, on Undo, feed an
  // older one back through the `state` prop, the same path a restore uses.

  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  /** Data snapshot of what's on screen now; null until there is something to undo back to. */
  const currentDataRef = useRef<string | null>(null);
  const latestStateRef = useRef<NmriumState | null>(null);
  const settleUntilRef = useRef(0);

  const trackHistory = useCallback((state: NmriumState, source: "data" | "view" | "settings") => {
    latestStateRef.current = state;
    if (Date.now() < settleUntilRef.current) return;
    const hasSpectra = state.data.spectra.length > 0;

    if (source !== "data") {
      // A file just loaded (it only reports "view"): that's the baseline to undo back to.
      if (currentDataRef.current === null && hasSpectra) currentDataRef.current = serializeData(state);
      return;
    }
    const text = serializeData(state);
    if (text === currentDataRef.current) return;
    if (currentDataRef.current !== null) {
      undoStackRef.current.push(currentDataRef.current);
      if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
    }
    currentDataRef.current = text;
    redoStackRef.current = [];
  }, []);

  /** Show `snapshot` (a serializeData() text), keeping the user's current view and settings. */
  const applySnapshot = async (snapshot: string) => {
    const live = latestStateRef.current;
    const liveParts = live ? JSON.parse(serialize(live)) : {};
    const target = { ...JSON.parse(snapshot), view: liveParts.view, settings: liveParts.settings };
    const { state, aggregator } = await core.readNMRiumObject(target);
    // Same guard as a restore: don't save the transient empty state NMRium reports first.
    restoredRef.current = true;
    restoreSeenRef.current = (state.data?.spectra?.length ?? 0) === 0;
    settleUntilRef.current = Date.now() + HISTORY_SETTLE_MS;
    currentDataRef.current = snapshot;
    setInitial({ state, aggregator });
  };

  const stepHistory = (direction: "undo" | "redo") => {
    const from = direction === "undo" ? undoStackRef.current : redoStackRef.current;
    const to = direction === "undo" ? redoStackRef.current : undoStackRef.current;
    const snapshot = from.pop();
    if (snapshot === undefined) return;
    if (currentDataRef.current !== null) to.push(currentDataRef.current);
    applySnapshot(snapshot).catch((err) => {
      console.error(`Could not ${direction}:`, err);
      statusRef.current?.({ kind: "error", message: `Could not ${direction}: ${messageOf(err)}` });
    });
  };

  const stepHistoryRef = useRef(stepHistory);
  useEffect(() => {
    stepHistoryRef.current = stepHistory;
  });

  /** Ctrl/Cmd+Z = Undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = Redo. Returns true if the key was ours. */
  const ownShortcutRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  useEffect(() => {
    ownShortcutRef.current = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
      const key = e.key.toLowerCase();
      if (key === "z") stepHistoryRef.current(e.shiftKey ? "redo" : "undo");
      else if (key === "y" && !e.shiftKey) stepHistoryRef.current("redo");
      else return false;
      return true;
    };
    return () => {
      ownShortcutRef.current = null;
    };
  }, []);

  const pointerInsideRef = useRef(false);
  const wrapperRef = useCallback(
    (el: HTMLDivElement | null) => shieldKeysFromKetcher(el, ownShortcutRef, pointerInsideRef),
    [],
  );

  // A different experiment starts with a clean history.
  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    currentDataRef.current = null;
    latestStateRef.current = null;
  }, [experimentId]);

  const handleChange = useCallback<NMRiumChangeCb>(
    (state, source) => {
      trackHistory(state, source);
      // Every kind of change is saved: "data" (peaks, integrals, assignments, ...), "view"
      // (molecule size / position, visibility, ...) and "settings" (UI preferences). Loading a
      // file only reports "view". Identical states are dropped at write time (see flush).
      const spectraCount = state.data.spectra.length;

      // After a restore, NMRium first reports an empty state (it mounts before it has applied
      // the restored one). Saving that would wipe the workspace we're trying to restore, so
      // wait until the restored spectra show up.
      if (restoredRef.current && !restoreSeenRef.current) {
        if (spectraCount === 0) return;
        restoreSeenRef.current = true;
      }

      // NMRium also reports its initial empty state on mount; don't create a file for that.
      if (!hasSavedRef.current && spectraCount === 0) return;

      pendingRef.current = state;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush, trackHistory],
  );

  // Closing the room (or switching experiment) inside the debounce window must not lose edits.
  useEffect(() => flush, [flush]);

  // --- Drag & drop (files and whole folders) ------------------------------------
  //
  // NMRium has its own dropzone, but we put a full-size overlay in front of it for the
  // duration of a file drag. That way the drop always reaches our folder-aware traversal,
  // and NMRium's dropzone never sees the drag (so it can't get stuck in its "dragging" state).

  const handleDragEnterCapture = (e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.stopPropagation();
    e.preventDefault();
    setDragging(true);
  };

  const handleOverlayDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleOverlayDragLeave = (e: DragEvent) => {
    // Ignore leaves that merely cross into a child element.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const handleOverlayDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    // Must run synchronously: collectDroppedFiles grabs the entries before its first await.
    collectDroppedFiles(e.dataTransfer)
      .then((files) => {
        if (files.length > 0) apiRef.current?.loadFiles(files);
      })
      .catch((err) => {
        console.error("Could not read the dropped files:", err);
        statusRef.current?.({
          kind: "error",
          message: `Could not read the dropped files: ${messageOf(err)}`,
        });
      });
  };

  if (initial === null) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#a1a1aa" }}>
        Loading saved NMR workspace…
      </div>
    );
  }

  // NMRium's shortcuts (I, P, R, Ctrl+Z, ...) are a document-level keydown listener that
  // ignores keys typed into form fields. Pulling focus onto the workspace as soon as the
  // pointer enters means a previously focused input can't swallow them.
  const handleMouseEnter = (e: MouseEvent<HTMLDivElement>) => {
    pointerInsideRef.current = true;
    const wrapper = e.currentTarget;
    const active = document.activeElement;
    // ...but never steal focus from a field the user is typing into inside NMRium itself.
    const isEditingInside =
      active instanceof HTMLElement &&
      wrapper.contains(active) &&
      active.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])");
    if (!isEditingInside) wrapper.focus({ preventScroll: true });
  };

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => {
        pointerInsideRef.current = false;
      }}
      onDragEnterCapture={handleDragEnterCapture}
      style={{ position: "relative", height: "100%", width: "100%", outline: "none" }}
    >
      <input
        data-key-sink=""
        type="checkbox"
        tabIndex={-1}
        aria-hidden="true"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
      {/* Explicit: the full "default" workspace (peak picking, integration, 2D, …). */}
      <NMRium
        ref={apiRef}
        core={core}
        workspace="default"
        state={initial.state}
        aggregator={initial.aggregator}
        onChange={handleChange}
      />
      {dragging && (
        <div
          onDragOver={handleOverlayDragOver}
          onDragLeave={handleOverlayDragLeave}
          onDrop={handleOverlayDrop}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            background: "rgba(28, 33, 39, 0.45)",
          }}
        >
          <p
            style={{
              pointerEvents: "none",
              margin: 0,
              padding: "12px 24px",
              borderRadius: 999,
              background: "#fff",
              fontWeight: 600,
              color: "#1c2127",
            }}
          >
            Drop spectra files or a Bruker experiment folder
          </p>
        </div>
      )}
    </div>
  );
}
