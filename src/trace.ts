import { PNG } from "pngjs";
import {
  PALETTE_SLOT_COUNT,
  hexToRgb,
  rgbDistance,
  rgbToHex,
  type Palette,
  type RGB,
} from "./palettes.js";
import type { Grid } from "./types.js";

export interface TraceOptions {
  /** 目标宽高（像素）；都不给时按图片比例自动吸附到 16 的倍数 */
  width?: number;
  height?: number;
  /** 最近邻适合像素画；面积平均适合照片 */
  mode?: "nearest" | "area";
  /** Floyd–Steinberg 抖动 */
  dither?: boolean;
  /** alpha < 阈值 -> 透明，默认 128 */
  alphaThreshold?: number;
  /** 从图里提取 15 色，而不是用会话调色板 */
  adaptive?: boolean;
  /** 自动尺寸的最长边，默认 128 */
  maxSide?: number;
}

export interface TraceResult {
  grid: Grid;
  palette: Palette;
  width: number;
  height: number;
  adaptive: boolean;
}

interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function clampDim(v: number, min = 4, max = 256): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function clampThreshold(v: number | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 128;
}

/** 自动尺寸：保持比例、最长边不超过 maxSide、吸附到 16 的倍数 */
export function resolveTraceSize(
  srcW: number,
  srcH: number,
  opts: TraceOptions = {},
): { width: number; height: number } {
  if (opts.width && opts.height) {
    return { width: clampDim(opts.width), height: clampDim(opts.height) };
  }
  if (opts.width) {
    const w = clampDim(opts.width);
    return { width: w, height: clampDim((w * srcH) / srcW) };
  }
  if (opts.height) {
    const h = clampDim(opts.height);
    return { width: clampDim((h * srcW) / srcH), height: h };
  }
  const maxSide = clampDim(opts.maxSide ?? 128, 16, 256);
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const snap = (v: number) => clampDim(Math.round((v * scale) / 16) * 16, 16, 256);
  return { width: snap(srcW), height: snap(srcH) };
}

function resizeNearest(src: RGBAImage, dw: number, dh: number): RGBAImage {
  const data = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
      const si = (sy * src.width + sx) * 4;
      const di = (y * dw + x) * 4;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = src.data[si + 3];
    }
  }
  return { width: dw, height: dh, data };
}

function resizeArea(src: RGBAImage, dw: number, dh: number): RGBAImage {
  const data = new Uint8ClampedArray(dw * dh * 4);
  const xScale = src.width / dw;
  const yScale = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yScale);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * yScale));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xScale);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * xScale));
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy++) {
        for (let sx = x0; sx < x1 && sx < src.width; sx++) {
          const si = (sy * src.width + sx) * 4;
          const a = src.data[si + 3] / 255;
          sr += src.data[si] * a;
          sg += src.data[si + 1] * a;
          sb += src.data[si + 2] * a;
          sa += src.data[si + 3];
          n++;
        }
      }
      const di = (y * dw + x) * 4;
      const alpha = n ? sa / n : 0;
      if (sr + sg + sb > 0) {
        const wsum = sa / 255 || 1;
        data[di] = sr / wsum;
        data[di + 1] = sg / wsum;
        data[di + 2] = sb / wsum;
      }
      data[di + 3] = alpha;
    }
  }
  return { width: dw, height: dh, data };
}

function channelRange(colors: RGB[], channel: 0 | 1 | 2): number {
  let min = 255;
  let max = 0;
  for (const c of colors) {
    if (c[channel] < min) min = c[channel];
    if (c[channel] > max) max = c[channel];
  }
  return max - min;
}

/** median-cut 提取最多 15 色 */
export function extractPalette(colors: RGB[], count: number = PALETTE_SLOT_COUNT): RGB[] {
  if (!colors.length) return [];
  let boxes: RGB[][] = [colors];
  while (boxes.length < count) {
    let pick = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const range = Math.max(channelRange(box, 0), channelRange(box, 1), channelRange(box, 2));
      const score = range * Math.log2(box.length + 1);
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    if (pick < 0) break;

    const box = boxes[pick];
    const ranges = [channelRange(box, 0), channelRange(box, 1), channelRange(box, 2)];
    const channel = (ranges.indexOf(Math.max(...ranges)) as 0 | 1 | 2) ?? 0;
    box.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.max(1, Math.min(box.length - 1, Math.floor(box.length / 2)));
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
  }

  const out: RGB[] = [];
  for (const box of boxes) {
    if (!box.length) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of box) {
      r += c[0];
      g += c[1];
      b += c[2];
    }
    out.push([Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)]);
  }
  return out.slice(0, count);
}

