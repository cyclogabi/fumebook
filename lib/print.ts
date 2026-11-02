import { isTauri } from "@/lib/tauri";

/** Let the print stylesheet and eager images land before the print sheet opens. */
function waitForPrintLayout(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // A hidden or unfocused webview may never fire a frame, so the timeout is the guarantee.
    requestAnimationFrame(finish);
    window.setTimeout(finish, 50);
  });
}

/**
 * Print the notebook. Inside the desktop app this uses the native print sheet
 * (required on macOS WKWebView). A normal browser tab uses `window.print()`.
 */
export async function triggerPrint(): Promise<void> {
  await waitForPrintLayout();
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("print_notebook");
      return;
    } catch {
      // The native command failed; the browser dialog is the remaining path.
    }
  }
  window.print();
}
