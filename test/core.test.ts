import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { ParseError, parseAIOutput, toCode } from "../src/parse.js";
import { validateResult, sizeHintFrom } from "../src/validate.js";
import { renderPNG, combineTiles, gridSize } from "../src/render.js";

const OK16 = Array.from({ length: 16 }, () => Array(16).fill(".")).map((r, y) =>
  r.map((_, x) => (x === y ? "2" : ".")),
);

function singleCode(rows: string[][]): string {
  return "export const result = img`\n" + rows.map((r) => r.join(" ")).join("\n") + "\n`;";
}

test("parse: 单图", () => {
  const code = singleCode(OK16);
  const r = parseAIOutput("解释一下……\n```js\n" + code + "\n```");
  assert.equal(r.kind, "single");
  assert.equal(r.kind === "single" && r.grid.rows.length, 16);
  assert.ok(validateResult(r, null) === null);
});

test("parse: 无空格的行也能按字符展开", () => {
  const lines = Array.from({ length: 16 }, (_, y) =>
    "........".repeat(2).slice(0, 15) + (y === 8 ? "2" : "."),
  );
  const code = "export const result = img`\n" + lines.join("\n") + "\n`;";
  const r = parseAIOutput(code);
  assert.ok(validateResult(r, { width: 16, height: 16 }) === null);
});

test("validate: 行数不足给出具体错误", () => {
  const r = parseAIOutput(singleCode(OK16.slice(0, 15)));
  const err = validateResult(r, { width: 16, height: 16 });
  assert.match(err ?? "", /15 行像素，应为 16 行/);
});

test("validate: 某行像素数错误给出具体错误", () => {
  const rows = OK16.map((r, i) => (i === 2 ? [...r, "1"] : r));
  const r = parseAIOutput(singleCode(rows));
  const err = validateResult(r, { width: 16, height: 16 });
  assert.match(err ?? "", /第 3 行有 17 个像素/);
});

test("validate: 非法字符被拦截", () => {
  const rows = OK16.map((r, i) => (i === 0 ? ["#", ...r.slice(1)] : r));
  const r = parseAIOutput(singleCode(rows));
  const err = validateResult(r, { width: 16, height: 16 });
  assert.match(err ?? "", /非法字符 `#`/);
});

test("validate: 用户指定 32*32 尺寸生效", () => {
  assert.deepEqual(sizeHintFrom("生成 32*32 的图标"), { width: 32, height: 32 });
  assert.equal(sizeHintFrom("画一只猫"), null);
  const rows16 = OK16;
  const r = parseAIOutput(singleCode(rows16));
  assert.match(validateResult(r, sizeHintFrom("32*32")) ?? "", /16 行像素，应为 32 行/);
});

test("parse: 缺少 img 围栏时抛 ParseError", () => {
  assert.throws(() => parseAIOutput("我不会画"), ParseError);
});

test("parse: CombinedTiles 图块数量与布局不符报错", () => {
  const tiles = [1, 2].map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;").join("\n");
  const code = tiles + "\nexport const result = new CombinedTiles([tile1, tile2], 4, 4);";
  assert.throws(() => parseAIOutput(code), /引用了 2 个图块/);
});

test("parse+validate: 2x1 图块拼接通过", () => {
  const tiles = [1, 2]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  const code = tiles + "\nexport const result = new CombinedTiles([tile1, tile2], 2, 1);";
  const r = parseAIOutput(code);
  assert.equal(r.kind, "tiles");
  assert.ok(validateResult(r, null) === null);
  const combined = r.kind === "tiles" ? combineTiles(r.tiles, r.width, r.height) : { rows: [] };
  assert.deepEqual(gridSize(combined), { width: 32, height: 16 });
});

