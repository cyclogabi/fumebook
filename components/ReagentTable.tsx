"use client";

import NumberInput, { cellInput } from "./NumberInput";
import ReagentNameInput from "./ReagentNameInput";
import { useEffect, useRef, useState } from "react";
import type { ChemicalEntry } from "@/lib/chemicalDictionary";
import { libraryCompoundSmiles, useLibrary, type LibraryCompound } from "@/lib/library";
import {
  concentration,
  displayValue,
  editField,
  formatConcentration,
  setRole,
  toCanonical,
  type EditableField,
} from "@/lib/stoich";
import {
  ROLES,
  UNIT_OPTIONS,
  newRow,
  type Columns,
  type ReagentRow,
  type Role,
  type UnitKind,
  type Units,
} from "@/lib/types";

interface Props {
  rows: ReagentRow[];
  units: Units;
  columns?: Columns;
  /** Functional update so rapid edits never act on stale rows. */
  onRows: (fn: (rows: ReagentRow[]) => ReagentRow[]) => void;
  onUnits: (units: Units) => void;
  onColumns?: (columns: Columns) => void;
  /**
   * Add a library compound's structure to the reaction scheme (`reactant` or `product` zone).
   * Resolves to an error message, or null when it was added. Without it the library picker only fills the row.
   */
  onInsertStructure?: (
    compound: LibraryCompound,
    preferredZone?: "reactant" | "product",
  ) => Promise<string | null>;
  /**
   * Open the Personal Library modal pre-filled with this row's name, MW, and density
   * so the user can paste a ChemDraw structure (Ctrl+V) and save it to their library.
   */
  onSaveToLibrary?: (reagent: {
    name: string;
    mw: number | null;
    density: number | null;
  }) => void;
}

/** How long the "added to the sketcher" confirmation stays under the table. */
const STATUS_MS = 4000;

/**
 * Apply a local-dictionary pick to one row in a single state update:
 * name, role (not for Limiting / Catalyst rows), MW, and density. Solids have
 * no density in the dictionary, so any stale density from the previous
 * chemical is cleared. MW and density go through `editField`, so n / mass /
 * vol (and the equivalents of other rows, for the limiting reagent) are
 * recalculated exactly as if they had been typed.
 */
export function applyLocalPick(rows: ReagentRow[], id: string, entry: ChemicalEntry): ReagentRow[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows;

  let next = rows.map((r) => {
    if (r.id !== id) return r;
    const { smiles: _previous, ...rest } = r;
    return { ...rest, name: entry.commonName };
  });
  if (target.role === "Reagent" || target.role === "Solvent") {
    next = setRole(next, id, entry.defaultRole);
  }
  next = editField(next, id, "mw", entry.mw);
  next = editField(next, id, "density", entry.density ?? null);
  return next;
}

/**
 * Apply a Personal Library pick to one row in a single state update: name, MW and density.
 * Like a dictionary pick, MW and density go through `editField` (so n / mass / vol and the
 * equivalents are recalculated as if typed), and a value the compound doesn't have is cleared
 * rather than left over from whatever the row held before.
 */
export function applyLibraryPick(rows: ReagentRow[], id: string, compound: LibraryCompound): ReagentRow[] {
  if (!rows.some((r) => r.id === id)) return rows;
  const smiles = libraryCompoundSmiles(compound);
  let next = rows.map((r) => {
    if (r.id !== id) return r;
    const { smiles: _previous, ...rest } = r;
    return smiles ? { ...rest, name: compound.name, smiles } : { ...rest, name: compound.name };
  });
  next = editField(next, id, "mw", compound.mw ?? null);
  next = editField(next, id, "density", compound.density ?? null);
  return next;
}

