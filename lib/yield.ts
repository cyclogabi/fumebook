/**
 * Theoretical / percent yield.
 *
 * Assumes the product forms 1:1 from the limiting reagent, so
 *   theoretical yield [mg] = n(limiting) [mmol] * product MW [g/mol]
 *   % yield = isolated mass / theoretical yield * 100
 * Everything is canonical (mmol, mg, g/mol); the UI converts to mg / g for display.
 */

import { limitingN } from "./stoich";
import type { ReagentRow } from "./types";

export interface YieldResult {
  /** mmol of the limiting reagent the calculation is based on. */
  limitingN: number | null;
  /** mg */
  theoreticalMg: number | null;
  percent: number | null;
}

const isPositive = (v: number | null): v is number =>
  v !== null && Number.isFinite(v) && v > 0;

export function computeYield(
  rows: ReagentRow[],
  productMw: number | null,
  isolatedMg: number | null,
): YieldResult {
  const nLim = limitingN(rows);
  const theoreticalMg = nLim !== null && isPositive(productMw) ? nLim * productMw : null;
  const percent =
    theoreticalMg !== null && isolatedMg !== null && Number.isFinite(isolatedMg)
      ? (isolatedMg / theoreticalMg) * 100
      : null;
  return { limitingN: nLim, theoreticalMg, percent };
}

/** Yields above this are shown in green. */
export const GOOD_YIELD_PERCENT = 70;
