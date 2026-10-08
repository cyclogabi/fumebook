"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatChemicalName,
  isDictionaryName,
  searchDictionary,
  type ChemicalEntry,
} from "@/lib/chemicalDictionary";
import { fetchMolecularWeight, fetchSuggestions } from "@/lib/pubchem";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2; // PubChem lookups; the local dictionary answers from the first character
const MENU_MIN_WIDTH = 300;
const MENU_MAX_HEIGHT = 360;

type SearchStatus = "idle" | "loading" | "ready" | "error";
type MwStatus = "idle" | "loading" | "error";

/** One row in the dropdown: a local quick pick or a PubChem suggestion. */
type Item =
  | { kind: "local"; key: string; entry: ChemicalEntry }
  | { kind: "pubchem"; key: string; raw: string; label: string };

interface Props {
  value: string;
  /** Bold the name (limiting reagent). */
  emphasized?: boolean;
  /** Styling for the editable input (shared cell styling from the table). */
  className: string;
  onNameChange: (name: string) => void;
  /** Called with the PubChem molecular weight (g/mol) after a PubChem suggestion is chosen. */
  onMolecularWeight: (mw: number) => void;
  /**
   * A local dictionary entry was chosen. The parent applies name, MW, density
   * and role in one update so the stoichiometry is recalculated once.
   */
  onPickLocal: (entry: ChemicalEntry) => void;
}

/**
 * Reagent-name combobox.
 *
 * Two sources feed one dropdown:
 *  1. a local dictionary of common reagents / solvents (instant, offline,
 *     matches names *and* abbreviations such as DCM or Et3N) - pinned on top;
 *  2. PubChem autocomplete (debounced) - names are re-cased from PubChem's
 *     ALL CAPS to clean Title Case.
 * Choosing a local entry hands everything to `onPickLocal`; choosing a PubChem
 * suggestion sets the name and looks up its molecular weight. The menu is
 * portalled to <body> with fixed positioning so the table's horizontal-scroll
 * wrapper cannot clip it.
 */
