import { VALID_CHARS } from "./palette.js";
import type { ParseResult } from "./types.js";

export interface SizeHint {
  width: number;
  height: number;
}

/** 从用户消息中识别显式尺寸要求，如 "32*32" / "32x32" / "32×32" */
export function sizeHintFrom(message: string): SizeHint | null {
  const m = message.match(/(\d{1,3})\s*(?:\*|x|×)\s*(\d{1,3})/i);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w < 4 || h < 4 || w > 128 || h > 128) return null;
  return { width: w, height: h };
}

const MAX_TILES = 16;
const MAX_DIM = 128;

/** 非透明像素数量 */
export function countVisible(rows: string[][]): number {
  let n = 0;
  for (const row of rows) for (const ch of row) if (ch !== ".") n++;
  return n;
}

/** 校验解析结果，返回 null 表示通过，否则返回回传给模型的错误描述 */
export function validateResult(result: ParseResult, hint: SizeHint | null): string | null {
  if (result.kind === "single") {
    const err = validateGrid(result.grid.rows, hint?.width ?? 16, hint?.height ?? 16, "单图");
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
