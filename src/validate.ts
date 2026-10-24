import { VALID_CHARS } from "./palette.js";
import { MAX_DIM, MAX_LEGACY_TILES, TILE_SIZE } from "./limits.js";
import type { ParseResult } from "./types.js";

export interface SizeHint {
  width: number;
  height: number;
}

function validSize(w: number, h: number): SizeHint | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  return { width: w, height: h };
}

/**
 * @deprecated 尺寸现在由界面明确指定（`targetSize`），不再从提示词里解析。
 * 仅保留给旧版/测试参考；生成流程请勿再调用。
 *
 * 从用户消息中识别目标画布尺寸。
 * 支持：
 * - 像素尺寸：`32*32`、`32x32`、`32×32`
 * - tile 数量：`宽 10 tile，高 8 tile`、`10×8 tiles`
 * - 像素尺寸与 tile 同时出现时，显式像素尺寸优先
 */
export function sizeHintFrom(message: string): SizeHint | null {
  let tileHint: SizeHint | null = null;

  const tw = message.match(/(?:宽|width)\s*[:=]?\s*(\d{1,3})\s*(?:个)?\s*tiles?/i);
  const th = message.match(/(?:高|height)\s*[:=]?\s*(\d{1,3})\s*(?:个)?\s*tiles?/i);
  if (tw && th) {
    tileHint = validSize(parseInt(tw[1], 10) * TILE_SIZE, parseInt(th[1], 10) * TILE_SIZE);
  } else {
    const pair = message.match(/(\d{1,3})\s*(?:[x*×]|by)\s*(\d{1,3})\s*(?:个)?\s*tiles?/i);
    if (pair) {
      tileHint = validSize(parseInt(pair[1], 10) * TILE_SIZE, parseInt(pair[2], 10) * TILE_SIZE);
    }
  }

  // 显式像素尺寸：排除后面紧跟 "tile(s)" 的数量，取面积最大的一个作为画布
  const pixels: Array<{ width: number; height: number }> = [];
  const re = /(\d{1,3})\s*(?:\*|x|×)\s*(\d{1,3})(?!\s*(?:个)?\s*tiles?)/gi;
  for (const m of message.matchAll(re)) {
    const start = m.index ?? 0;
    const before = message.slice(Math.max(0, start - 10), start);
    const after = message.slice(start + m[0].length, start + m[0].length + 10);
    // “每个 tile 16×16”“16×16 的 tile”是在描述 tile 大小，不是画布
    if (/(?:tile|每个|单块|单张)\s*$/i.test(before)) continue;
    if (/^\s*(?:的\s*)?tile/i.test(after)) continue;
    const s = validSize(parseInt(m[1], 10), parseInt(m[2], 10));
    if (s) pixels.push(s);
  }
  if (pixels.length) {
    pixels.sort((a, b) => a.width * a.height - b.width * b.height);
    // 允许超过 MAX_DIM：交给编译器/校验器给出“超出上限”的明确错误
    return pixels[pixels.length - 1];
  }

  return tileHint;
}

const MAX_TILES = MAX_LEGACY_TILES;

/** 非透明像素数量 */
export function countVisible(rows: string[][]): number {
  let n = 0;
  for (const row of rows) for (const ch of row) if (ch !== ".") n++;
  return n;
}

/** 校验解析结果，返回 null 表示通过，否则返回回传给模型的错误描述 */
export function validateResult(result: ParseResult, hint: SizeHint | null): string | null {
  if (result.kind === "single") {
    const expW = hint?.width ?? 16;
    const expH = hint?.height ?? 16;
    if (expW > MAX_DIM || expH > MAX_DIM) {
      return `画布 ${expW}×${expH} 超出上限 ${MAX_DIM}；请缩小尺寸（tile 固定 16×16，10×8 tile = 160×128）`;
    }
    const err = validateGrid(result.grid.rows, expW, expH, "单图");
    if (err) return err;
    if (countVisible(result.grid.rows) === 0) {
      return "图像完全是透明色（没有任何可见像素），这是一张空图。请实际绘制内容，禁止用全透明占位符代替画面。";
    }
    return null;
  }
  if (result.tiles.length > MAX_TILES) {
    return `图块数量 ${result.tiles.length} 超过上限 ${MAX_TILES}，请精简场景（减少图块或提高单块尺寸）`;
  }
  if (result.width > MAX_DIM || result.height > MAX_DIM) {
    return `布局 ${result.width}x${result.height} 超出上限（最大 ${MAX_DIM}）`;
  }
  for (let i = 0; i < result.tiles.length; i++) {
    const err = validateGrid(result.tiles[i].rows, 16, 16, `tile${i + 1}`);
    if (err) return err;
    if (countVisible(result.tiles[i].rows) === 0) {
      return `tile${i + 1} 完全是透明色（没有任何可见像素），禁止输出空白图块或占位符，请在该图块中实际绘制内容。`;
    }
  }
  return null;
}

function validateGrid(rows: string[][], expW: number, expH: number, label: string): string | null {
  if (rows.length !== expH) {
    return `${label} 有 ${rows.length} 行像素，应为 ${expH} 行`;
  }
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    if (row.length !== expW) {
      return `${label} 第 ${y + 1} 行有 ${row.length} 个像素，应为 ${expW} 个`;
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (!VALID_CHARS.has(ch)) {
        return `${label} 第 ${y + 1} 行第 ${x + 1} 列出现非法字符 \`${ch}\`（只允许 . 和 1-f）`;
      }
    }
  }
  return null;
}
