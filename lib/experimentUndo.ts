"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperimentUpdate } from "@/lib/storage";
import type { Experiment } from "@/lib/types";

const MAX_HISTORY = 50;
const TEXT_DEBOUNCE_MS = 300;

function cloneExperiment(experiment: Experiment): Experiment {
  return structuredClone(experiment);
}

/**
 * Fields that change with every keystroke. Everything else (structures, rows, uploads)
 * is treated as a discrete action and recorded immediately.
 */
function structuralKey(experiment: Experiment): string {
  return JSON.stringify({
    reactionSchemeRxn: experiment.reactionSchemeRxn,
    moleculeMode: experiment.moleculeMode,
    moleculeImage: experiment.moleculeImage,
    structuredScheme: experiment.structuredScheme
      ? {
          reactantImage: experiment.structuredScheme.reactantImage ?? "",
          reactantCdxml: experiment.structuredScheme.reactantCdxml ?? "",
          productImage: experiment.structuredScheme.productImage ?? "",
          productCdxml: experiment.structuredScheme.productCdxml ?? "",
        }
      : null,
    reagents: experiment.reagents.map((row) => ({
      id: row.id,
      role: row.role,
      mw: row.mw,
      eq: row.eq,
      n: row.n,
      mass: row.mass,
      vol: row.vol,
      density: row.density,
    })),
    product: {
      mw: experiment.product.mw,
      isolatedMass: experiment.product.isolatedMass,
      massUnit: experiment.product.massUnit,
      stoichRatio: experiment.product.stoichRatio ?? 1,
      elutionStartCv: experiment.product.elutionStartCv ?? null,
      elutionEndCv: experiment.product.elutionEndCv ?? null,
    },
    secondaryProducts: (experiment.secondaryProducts ?? []).map((p) => ({
      id: p.id,
      mw: p.mw,
      mass: p.mass,
      massUnit: p.massUnit ?? "mg",
      stoichRatio: p.stoichRatio ?? 1,
      elutionStartCv: p.elutionStartCv ?? null,
      elutionEndCv: p.elutionEndCv ?? null,
    })),
    tlcImages: experiment.tlcImages,
    references: experiment.references,
    units: experiment.units,
    columns: experiment.columns,
    purificationGradient: experiment.purificationGradient ?? null,
    msSpectrum: experiment.msSpectrum
      ? {
          fileName: experiment.msSpectrum.fileName,
          peaks: experiment.msSpectrum.peaks,
        }
      : null,
  });
}

function applyPatch(experiment: Experiment, change: ExperimentUpdate): Experiment {
  const patch = typeof change === "function" ? change(experiment) : change;
  return { ...experiment, ...patch, id: experiment.id };
}

/** Explicit optional keys so restoring a snapshot can clear them. */
function restorePatch(snapshot: Experiment): Partial<Experiment> {
  return {
    title: snapshot.title,
    dateCreated: snapshot.dateCreated,
    reactionSchemeRxn: snapshot.reactionSchemeRxn,
    moleculeMode: snapshot.moleculeMode,
    moleculeImage: snapshot.moleculeImage,
    structuredScheme: snapshot.structuredScheme,
    procedureText: snapshot.procedureText,
    purificationText: snapshot.purificationText,
    purificationGradient: snapshot.purificationGradient,
    commentsText: snapshot.commentsText,
    reagents: snapshot.reagents,
    product: snapshot.product,
    secondaryProducts: snapshot.secondaryProducts,
    tlcImages: snapshot.tlcImages,
    references: snapshot.references,
    units: snapshot.units,
    columns: snapshot.columns,
    msSpectrum: snapshot.msSpectrum,
    reactantSmiles: snapshot.reactantSmiles,
    productSmiles: snapshot.productSmiles,
    aiReactionData: snapshot.aiReactionData,
  };
}

