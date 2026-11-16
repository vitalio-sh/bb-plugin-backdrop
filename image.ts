// Turns a generated black-on-white pattern into a transparent "ink" mask.
//
// The output PNG has black RGB everywhere and the pattern's ink as alpha, so
// the frontend can draw it as a CSS mask tinted with the active theme's
// foreground colour. One image then works in day and night themes alike.
import { PNG } from "pngjs";

export interface MaskOptions {
  /** Output edge length in pixels; the source is box-downscaled to fit. */
  size: number;
  /** Mirror the tile 2x2 so edges always match, even if the source is not seamless. */
  mirror: boolean;
  /** Swap ink and paper, for sources drawn light-on-dark. */
  invert: boolean;
}

export interface MaskResult {
  png: Buffer;
  width: number;
  height: number;
  /** Share of pixels carrying visible ink (0..1); a sanity signal for the UI. */
  coverage: number;
}

export function isPng(bytes: Buffer): boolean {
  return (
    bytes.length > 8 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(4) === 0x0d0a1a0a
  );
}

/** Luminance per pixel, compositing any source alpha over white paper. */
function luminance(src: PNG): Float32Array {
  const out = new Float32Array(src.width * src.height);
  const d = src.data;
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const a = d[i + 3]! / 255;
    const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    out[p] = l * a + 255 * (1 - a);
  }
  return out;
}

/** Area-average downscale of a single-channel image to w x h. */
function downscale(
  lum: Float32Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Float32Array {
  if (sw === w && sh === h) return lum;
  const out = new Float32Array(w * h);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) sum += lum[row + xx]!;
      }
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function percentile(values: Float32Array, q: number): number {
  const hist = new Uint32Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]!++;
  const target = q * values.length;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= target) return i;
  }
  return 255;
}

/**
 * Image generators often leave a wider empty band on one side than the
 * other, which shows as a seam once tiled. Re-centre the ink so opposite
 * margins match (left = right, top = bottom). Patterns whose motifs already
 * cross the edges have no empty band and pass through unchanged.
 */
function balanceMargins(
  lum: Float32Array,
  width: number,
  height: number,
): { lum: Float32Array; width: number; height: number } {
  const threshold = 160;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lum[y * width + x]! < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { lum, width, height };
  const marginX = Math.round((minX + (width - 1 - maxX)) / 2);
  const marginY = Math.round((minY + (height - 1 - maxY)) / 2);
  const inkW = maxX - minX + 1;
  const inkH = maxY - minY + 1;
  const outW = inkW + 2 * marginX;
  const outH = inkH + 2 * marginY;
  const out = new Float32Array(outW * outH).fill(255);
  for (let y = 0; y < inkH; y++) {
    const from = (minY + y) * width + minX;
    out.set(lum.subarray(from, from + inkW), (marginY + y) * outW + marginX);
  }
  return { lum: out, width: outW, height: outH };
}

export function toInkMask(source: Buffer, options: MaskOptions): MaskResult {
  const src = PNG.sync.read(source);
  let lum = luminance(src);
  if (options.invert) for (let i = 0; i < lum.length; i++) lum[i] = 255 - lum[i]!;
  const balanced = balanceMargins(lum, src.width, src.height);
  lum = balanced.lum;

  // Fit inside size x size, keeping the aspect ratio.
  const tile = options.mirror ? Math.max(8, Math.round(options.size / 2)) : options.size;
  const scale = Math.min(1, tile / Math.max(balanced.width, balanced.height));
  const w = Math.max(1, Math.round(balanced.width * scale));
  const h = Math.max(1, Math.round(balanced.height * scale));
  lum = downscale(lum, balanced.width, balanced.height, w, h);

  // Levels: the darkest few percent is full ink, the lightest is paper.
  const ink = percentile(lum, 0.02);
  const paper = percentile(lum, 0.6);
  const range = Math.max(1, paper - ink);

  const outW = options.mirror ? w * 2 : w;
  const outH = options.mirror ? h * 2 : h;
  const out = new PNG({ width: outW, height: outH });
  let inked = 0;
  for (let y = 0; y < outH; y++) {
    const sy = y < h ? y : 2 * h - 1 - y;
    for (let x = 0; x < outW; x++) {
      const sx = x < w ? x : 2 * w - 1 - x;
      const t = Math.min(1, Math.max(0, (paper - lum[sy * w + sx]!) / range));
      const alpha = Math.round(255 * t);
      if (alpha > 32) inked++;
      const o = (y * outW + x) * 4;
      out.data[o] = 0;
      out.data[o + 1] = 0;
      out.data[o + 2] = 0;
      out.data[o + 3] = alpha;
    }
  }
  return {
    png: PNG.sync.write(out, { colorType: 6 }),
    width: outW,
    height: outH,
    coverage: inked / (outW * outH),
  };
}
