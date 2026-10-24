import { PNG } from "pngjs";
import { charToRGBA } from "./palette.js";
import { DEFAULT_PALETTE, type Palette } from "./palettes.js";
import type { Grid } from "./types.js";

/** 把若干 16x16 图块按行优先拼成一张大网格 */
export function combineTiles(tiles: Grid[], width: number, height: number): Grid {
  const tileH = tiles[0]?.rows.length ?? 0;
  const tileW = tiles[0]?.rows[0]?.length ?? 0;
  const rows: string[][] = [];
  for (let y = 0; y < tileH * height; y++) {
    const ty = Math.floor(y / tileH);
    const row: string[] = [];
    for (let x = 0; x < tileW * width; x++) {
      const tx = Math.floor(x / tileW);
      row.push(tiles[ty * width + tx].rows[y % tileH][x % tileW]);
    }
    rows.push(row);
  }
  return { rows };
}

/** 透明区画 4x4 逻辑像素的浅灰棋盘格 */
function checkerColor(x: number, y: number): [number, number, number] {
  const block = (Math.floor(x / 4) + Math.floor(y / 4)) % 2;
  return block === 0 ? [255, 255, 255] : [204, 204, 204];
}

/** 网格 -> PNG Buffer（最近邻放大 scale 倍，透明区画棋盘格） */
export function renderPNG(grid: Grid, scale: number, palette: Palette = DEFAULT_PALETTE): Buffer {
  const h = grid.rows.length;
  const w = grid.rows[0]?.length ?? 0;
  const png = new PNG({ width: w * scale, height: h * scale });

  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const ch = grid.rows[Math.floor(y / scale)][Math.floor(x / scale)];
      const [r, g, b, a] = charToRGBA(ch, palette);
      const idx = (y * png.width + x) << 2;
      if (a === 0) {
        const [cr, cg, cb] = checkerColor(Math.floor(x / scale), Math.floor(y / scale));
        png.data[idx] = cr;
        png.data[idx + 1] = cg;
        png.data[idx + 2] = cb;
        png.data[idx + 3] = 255;
      } else {
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

/** 网格尺寸 */
export function gridSize(grid: Grid): { width: number; height: number } {
  return { width: grid.rows[0]?.length ?? 0, height: grid.rows.length };
}

/** 合并前后差异高亮图：变化像素用洋红，未变化像素用深色 */
export function renderDiffPNG(before: Grid, after: Grid, scale: number): Buffer {
  const h = Math.min(before.rows.length, after.rows.length);
  const w = Math.min(before.rows[0]?.length ?? 0, after.rows[0]?.length ?? 0);
  const png = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const changed = before.rows[Math.floor(y / scale)][Math.floor(x / scale)] !==
        after.rows[Math.floor(y / scale)][Math.floor(x / scale)];
      const idx = (y * png.width + x) << 2;
      png.data[idx] = changed ? 255 : 24;
      png.data[idx + 1] = changed ? 0 : 24;
      png.data[idx + 2] = changed ? 255 : 32;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
