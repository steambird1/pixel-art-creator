import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { renderPNG } from "../src/render.js";
import {
  DEFAULT_PALETTE,
  PRESET_PALETTES,
  paletteRef,
  remapGrid,
  resolvePalette,
  rotatePalettes,
  validatePaletteColors,
} from "../src/palettes.js";
import type { Grid } from "../src/types.js";

function solid(w: number, h: number, ch: string): Grid {
  return { rows: Array.from({ length: h }, () => Array<string>(w).fill(ch)) };
}

function customPalette(first: string, second: string) {
  const colors = Array<string>(15).fill("#000000");
  colors[0] = first;
  colors[1] = second;
  return { name: "custom", colors };
}

test("palette: 必须正好 15 个 #RRGGBB", () => {
  assert.equal(validatePaletteColors(DEFAULT_PALETTE.colors), null);
  assert.match(validatePaletteColors(DEFAULT_PALETTE.colors.slice(0, 14))!, /正好 15/);
  assert.match(validatePaletteColors([...DEFAULT_PALETTE.colors.slice(0, 14), "red"])!, /第 15/);
  assert.equal(resolvePalette(undefined).name, "default");
  assert.equal(resolvePalette({ name: "gameboy" }).name, "gameboy");
  assert.equal(resolvePalette({ name: "unknown" }).name, "default");
});

test("palette: 自定义调色板被冻结保存，可直接解析", () => {
  const p = customPalette("#112233", "#445566");
  const resolved = resolvePalette(p);
  assert.equal(resolved.name, "custom");
  assert.equal(resolved.colors[0], "#112233");
  assert.equal(resolved.colors[1], "#445566");
  const ref = paletteRef(resolved);
  assert.deepEqual(ref.colors, resolved.colors);
});

test("palette: renderPNG 用调色板决定实际 RGB", () => {
  const p = customPalette("#112233", "#FF0000");
  const png = PNG.sync.read(renderPNG(solid(1, 1, "2"), 1, p));
  assert.equal(png.width, 1);
  assert.equal(png.height, 1);
  assert.deepEqual([...png.data.slice(0, 4)], [255, 0, 0, 255]);
});

test("palette: remapGrid 按 RGB 最近色映射（透明保持）", () => {
  const target = customPalette("#FF0000", "#0000FF");
  // 默认调色板 2 = #FF2121，最接近目标槽 1 的纯红
  const grid: Grid = { rows: [["2", ".", "8"]] };
  const out = remapGrid(grid, PRESET_PALETTES.default, target);
  assert.equal(out.rows[0][0], "1");
  assert.equal(out.rows[0][1], ".");
  // 默认 8 = #003FAD 蓝，最接近目标槽 2 的纯蓝
  assert.equal(out.rows[0][2], "2");
});

test("palette: 组图自动轮换首张会话色、其余不同预设", () => {
  const list = rotatePalettes(DEFAULT_PALETTE, 4);
  assert.equal(list.length, 4);
  assert.equal(list[0].name, "default");
  assert.equal(new Set(list.map((p) => p.name)).size, 4);
  assert.notEqual(list[1].name, "default");
});
