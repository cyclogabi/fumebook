"use client";

import NumberInput from "./NumberInput";
import { formatNumber, fromCanonical, toCanonical } from "@/lib/stoich";
import { GOOD_YIELD_PERCENT, computeYield } from "@/lib/yield";
import {
  PRODUCT_MASS_UNITS,
  type ProductInfo,
  type ProductMassUnit,
  type ReagentRow,
} from "@/lib/types";

interface Props {
  product: ProductInfo;
  /** Reagent rows - the limiting reagent's mmol drives the theoretical yield. */
  rows: ReagentRow[];
  onChange: (patch: Partial<ProductInfo>) => void;
}

const fieldInput =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 " +
  "placeholder:text-zinc-300 focus:border-fume-500 focus:outline-none";

/** Canonical mg -> the unit currently shown. */
const mass = (mg: number | null, unit: ProductMassUnit) =>
  mg === null ? null : fromCanonical(mg, unit);

export default function ProductYieldCard({ product, rows, onChange }: Props) {
  const { name, mw, isolatedMass, massUnit } = product;
  const result = computeYield(rows, mw, isolatedMass);
  const limiting = rows.find((r) => r.role === "Limiting");

  const theoretical = mass(result.theoreticalMg, massUnit);
  const percent = result.percent;
  const isGood = percent !== null && percent > GOOD_YIELD_PERCENT;

  const isEmpty = name.trim() === "" && mw === null && isolatedMass === null;

  const nothingToCompute =
    result.limitingN === null
      ? "Enter the limiting reagent amount in the table above to calculate the theoretical yield."
      : mw === null
        ? "Enter the product MW to calculate the theoretical yield."
        : null;

  return (
    <section
      aria-label="Isolated product and yield"
      className={`break-inside-avoid rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 print:rounded-none print:border-0 print:bg-transparent print:p-0 ${
        isEmpty ? "print:hidden" : ""
      }`}
    >
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 print:mb-1.5">
        Isolated product &amp; yield
      </h2>

      {/* Inputs (screen) */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_12rem] print:hidden">
        <Field label="Product name">
          <input
            value={name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Benzyl 3-methylpropyl ether"
            aria-label="Product name"
            spellCheck={false}
            className={fieldInput}
          />
        </Field>

        <Field label="Product MW" unit="g/mol">
          <NumberInput
            ariaLabel="Product molecular weight"
            value={mw}
            onCommit={(v) => onChange({ mw: v })}
            className={`${fieldInput} text-right tabular-nums`}
          />
        </Field>

        <Field label="Isolated mass">
          <div className="flex items-stretch gap-1.5">
            <NumberInput
              ariaLabel="Isolated mass"
              value={mass(isolatedMass, massUnit)}
              onCommit={(v) => onChange({ isolatedMass: v === null ? null : toCanonical(v, massUnit) })}
              className={`${fieldInput} min-w-0 flex-1 text-right tabular-nums`}
            />
            <div
              role="group"
              aria-label="Isolated mass unit"
              className="flex shrink-0 overflow-hidden rounded-md border border-zinc-300 bg-white text-xs font-medium"
            >
              {PRODUCT_MASS_UNITS.map((unit) => (
                <button
                  key={unit}
                  type="button"
                  aria-pressed={massUnit === unit}
                  onClick={() => onChange({ massUnit: unit })}
                  className={`px-2.5 ${
                    massUnit === unit
                      ? "bg-fume-500 text-white"
                      : "text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {unit}
                </button>
              ))}
            </div>
          </div>
        </Field>
      </div>

      {/* Inputs (print): compact plain text */}
      <p className="hidden break-words text-[11px] print:block">
        <PrintItem label="Product" value={name.trim() || "–"} />
        <PrintItem label="MW" value={mw === null ? "–" : `${formatNumber(mw)} g/mol`} />
        <PrintItem
          label="Isolated mass"
          value={
            isolatedMass === null ? "–" : `${formatNumber(mass(isolatedMass, massUnit)!)} ${massUnit}`
          }
        />
      </p>

      {/* Results */}
      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3 border-t border-zinc-200 pt-3 print:mt-2 print:gap-x-6 print:pt-2">
        <Stat
          label="Limiting reagent"
          value={
            result.limitingN === null
              ? "–"
              : `${formatNumber(result.limitingN)} mmol${limiting?.name.trim() ? ` · ${limiting.name.trim()}` : ""}`
          }
        />
        <Stat
          label="Theoretical yield"
          value={theoretical === null ? "–" : `${formatNumber(theoretical)} ${massUnit}`}
        />

        <div className="ml-auto flex flex-col items-end gap-1 print:ml-0 print:items-start">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Yield
          </span>
          <span
            role="status"
            aria-label={percent === null ? "Percent yield not available" : `Percent yield ${percent.toFixed(1)}`}
            className={`rounded-full px-4 py-1 text-2xl font-semibold tabular-nums ring-1 ring-inset print:px-3 print:py-0.5 print:text-lg ${
              isGood
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-zinc-100 text-zinc-600 ring-zinc-200"
            }`}
          >
            {percent === null ? "–" : `${percent.toFixed(1)} %`}
          </span>
        </div>
      </div>

      {/* Hints (screen) */}
      <div className="mt-2 space-y-0.5 text-xs text-zinc-400 print:hidden">
        {nothingToCompute ? (
          <p>{nothingToCompute}</p>
        ) : (
          <p>Assumes the product forms 1:1 from the limiting reagent.</p>
        )}
        {percent !== null && percent > 100 && (
          <p className="text-amber-600">
            Above 100 % - check for residual solvent or impurities.
          </p>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  unit,
  children,
}: {
  label: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-zinc-500">
        {label}
        {unit && <span className="ml-1 font-normal text-zinc-400">({unit})</span>}
      </span>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <span className="break-words text-sm font-medium tabular-nums text-zinc-900 print:text-[11px]">
        {value}
      </span>
    </div>
  );
}

function PrintItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="mr-5 inline-block">
      <span className="text-zinc-500">{label}: </span>
      <span className="font-medium">{value}</span>
    </span>
  );
}
