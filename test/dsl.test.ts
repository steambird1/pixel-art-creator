import { test } from "node:test";
import assert from "node:assert/strict";
import { compileDSL, extractDSLBlock, looksLikeDSL } from "../src/dsl.js";
import { parseAIOutput, toCode } from "../src/parse.js";
import { countVisible, validateResult } from "../src/validate.js";
import { renderPNG } from "../src/render.js";

function rows(source: string): string[][] {
  return compileDSL(source).grid.rows;
}

test("dsl: rect / pixel / frame 基本绘制", () => {
  const g = rows("size 8 8\nrect 2 2 4 4 5\npixel 3 3 2\nframe 1 1 6 6 e");
  assert.equal(g.length, 8);
  assert.equal(g[0].length, 8);
  assert.equal(g[1][1], "e"); // frame 边框
  assert.equal(g[2][2], "5"); // frame 在 rect 外侧，不覆盖 rect 内部
  assert.equal(g[3][3], "2");
  assert.equal(g[4][4], "5");
  assert.equal(g[6][6], "e");
  assert.equal(g[0][0], ".");
});

test("dsl: line / hline / vline", () => {
  const g = rows("size 8 8\nline 0 0 7 7 1\nhline 0 7 8 2\nvline 7 0 8 3");
  for (let i = 0; i < 7; i++) {
    assert.equal(g[i][i], "1");
    assert.equal(g[7][i], "2");
  }
  assert.equal(g[7][7], "3");
  for (let i = 0; i < 8; i++) assert.equal(g[i][7], "3");
});

test("dsl: fill 只填充相连区域", () => {
  const g = rows("size 8 8\nframe 2 2 4 4 e\nfill 3 3 5");
  assert.equal(g[2][2], "e");
  assert.equal(g[3][3], "5");
  assert.equal(g[4][4], "5");
  assert.equal(g[1][1], ".");
});

test("dsl: ellipse / circle", () => {
  const g = rows("size 9 9\nellipse 2 2 5 5 5\ncircle 4 4 1 2");
  assert.equal(g[4][4], "2");
  assert.equal(g[2][2], ".");
  assert.equal(g[4][2], "5");
  assert.equal(g[0][0], ".");
});

test("dsl: circle 半径为 1 时是十字", () => {
  const g = rows("size 7 7\ncircle 3 3 1 2");
  assert.equal(g[3][3], "2");
  assert.equal(g[2][3], "2");
  assert.equal(g[4][3], "2");
  assert.equal(g[3][2], "2");
  assert.equal(g[3][4], "2");
  assert.equal(g[2][2], ".");
});

test("dsl: mirror x / y", () => {
  const mx = rows("size 8 8\npixel 1 1 5\nmirror x");
  assert.equal(mx[1][1], "5");
  assert.equal(mx[1][6], "5");
  assert.equal(mx[1][2], ".");

  const my = rows("size 8 8\npixel 1 1 5\nmirror y");
  assert.equal(my[1][1], "5");
  assert.equal(my[6][1], "5");
  assert.equal(my[2][1], ".");
});

test("dsl: bg 铺底，后续指令覆盖", () => {
  const g = rows("size 8 8\nbg 7\npixel 0 0 1");
  assert.equal(g[0][0], "1");
  assert.equal(g[7][7], "7");
  assert.equal(countVisible(g), 64);
});

test("dsl: 容忍围栏、说明文字、括号逗号写法", () => {
  const raw = [
    "画一个方块：",
    "```dsl",
    "size(8, 8)",
    "rect(1, 1, 3, 3, 5)",
    "pixel(2, 2, 1)",
    "```",
  ].join("\n");
  assert.equal(looksLikeDSL(raw), true);
  const block = extractDSLBlock(raw);
  assert.ok(block);
  const r = compileDSL(block!);
  assert.equal(r.width, 8);
  assert.equal(r.height, 8);
  assert.equal(r.grid.rows[1][1], "5");
  assert.equal(r.grid.rows[2][2], "1");
  assert.ok(validateResult({ kind: "single", grid: r.grid, format: "dsl", source: r.source }, { width: 8, height: 8 }) === null);
});

test("dsl: 没有围栏时从 size 行开始，遇到中文说明停止", () => {
  const raw = "先画一个方块：\nsize 8 8\nrect 1 1 2 2 5\n希望你喜欢。";
  assert.equal(looksLikeDSL(raw), true);
  const block = extractDSLBlock(raw);
  assert.ok(block);
  assert.doesNotMatch(block!, /希望/);
  const g = compileDSL(block!).grid.rows;
  assert.equal(g[1][1], "5");
});

