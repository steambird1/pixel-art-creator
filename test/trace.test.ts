import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { DEFAULT_PALETTE } from "../src/palettes.js";
import { resolveTraceSize, tracePNG } from "../src/trace.js";

function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * width + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

test("trace: 自动尺寸保持比例并吸附到 16 的倍数", () => {
  assert.deepEqual(resolveTraceSize(1000, 500), { width: 128, height: 64 });
  assert.deepEqual(resolveTraceSize(100, 100), { width: 96, height: 96 });
  assert.deepEqual(resolveTraceSize(1000, 500, { width: 32 }), { width: 32, height: 16 });
  assert.deepEqual(resolveTraceSize(1000, 500, { width: 32, height: 32 }), { width: 32, height: 32 });
});

test("trace: PNG -> 网格，颜色映射到会话调色板", () => {
  const buf = makePng(16, 16, (x) => (x < 8 ? [255, 33, 33, 255] : [0, 63, 173, 255]));
  const result = tracePNG(buf, DEFAULT_PALETTE);
  assert.equal(result.width, 16);
  assert.equal(result.height, 16);
  assert.equal(result.adaptive, false);
  assert.equal(result.grid.rows.length, 16);
  assert.equal(result.grid.rows[0].length, 16);
  assert.equal(result.grid.rows[0][0], "2"); // 红
  assert.equal(result.grid.rows[0][15], "8"); // 蓝
});

test("trace: alpha 低于阈值变透明", () => {
  const buf = makePng(16, 16, (x) => (x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const result = tracePNG(buf, DEFAULT_PALETTE, { alphaThreshold: 128 });
  assert.equal(result.grid.rows[0][0], "1");
  assert.equal(result.grid.rows[0][15], ".");
});

test("trace: 自适应提取 15 色", () => {
  const colors: Array<[number, number, number]> = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255],
    [0, 255, 255], [128, 0, 0], [0, 128, 0], [0, 0, 128], [128, 128, 0],
    [128, 0, 128], [0, 128, 128], [64, 64, 64], [192, 192, 192], [255, 255, 255],
  ];
  const buf = makePng(16, 16, (x, y) => {
    const c = colors[(x + y * 16) % colors.length];
    return [c[0], c[1], c[2], 255];
  });
  const result = tracePNG(buf, DEFAULT_PALETTE, { adaptive: true, width: 16, height: 16 });
  assert.equal(result.adaptive, true);
  assert.equal(result.palette.name, "adaptive");
  assert.equal(result.palette.colors.length, 15);
  assert.ok(result.grid.rows.every((row) => row.every((ch) => ch !== ".")));
});

test("trace: 抖动模式可运行且输出合法字符", () => {
  const buf = makePng(32, 32, (x, y) => {
    const v = x < 16 ? 80 + x * 4 : 160 + y * 2;
    return [v, v, v, 255];
  });
  const result = tracePNG(buf, DEFAULT_PALETTE, { dither: true, width: 32, height: 32 });
  assert.equal(result.grid.rows.length, 32);
  for (const row of result.grid.rows) {
    for (const ch of row) assert.match(ch, /^[.1-9a-f]$/);
  }
});
