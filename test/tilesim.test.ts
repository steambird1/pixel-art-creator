import { test } from "node:test";
import assert from "node:assert/strict";
import { combineTiles } from "../src/render.js";
import { DEFAULT_PALETTE } from "../src/palettes.js";
import { DEFAULT_MERGE_EPSILON, buildMergePlan, pairError } from "../src/tilesim.js";
import { mergeGroupsInLayout, splitGridToTiles, toJs } from "../src/tojs.js";
import type { Grid } from "../src/types.js";

function solid(ch: string): Grid {
  return { rows: Array.from({ length: 16 }, () => Array<string>(16).fill(ch)) };
}

function onePixel(base: string, x: number, y: number, ch: string): Grid {
  const rows = Array.from({ length: 16 }, () => Array<string>(16).fill(base));
  rows[y][x] = ch;
  return { rows };
}

function verticalLine(base: string, x: number, ch: string): Grid {
  const rows = Array.from({ length: 16 }, () => Array<string>(16).fill(base));
  for (let y = 0; y < 16; y++) rows[y][x] = ch;
  return { rows };
}

function sameColorPalette(hex: string) {
  return { name: "same", colors: Array<string>(15).fill(hex) };
}

test("tilesim: 距离在调色板 RGB 空间计算", () => {
  const a = solid("1");
  const b = onePixel("1", 4, 4, "2");
  const colored = pairError(a, b, DEFAULT_PALETTE);
  assert.ok(colored.max > 0);
  // 把槽 1/2 都设成同色，像素差应消失
  const same = pairError(a, b, sameColorPalette("#FF0000"));
  assert.equal(same.max, 0);
});

test("tilesim: 边缘权重显著高于平坦区", () => {
  const a = solid("1");
  // 整块换色：所有像素都处在各自 tile 的平坦区
  const flatTile = solid("2");
  // 单像素轮廓变化：变化点自身形成边缘
  const outline = verticalLine("1", 8, "2");
  const flatErr = pairError(a, flatTile, DEFAULT_PALETTE).max;
  const edgeErr = pairError(a, outline, DEFAULT_PALETTE).max;
  assert.ok(edgeErr > flatErr * 2, `edge=${edgeErr} flat=${flatErr}`);
  assert.ok(flatErr <= DEFAULT_MERGE_EPSILON);
});

test("tilesim: 层次聚类曲线单调、代表取使用最多者", () => {
  const a = solid("1");
  const b = onePixel("1", 4, 4, "2");
  const c = solid("7");
  const grid = combineTiles([a, b, b, c], 2, 2);
  const layout = splitGridToTiles(grid);
  assert.ok(layout);

  const plan = buildMergePlan(layout!.unique, layout!.layout, DEFAULT_PALETTE, DEFAULT_MERGE_EPSILON);
  assert.equal(plan.uniqueBefore, 3);
  assert.equal(plan.uniqueAfter, 2);
  assert.equal(plan.groups.length, 1);
  // b 在 layout 中出现 2 次，a 1 次 → 代表应为 b（unique 下标 1，1 基 2）
  assert.equal(plan.groups[0].representative, 2);
  assert.deepEqual(plan.groups[0].members, [1]);
  assert.ok(plan.groups[0].maxError > 0);
  assert.ok(plan.knee >= 0);

  for (let i = 1; i < plan.curve.length; i++) {
    assert.ok(plan.curve[i].clusters < plan.curve[i - 1].clusters);
    assert.ok(plan.curve[i].maxError >= plan.curve[i - 1].maxError);
  }
});

test("tilesim: epsilon=0 不合并；批量合并后 unique 下降", () => {
  const a = solid("1");
  const b = onePixel("1", 4, 4, "2");
  const c = solid("7");
  const grid = combineTiles([a, b, a, c], 2, 2);
  const layout = splitGridToTiles(grid);
  assert.ok(layout);

  const none = buildMergePlan(layout!.unique, layout!.layout, DEFAULT_PALETTE, 0);
  assert.equal(none.groups.length, 0);
  assert.equal(none.uniqueAfter, 3);

  const plan = buildMergePlan(layout!.unique, layout!.layout, DEFAULT_PALETTE, DEFAULT_MERGE_EPSILON);
  const merged = mergeGroupsInLayout(layout!, plan.groups);
  const js = toJs({ kind: "single", grid: merged });
  assert.ok(js.tileStats);
  assert.equal(js.tileStats!.unique, 2);
  assert.equal(js.tileStats!.total, 4);
});
