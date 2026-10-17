"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { Editor } from "ketcher-react";
import "ketcher-react/dist/index.css";
import { readClipboardText } from "@/lib/clipboard";
import { cleanClipboardText, isValidChemicalText } from "@/lib/chemText";
import { prepareForKetcher } from "@/lib/library";
import { saveCdxmlFile } from "@/lib/fileDialogs";
import { blobToDataUrl } from "@/lib/storage";
import { isTauri } from "@/lib/tauri";
import { hasCdxmlContent, useChemDrawLink } from "./useChemDrawLink";
import {
  SKETCHER_HEIGHTS,
  clampSketcherHeight,
  readSketcherHeight,
  saveSketcherHeight,
} from "@/lib/sketcherLayout";

/**
 * Ketcher touches `window`/`document` at import time, so it must never be
 * evaluated on the server. Both packages are therefore imported inside a
 * `next/dynamic` loader with `ssr: false` (this file is a Client Component,
 * which is required for `ssr: false`). Only *types* are imported statically.
 */
type Ketcher = Parameters<NonNullable<ComponentProps<typeof Editor>["onInit"]>>[0];

interface KetcherEditorProps {
  onInit: (ketcher: Ketcher) => void;
  onError: (message: string) => void;
}

const KetcherEditor = dynamic(
  async () => {
    const [{ Editor }, { StandaloneStructServiceProvider }] = await Promise.all([
      import("ketcher-react"),
      import("ketcher-standalone"),
    ]);
    // One provider for the lifetime of the page; keeps Editor props referentially stable.
    const structServiceProvider = new StandaloneStructServiceProvider();

    return function LoadedKetcherEditor({ onInit, onError }: KetcherEditorProps) {
      return (
        <Editor
          staticResourcesUrl=""
          structServiceProvider={structServiceProvider}
          errorHandler={onError}
          disableMacromoleculesEditor
          onInit={onInit}
        />
      );
    };
  },
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center text-sm text-zinc-400">
        Loading drawing tools…
      </div>
    ),
  },
);

/** Rxnfile when a reaction arrow is drawn, Molfile otherwise; "" for a blank canvas. */
async function exportScheme(ketcher: Ketcher): Promise<string> {
  if (ketcher.editor.struct().isBlank()) return "";
  return ketcher.containsReaction() ? ketcher.getRxn() : ketcher.getMolfile();
}