export default function ReagentTable({
  rows,
  units,
  onRows,
  onUnits,
  onInsertStructure,
  onSaveToLibrary,
}: Props) {
  const conc = concentration(rows);
  const { compounds: library } = useLibrary();

  // Result of "+ Sketch" (screen readers announce it; sighted users see the structure appear).
  const [sketchStatus, setSketchStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  async function sendCompoundToSelectedZone(compound: LibraryCompound) {
    if (!onInsertStructure) return;
    const problem = await onInsertStructure(compound, undefined);
    setSketchStatus(
      problem
        ? { kind: "error", text: problem }
        : {
            kind: "ok",
            text: `Loaded ${compound.name} structure & MW into the selected reaction scheme box.`,
          },
    );
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setSketchStatus(null), STATUS_MS);
  }

  async function pickFromLibrary(
    rowId: string,
    compound: LibraryCompound,
    withStructure: boolean,
    isLimiting = false,
  ) {
    onRows((cur) => applyLibraryPick(cur, rowId, compound));
    const hasStruct = Boolean(
      compound.cdxml?.trim() || compound.imageDataUrl || compound.structure?.trim(),
    );
    if (!hasStruct || !onInsertStructure) return;
    if (withStructure || isLimiting) {
      await sendCompoundToSelectedZone(compound);
    }
  }

  const edit = (id: string, field: EditableField, value: number | null) =>
    onRows((current) => editField(current, id, field, value));

  /** Number cell shown/typed in the display unit, stored in canonical units. */
  const quantityCell = (row: ReagentRow, field: "n" | "mass" | "vol", label: string) => (
    <NumberInput
      ariaLabel={`${label} of ${row.name || "reagent"}`}
      value={displayValue(row[field], field, units)}
      onCommit={(v) => edit(row.id, field, v === null ? null : toCanonical(v, units[field]))}
    />
  );

  return (
    <div>
      <div className="-mx-2 overflow-x-auto px-2 print:mx-0 print:overflow-visible print:px-0">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-sm print:min-w-0 print:text-xs">
          <thead>
            <tr className="border-b border-zinc-300 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              <Th align="left" className="w-auto">Reagent name</Th>
              <Th align="left" className="w-24">Role</Th>
              <Th className="w-[4.5rem]">
                MW
                <Sub>g/mol</Sub>
              </Th>
              <Th className="w-14">Eq</Th>
              <Th className="w-[5.25rem]">
                <span className="normal-case">n</span>
                <UnitSelect kind="n" units={units} onUnits={onUnits} />
              </Th>
              <Th className="w-[5.25rem]">
                <span className="normal-case">m</span>
                <UnitSelect kind="mass" units={units} onUnits={onUnits} />
              </Th>
              <Th className="w-[5.25rem]">
                <span className="normal-case">v</span>
                <UnitSelect kind="vol" units={units} onUnits={onUnits} />
              </Th>
              <Th className="w-[4.5rem]">
                <span className="normal-case">d</span>
                <Sub>g/mL</Sub>
              </Th>
              <th className="w-14 print:hidden" />
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const isLimiting = row.role === "Limiting";
              // Solvents only have a name, volume and density.
              const isSolvent = row.role === "Solvent";
              // Untouched rows are left out of the printout (limiting eq=1 is implicit).
              const isBlank =
                row.name.trim() === "" &&
                [row.mw, row.n, row.mass, row.vol, row.density, isLimiting ? null : row.eq].every(
                  (v) => v === null,
                );
              const matchedLibraryCompound =
                library?.find(
                  (c) =>
                    c.name.trim().toLowerCase() === row.name.trim().toLowerCase() &&
                    Boolean(c.cdxml?.trim() || c.imageDataUrl || c.structure?.trim()),
                ) ?? null;

              return (
                <tr
                  key={row.id}
                  className={`group/row border-b border-zinc-100 break-inside-avoid align-middle print:border-zinc-200 ${
                    isLimiting ? "bg-fume-50/50 print:bg-transparent" : ""
                  } ${isBlank ? "print:hidden" : ""}`}
                >
                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    <div className="flex items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <ReagentNameInput
                          value={row.name}
                          emphasized={isLimiting}
                          className={`${cellInput} text-left ${isLimiting ? "font-medium" : ""} print:hidden`}
                          onNameChange={(name) =>
                            onRows((cur) =>
                              cur.map((r) => {
                                if (r.id !== row.id) return r;
                                if (r.name === name) return r;
                                const { smiles: _previous, ...rest } = r;
                                return { ...rest, name };
                              }),
                            )
                          }
                          // Same path as typing an MW by hand, so n / mass / vol are recalculated
                          // by lib/stoich.ts (the limiting reagent also rescales the other rows).
                          onMolecularWeight={(mw) => edit(row.id, "mw", mw)}
                          onPickLocal={(entry) =>
                            onRows((cur) => applyLocalPick(cur, row.id, entry))
                          }
                          library={library ?? undefined}
                          onPickLibrary={(compound, withStructure) =>
                            void pickFromLibrary(row.id, compound, withStructure, isLimiting)
                          }
                          canSketch={onInsertStructure !== undefined}
                        />
                      </div>
                      {matchedLibraryCompound && onInsertStructure && (
                        <button
                          type="button"
                          onClick={() => void sendCompoundToSelectedZone(matchedLibraryCompound)}
                          title={`Load "${matchedLibraryCompound.name}" structure & MW into the selected Reaction Scheme box`}
                          aria-label={`Load ${matchedLibraryCompound.name} structure into selected reaction scheme box`}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded border border-fume-200 bg-fume-50/70 px-1.5 py-0.5 text-[10px] font-medium text-fume-700 transition-colors hover:border-fume-400 hover:bg-fume-100 print:hidden"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            className="size-3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M8 2l5 3v6l-5 3-5-3V5l5-3z" />
                          </svg>
                          <span>Scheme</span>
                        </button>
                      )}
                    </div>
                  </td>

                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    <select
                      value={row.role}
                      aria-label="Role"
                      onChange={(e) =>
                        onRows((cur) => setRole(cur, row.id, e.target.value as Role))
                      }
                      className="w-full cursor-pointer rounded border border-transparent bg-transparent px-1 py-1 text-sm text-zinc-700 hover:border-zinc-200 focus:border-fume-500 focus:bg-white focus:outline-none print:appearance-none print:border-0 print:p-0 print:text-[11px]"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    {isSolvent ? (
                      <Dash />
                    ) : (
                      <NumberInput
                        ariaLabel={`MW of ${row.name || "reagent"}`}
                        value={row.mw}
                        onCommit={(v) => edit(row.id, "mw", v)}
                      />
                    )}
                  </td>

                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    {isSolvent ? (
                      <Dash />
                    ) : (
                      <NumberInput
                        ariaLabel={`Equivalents of ${row.name || "reagent"}`}
                        value={isLimiting ? 1 : row.eq}
                        readOnly={isLimiting}
                        onCommit={(v) => edit(row.id, "eq", v)}
                      />
                    )}
                  </td>

                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    {isSolvent ? <Dash /> : quantityCell(row, "n", "Amount")}
                  </td>
                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    {isSolvent ? <Dash /> : quantityCell(row, "mass", "Mass")}
                  </td>
                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    {quantityCell(row, "vol", "Volume")}
                  </td>

                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    <NumberInput
                      ariaLabel={`Density of ${row.name || "reagent"}`}
                      value={row.density}
                      onCommit={(v) => edit(row.id, "density", v)}
                    />
                  </td>

                  <td className="py-1 text-right print:hidden">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {onSaveToLibrary && (
                        <button
                          type="button"
                          title="Save to Library (paste ChemDraw structure)"
                          aria-label="Save to Library"
                          onClick={() =>
                            onSaveToLibrary({
                              name: row.name.trim(),
                              mw: row.mw,
                              density: row.density,
                            })
                          }
                          className="rounded p-1 text-zinc-400 transition-colors hover:bg-fume-50 hover:text-fume-700 group-hover/row:text-zinc-500 print:hidden"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            className="size-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M4 2.5h8a1 1 0 0 1 1 1v10l-5-3-5 3v-10a1 1 0 0 1 1-1Z" />
                            <path d="M8 5v4M6 7h4" />
                          </svg>
                        </button>
                      )}
                      <button
                        type="button"
                        title="Remove row"
                        aria-label="Remove row"
                        onClick={() => onRows((cur) => cur.filter((r) => r.id !== row.id))}
                        className="rounded p-1 text-zinc-300 hover:bg-red-50 hover:text-red-600 group-hover/row:text-zinc-400"
                      >
                        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className={`mt-2 flex flex-wrap items-center justify-between gap-2 print:mt-1 ${
          conc === null ? "print:hidden" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => onRows((cur) => [...cur, newRow("Reagent")])}
          className="rounded-md px-2 py-1 text-xs font-medium text-fume-700 hover:bg-fume-50 print:hidden"
        >
          + Add row
        </button>
        <p
          role={sketchStatus?.kind === "error" ? "alert" : "status"}
          className={`text-xs print:hidden ${sketchStatus?.kind === "error" ? "text-red-600" : "text-emerald-700"}`}
        >
          {sketchStatus?.text}
        </p>
        {conc !== null && (
          <p className="ml-auto text-xs text-zinc-500 print:text-[11px]">
            Concentration (limiting reagent in solvent):{" "}
            <span className="font-medium tabular-nums text-zinc-800">
              {formatConcentration(conc)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

// --- Small pieces ---------------------------------------------------------------

function Th({
  children,
  className = "",
  align = "right",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-1.5 py-2 align-bottom font-semibold print:px-1.5 print:py-0.5 ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      <div className={`flex flex-col leading-tight ${align === "right" ? "items-end" : "items-start"}`}>
        {children}
      </div>
    </th>
  );
}

function Dash() {
  return (
    <div
      aria-hidden="true"
      className="select-none px-1 py-1 text-right text-sm text-zinc-300 print:px-1 print:py-0 print:text-xs print:text-zinc-400"
    >
      —
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-0.5 text-[10px] font-normal normal-case tracking-normal text-zinc-400">
      {children}
    </span>
  );
}

function UnitSelect({
  kind,
  units,
  onUnits,
}: {
  kind: UnitKind;
  units: Units;
  onUnits: (units: Units) => void;
}) {
  return (
    <select
      value={units[kind]}
      aria-label={`${kind} unit`}
      onChange={(e) => onUnits({ ...units, [kind]: e.target.value } as Units)}
      className="-mr-1 mt-0.5 cursor-pointer rounded bg-transparent py-0 pl-0.5 text-[10px] font-normal normal-case tracking-normal text-zinc-500 hover:bg-zinc-100 focus:outline-none print:appearance-none print:p-0 print:hover:bg-transparent"
    >
      {UNIT_OPTIONS[kind].map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}