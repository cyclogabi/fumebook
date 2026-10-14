"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import FumebookLogo from "./FumebookLogo";
import {
  INITIALS_MAX,
  INITIALS_MIN,
  START_NUMBER_DEFAULT,
  isValidInitials,
  parseStartNumber,
  readInitials,
  readStartNumber,
  resetProfile,
  sanitiseInitials,
  saveProfile,
  useSavedInitials,
} from "@/lib/initials";

interface Props {
  /**
   * The user asked to see their profile (the header button). Without it the dialog only appears
   * when no initials are saved yet, and then it can't be dismissed.
   */
  editing?: boolean;
  /** Called after the profile was saved (first launch or edit) or the edit was cancelled. */
  onClose?: () => void;
}

/**
 * First-launch onboarding and, later, the profile / settings dialog.
 *
 * Two fields: the user's initials (they prefix every experiment ID) and the number the first
 * experiment should have (someone with 55 paper experiments starts at 56 -> GH056).
 *
 * - First launch (no initials saved): full-screen and blocking. No close button, Escape and
 *   backdrop clicks are ignored and focus stays inside, so the app can't be used before a valid
 *   profile is saved.
 * - Editing (opened from the header): the same form, pre-filled, which can be cancelled, and
 *   which offers to reset the profile (back to the first-launch dialog).
 */
export default function OnboardingModal({ editing = false, onClose }: Props) {
  const saved = useSavedInitials();
  if (saved === undefined) return null; // not hydrated yet
  const first = saved === "";
  if (!first && !editing) return null;
  // key: resetting the profile while editing remounts the dialog as a fresh first-launch form.
  return <ProfileDialog key={first ? "first" : "edit"} first={first} onClose={onClose} />;
}

/** "GH" + 56 -> "GH056": mirrors how experiment IDs are built (3 digits at least). */
const previewId = (initials: string, start: number) =>
  `${initials || "XX"}${String(start).padStart(3, "0")}`;

function ProfileDialog({ first, onClose }: { first: boolean; onClose?: () => void }) {
  const [initials, setInitials] = useState(() => readInitials() ?? "");
  const [startText, setStartText] = useState(() => String(readStartNumber()));
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const initialsRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the first field, keep focus inside while open, and give focus back on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialsRef.current?.focus();
    const onFocusIn = (e: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        initialsRef.current?.focus();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const initialsValid = isValidInitials(initials);
  const start = parseStartNumber(startText);
  const startInvalid = startText !== "" && start === null;
  const canSave = initialsValid && start !== null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave || start === null) return;
    if (!saveProfile(initials, start)) {
      setError("Your profile could not be saved. Check that browser storage is available and try again.");
      return;
    }
    onClose?.();
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center overflow-y-auto bg-zinc-900/70 p-4 backdrop-blur-sm print:hidden"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (!first) onClose?.();
      }}
      onMouseDown={(e) => {
        if (!first && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-desc"
        className="my-auto w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <FumebookLogo className="size-10" />
          <h1 id="onboarding-title" className="text-xl font-bold tracking-tight text-zinc-900">
            {first ? "Welcome to Fumebook" : "Profile & settings"}
          </h1>
        </div>
        <p id="onboarding-desc" className="mt-4 text-sm text-zinc-600">
          {first ? (
            <>
              Two quick questions. Your initials start every experiment ID, and the starting number
              is where the numbering begins.
            </>
          ) : (
            <>
              Change your initials or where the numbering starts. Experiments you already have keep
              their IDs; new ones continue after your highest number for these initials, but never
              below the starting number.
            </>
          )}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
          <div>
            <label htmlFor="initials" className="block text-sm font-medium text-zinc-700">
              Initials ({INITIALS_MIN}-{INITIALS_MAX} letters)
            </label>
            <input
              ref={initialsRef}
              id="initials"
              type="text"
              value={initials}
              onChange={(e) => {
                setInitials(sanitiseInitials(e.target.value));
                setError(null);
              }}
              maxLength={INITIALS_MAX}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              aria-required="true"
              placeholder="GH"
              aria-invalid={error !== null}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-lg uppercase tracking-widest text-zinc-900 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fume-500"
            />
          </div>

          <div>
            <label htmlFor="start-number" className="block text-sm font-medium text-zinc-700">
              Starting experiment number
            </label>
            <input
              id="start-number"
              type="text"
              inputMode="numeric"
              value={startText}
              onChange={(e) => {
                setStartText(e.target.value.replace(/\D/g, "").slice(0, 6));
                setError(null);
              }}
              autoComplete="off"
              required
              aria-required="true"
              aria-describedby="start-number-help"
              aria-invalid={startInvalid}
              placeholder={String(START_NUMBER_DEFAULT)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-lg text-zinc-900 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fume-500"
            />
            <p
              id="start-number-help"
              className={`mt-1.5 text-xs ${startInvalid ? "text-red-600" : "text-zinc-500"}`}
            >
              {startInvalid
                ? "Enter a whole number, 1 or higher."
                : "A whole number, 1 or higher. If you already have 55 paper experiments and are starting on #56, enter 56."}
            </p>
          </div>

          <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            {first ? "Your first experiment will be " : "New experiments start at "}
            <span className="font-mono font-semibold text-zinc-900">
              {previewId(initials, start ?? START_NUMBER_DEFAULT)}
            </span>
            {first ? "." : " or later."}
          </p>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            {!first && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={!canSave}
              className="flex-1 rounded-lg border border-cyan-300 bg-[#E0FFFF] px-4 py-2 font-medium text-zinc-900 shadow-sm hover:bg-[#C6F2F2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {first ? "Get started" : "Save"}
            </button>
          </div>
        </form>

        {!first && (
          <div className="mt-6 border-t border-zinc-200 pt-4">
            {confirmingReset ? (
              <div className="text-sm text-zinc-600">
                <p>
                  Forget your initials and starting number? You will be asked for them again right
                  away. Your experiments are not touched.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetProfile}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
                  >
                    Reset profile
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingReset(false)}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                  >
                    Keep
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingReset(true)}
                className="text-sm font-medium text-red-600 hover:underline"
              >
                Reset onboarding…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
