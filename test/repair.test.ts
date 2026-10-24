import { test } from "node:test";
import assert from "node:assert/strict";
import { repairGrid } from "../src/repair.js";
import { countVisible, validateResult } from "../src/validate.js";

/** 32x32 的“宝箱”示意：中间 8 行有内容，其余透明 */
function chestRows(): string[][] {
  return Array.from({ length: 32 }, (_, y) =>
    Array.from({ length: 32 }, (_, x) => {
      if (y >= 12 && y < 20 && x >= 4 && x < 28) return x % 3 === 0 ? "5" : "4";
      return ".";
    }),
  );
}

test("repair: 补齐短行末尾缺失的透明像素", () => {
  const rows = chestRows();
  // 8 行各少最后一个透明像素（模型实际失败形态）
  for (let y = 14; y < 22; y++) rows[y] = rows[y].slice(0, 31);
  const r = repairGrid({ rows }, 32, 32);
  assert.ok(r);
  assert.equal(r!.grid.rows.length, 32);
  assert.ok(r!.grid.rows.every((row) => row.length === 32));
  assert.deepEqual(r!.grid.rows, chestRows());
  assert.match(r!.notes.join("；"), /补齐 8 个缺失的透明像素/);
});

test("repair: 删除末尾多余空白行并修剪行尾多余点", () => {
  const expected = chestRows();
  const rows = expected.map((r) => [...r]);
  rows[20].push("."); // 33 个像素，最后一个是多余的透明格
  rows.push(Array(32).fill(".")); // 33 行，最后一行空白
  const r = repairGrid({ rows }, 32, 32);
  assert.ok(r);
  assert.deepEqual(r!.grid.rows, expected);
  assert.match(r!.notes.join("；"), /删除 1 行多余空白行/);
  assert.match(r!.notes.join("；"), /删除 1 个多余的透明像素/);
});

test("repair: 行首多出透明格且行尾有内容时不擅自整体左移", () => {
  const rows = chestRows();
  rows[15] = Array(32).fill("5"); // 该行内容顶到最右
  rows[15] = [".", ...rows[15]]; // 33 个像素，多出的点在行首
  assert.equal(repairGrid({ rows }, 32, 32), null);
});

test("repair: 多余的是有内容的像素时不猜测", () => {
  const rows = chestRows();
  rows[20] = [...rows[20], "5"]; // 末尾多一个颜色像素，无法安全判断
  assert.equal(repairGrid({ rows }, 32, 32), null);
});

test("repair: 多余行有内容时不删除", () => {
  const rows = chestRows();
  rows.push(Array(32).fill("5"));
  assert.equal(repairGrid({ rows }, 32, 32), null);
});

test("repair: 缺少行时在末尾补空白行", () => {
  const expected = chestRows();
  const rows = expected.slice(0, 31);
  const r = repairGrid({ rows }, 32, 32);
  assert.ok(r);
  assert.deepEqual(r!.grid.rows, expected);
  assert.match(r!.notes.join("；"), /补齐 1 行空白行/);
});

test("repair: 空图修复后仍会被空图校验拦截", () => {
  const rows = Array.from({ length: 33 }, () => Array(32).fill("."));
  const r = repairGrid({ rows }, 32, 32);
  assert.ok(r);
  assert.equal(r!.grid.rows.length, 32);
  assert.equal(countVisible(r!.grid.rows), 0);
  assert.match(validateResult({ kind: "single", grid: r!.grid }, { width: 32, height: 32 }) ?? "", /完全是透明色/);
});
