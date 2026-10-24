import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIntro } from "../src/text.js";

const CODE = [
  "export const result = img`",
  ". . . .",
  ". 5 5 .",
  ". 5 5 .",
  ". . . .",
  "`;",
].join("\n");

test("text: 纯代码不产生介绍", () => {
  assert.equal(extractIntro(CODE), undefined);
});

test("text: 代码前/后的普通说明会被提取", () => {
  assert.equal(extractIntro(`这是一个金色宝箱：\n${CODE}`), "这是一个金色宝箱：");
  assert.equal(extractIntro(`${CODE}\n希望你喜欢这个像素画。`), "希望你喜欢这个像素画。");
});

test("text: fenced code block 会被剔除", () => {
  const raw = "先画一个宝箱。\n```ts\n" + CODE + "\n```\n完成。";
  assert.equal(extractIntro(raw), "先画一个宝箱。\n完成。");
});

test("text: 英文介绍不会被误判为像素行", () => {
  assert.equal(extractIntro(`A face\n${CODE}`), "A face");
});

test("text: 介绍过长会截断", () => {
  const intro = extractIntro("啊".repeat(1000) + "\n" + CODE);
  assert.ok(intro);
  assert.ok(intro!.length <= 801);
  assert.ok(intro!.endsWith("…"));
});