test("dsl: 未写 size 时使用用户显式尺寸；未指定时默认 16", () => {
  const r = compileDSL("rect 0 0 1 1 5", { width: 24, height: 24 });
  assert.equal(r.width, 24);
  assert.equal(r.height, 24);
  assert.match(r.source, /^size 24 24/);

  const d = compileDSL("rect 0 0 1 1 5");
  assert.equal(d.width, 16);
  assert.equal(d.height, 16);
});

test("dsl: size 与用户要求不一致时报错", () => {
  assert.throws(
    () => compileDSL("size 16 16\nrect 0 0 1 1 5", { width: 32, height: 32 }),
    /32×32/,
  );
});

test("dsl: 越界 / 非法颜色 / 未知指令 / 没有绘制内容时报错", () => {
  assert.throws(() => compileDSL("size 8 8\nrect 7 7 2 2 5"), /超出/);
  assert.throws(() => compileDSL("size 8 8\npixel 0 0 x"), /颜色/);
  assert.throws(() => compileDSL("size 8 8\nblur 0 0"), /未知指令/);
  assert.throws(() => compileDSL("size 8 8\nbg 7"), /没有实际绘制形状/);
  assert.throws(() => compileDSL("size 8 8\nbg 7\nfill 0 0 5"), /没有实际绘制形状/);
  assert.throws(() => compileDSL("size 8 8\nrect 0 0 2 2 5\nsize 16 16"), /size 必须/);
});

test("dsl: parseAIOutput 优先识别 DSL，toCode 保留 DSL 源码并可幂等解析", () => {
  const raw = "```dsl\nsize 8 8\nrect 0 0 8 8 5\npixel 3 3 2\n```";
  const r = parseAIOutput(raw);
  assert.equal(r.kind, "single");
  assert.equal(r.kind === "single" && r.format, "dsl");
  assert.equal(r.kind === "single" && r.grid.rows.length, 8);
  assert.equal(r.kind === "single" && r.grid.rows[3][3], "2");

  const code = toCode(r);
  assert.match(code, /^size 8 8/);
  assert.doesNotMatch(code, /img`/);
  const r2 = parseAIOutput(code);
  assert.equal(toCode(r2), code);
});

test("dsl: palette 预设 / 多个预设 / 自定义 15 色", () => {
  const a = compileDSL("size 8 8\npalette gameboy\npixel 0 0 1");
  assert.equal(a.palettes?.length, 1);
  assert.equal(a.palettes?.[0].name, "gameboy");
  assert.match(a.source, /^size 8 8\npalette gameboy\n/);

  const b = compileDSL("size 8 8\npalette default nes\npixel 0 0 1");
  assert.deepEqual(b.palettes?.map((p) => p.name), ["default", "nes"]);

  const colors = Array.from({ length: 15 }, (_, i) => `#${(i * 0x111111).toString(16).padStart(6, "0")}`);
  const c = compileDSL(`size 8 8\npalette custom ${colors.join(" ")}\npixel 0 0 1`);
  assert.equal(c.palettes?.length, 1);
  assert.deepEqual(c.palettes?.[0].colors, colors.map((x) => x.toUpperCase()));
  assert.match(c.source, /palette custom #000000/);

  const parsed = parseAIOutput("```dsl\nsize 8 8\npalette neon\npixel 0 0 1\n```");
  assert.equal(parsed.palettes?.[0].name, "neon");
  assert.equal(parseAIOutput(toCode(parsed)).palettes?.[0].name, "neon");
});

test("dsl: palette 非法名称 / 数量不足 / 出现在 size 之前时报错", () => {
  assert.throws(() => compileDSL("size 8 8\npalette nope\npixel 0 0 1"), /未知调色板/);
  assert.throws(() => compileDSL("size 8 8\npalette custom #FFFFFF\npixel 0 0 1"), /正好 15/);
  assert.throws(() => compileDSL("palette default\nsize 8 8\npixel 0 0 1"), /size 之后/);
});

test("dsl: 32x32 宝箱示例可编译、校验、渲染", () => {
  const source = [
    "size 32 32",
    "bg .",
    "frame 5 7 22 18 e",
    "rect 6 8 20 16 5",
    "rect 6 8 20 5 4",
    "rect 14 14 4 6 2",
    "pixel 15 15 1",
    "hline 6 21 20 e",
    "vline 16 8 16 e",
    "mirror x",
  ].join("\n");
  const r = compileDSL(source, { width: 32, height: 32 });
  assert.equal(r.grid.rows.length, 32);
  assert.ok(r.grid.rows.every((row) => row.length === 32));
  assert.ok(countVisible(r.grid.rows) > 0);
  assert.equal(validateResult({ kind: "single", grid: r.grid, format: "dsl", source: r.source }, { width: 32, height: 32 }), null);
  const png = renderPNG(r.grid, 8);
  assert.ok(png.length > 100);
});