/** Indigo stamps a date/time into every header ("-INDIGO-1008261503"); ignore it when comparing. */
const sameScheme = (a: string, b: string) => {
  const strip = (s: string) => s.replace(/-INDIGO-\s*\d{10}/g, "-INDIGO-");
  return strip(a) === strip(b);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const LOAD_ATTEMPTS = 6;

/** How long after a Ctrl+V key press to wait for the `paste` event before reading the clipboard ourselves. */
const KEY_PASTE_FALLBACK_MS = 150;

const NOT_CHEMICAL_NOTICE =
  "Clipboard does not contain a valid chemical structure. In ChemDraw, use Edit -> Copy As -> SMILES or CDXML, or save and upload the .cdxml file.";

/**
 * Put a structure (MOLfile, SMILES or CDXML) on the canvas: on an empty canvas it becomes the
 * drawing, otherwise it is added next to what is there. This one path serves the Personal Library,
 * "+ Sketch", and Ctrl+V. Ketcher sniffs the format, `prepareForKetcher` makes single-line CDXML
 * look like a file to it.
 */
async function insertIntoKetcher(ketcher: Ketcher, structure: string): Promise<void> {
  const text = prepareForKetcher(structure);
  // No "did anything arrive?" check afterwards: Ketcher updates its structure asynchronously
  // after these promises resolve, so an immediate comparison reports failure for good input.
  // A real parse error reaches the user through Ketcher's own error handler (`onError`).
  if (ketcher.editor.struct().isBlank()) await ketcher.setMolecule(text);
  else await ketcher.addFragment(text);
}

/**
 * The editor Ketcher builds in this configuration. Its typed `editor` is the macromolecule one,
 * but the molecule editor we run (`disableMacromoleculesEditor`) is the ketcher-react `Editor`,
 * which is where zoom lives; `ketcher.setZoom` talks to the macromolecule editor and does nothing here.
 */
interface MoleculeEditor {
  zoom: (value?: number) => number;
  centerViewportAccordingToStruct: () => void;
  struct: () => {
    isBlank: () => boolean;
    getCoordBoundingBox: () => { min: { x: number; y: number }; max: { x: number; y: number } };
  };
  render: {
    options: { microModeScale: number };
    clientArea: { getBoundingClientRect: () => { width: number; height: number } };
  };
  event: { zoomChanged?: { dispatch: () => void } };
}

const MIN_ZOOM = 0.1; // Ketcher's own auto-zoom floor
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
/** Space kept clear around the drawing by "Fit", in pixels. */
const FIT_MARGIN = 40;

/** Fields with their own text editing (Ketcher dialogs, label editors) keep the native paste. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.hasAttribute("data-cliparea")) return false; // Ketcher's hidden paste target
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  );
}

const barButton =
  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50";

/** What the parent can ask of the sketcher (the Ketcher instance itself stays private). */
export interface ReactionCanvasHandle {
  /**
   * Put a structure (MOLfile, SMILES or CDXML) on the canvas: on an empty canvas it simply becomes the
   * drawing; otherwise it is added next to what is already drawn (and selected, ready to move).
   */
  insertStructure: (structure: string) => Promise<void>;
  /** The current drawing as a MOLfile ("" for a blank canvas). */
  getMolfile: () => Promise<string>;
}

interface Props {
  /** Saved Rxnfile/Molfile; only read when the canvas initialises. */
  value: string;
  onChange: (rxn: string) => void;
  /** Download name without extension, e.g. the experiment ID. */
  fileName: string;
  /** Extra controls for the section header (screen only), left of "Export to CDXML". */
  toolbar?: ReactNode;
  /** The experiment this drawing belongs to; enables "Open in ChemDraw" (desktop app only). */
  experimentId?: string;
  ref?: Ref<ReactionCanvasHandle>;
}

export default function ReactionCanvas({ value, onChange, fileName, toolbar, experimentId, ref }: Props) {
  const ketcherRef = useRef<Ketcher | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSeqRef = useRef(0);
  /** Serialises restores: Ketcher can init more than once per mount (StrictMode, re-init). */
  const loadChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Number of restores in flight; their transient errors are retried, not shown. */
  const loadingRef = useRef(0);

  // Latest props for use inside the long-lived Ketcher callbacks.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  /** Last scheme we know is persisted; used to ignore no-op change events. */
  const lastSavedRef = useRef(value);

  const [hasContent, setHasContent] = useState(value.trim() !== "");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [height, setHeight] = useState(readSketcherHeight);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number; height: number } | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      async insertStructure(structure) {
        const ketcher = ketcherRef.current;
        if (!ketcher) throw new Error("The drawing tools are still loading, try again in a moment.");
        await insertIntoKetcher(ketcher, structure);
      },
      async getMolfile() {
        const ketcher = ketcherRef.current;
        if (!ketcher) throw new Error("The drawing tools are still loading, try again in a moment.");
        return ketcher.editor.struct().isBlank() ? "" : ketcher.getMolfile();
      },
    }),
    [],
  );

  // Static vector SVG data URL of the scheme, shown instead of the editor when printing.
  const updatePreview = useCallback((ketcher: Ketcher, text: string) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const seq = ++previewSeqRef.current;
    previewTimerRef.current = setTimeout(async () => {
      try {
        const svgBlob = text
          ? await ketcher.generateImage(text, {
              outputFormat: "svg",
              backgroundColor: "255, 255, 255",
            })
          : null;
        const url = svgBlob ? await blobToDataUrl(svgBlob) : null;
        if (seq !== previewSeqRef.current) return;
        setPreviewUrl(url);
      } catch {
        // Preview is a print nicety; never surface its failure.
      }
    }, 250);
  }, []);

  const handleInit = useCallback(
    (ketcher: Ketcher) => {
      if (!mountedRef.current) return; // Ketcher finished booting after we unmounted
      if (ketcherRef.current === ketcher && unsubscribeRef.current) return; // already wired up
      unsubscribeRef.current?.(); // a newer instance replaces the old one
      ketcherRef.current = ketcher;
      let disposed = false;
      let restoring = false;
      const isCurrent = () => !disposed && ketcherRef.current === ketcher;

      const onCanvasChange = async () => {
        if (restoring || !isCurrent()) return;
        try {
          const text = await exportScheme(ketcher);
          if (restoring || !isCurrent()) return;
          setHasContent(text !== "");
          setError(null);
          updatePreview(ketcher, text);
          if (!sameScheme(text, lastSavedRef.current)) {
            lastSavedRef.current = text;
            onChangeRef.current(text);
          }
        } catch (e) {
          if (isCurrent()) setError(`Could not read the drawing: ${messageOf(e)}`);
        }
      };

      ketcher.changeEvent.add(onCanvasChange);
      unsubscribeRef.current = () => {
        disposed = true;
        ketcher.changeEvent.remove(onCanvasChange);
      };

      // Restore the saved drawing (setMolecule auto-detects Rxn/Mol format).
      const saved = valueRef.current;
      if (saved.trim() === "") return;

      restoring = true;
      loadingRef.current += 1;
      loadChainRef.current = loadChainRef.current
        .then(async () => {
          // Ketcher's setMolecule resolves even when it silently failed (e.g. its
          // structure service is not ready yet), so verify the canvas and retry.
          for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
            if (!isCurrent()) return;
            await ketcher.setMolecule(saved);
            if (!isCurrent()) return;
            const text = await exportScheme(ketcher);
            if (!isCurrent()) return;
            if (text !== "") {
              // Remember Ketcher's own re-export so loading never counts as an edit.
              lastSavedRef.current = text;
              setHasContent(true);
              setError(null);
              updatePreview(ketcher, text);
              return;
            }
            await sleep(300 * (attempt + 1));
          }
          throw new Error("Ketcher did not accept the saved structure.");
        })
        .catch((e) => {
          if (isCurrent()) setError(`Could not load the saved drawing: ${messageOf(e)}`);
        })
        .finally(() => {
          restoring = false;
          loadingRef.current -= 1;
        });
    },
    [updatePreview],
  );

  const handleError = useCallback((message: string) => {
    if (loadingRef.current > 0) return; // restore loop retries and reports its own failure
    setError(message);
  }, []);

  // Tear down listeners/timers when leaving the experiment (or on a StrictMode re-mount).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      ketcherRef.current = null;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewSeqRef.current += 1;
    };
  }, []);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 10000);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  /**
   * Ctrl+V on the canvas. Ketcher's own handler reads the clipboard and crashes with
   * "Cannot read properties of undefined (reading 'sgroups')" on empty text, plain prose, or
   * single-line CDXML, so it never sees the event: we check the text and insert it through the
   * same path as the Personal Library.
   *
   * `syncText` is the text the paste event itself carries ("" when the paste came from a key
   * press with no event). If that is already a valid structure it is inserted at once, with no
   * waiting on anything async; otherwise the clipboard util is asked (plugin, webview, then
   * ChemDraw's own clipboard formats). Nothing in here is allowed to throw.
   */
  const pasteStructure = useCallback(
    async (syncText: string) => {
      const ketcher = ketcherRef.current;
      if (!ketcher) {
        showNotice("The drawing tools are still loading, try again in a moment.");
        return;
      }
      try {
        let text = cleanClipboardText(syncText);
        if (!isValidChemicalText(text)) {
          const fromClipboard = await readClipboardText();
          if (fromClipboard.trim() !== "") text = fromClipboard;
        }
        if (!isValidChemicalText(text)) {
          showNotice(NOT_CHEMICAL_NOTICE);
          return;
        }
        setNotice(null);
        await insertIntoKetcher(ketcher, text);
      } catch (e) {
        console.warn("Pasting into the sketcher failed:", e);
        if (ketcherRef.current === ketcher) setError(`Could not paste that structure: ${messageOf(e)}`);
      }
    },
    [showNotice],
  );

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let keyPasteTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelKeyPaste = () => {
      if (keyPasteTimer) clearTimeout(keyPasteTimer);
      keyPasteTimer = null;
    };

    // Both listeners are capture-phase on our wrapper, so they run before Ketcher's own
    // (bubble-phase) handlers, and both leave real text fields (inputs, textareas) alone.
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      cancelKeyPaste(); // the paste event arrived, so the key-press fallback is not needed
      event.preventDefault(); // must happen synchronously; the paste itself is async
      event.stopPropagation();
      void pasteStructure(event.clipboardData?.getData("text/plain") ?? "");
    };
    // Ctrl/Cmd+V as a key press. The paste event normally follows within the same tick and does
    // the work; if it never comes (some webviews skip it when the clipboard has no text slot),
    // the timer reads the clipboard itself. Ctrl+Alt+V is Ketcher's own SMARTS paste: left alone.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "v") return;
      if (isTextField(event.target)) return;
      cancelKeyPaste();
      keyPasteTimer = setTimeout(() => {
        keyPasteTimer = null;
        void pasteStructure("");
      }, KEY_PASTE_FALLBACK_MS);
    };
    box.addEventListener("paste", onPaste, true);
    box.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelKeyPaste();
      box.removeEventListener("paste", onPaste, true);
      box.removeEventListener("keydown", onKeyDown, true);
    };
  }, [pasteStructure]);

  // --- Edit in ChemDraw ------------------------------------------------------------

  const getCdxml = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher) throw new Error("The drawing tools are still loading, try again in a moment.");
    return ketcher.editor.struct().isBlank() ? "" : ketcher.getCDXml();
  }, []);

  /** Replace the drawing with a CDXML document from ChemDraw (an empty one clears the canvas). */
  const loadCdxml = useCallback(async (cdxml: string) => {
    const ketcher = ketcherRef.current;
    if (!ketcher) throw new Error("The drawing tools are still loading, try again in a moment.");
    if (!hasCdxmlContent(cdxml)) {
      (ketcher.editor as unknown as { clear: () => void }).clear();
      return;
    }
    // setMolecule can resolve without having loaded anything while Ketcher is busy: verify, retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      await ketcher.setMolecule(prepareForKetcher(cdxml));
      if ((await exportScheme(ketcher)) !== "") return;
      await sleep(300 * (attempt + 1));
    }
    throw new Error("Ketcher could not read the CDXML saved by ChemDraw.");
  }, []);

  const chemDraw = useChemDrawLink({
    experimentId: experimentId ?? fileName,
    getCdxml,
    loadCdxml,
    onNotice: showNotice,
    onError: setError,
  });
  const showChemDraw = chemDraw.supported && experimentId !== undefined;

  const molecule = () => ketcherRef.current?.editor as unknown as MoleculeEditor | undefined;

  /** Zoom around the centre of the view; also tells Ketcher's own zoom readout to refresh. */
  function scaleBy(factor: number) {
    const editor = molecule();
    if (!editor) return;
    editor.zoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, editor.zoom() * factor)));
    editor.event.zoomChanged?.dispatch();
  }

  /**
   * Zoom so the whole drawing fits the view (100% at most, never enlarged) and centre it. Ketcher's
   * own fit-to-content is too conservative in a narrow view, so the zoom is worked out here from the
   * drawing's size; Ketcher then only does the centring.
   */
  function fitToView() {
    const editor = molecule();
    if (!editor) return;
    editor.zoom(1);
    const struct = editor.struct();
    if (!struct.isBlank()) {
      const box = struct.getCoordBoundingBox();
      const scale = editor.render.options.microModeScale;
      const area = editor.render.clientArea.getBoundingClientRect();
      const fit = Math.min(
        1,
        (area.width - 2 * FIT_MARGIN) / ((box.max.x - box.min.x) * scale),
        (area.height - 2 * FIT_MARGIN) / ((box.max.y - box.min.y) * scale),
      );
      editor.zoom(Math.max(MIN_ZOOM, Math.floor(fit * 100) / 100));
      editor.centerViewportAccordingToStruct();
    }
    editor.event.zoomChanged?.dispatch();
  }

  // Ketcher measures its canvas on window resize, so nudge it whenever the box changes height.
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [height]);

  function commitHeight(px: number) {
    const next = clampSketcherHeight(px);
    setHeight(next);
    saveSketcherHeight(next);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const box = boxRef.current;
    if (!box) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId); // keeps the drag alive outside the handle
    } catch {
      // Not an active pointer (synthetic event): the drag still works while the pointer is over the handle.
    }
    dragRef.current = { startY: event.clientY, startHeight: box.offsetHeight, height: box.offsetHeight };
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const box = boxRef.current;
    if (!drag || !box) return;
    drag.height = clampSketcherHeight(drag.startHeight + event.clientY - drag.startY);
    box.style.height = `${drag.height}px`; // live, without re-rendering Ketcher on every move
    window.dispatchEvent(new Event("resize"));
  }

  function endResize() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) commitHeight(drag.height);
  }

  function resizeWithKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 100 : 25;
    if (event.key === "ArrowDown") commitHeight(height + step);
    else if (event.key === "ArrowUp") commitHeight(height - step);
    else return;
    event.preventDefault();
  }

  async function exportCdxml() {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;
    setExporting(true);
    setError(null);
    try {
      const cdxml = await ketcher.getCDXml();
      // Desktop: a real Save As dialog (WebView2 drops download links). Browser: a download.
      const saved = await saveCdxmlFile(`${fileName}.cdxml`, cdxml);
      if (saved && isTauri()) showNotice(`Saved ${saved.path}`);
    } catch (e) {
      setError(`CDXML export failed: ${messageOf(e)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className={`print:w-full ${hasContent ? "" : "print:hidden"}`}>
      <div className="mb-2 flex items-center justify-between gap-2 print:mb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Reaction scheme
        </h2>
        <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
          {toolbar}
          {showChemDraw && (
            <>
              <button
                type="button"
                onClick={() => void chemDraw.open()}
                disabled={chemDraw.busy !== null}
                title="Open this drawing in ChemDraw (saved as scheme.cdxml next to the experiment's other files)"
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {chemDraw.busy === "open" ? "Opening…" : "Open in ChemDraw"}
              </button>
              <button
                type="button"
                onClick={() => void chemDraw.reload()}
                disabled={chemDraw.busy !== null}
                title="Bring in what you saved in ChemDraw (Ctrl+S). This also happens when you return to Fumebook."
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {chemDraw.busy === "reload" ? "Reloading…" : "Reload from ChemDraw"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={exportCdxml}
            disabled={!hasContent || exporting}
            title={hasContent ? "Download for ChemDraw" : "Draw a structure first"}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export to CDXML"}
          </button>
        </div>
      </div>

      {/* Interactive editor: screen only. The toolbars live inside it, so hiding
          it for print removes them and leaves just the rendered scheme below. */}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div role="group" aria-label="Scale the drawing" className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => scaleBy(1 / ZOOM_STEP)}
            title="Zoom the drawing out"
            className={barButton}
          >
            Scale −
          </button>
          <button
            type="button"
            onClick={() => scaleBy(ZOOM_STEP)}
            title="Zoom the drawing in"
            className={barButton}
          >
            Scale +
          </button>
          <button
            type="button"
            onClick={fitToView}
            title="Shrink the whole drawing to fit the view and centre it"
            className={barButton}
          >
            Fit
          </button>
        </div>
        <div role="group" aria-label="Editor height" className="flex items-center gap-1">
          <span className="mr-0.5 text-[11px] text-zinc-400">Height</span>
          {SKETCHER_HEIGHTS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => commitHeight(preset.px)}
              aria-pressed={height === preset.px}
              title={`${preset.px}px`}
              className={`${barButton} ${height === preset.px ? "!border-zinc-800 !bg-zinc-800 !text-white" : ""}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={boxRef}
        style={{ height }}
        className="relative overflow-hidden rounded-md border border-zinc-200 bg-white print:hidden"
      >
        <KetcherEditor onInit={handleInit} onError={handleError} />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize the editor height"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeWithKeys}
        title="Drag to resize"
        className="group mt-0.5 flex h-3 cursor-ns-resize touch-none items-center justify-center print:hidden"
      >
        <span className="h-1 w-10 rounded-full bg-zinc-200 group-hover:bg-zinc-400 group-focus-visible:bg-zinc-500" />
      </div>

      {notice && (
        <p
          role="status"
          className="mt-2 flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 print:hidden"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-amber-700 hover:text-amber-900"
          >
            ×
          </button>
        </p>
      )}

      {previewUrl && (
        <div className="hidden print:flex print:w-full print:items-center print:justify-center print:py-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- generated blob URL */}
          <img
            src={previewUrl}
            alt="Reaction scheme"
            className="mx-auto block max-h-36 max-w-full object-contain print:mx-auto print:max-h-36"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 print:hidden">
          {error}
        </p>
      )}
    </section>
  );
}
