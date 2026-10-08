"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

/**
 * NMRium touches `window`/`document` at import time, so it is only ever loaded
 * in the browser (`ssr: false` requires this to be a Client Component).
 */
const NMRium = dynamic(() => import("./NmrWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-sm text-zinc-400">
      Loading NMR workspace…
    </div>
  ),
});

interface Props {
  onClose: () => void;
}

/**
 * Full-screen NMR processing room.
 *
 * Deliberately stateless: nothing from NMRium is persisted (raw FIDs are far too
 * large for localStorage). Each time the room opens it mounts a fresh NMRium
 * workspace; users save their work with NMRium's own export tools.
 */
export default function NmrRoom({ onClose }: Props) {
  // Prevent the notebook behind the overlay from scrolling.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="NMR Analysis Room"
      className="fixed inset-0 z-50 flex flex-col bg-white"
    >
      <nav className="flex shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-4 py-2.5 shadow-sm">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-fume-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-fume-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-fume-500 focus-visible:ring-offset-2"
        >
          ← Back to Notebook
        </button>
        <h2 className="text-sm font-semibold text-zinc-800">🔬 NMR Analysis Room</h2>
        <p className="ml-auto hidden text-xs text-zinc-500 sm:block">
          Work here is not saved to the notebook. Use NMRium&apos;s export tools to keep it.
        </p>
      </nav>

      {/* Strict bounds: NMRium sizes its canvases from this box's pixel size. */}
      <div className="relative h-full min-h-0 w-full flex-1 overflow-hidden">
        {/* `nmr-isolate` shields NMRium from Tailwind's preflight (see nmr-room.css). */}
        <div className="nmr-isolate absolute inset-0">
          {/* Loads the full "default" workspace (see NmrWorkspace.tsx). */}
          <NMRium />
        </div>
      </div>
    </div>
  );
}