/**
 * Per-experiment undo/redo. Typing is coalesced (300 ms); discrete actions are recorded at once.
 * Restores reaction-scheme images/CDXML, reagents, products, conditions, reaction SMILES, and the MS spectrum.
 * Ctrl+Z / Ctrl+Y are handled in ExperimentEditor (window capture phase) so WebView2 focus cannot swallow them.
 */
export function useExperimentUndo(
  experiment: Experiment,
  onUpdate: (change: ExperimentUpdate) => void,
) {
  const experimentRef = useRef(experiment);
  experimentRef.current = experiment;

  const pastRef = useRef<Experiment[]>([]);
  const futureRef = useRef<Experiment[]>([]);
  const pendingBeforeRef = useRef<Experiment | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringRef = useRef(false);
  const [, bump] = useState(0);

  const refresh = useCallback(() => bump((n) => n + 1), []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pushPast = useCallback(
    (snapshot: Experiment) => {
      const last = pastRef.current[pastRef.current.length - 1];
      if (last && structuralKey(last) === structuralKey(snapshot) && last.title === snapshot.title) {
        const lastJson = JSON.stringify(restorePatch(last));
        const nextJson = JSON.stringify(restorePatch(snapshot));
        if (lastJson === nextJson) return;
      }
      pastRef.current = [...pastRef.current, snapshot].slice(-MAX_HISTORY);
      futureRef.current = [];
      refresh();
    },
    [refresh],
  );

  const commitPending = useCallback(() => {
    clearTimer();
    if (!pendingBeforeRef.current) return;
    pushPast(pendingBeforeRef.current);
    pendingBeforeRef.current = null;
  }, [clearTimer, pushPast]);

  const restore = useCallback(
    (snapshot: Experiment) => {
      restoringRef.current = true;
      onUpdate(restorePatch(snapshot));
      restoringRef.current = false;
      refresh();
    },
    [onUpdate, refresh],
  );

  const recordUpdate = useCallback(
    (change: ExperimentUpdate) => {
      if (restoringRef.current) {
        onUpdate(change);
        return;
      }
      const before = experimentRef.current;
      const after = applyPatch(before, change);
      const typing = structuralKey(before) === structuralKey(after);

      if (typing) {
        if (!pendingBeforeRef.current) {
          pendingBeforeRef.current = cloneExperiment(before);
          refresh();
        }
        clearTimer();
        timerRef.current = setTimeout(() => {
          if (pendingBeforeRef.current) {
            pushPast(pendingBeforeRef.current);
            pendingBeforeRef.current = null;
          }
          timerRef.current = null;
        }, TEXT_DEBOUNCE_MS);
      } else {
        commitPending();
        pushPast(cloneExperiment(before));
      }
      onUpdate(change);
    },
    [clearTimer, commitPending, onUpdate, pushPast, refresh],
  );

  const undo = useCallback(() => {
    if (pendingBeforeRef.current) {
      clearTimer();
      const before = pendingBeforeRef.current;
      pendingBeforeRef.current = null;
      futureRef.current = [...futureRef.current, cloneExperiment(experimentRef.current)].slice(
        -MAX_HISTORY,
      );
      restore(before);
      return;
    }
    const past = pastRef.current;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    pastRef.current = past.slice(0, -1);
    futureRef.current = [...futureRef.current, cloneExperiment(experimentRef.current)].slice(
      -MAX_HISTORY,
    );
    restore(prev);
  }, [clearTimer, restore]);

  const redo = useCallback(() => {
    commitPending();
    const future = futureRef.current;
    if (future.length === 0) return;
    const next = future[future.length - 1];
    futureRef.current = future.slice(0, -1);
    pastRef.current = [...pastRef.current, cloneExperiment(experimentRef.current)].slice(
      -MAX_HISTORY,
    );
    restore(next);
  }, [commitPending, restore]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    update: recordUpdate,
    undo,
    redo,
    canUndo: pastRef.current.length > 0 || pendingBeforeRef.current !== null,
    canRedo: futureRef.current.length > 0,
  };
}
