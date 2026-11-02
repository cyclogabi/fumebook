import { isTauri } from "@/lib/tauri";

/**
 * Ask the desktop shell whether a local helper is listening on port 8000.
 * The result is unused: a missing server is the normal standalone case, and
 * this must not reject, log, or delay the notebook.
 */
export function probeLocalAi(): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("local_ai_health"))
    .then(() => undefined)
    .catch(() => undefined);
}
