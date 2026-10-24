import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { combineTiles, renderDiffPNG, renderPNG } from "../src/render.js";
import { parseAIOutput } from "../src/parse.js";
import { diffGrids, mergeTilesInLayout, parsedToGrid, splitGridToTiles, toJs } from "../src/tojs.js";
import { sizeHintFrom } from "../src/validate.js";
import { compileDSL } from "../src/dsl.js";
import type { Grid } from "../src/types.js";

function solidTile(ch: string): Grid {
  return { rows: Array.from({ length: 16 }, () => Array<string>(16).fill(ch)) };
}

function nearTile(base: string, x: number, y: number, ch: string): Grid {
  const rows = Array.from({ length: 16 }, () => Array<string>(16).fill(base));
  rows[y][x] = ch;
  return { rows };
}

test("size: 识别 tile 数量与像素尺寸", () => {
  assert.deepEqual(sizeHintFrom("宽 10 tile，高 8 tile"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("10×8 tiles"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("画布 160*128"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("从 16×16 放大到 160×128"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("每个 tile 16×16，画布 160×128"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("每个 tile 16×16，画布 10×8 tiles"), { width: 160, height: 128 });
  assert.deepEqual(sizeHintFrom("10×8 tiles，画布 120×96"), { width: 120, height: 96 });
  assert.equal(sizeHintFrom("更大的画面"), null);
});

test("toJs: 32×32 精确去重，JS 可被旧解析器读回", () => {
  const a = solidTile("1");
  const b = solidTile("2");
  const g = combineTiles([a, b, a, a], 2, 2);
  const js = toJs({ kind: "single", grid: g });
  assert.ok(js.tileStats);
  assert.equal(js.tileStats!.total, 4);
  assert.equal(js.tileStats!.unique, 2);
  assert.equal(js.tileStats!.reused, 2);
  assert.match(js.code, /new CombinedTiles/);
  assert.equal((js.code.match(/const tile\d+ = img/g) ?? []).length, 2);

  const parsed = parseAIOutput(js.code, { width: 32, height: 32 });
  assert.deepEqual(parsedToGrid(parsed), g);
});

test("toJs: 160×128 / 10×8 tiles 复用与统计", () => {
  const a = solidTile("1");
  const b = solidTile("2");
  const c = solidTile("3");
  const d = solidTile("4");
  const palette = [a, b, c, d];
  const tiles = Array.from({ length: 10 * 8 }, (_, i) => palette[i % palette.length]);
  const g = combineTiles(tiles, 10, 8);

  const js = toJs({ kind: "single", grid: g });
  assert.ok(js.tileStats);
  assert.equal(js.tileStats!.total, 80);
  assert.equal(js.tileStats!.unique, 4);
  assert.equal(js.tileStats!.reused, 76);
  assert.equal((js.code.match(/const tile\d+ = img/g) ?? []).length, 4);
  assert.ok((js.code.match(/tile\d+/g) ?? []).length >= 80);

  const parsed = parseAIOutput(js.code, { width: 160, height: 128 });
  assert.equal(parsed.kind, "tiles");
  assert.deepEqual(parsedToGrid(parsed), g);
});

test("toJs: 相近 tile 只提示，不自动合并；手动合并后 unique 下降", () => {
  const a = solidTile("1");
  const b = nearTile("1", 3, 4, "2");
  const g = combineTiles([a, b, a, b], 2, 2);
  const js = toJs({ kind: "single", grid: g });
  assert.ok(js.tileStats);
  assert.equal(js.tileStats!.unique, 2);
  assert.equal(js.tileStats!.nearGroups.length, 1);
  assert.equal(js.tileStats!.nearGroups[0].maxDiff, 1);

  const layout = splitGridToTiles(g);
  assert.ok(layout);
  const mergedGrid = mergeTilesInLayout(layout!, 0, [1]);
  const merged = toJs({ kind: "single", grid: mergedGrid });
  assert.ok(merged.tileStats);
  assert.equal(merged.tileStats!.unique, 1);
  assert.equal(merged.tileStats!.reused, 3);
  assert.equal(merged.tileStats!.nearGroups.length, 0);
  assert.deepEqual(parsedToGrid(parseAIOutput(merged.code, { width: 32, height: 32 })), mergedGrid);
});

test("toJs: 16×16 单图 / 非 16 倍数回退为单张 img", () => {
  const single = solidTile("5");
  const js = toJs({ kind: "single", grid: single });
  assert.match(js.code, /^export const result = img`/);
  assert.equal(js.tileStats?.total, 1);

  const odd: Grid = { rows: Array.from({ length: 20 }, () => Array<string>(20).fill("7")) };
  const oddJs = toJs({ kind: "single", grid: odd });
  assert.match(oddJs.code, /^export const result = img`/);
  assert.equal(oddJs.tileStats, undefined);
});

test("toJs + DSL: 160×128 编译后可切 10×8 tiles 并渲染", () => {
  const source = [
    "size 160 128",
    "bg .",
    "rect 0 0 160 128 7",
    "frame 0 0 160 128 2",
    "rect 20 20 120 80 1",
    "pixel 25 25 5",
  ].join("\n");
  const compiled = compileDSL(source, { width: 160, height: 128 });
  const js = toJs({ kind: "single", grid: compiled.grid });
  assert.ok(js.tileStats);
  assert.equal(js.tileStats!.total, 80);

  const png = renderPNG(compiled.grid, 1);
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width, 160);
  assert.equal(decoded.height, 128);
});

test("diffGrids / renderDiffPNG: 合并前后差异统计与高亮", () => {
  const before: Grid = { rows: Array.from({ length: 32 }, () => Array<string>(32).fill("1")) };
  const after: Grid = { rows: before.rows.map((row) => [...row]) };
  after.rows[4][3] = "2";
  after.rows[20][25] = "3";
  const diff = diffGrids(before, after);
  assert.equal(diff.changedPixels, 2);
  assert.equal(diff.changedTiles, 2);
  assert.deepEqual(diff.bounds, { x: 3, y: 4, w: 23, h: 17 });

  const png = renderDiffPNG(before, after, 1);
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 32);
  const changedIdx = (4 * 32 + 3) << 2;
  assert.equal(decoded.data[changedIdx], 255);
  assert.equal(decoded.data[changedIdx + 1], 0);
  assert.equal(decoded.data[changedIdx + 2], 255);
  const unchangedIdx = (0 * 32 + 0) << 2;
  assert.equal(decoded.data[unchangedIdx], 24);
});
