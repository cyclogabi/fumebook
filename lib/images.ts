/**
 * Read an image file and return a downscaled JPEG data URL.
 *
 * localStorage is limited to ~5 MB, so raw phone/camera photos would fill it
 * after a handful of plates. Capping the long edge keeps each plate ~100-300 KB
 * while staying sharp enough for the A4 printout.
 */
const MAX_EDGE = 1000;
const JPEG_QUALITY = 0.82;

const PNG_MAX_EDGE = 1600;

/** Decode any browser-readable image, including SVG (which createImageBitmap can't do). */
async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const width = img.naturalWidth || 800;
      const height = img.naturalHeight || 600;
      return { source: img, width, height, close: () => {} };
    } finally {
      // Safe to revoke once decoded: the bitmap data is already in the element.
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Convert an image file (PNG, JPEG, GIF, WebP, SVG...) to a PNG on a white background,
 * with the long edge capped so a phone photo doesn't become a 20 MB attachment.
 * Structure drawings stay crisp: PNG is lossless.
 */
export async function imageFileToPng(file: Blob): Promise<Blob> {
  const image = await decodeImage(file);
  try {
    const scale = Math.min(1, PNG_MAX_EDGE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image.source, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be converted to PNG."))),
        "image/png",
      ),
    );
  } finally {
    image.close();
  }
}

export async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported in this browser.");

    // JPEG has no alpha channel; flatten transparent PNGs onto white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}
