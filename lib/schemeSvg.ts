/** Escape text placed in an SVG file. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(value: string, width: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length === 3) break;
  }
  if (lines.length < 3 && line) lines.push(line);
  return lines.slice(0, 3);
}

export interface SchemeSvgInput {
  reactantImage?: string;
  reactantLabel: string;
  productImage?: string;
  productLabel: string;
  above: string;
  below: string;
  /** Pre-computed arrow width in px. When omitted it is derived from the longest text line. */
  arrowWidthPx?: number;
  /**
   * Widths chosen by "Match Molecule Scale" (px). When both are set, the exported
   * drawings use that same ratio instead of stretching each image to the full box.
   */
  reactantDisplayWidth?: number;
  productDisplayWidth?: number;
}

/** Extract intrinsic width and height from an SVG data URL (or its viewBox). */
export function extractSvgDimensions(dataUrl: string): { width: number; height: number } | null {
  if (!dataUrl) return null;
  let svgText = "";
  if (dataUrl.startsWith("<svg") || dataUrl.startsWith("<?xml")) {
    svgText = dataUrl;
  } else if (!dataUrl.startsWith("data:image/svg+xml")) {
    return null;
  }
  if (dataUrl.includes(";base64,")) {
    const b64 = dataUrl.slice(dataUrl.indexOf(";base64,") + 8);
    try {
      svgText =
        typeof atob === "function"
          ? atob(b64)
          : Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return null;
    }
  } else {
    const comma = dataUrl.indexOf(",");
    if (comma >= 0) {
      try {
        svgText = decodeURIComponent(dataUrl.slice(comma + 1));
      } catch {
        svgText = dataUrl.slice(comma + 1);
      }
    }
  }

  const svgTagMatch = svgText.match(/<svg\b[^>]*>/i);
  if (!svgTagMatch) return null;
  const tag = svgTagMatch[0];

  const wMatch = tag.match(/\bwidth=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
  const hMatch = tag.match(/\bheight=["']?(\d+(?:\.\d+)?)(?:px)?["']/i);
  let w = wMatch ? parseFloat(wMatch[1]) : 0;
  let h = hMatch ? parseFloat(hMatch[1]) : 0;

  if (w <= 0 || h <= 0) {
    const vbMatch = tag.match(
      /\bviewBox=["']?([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)["']/i,
    );
    if (vbMatch) {
      w = parseFloat(vbMatch[3]);
      h = parseFloat(vbMatch[4]);
    }
  }

  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Compute the arrow width from the longest line of text that appears above or below the arrow.
 * Matches the formula used for publication-clean Scheme SVG export.
 */
export function computeArrowWidthPx(above: string, below: string): number {
  const aboveLines = above.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const longestLineCharCount = Math.max(
    0,
    ...aboveLines.map((s) => s.length),
    below.trim().length,
  );
  return Math.max(100, Math.min(320, longestLineCharCount * 8.6 + 32));
}

/**
 * A standalone SVG of the notebook scheme: reactant drawing, arrow, conditions, and product drawing.
 * Structure images are embedded as data URLs, so the file stays a single drawing.
 */
export function buildReactionSchemeSvg(input: SchemeSvgInput): string {
  const arrowPx = input.arrowWidthPx ?? computeArrowWidthPx(input.above, input.below);
  // Layout: fixed-height canvas, structure boxes on left/right, dynamic arrow in the middle.
  const box = 230;
  const pad = 24;
  const arrowGap = 20; // gap between structure box edge and arrow shaft start/end
  const width = pad + box + arrowGap + arrowPx + arrowGap + box + pad;
  const height = 340;
  const left = pad;
  const right = pad + box + arrowGap + arrowPx + arrowGap;
  const top = 28;
  const wrapWidth = Math.max(22, Math.round((arrowPx + 20) / 8.6));
  const above = wrap(input.above, wrapWidth);
  const below = wrap(input.below, wrapWidth);

  // Natural (unclamped 20 px/Å) dimensions of both structures
  const reactantDims = input.reactantImage ? extractSvgDimensions(input.reactantImage) : null;
  const productDims = input.productImage ? extractSvgDimensions(input.productImage) : null;

  const w_R = reactantDims?.width ?? 0;
  const h_R = reactantDims?.height ?? 0;
  const w_P = productDims?.width ?? 0;
  const h_P = productDims?.height ?? 0;

  const maxW = Math.max(w_R, w_P);
  const maxH = Math.max(h_R, h_P);

  // Compute single shared scale factor for the pair so the larger molecule dictates scale:
  const sharedScale = Math.min(
    1.0,
    maxW > 0 ? box / maxW : 1.0,
    maxH > 0 ? box / maxH : 1.0,
  );

  const reactantSlot = input.reactantDisplayWidth ?? 0;
  const productSlot = input.productDisplayWidth ?? 0;
  const matchedScale = reactantSlot > 0 && productSlot > 0;
  const maxSlot = Math.max(reactantSlot, productSlot);

  const image = (
    href: string | undefined,
    x: number,
    label: string,
    dims: { width: number; height: number } | null,
    displayWidth?: number,
  ) => {
    if (href) {
      let imgW = box;
      let imgH = box;
      let imgX = x;
      let imgY = top;

      if (matchedScale && displayWidth && displayWidth > 0 && maxSlot > 0) {
        // Same ratio the user set with Match Molecule Scale (larger drawing fills the box).
        imgW = Math.max(48, Math.round(box * (displayWidth / maxSlot)));
        imgH = box;
        imgX = Math.round(x + (box - imgW) / 2);
        imgY = top;
      } else if (dims && dims.width > 0 && dims.height > 0) {
        // Multiply by sharedScale so both molecules share the exact same scale factor
        imgW = Math.round(dims.width * sharedScale);
        imgH = Math.round(dims.height * sharedScale);
        imgX = Math.round(x + (box - imgW) / 2);
        imgY = Math.round(top + (box - imgH) / 2);
      }

      return `<image href="${xml(href)}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    return `<rect x="${x}" y="${top}" width="${box}" height="${box}" rx="8" fill="#fafafa" stroke="#d4d4d8" stroke-dasharray="5 4"/>
      <text x="${x + box / 2}" y="${top + box / 2}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#a1a1aa">${xml(label)}</text>`;
  };

  const caption = (text: string, x: number) =>
    `<text x="${x + box / 2}" y="${top + box + 22}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#27272a">${xml(text)}</text>`;

  const arrowMidX = left + box + arrowGap + arrowPx / 2;
  const centered = (lines: string[], y: number, fill: string, fontWeight = "normal") =>
    lines
      .map(
        (line, index) =>
          `<text x="${arrowMidX}" y="${y + index * 18}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="${fontWeight}" fill="${fill}">${xml(line)}</text>`,
      )
      .join("\n");

  const arrowX1 = left + box + arrowGap;
  const arrowX2 = right - arrowGap;
  const arrowY = top + box / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${image(input.reactantImage, left, input.reactantLabel || "Reactant", reactantDims, input.reactantDisplayWidth)}
  ${caption(input.reactantLabel || "Reactant", left)}
  ${centered(above, arrowY - 20 - (above.length - 1) * 18, "#1e293b", "500")}
  <line x1="${arrowX1}" y1="${arrowY}" x2="${arrowX2 - 8}" y2="${arrowY}" stroke="#065f46" stroke-width="2.2"/>
  <polygon points="${arrowX2},${arrowY} ${arrowX2 - 14},${arrowY - 7} ${arrowX2 - 14},${arrowY + 7}" fill="#065f46"/>
  ${centered(below, arrowY + 26, "#334155")}
  ${image(input.productImage, right, input.productLabel || "Product", productDims, input.productDisplayWidth)}
  ${caption(input.productLabel || "Product", right)}
</svg>`;
}

/**
 * Download a reaction scheme SVG.
 *
 * In the **installed Tauri build** (`window.__TAURI_INTERNALS__` is present) the synthetic
 * `<a download>` blob-click is silently ignored by WebView2, so we call the Rust
 * `save_svg_file` command which opens a native "Save As…" dialog instead.
 *
 * In **`npm run dev`** (plain browser tab) the regular blob-anchor download is used as a
 * fallback so development is unaffected.
 */
export async function downloadReactionSchemeSvg(filename: string, svg: string): Promise<void> {
  const name = filename.endsWith(".svg") ? filename : `${filename}.svg`;

  // Tauri production build: use the native Save-As dialog via the Rust command.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_svg_file", { defaultName: name, svgContent: svg });
      return;
    } catch (err) {
      console.warn("save_svg_file Tauri command failed, falling back to blob download:", err);
    }
  }

  // Browser / dev fallback: synthetic <a download> click.
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
