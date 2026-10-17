"use client";

import { formatDate } from "./ExperimentEditor";
import { sortExperiments } from "./Sidebar";
import { yieldSummary } from "@/lib/stoich";
import type { Experiment } from "@/lib/types";

/** "58%" or "58% (+18%)"; never throws on odd saved data. */
function yieldText(exp: Experiment): string | null {
  try {
    return yieldSummary(exp);
  } catch {
    return null;
  }
}

interface Props {
  experiments: Experiment[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onParse: () => void;
  onImportBackup: () => void;
}

export default function Dashboard({ experiments, onOpen, onNew, onParse, onImportBackup }: Props) {
  const now = new Date();
  const thisMonth = experiments.filter((e) => {
    const d = new Date(e.dateCreated);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const plates = experiments.reduce((sum, e) => sum + e.tlcImages.length, 0);
  const recent = sortExperiments(experiments);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Lab dashboard</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Everything is stored in this browser. Select an experiment to open its notebook page.
      </p>

      <dl className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Experiments" value={experiments.length} />
        <Stat label="This month" value={thisMonth} />
        <Stat label="TLC plates" value={plates} />
      </dl>

      <h2 className="mb-2 mt-8 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        All experiments
      </h2>

      {recent.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-zinc-600">Your notebook is empty.</p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={onNew}
              className="flex items-center justify-center gap-2 rounded-lg border border-cyan-300 bg-[#E0FFFF] px-4 py-2 font-medium text-zinc-900 shadow-sm hover:bg-[#C6F2F2]"
            >
              + New Experiment
            </button>
            <button
              type="button"
              onClick={onParse}
              className="rounded-md border border-fume-300 bg-fume-50 px-4 py-2 text-sm font-semibold text-fume-700 shadow-sm hover:bg-fume-100"
            >
              ✨ Parse Protocol
            </button>
            <button
              type="button"
              onClick={onImportBackup}
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
            >
              Import Full Backup
            </button>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {recent.map((exp) => (
            <li key={exp.id}>
              <button
                type="button"
                onClick={() => onOpen(exp.id)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-zinc-50"
              >
                <span className="w-20 shrink-0 font-mono text-sm font-semibold text-zinc-900">
                  {exp.id}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-700">
                  {exp.title || <span className="italic text-zinc-400">Untitled</span>}
                </span>
                <span className="hidden shrink-0 text-xs text-zinc-400 sm:block">
                  {exp.reagents.filter((r) => r.name.trim()).length} reagents
                  {exp.tlcImages.length > 0 && ` · ${exp.tlcImages.length} TLC`}
                </span>
                {yieldText(exp) && (
                  <span
                    title="Isolated yield (+ extra from secondary products)"
                    className="shrink-0 text-xs font-medium tabular-nums text-zinc-600"
                  >
                    {yieldText(exp)}
                  </span>
                )}
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatDate(exp.dateCreated)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</dd>
    </div>
  );
}
