import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteSignature, resolveEditedPalettes } from "../src/dslEdit.js";
import { PRESET_PALETTES, type Palette } from "../src/palettes.js";

const gb = PRESET_PALETTES.gameboy;
const nes = PRESET_PALETTES.nes;
const pastel = PRESET_PALETTES.pastel;
const def = PRESET_PALETTES.default;

function names(palettes: Palette[]): string[] {
  return palettes.map((p) => p.name);
}

test("dslEdit: palette 行未改动时保留当前调色板", () => {
  const r = resolveEditedPalettes([gb], [gb], [nes], def);
  assert.ok(!("error" in r));
  assert.equal(r.changed, false);
  assert.deepEqual(names(r.palettes), ["nes"]);
});

test("dslEdit: 删除 palette 行后回到会话调色板", () => {
  const r = resolveEditedPalettes([gb], undefined, [nes, pastel], def);
  assert.ok(!("error" in r));
  assert.ok(r.changed);
  assert.equal(r.source, "session");
  assert.deepEqual(names(r.palettes), ["default", "default"]);
});

test("dslEdit: 改成 1 个 palette 时整组统一使用", () => {
  const r = resolveEditedPalettes([gb], [nes], [gb, pastel, nes], def);
  assert.ok(!("error" in r));
  assert.ok(r.changed);
  assert.equal(r.source, "explicit");
  assert.deepEqual(names(r.palettes), ["nes", "nes", "nes"]);
});

test("dslEdit: palette 数与组图张数一致时按顺序对应", () => {
  const r = resolveEditedPalettes([gb], [nes, pastel, gb], [gb, nes, pastel], def);
  assert.ok(!("error" in r));
  assert.ok(r.changed);
  assert.equal(r.source, "explicit");
  assert.deepEqual(names(r.palettes), ["nes", "pastel", "gameboy"]);
});

test("dslEdit: 单图给多个 palette 时拒绝", () => {
  const r = resolveEditedPalettes([gb], [nes, pastel], [gb], def);
  assert.ok("error" in r);
  assert.match(r.error, /单图最多只能有 1 个 palette/);
});

test("dslEdit: 组图 palette 数量不匹配时拒绝", () => {
  const r = resolveEditedPalettes([gb], [nes, pastel], [gb, nes, pastel], def);
  assert.ok("error" in r);
  assert.match(r.error, /palette 行必须为 0、1 或 3 个/);
});

test("dslEdit: signature 只比较名称与颜色", () => {
  assert.equal(
    paletteSignature([{ ...gb, label: "old" }]),
    paletteSignature([{ ...gb, label: "new" }]),
  );
  assert.notEqual(paletteSignature([gb]), paletteSignature([nes]));
});
