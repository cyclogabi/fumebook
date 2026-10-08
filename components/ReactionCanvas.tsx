"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import type { Editor } from "ketcher-react";
import "ketcher-react/dist/index.css";

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

interface Props {
  /** Saved Rxnfile/Molfile; only read when the canvas initialises. */
  value: string;
  onChange: (rxn: string) => void;
  /** Download name without extension, e.g. the experiment ID. */
  fileName: string;
}

export default function ReactionCanvas({ value, onChange, fileName }: Props) {
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

  // Static SVG of the scheme, shown instead of the editor when printing.
  const updatePreview = useCallback((ketcher: Ketcher, text: string) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const seq = ++previewSeqRef.current;
    previewTimerRef.current = setTimeout(async () => {
      try {
        const url = text
          ? URL.createObjectURL(
              await ketcher.generateImage(text, {
                outputFormat: "svg",
                backgroundColor: "255, 255, 255",
              }),
            )
          : null;
        if (seq !== previewSeqRef.current) {
          if (url) URL.revokeObjectURL(url); // a newer render superseded this one
          return;
        }
        setPreviewUrl(url); // the previous URL is revoked by the cleanup effect below
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

  async function exportCdxml() {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;
    setExporting(true);
    setError(null);
    try {
      const cdxml = await ketcher.getCDXml();
      const url = URL.createObjectURL(new Blob([cdxml], { type: "chemical/x-cdxml" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName}.cdxml`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(`CDXML export failed: ${messageOf(e)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className={hasContent ? "" : "print:hidden"}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Reaction scheme
        </h2>
        <button
          type="button"
          onClick={exportCdxml}
          disabled={!hasContent || exporting}
          title={hasContent ? "Download for ChemDraw" : "Draw a structure first"}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 print:hidden"
        >
          {exporting ? "Exporting…" : "Export to CDXML"}
        </button>
      </div>

      {/* Interactive editor: screen only. The toolbars live inside it, so hiding
          it for print removes them and leaves just the rendered scheme below. */}
      <div className="relative h-96 overflow-hidden rounded-md border border-zinc-200 bg-white print:hidden">
        <KetcherEditor onInit={handleInit} onError={handleError} />
      </div>

      {previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- generated blob URL
        <img
          src={previewUrl}
          alt="Reaction scheme"
          className="hidden max-h-[110mm] max-w-full print:block"
        />
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 print:hidden">
          {error}
        </p>
      )}
    </section>
  );
}
