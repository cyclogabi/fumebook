"use client";

import NumberInput, { cellInput } from "./NumberInput";
import ReagentNameInput from "./ReagentNameInput";
import { useEffect, useRef, useState } from "react";
import type { ChemicalEntry } from "@/lib/chemicalDictionary";
import { useLibrary, type LibraryCompound } from "@/lib/library";
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
  type ColumnKey,
  type Columns,
  type ReagentRow,
  type Role,
  type UnitKind,
  type Units,
} from "@/lib/types";

interface Props {
  rows: ReagentRow[];
  units: Units;
  columns: Columns;
  /** Functional update so rapid edits never act on stale rows. */
  onRows: (fn: (rows: ReagentRow[]) => ReagentRow[]) => void;
  onUnits: (units: Units) => void;
  onColumns: (columns: Columns) => void;
  /**
   * Add a library compound's structure to the sketcher. Resolves to an error message, or null when
   * it was added. Without it the library picker only fills the row.
   */
  onInsertStructure?: (compound: LibraryCompound) => Promise<string | null>;
}

/** How long the "added to the sketcher" confirmation stays under the table. */
const STATUS_MS = 4000;

const COLUMN_LABELS: Record<ColumnKey, string> = {
  mw: "MW",
  eq: "Eq",
  n: "n",
  mass: "m",
  vol: "v",
  density: "d",
};

/**
 * Apply a local-dictionary pick to one row in a single state update:
 * name, role (not for Limiting / Catalyst rows), MW, and density. Solids have
 * no density in the dictionary, so any stale density from the previous
 * chemical is cleared. MW and density go through `editField`, so n / mass /
 * vol (and the equivalents of other rows, for the limiting reagent) are
 * recalculated exactly as if they had been typed.
 */
function applyLocalPick(rows: ReagentRow[], id: string, entry: ChemicalEntry): ReagentRow[] {
  const target = rows.find((r) => r.id === id);
  if (!target) return rows;

  let next = rows.map((r) => (r.id === id ? { ...r, name: entry.commonName } : r));
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
function applyLibraryPick(rows: ReagentRow[], id: string, compound: LibraryCompound): ReagentRow[] {
  if (!rows.some((r) => r.id === id)) return rows;
  let next = rows.map((r) => (r.id === id ? { ...r, name: compound.name } : r));
  next = editField(next, id, "mw", compound.mw ?? null);
  next = editField(next, id, "density", compound.density ?? null);
  return next;
}

export default function ReagentTable({
  rows,
  units,
  columns,
  onRows,
  onUnits,
  onColumns,
  onInsertStructure,
}: Props) {
  const show = columns;
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

  async function pickFromLibrary(rowId: string, compound: LibraryCompound, withStructure: boolean) {
    onRows((cur) => applyLibraryPick(cur, rowId, compound));
    if (!withStructure || !onInsertStructure) return;
    const problem = await onInsertStructure(compound);
    setSketchStatus(
      problem
        ? { kind: "error", text: problem }
        : { kind: "ok", text: `Added the structure of ${compound.name} to the sketcher.` },
    );
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setSketchStatus(null), STATUS_MS);
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
      {/* Column visibility (screen only) */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
        <span className="text-xs text-zinc-500">Columns</span>
        {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((key) => (
          <label
            key={key}
            className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-zinc-700"
          >
            <input
              type="checkbox"
              checked={columns[key]}
              onChange={(e) => onColumns({ ...columns, [key]: e.target.checked })}
              className="size-3.5 rounded border-zinc-300 accent-fume-600"
            />
            {COLUMN_LABELS[key]}
          </label>
        ))}
      </div>

      <div className="-mx-2 overflow-x-auto px-2 print:mx-0 print:overflow-visible print:px-0">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-sm print:min-w-0 print:text-xs">
          <thead>
            <tr className="border-b border-zinc-300 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              <Th align="left" className="w-auto">Reagent name</Th>
              <Th align="left" className="w-24">Role</Th>
              {show.mw && (
                <Th className="w-[4.5rem]">
                  MW
                  <Sub>g/mol</Sub>
                </Th>
              )}
              {show.eq && <Th className="w-14">Eq</Th>}
              {show.n && (
                <Th className="w-[5.25rem]">
                  <span className="normal-case">n</span>
                  <UnitSelect kind="n" units={units} onUnits={onUnits} />
                </Th>
              )}
              {show.mass && (
                <Th className="w-[5.25rem]">
                  <span className="normal-case">m</span>
                  <UnitSelect kind="mass" units={units} onUnits={onUnits} />
                </Th>
              )}
              {show.vol && (
                <Th className="w-[5.25rem]">
                  <span className="normal-case">v</span>
                  <UnitSelect kind="vol" units={units} onUnits={onUnits} />
                </Th>
              )}
              {show.density && (
                <Th className="w-[4.5rem]">
                  <span className="normal-case">d</span>
                  <Sub>g/mL</Sub>
                </Th>
              )}
              <th className="w-8 print:hidden" />
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
              return (
                <tr
                  key={row.id}
                  className={`group/row border-b border-zinc-100 break-inside-avoid align-middle print:border-zinc-200 ${
                    isLimiting ? "bg-fume-50/50 print:bg-transparent" : ""
                  } ${isBlank ? "print:hidden" : ""}`}
                >
                  <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                    <ReagentNameInput
                      value={row.name}
                      emphasized={isLimiting}
                      className={`${cellInput} text-left ${isLimiting ? "font-medium" : ""} print:hidden`}
                      onNameChange={(name) =>
                        onRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, name } : r)))
                      }
                      // Same path as typing an MW by hand, so n / mass / vol are recalculated
                      // by lib/stoich.ts (the limiting reagent also rescales the other rows).
                      onMolecularWeight={(mw) => edit(row.id, "mw", mw)}
                      onPickLocal={(entry) => onRows((cur) => applyLocalPick(cur, row.id, entry))}
                      library={library ?? undefined}
                      onPickLibrary={(compound, withStructure) =>
                        void pickFromLibrary(row.id, compound, withStructure)
                      }
                      canSketch={onInsertStructure !== undefined}
                    />
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

                  {show.mw && (
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
                  )}

                  {show.eq && (
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
                  )}

                  {show.n && (
                    <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                      {isSolvent ? <Dash /> : quantityCell(row, "n", "Amount")}
                    </td>
                  )}
                  {show.mass && (
                    <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                      {isSolvent ? <Dash /> : quantityCell(row, "mass", "Mass")}
                    </td>
                  )}
                  {show.vol && (
                    <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                      {quantityCell(row, "vol", "Volume")}
                    </td>
                  )}

                  {show.density && (
                    <td className="py-1 pr-1 print:px-1.5 print:py-0.5">
                      <NumberInput
                        ariaLabel={`Density of ${row.name || "reagent"}`}
                        value={row.density}
                        onCommit={(v) => edit(row.id, "density", v)}
                      />
                    </td>
                  )}

                  <td className="py-1 text-right print:hidden">
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