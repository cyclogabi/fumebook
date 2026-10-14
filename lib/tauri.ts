/** True only inside the Tauri webview (never during SSR / in a normal browser tab). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
