/**
 * Read an image file and return a downscaled JPEG data URL.
 *
 * localStorage is limited to ~5 MB, so raw phone/camera photos would fill it
 * after a handful of plates. Capping the long edge keeps each plate ~100-300 KB
 * while staying sharp enough for the A4 printout.
 */
const MAX_EDGE = 1000;
const JPEG_QUALITY = 0.82;

const PNG_MAX_EDGE = 3200;

/** Detect whether a File or Blob is an SVG vector graphic. */
export async function isSvgBlob(file: Blob): Promise<boolean> {
  if (file.type === "image/svg+xml") return true;
  if (typeof File !== "undefined" && file instanceof File && /\.svg$/i.test(file.name)) {
    return true;
  }
  if (
    !file.type ||
    file.type === "text/xml" ||
    file.type === "application/xml" ||
    file.type === "text/plain"
  ) {
    try {
      const head = await file.slice(0, 1024).text();
      return /<svg[\s>]/i.test(head);
    } catch {
      return false;
    }
  }
  return false;
}

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
 * Prepare a reaction-scheme image for saving:
 * - `.svg` / `image/svg+xml`: preserved as a lossless vector `image/svg+xml` Blob (never rasterized
 *   through `<canvas>`, so bonds and atom labels print as infinite-resolution vector paths in PDF).
 * - Raster images (PNG, JPEG, BMP, clipboard bitmaps): rendered onto a white background at up to
 *   3200px long-edge, trimmed of excess white/transparent padding, and encoded as lossless `image/png`
 *   so 300–600 DPI ChemDraw pastes stay razor-sharp.
 */
export async function imageFileToPng(file: Blob): Promise<Blob> {
  if (await isSvgBlob(file)) {
    const svgText = await file.text();
    if (!/<svg[\s>]/i.test(svgText)) {
      throw new Error("The SVG file does not contain a valid <svg> element.");
    }
    return new Blob([svgText], { type: "image/svg+xml" });
  }

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
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image.source, 0, 0, width, height);

    const outCanvas = trimCanvasWhiteBorder(canvas, ctx);

    return await new Promise<Blob>((resolve, reject) =>
      outCanvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be converted to PNG."))),
        "image/png",
      ),
    );
  } finally {
    image.close();
  }
}

/**
 * Trim excess white border around a drawn structure on `<canvas>` while keeping a clean margin
 * and preserving the exact 1:1 aspect ratio.
 */
export function trimCanvasWhiteBorder(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): HTMLCanvasElement {
  const { width, height } = canvas;
  if (width <= 8 || height <= 8) return canvas;

  let imgData: ImageData;
  try {
    imgData = ctx.getImageData(0, 0, width, height);
  } catch {
    return canvas;
  }

  const data = imgData.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (r < 250 || g < 250 || b < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return canvas;

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const pad = Math.max(8, Math.round(Math.max(contentW, contentH) * 0.025));

  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropX, contentW + pad * 2);
  const cropH = Math.min(height - cropY, contentH + pad * 2);

  if (cropX === 0 && cropY === 0 && cropW === width && cropH === height) {
    return canvas;
  }

  const trimmed = document.createElement("canvas");
  trimmed.width = cropW;
  trimmed.height = cropH;
  const tCtx = trimmed.getContext("2d");
  if (!tCtx) return canvas;
  tCtx.fillStyle = "#ffffff";
  tCtx.fillRect(0, 0, cropW, cropH);
  tCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return trimmed;
}

/**
 * Convert a clipboard image data URL (`data:image/bmp;base64,...`, `data:image/png;base64,...`,
 * or `data:image/svg+xml;base64,...`) into a trimmed, lossless PNG (or SVG) data URL.
 */
export async function dataUrlToTrimmedPngDataUrl(dataUrl: string): Promise<string> {
  if (/^data:image\/svg\+xml/i.test(dataUrl)) {
    return dataUrl;
  }
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) return dataUrl;
  const header = dataUrl.slice(0, commaIdx);
  const b64 = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const inputBlob = new Blob([bytes], { type: mime });
  const pngBlob = await imageFileToPng(inputBlob);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read PNG blob."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read PNG blob."));
    reader.readAsDataURL(pngBlob);
  });
}

export async function fileToDataUrl(file: File, maxEdge: number = MAX_EDGE): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
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
