"use client";

import * as path from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "./tauri";

/**
 * Saving and opening user-chosen files.
 *
 * Desktop: real Windows "Save As..." / "Open" dialogs (`@tauri-apps/plugin-dialog`) and the fs
 * plugin. The WebView2 shell silently drops `<a download>` blob links or sends them to a folder
 * nobody knows, so they are never used inside Tauri. The dialog plugin adds the chosen path to the
 * fs scope, so writing to / reading from anywhere the user picked works.
 *
 * Plain browser (`next dev` preview): a download link and a file input.
 */

const APP_DIR_NAME = "Fumebook";
const BACKUPS_DIR_NAME = "backups";

const JSON_FILTER = [{ name: "Fumebook JSON", extensions: ["json"] }];
const CDXML_FILTER = [{ name: "ChemDraw CDXML", extensions: ["cdxml"] }];

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SavedFile {
  /** The full path on disk (desktop) or the download's file name (browser). */
  path: string;
}

export interface PickedFile {
  name: string;
  /** Full path on disk (desktop only). */
  path?: string;
  text: string;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Write `text` to `file`, then check the file really is on disk with the right size. */
async function writeVerified(file: string, text: string): Promise<void> {
  await writeTextFile(file, text);
  const info = await stat(file);
  const expected = byteLength(text);
  if (info.size !== expected) {
    throw new Error(`${file} was written incompletely (${info.size} of ${expected} bytes).`);
  }
}

function browserDownload(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Let the user choose where to save `text` and write it there.
 * Resolves to `null` if they cancel; throws (with the reason) if the file could not be written.
 */
export async function saveJsonFile(defaultName: string, text: string): Promise<SavedFile | null> {
  return saveWithDialog(defaultName, text, JSON_FILTER, "application/json");
}

/** Same as `saveJsonFile`, for a ChemDraw `.cdxml` document. */
export async function saveCdxmlFile(defaultName: string, text: string): Promise<SavedFile | null> {
  return saveWithDialog(defaultName, text, CDXML_FILTER, "chemical/x-cdxml");
}

async function saveWithDialog(
  defaultName: string,
  text: string,
  filters: { name: string; extensions: string[] }[],
  mime: string,
): Promise<SavedFile | null> {
  if (!isTauri()) {
    browserDownload(defaultName, text, mime);
    return { path: defaultName };
  }

  let defaultPath = defaultName;
  try {
    defaultPath = await path.join(await path.documentDir(), defaultName);
  } catch {
    // The dialog then opens in its own default folder.
  }
  const target = await save({ title: "Save as…", defaultPath, filters });
  if (!target) return null;
  try {
    await writeVerified(target, text);
  } catch (err) {
    throw new Error(`Could not write ${target}: ${messageOf(err)}`);
  }
  return { path: target };
}

/**
 * Write `text` without asking where: `Documents/Fumebook/backups/[name]` on the desktop (the
 * safety copy taken before a "Replace All"), a download in the browser. Throws on failure.
 */
export async function saveJsonToBackupsFolder(name: string, text: string): Promise<SavedFile> {
  if (!isTauri()) {
    browserDownload(name, text);
    return { path: name };
  }
  const dir = await path.join(await path.documentDir(), APP_DIR_NAME, BACKUPS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const file = await path.join(dir, name);
  try {
    await writeVerified(file, text);
  } catch (err) {
    throw new Error(`Could not write ${file}: ${messageOf(err)}`);
  }
  return { path: file };
}

/** The browser's file picker. Resolves to `null` when it is cancelled. */
function pickInBrowser(): Promise<PickedFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.click();
  });
}

/**
 * Let the user choose a `.json` file and read it. Resolves to `null` if they cancel; throws if
 * the file could not be read.
 */
export async function pickJsonFile(): Promise<PickedFile | null> {
  if (!isTauri()) return pickInBrowser();

  let defaultPath: string | undefined;
  try {
    defaultPath = await path.documentDir();
  } catch {
    defaultPath = undefined;
  }
  const picked = await open({
    title: "Choose a Fumebook .json file",
    defaultPath,
    multiple: false,
    directory: false,
    filters: JSON_FILTER,
  });
  if (!picked || Array.isArray(picked)) return null;
  try {
    const text = await readTextFile(picked);
    const name = picked.split(/[\\/]/).pop() ?? picked;
    return { name, path: picked, text };
  } catch (err) {
    throw new Error(`Could not read ${picked}: ${messageOf(err)}`);
  }
}