export default function ReagentNameInput({
  value,
  emphasized = false,
  className,
  onNameChange,
  onMolecularWeight,
  onPickLocal,
}: Props) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const mwAbortRef = useRef<AbortController | null>(null);
  /** True until the user types: stops focus alone from popping the menu open. */
  const settledRef = useRef(true);

  const [open, setOpen] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [mwStatus, setMwStatus] = useState<MwStatus>("idle");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const query = value.trim();

  const items = useMemo<Item[]>(() => {
    const local: Item[] = searchDictionary(query).map((entry) => ({
      kind: "local",
      key: `local:${entry.commonName}`,
      entry,
    }));
    const remote: Item[] = suggestions
      // Names the dictionary already offers (e.g. "ethanol") would just be duplicates.
      .filter((raw) => !isDictionaryName(raw))
      .map((raw) => ({
        kind: "pubchem",
        key: `pubchem:${raw}`,
        raw,
        label: formatChemicalName(raw),
      }));
    return [...local, ...remote];
  }, [query, suggestions]);

  const localCount = items.filter((i) => i.kind === "local").length;
  const remoteCount = items.length - localCount;

  const statusMessage =
    remoteCount > 0
      ? null
      : searchStatus === "loading"
        ? "Searching PubChem…"
        : searchStatus === "error"
          ? "PubChem is unreachable. You can still type the name."
          : searchStatus === "ready" && localCount === 0
            ? "No matches on PubChem."
            : null;

  const menuVisible = open && anchor !== null && (items.length > 0 || statusMessage !== null);

  const measure = () => {
    if (inputRef.current) setAnchor(inputRef.current.getBoundingClientRect());
  };

  const cancelSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  };

  // Abort anything in flight when the row goes away.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      searchAbortRef.current?.abort();
      mwAbortRef.current?.abort();
    },
    [],
  );

  // While open: close on outside click, keep the menu glued to the input on scroll/resize.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => {
      if (inputRef.current) setAnchor(inputRef.current.getBoundingClientRect());
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", reposition, true); // capture: catches the table's own scroller
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  // Keep the keyboard-highlighted option visible.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-opt-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listboxId]);

  async function runSearch(text: string) {
    const controller = new AbortController();
    searchAbortRef.current = controller;
    try {
      const names = await fetchSuggestions(text, controller.signal);
      if (controller.signal.aborted) return;
      setSuggestions(names);
      setSearchStatus("ready");
    } catch {
      if (controller.signal.aborted) return;
      setSuggestions([]);
      setSearchStatus("error");
    }
    setActiveIndex(-1);
    // Only pop the menu open if the user is still in this field.
    if (document.activeElement === inputRef.current) {
      measure();
      setOpen(true);
    }
  }

  function handleChange(next: string) {
    onNameChange(next);
    settledRef.current = false;
    setActiveIndex(-1);

    // Typing invalidates a pending MW lookup from an earlier selection.
    mwAbortRef.current?.abort();
    setMwStatus("idle");

    // Local quick picks are instant, so they can open the menu straight away.
    const hasLocal = searchDictionary(next.trim()).length > 0;

    cancelSearch();
    if (next.trim().length < MIN_CHARS) {
      setSearchStatus("idle");
      setSuggestions([]);
      if (hasLocal) {
        measure();
        setOpen(true);
      } else {
        setOpen(false);
      }
      return;
    }

    setSearchStatus("loading");
    if (hasLocal) {
      measure();
      setOpen(true);
    }
    debounceRef.current = setTimeout(() => void runSearch(next), DEBOUNCE_MS);
  }

  function closeAfterPick() {
    cancelSearch();
    settledRef.current = true;
    setOpen(false);
    setActiveIndex(-1);
    setSearchStatus("idle");
    mwAbortRef.current?.abort();
    setMwStatus("idle");
  }

  async function choose(item: Item) {
    closeAfterPick();

    if (item.kind === "local") {
      onPickLocal(item.entry);
      return;
    }

    onNameChange(item.label);

    const controller = new AbortController();
    mwAbortRef.current = controller;
    setMwStatus("loading");
    try {
      // Look up by PubChem's own spelling; the display name is only cosmetic.
      const mw = await fetchMolecularWeight(item.raw, controller.signal);
      if (controller.signal.aborted) return;
      onMolecularWeight(mw);
      setMwStatus("idle");
    } catch {
      if (controller.signal.aborted) return;
      setMwStatus("error");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const count = items.length;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (count === 0) return;
        e.preventDefault();
        if (!open) {
          measure();
          setOpen(true);
        }
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => (i < 0 ? (step === 1 ? 0 : count - 1) : (i + step + count) % count));
        break;
      }
      case "Enter":
        if (open) {
          e.preventDefault();
          if (activeIndex >= 0 && items[activeIndex]) void choose(items[activeIndex]);
          else setOpen(false);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
    }
  }

  // Open below the input; flip above when there is not enough room underneath.
  const menuStyle = (() => {
    if (!anchor) return undefined;
    const width = Math.max(anchor.width, MENU_MIN_WIDTH);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const roomBelow = window.innerHeight - anchor.bottom;
    return roomBelow < MENU_MAX_HEIGHT && anchor.top > roomBelow
      ? { left, width, bottom: window.innerHeight - anchor.top + 4 }
      : { left, width, top: anchor.bottom + 4 };
  })();

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={value}
        placeholder="e.g. 3-methylpropanol"
        aria-label="Reagent name"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={menuVisible}
        aria-controls={listboxId}
        aria-activedescendant={
          menuVisible && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (!settledRef.current && items.length > 0) {
            measure();
            setOpen(true);
          }
        }}
        onBlur={() => setOpen(false)}
        className={`${className} ${mwStatus !== "idle" ? "pr-6" : ""}`}
      />

      {/* Molecular-weight lookup feedback (screen only) */}
      {mwStatus === "loading" && (
        <svg
          viewBox="0 0 16 16"
          className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fume-500 print:hidden"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          role="status"
          aria-label="Looking up molecular weight"
        >
          <path d="M8 2a6 6 0 1 0 6 6" />
        </svg>
      )}
      {mwStatus === "error" && (
        <span
          role="status"
          title="No molecular weight found on PubChem for this name. Enter MW manually."
          aria-label="No molecular weight found on PubChem. Enter MW manually."
          className="absolute right-1.5 top-1/2 grid size-4 -translate-y-1/2 cursor-help place-items-center rounded-full bg-amber-100 text-[10px] font-bold leading-none text-amber-700 print:hidden"
        >
          !
        </span>
      )}

      {/* Print: plain wrapped text instead of the input */}
      <span
        className={`hidden break-words text-[11px] print:block ${emphasized ? "font-semibold" : ""}`}
      >
        {value}
      </span>

      {menuVisible &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            // Don't let clicks in the menu steal focus (and blur-close) before they register.
            onMouseDown={(e) => e.preventDefault()}
            className="fixed z-[100] overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5 print:hidden"
          >
            <ul
              id={listboxId}
              role="listbox"
              aria-label="Reagent suggestions"
              style={{ maxHeight: MENU_MAX_HEIGHT }}
              className="overflow-y-auto py-1"
            >
              {items.map((item, i) => {
                const active = i === activeIndex;
                return (
                  <Fragment key={item.key}>
                    {/* Divider between the pinned local picks and PubChem results */}
                    {i === localCount && localCount > 0 && (
                      <li role="presentation" className="my-1 border-t border-zinc-100" />
                    )}
                    <li
                      id={`${listboxId}-opt-${i}`}
                      role="option"
                      aria-selected={active}
                      title={item.kind === "local" ? describeEntry(item.entry) : undefined}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => void choose(item)}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-zinc-600 ${
                        active ? "bg-fume-50 text-zinc-900" : ""
                      } ${item.kind === "pubchem" && searchStatus === "loading" ? "opacity-60" : ""}`}
                    >
                      {item.kind === "local" ? (
                        <>
                          <span className="min-w-0 flex-1 truncate">
                            <span className="text-zinc-800">
                              <Highlight text={item.entry.commonName} query={query} />
                            </span>
                            <span className="ml-2 text-xs text-zinc-400">
                              {item.entry.aliases.slice(0, 3).map((alias, k) => (
                                <Fragment key={alias}>
                                  {k > 0 && ", "}
                                  <Highlight text={alias} query={query} />
                                </Fragment>
                              ))}
                            </span>
                          </span>
                          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
                            Local
                          </span>
                        </>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">
                          <Highlight text={item.label} query={query} />
                        </span>
                      )}
                    </li>
                  </Fragment>
                );
              })}

              {statusMessage && (
                <>
                  {localCount > 0 && remoteCount === 0 && (
                    <li role="presentation" className="my-1 border-t border-zinc-100" />
                  )}
                  <li role="presentation" className="px-3 py-2 text-sm text-zinc-500">
                    {statusMessage}
                  </li>
                </>
              )}
            </ul>
            <p className="border-t border-zinc-100 bg-zinc-50 px-3 py-1 text-[10px] tracking-wide text-zinc-400">
              {localCount > 0
                ? "Quick picks fill name, MW, density & role"
                : "PubChem · click to fill name & MW"}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}

function describeEntry(entry: ChemicalEntry): string {
  const density = entry.density !== undefined ? ` · density ${entry.density} g/mL` : "";
  return `MW ${entry.mw} g/mol${density} · ${entry.defaultRole.toLowerCase()}`;
}

/** Bold the part of the text that matches what was typed. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold text-zinc-900">
        {text.slice(at, at + query.length)}
      </strong>
      {text.slice(at + query.length)}
    </>
  );
}