test("parse: 多行 CombinedTiles + 尾随逗号（模型常见写法）", () => {
  const tiles = [1, 2]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  const code =
    tiles + "\nexport const result = new CombinedTiles(\n  [tile1, tile2], 2, 1,\n);";
  const r = parseAIOutput(code);
  assert.equal(r.kind, "tiles");
  assert.equal(r.kind === "tiles" && r.width, 2);
  assert.equal(r.kind === "tiles" && r.height, 1);
  assert.equal(validateResult(r, null), null);
});

test("toCode: 多图块规范化后可再次解析（含尾随逗号）", () => {
  const tiles = [1, 2]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  const code =
    tiles + "\nexport const result = new CombinedTiles(\n  [tile1, tile2], 2, 1,\n);";
  const r1 = parseAIOutput(code);
  const canonical = toCode(r1);
  const r2 = parseAIOutput(canonical);
  assert.equal(r2.kind, "tiles");
  assert.equal(toCode(r2), canonical);
});

test("parse: 缺少 CombinedTiles 时按图块数自动推断 2x2", () => {
  const tiles = [1, 2, 3, 4]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  const r = parseAIOutput(tiles);
  assert.equal(r.kind, "tiles");
  assert.equal(r.kind === "tiles" && r.width, 2);
  assert.equal(r.kind === "tiles" && r.height, 2);
  assert.equal(validateResult(r, null), null);
});

test("parse: 缺少 CombinedTiles 时按用户尺寸推断布局", () => {
  const tiles = [1, 2]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  const r = parseAIOutput(tiles, { width: 32, height: 16 });
  assert.equal(r.kind, "tiles");
  assert.equal(r.kind === "tiles" && r.width, 2);
  assert.equal(r.kind === "tiles" && r.height, 1);
});

test("parse: 2 图块且无尺寸时布局有歧义，不做猜测", () => {
  const tiles = [1, 2]
    .map((i) => "const tile" + i + " = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;")
    .join("\n");
  assert.throws(() => parseAIOutput(tiles), /无法从图块数量与用户尺寸推断布局/);
});

test("toCode: 输出可再次解析（幂等）", () => {
  const code = singleCode(OK16);
  const r1 = parseAIOutput(code);
  const canonical = toCode(r1);
  const r2 = parseAIOutput(canonical);
  assert.ok(validateResult(r2, null) === null);
  assert.equal(toCode(r2), canonical);
});

test("render: 16x16 @16x 输出 256x256 PNG", () => {
  const buf = renderPNG({ rows: OK16 }, 16);
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG");
  // IHDR 宽高位于偏移 16/20
  assert.equal(buf.readUInt32BE(16), 256);
  assert.equal(buf.readUInt32BE(20), 256);
});

test("render: 透明像素画成棋盘格而不是黑色", () => {
  const rows = Array.from({ length: 16 }, () => Array(16).fill("."));
  const png = PNG.sync.read(renderPNG({ rows }, 16));
  const px = (x: number, y: number) =>
    Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
  const a = px(0, 0);
  const b = px(70, 0); // 相邻 4x4 逻辑格
  assert.deepEqual(a, [255, 255, 255, 255]);
  assert.deepEqual(b, [204, 204, 204, 255]);
  assert.notDeepEqual(a, [0, 0, 0, 255]);
});

test("validate: 全透明单图被判定为空图", () => {
  const rows = Array.from({ length: 16 }, () => Array(16).fill("."));
  const r = parseAIOutput(singleCode(rows));
  const err = validateResult(r, { width: 16, height: 16 });
  assert.match(err ?? "", /完全是透明色/);
});

test("validate: 全透明图块被判定为空图", () => {
  const blank = Array.from({ length: 16 }, () => Array(16).fill("."));
  const code = [
    "const tile1 = img`\n" + OK16.map((r) => r.join(" ")).join("\n") + "\n`;",
    "const tile2 = img`\n" + blank.map((r) => r.join(" ")).join("\n") + "\n`;",
    "export const result = new CombinedTiles([tile1, tile2], 2, 1);",
  ].join("\n");
  const r = parseAIOutput(code);
  assert.match(validateResult(r, null) ?? "", /tile2 完全是透明色/);
});