function paletteFromImage(
  img: RGBAImage,
  threshold: number,
): Palette | null {
  const samples: RGB[] = [];
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 20000));
  for (let i = 0; i < total; i += step) {
    const di = i * 4;
    if (img.data[di + 3] < threshold) continue;
    samples.push([img.data[di], img.data[di + 1], img.data[di + 2]]);
  }
  if (!samples.length) return null;

  const colors = extractPalette(samples, PALETTE_SLOT_COUNT).map(rgbToHex);
  while (colors.length < PALETTE_SLOT_COUNT) {
    colors.push(colors[colors.length - 1] ?? "#000000");
  }
  return { name: "adaptive", label: "自适应", colors: colors.slice(0, PALETTE_SLOT_COUNT) };
}

function quantize(
  img: RGBAImage,
  palette: Palette,
  threshold: number,
  dither: boolean,
): Grid {
  const paletteRgb = palette.colors.map(hexToRgb);
  const work = new Float32Array(img.width * img.height * 3);
  const alpha = new Uint8Array(img.width * img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    const di = i * 4;
    work[i * 3] = img.data[di];
    work[i * 3 + 1] = img.data[di + 1];
    work[i * 3 + 2] = img.data[di + 2];
    alpha[i] = img.data[di + 3];
  }

  const nearest = (r: number, g: number, b: number): { char: string; rgb: RGB } => {
    let best = 1;
    let bestD = Infinity;
    let bestRgb = paletteRgb[0];
    for (let i = 0; i < paletteRgb.length; i++) {
      const d = rgbDistance([r, g, b], paletteRgb[i]);
      if (d < bestD) {
        bestD = d;
        best = i + 1;
        bestRgb = paletteRgb[i];
      }
    }
    return { char: best.toString(16), rgb: bestRgb };
  };

  const rows: string[][] = Array.from({ length: img.height }, () => Array<string>(img.width).fill("."));
  const push = (x: number, y: number, er: number, eg: number, eb: number, factor: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = y * img.width + x;
    if (alpha[i] < threshold) return;
    work[i * 3] = Math.max(0, Math.min(255, work[i * 3] + er * factor));
    work[i * 3 + 1] = Math.max(0, Math.min(255, work[i * 3 + 1] + eg * factor));
    work[i * 3 + 2] = Math.max(0, Math.min(255, work[i * 3 + 2] + eb * factor));
  };

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x;
      if (alpha[i] < threshold) continue;
      const r = work[i * 3];
      const g = work[i * 3 + 1];
      const b = work[i * 3 + 2];
      const hit = nearest(r, g, b);
      rows[y][x] = hit.char;
      if (!dither) continue;
      const er = r - hit.rgb[0];
      const eg = g - hit.rgb[1];
      const eb = b - hit.rgb[2];
      push(x + 1, y, er, eg, eb, 7 / 16);
      push(x - 1, y + 1, er, eg, eb, 3 / 16);
      push(x, y + 1, er, eg, eb, 5 / 16);
      push(x + 1, y + 1, er, eg, eb, 1 / 16);
    }
  }
  return { rows };
}

/** PNG Buffer -> 像素网格（不调用模型） */
export function tracePNG(buffer: Buffer, sessionPalette: Palette, opts: TraceOptions = {}): TraceResult {
  const png = PNG.sync.read(buffer);
  if (!png.width || !png.height) throw new Error("PNG 尺寸无效");
  const { width, height } = resolveTraceSize(png.width, png.height, opts);
  const resized = opts.mode === "area"
    ? resizeArea(png as RGBAImage, width, height)
    : resizeNearest(png as RGBAImage, width, height);
  const threshold = clampThreshold(opts.alphaThreshold);
  const adaptivePalette = opts.adaptive ? paletteFromImage(resized, threshold) : null;
  const palette = adaptivePalette ?? sessionPalette;
  const grid = quantize(resized, palette, threshold, !!opts.dither);
  return {
    grid,
    palette,
    width,
    height,
    adaptive: !!adaptivePalette,
  };
}
