/**
 * Turn a drag-and-drop payload (files and/or whole folders) into a flat `File[]`
 * that NMRium's importer (`NMRiumRefAPI.loadFiles`) can digest.
 *
 * NMRium rebuilds the folder structure from `file.webkitRelativePath`, which
 * Bruker experiments depend on (`<exp>/<n>/fid`, `acqus`, `pdata/1/procs`, ...).
 * Files obtained from a directory entry don't carry that property, so each file
 * is re-created with the right relative path.
 */

/** Files that are never part of an experiment. */
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];

  // readEntries() returns results in batches (100 in Chromium); keep going until empty.
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Copy the file's bytes into memory and attach its path inside the dropped folder. */
async function withRelativePath(file: File, relativePath: string): Promise<File> {
  const copy = new File([await file.arrayBuffer()], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
  // `webkitRelativePath` is a read-only prototype getter; shadow it on the instance.
  Object.defineProperty(copy, "webkitRelativePath", { value: relativePath, enumerable: true });
  return copy;
}

async function collect(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    if (IGNORED_FILES.has(entry.name)) return;
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    // `fullPath` is "/<dropped folder>/sub/file"; NMRium wants it without the leading slash.
    out.push(await withRelativePath(file, entry.fullPath.replace(/^\/+/, "")));
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    await Promise.all(children.map((child) => collect(child, out)));
  }
}

/** True if the drag carries files or folders (as opposed to text, links, ...). */
export function dragHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

/**
 * Collect every file in a drop, recursing into folders.
 *
 * Call this synchronously from the `drop` handler: the browser invalidates
 * `dataTransfer.items` as soon as the handler returns, so the entries are
 * grabbed before the first `await`.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const plainFiles: File[] = [];

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) {
      entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) plainFiles.push(file);
    }
  }

  const out: File[] = [];
  await Promise.all(entries.map((entry) => collect(entry, out)));
  return [...out, ...plainFiles];
}
