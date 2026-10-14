"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeProperties, useLibrary, type LibraryCompound } from "@/lib/library";

interface Props {
  /** Put the chosen compound into the sketcher. May throw / reject with a readable message. */
  onPick: (compound: LibraryCompound) => Promise<void>;
  /** Save the current drawing (a MOLfile, "" when blank) under a name. Returns an error message or null. */
  onSaveDrawing: (name: string) => Promise<string | null>;
  /** Open the full "Personal Library" dialog. */
  onManage: () => void;
}

/**
 * "Load from Library" button with a quick-select menu: search, click a compound to drop it into
 * the sketcher. The footer saves whatever is drawn right now as a new compound.
 */
export default function LibraryMenu({ onPick, onSaveDrawing, onManage }: Props) {
  const { compounds, error: libraryError } = useLibrary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!compounds) return [];
    return q
      ? compounds.filter((c) => c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q))
      : compounds;
  }, [compounds, query]);

  function toggle() {
    setOpen((o) => !o);
    setMessage(null);
    setQuery("");
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  async function pick(compound: LibraryCompound) {
    setBusy(true);
    setMessage(null);
    try {
      await onPick(compound);
      setOpen(false);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveDrawing() {
    setBusy(true);
    setMessage(null);
    const problem = await onSaveDrawing(saveName);
    setBusy(false);
    if (problem) {
      setMessage({ kind: "error", text: problem });
    } else {
      setMessage({ kind: "ok", text: `Saved "${saveName.trim()}" to your library.` });
      setSaveName("");
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
      >
        Load from Library
      </button>

      {open && (
        <div
          id={menuId}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl"
        >
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your compounds…"
            aria-label="Search the library"
            className="mb-2 w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-fume-500 focus:bg-white focus:outline-none"
          />

          <ul className="max-h-56 overflow-y-auto" role="menu" aria-label="Library compounds">
            {compounds === null && <li className="px-2 py-3 text-sm text-zinc-400">Loading…</li>}
            {compounds !== null && visible.length === 0 && (
              <li className="px-2 py-3 text-sm text-zinc-400">
                {compounds.length === 0 ? "Your library is empty." : "No matches."}
              </li>
            )}
            {visible.map((c) => (
              <li key={c.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void pick(c)}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-fume-50 disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-900">{c.name}</span>
                    {c.format === "cdxml" && (
                      <span className="shrink-0 rounded bg-zinc-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                        CDXML
                      </span>
                    )}
                  </span>
                  {describeProperties(c) && (
                    <span className="truncate text-xs text-zinc-500">{describeProperties(c)}</span>
                  )}
                  {c.notes && <span className="truncate text-xs text-zinc-500">{c.notes}</span>}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 space-y-2 border-t border-zinc-200 pt-2">
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void saveDrawing();
              }}
            >
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Name for current drawing"
                aria-label="Name for the current drawing"
                className="min-w-0 flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs placeholder:text-zinc-400 focus:border-fume-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || saveName.trim() === ""}
                className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save drawing
              </button>
            </form>

            {(message || libraryError) && (
              <p
                role={message?.kind === "ok" ? "status" : "alert"}
                className={`text-xs ${message?.kind === "ok" ? "text-emerald-700" : "text-red-600"}`}
              >
                {message?.text ?? libraryError}
              </p>
            )}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="text-xs font-medium text-fume-700 hover:underline"
            >
              Manage library…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
