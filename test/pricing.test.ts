import { test } from "node:test";
import assert from "node:assert/strict";
import {
  affordableOutputTokens,
  calcCost,
  estimateTokens,
  inputWorstCost,
  isPeak,
  unitPrices,
  worstCaseCost,
} from "../src/pricing.js";
import { isTierKey, nextTierKey, tierFor, tierForKey } from "../src/modes.js";
import { config } from "../src/config.js";
import type { TokenUsage } from "../src/types.js";

function usage(p: Partial<TokenUsage>): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    ...p,
  };
}

test("pricing: 高峰时段按北京时间工作日 9-12 / 14-18", () => {
  // 2026-10-20 是周二
  assert.equal(isPeak(new Date("2026-10-20T02:00:00Z")), true); // 北京 10:00
  assert.equal(isPeak(new Date("2026-10-20T04:00:00Z")), false); // 北京 12:00
  assert.equal(isPeak(new Date("2026-10-20T06:00:00Z")), true); // 北京 14:00
  assert.equal(isPeak(new Date("2026-10-20T00:30:00Z")), false); // 北京 08:30
  assert.equal(isPeak(new Date("2026-10-17T02:00:00Z")), false); // 周六 10:00
});

test("pricing: 输入未命中/缓存命中/输出分别计价", () => {
  const at = new Date("2026-10-20T00:30:00Z"); // 空闲
  const cost = calcCost("deepseek-flash", usage({ promptTokens: 1000, cacheMissTokens: 1000, completionTokens: 1000 }), at);
  assert.equal(cost, (1000 * 1 + 1000 * 4) / 1e6);

  const cached = calcCost(
    "deepseek-flash",
    usage({ promptTokens: 1000, cacheHitTokens: 1000, cacheMissTokens: 0, completionTokens: 0 }),
    at,
  );
  assert.equal(cached, (1000 * 0.02) / 1e6);
});

test("pricing: 高峰价格为空闲 2 倍", () => {
  const idle = unitPrices("deepseek-flash", new Date("2026-10-20T00:30:00Z"));
  const peak = unitPrices("deepseek-flash", new Date("2026-10-20T02:00:00Z"));
  assert.equal(peak.inputMiss, idle.inputMiss * 2);
  assert.equal(peak.output, idle.output * 2);
});

test("pricing: 最坏情况按满 max_tokens 估算", () => {
  const at = new Date("2026-10-20T00:30:00Z");
  const cost = worstCaseCost("deepseek-flash", 1000, 8192, at);
  assert.equal(cost, (1000 * 1 + 8192 * 4) / 1e6);
  assert.ok(estimateTokens("画一个红色药水瓶") > 0);
});

test("pricing: 按剩余预算动态计算可输出 token 数", () => {
  const at = new Date("2026-10-20T00:30:00Z"); // 空闲
  const inputCost = inputWorstCost("deepseek-flash", 1000, at);
  assert.equal(inputCost, (1000 * 1) / 1e6);

  // 0.021 - 0.001 = 0.020 元，输出 4 元/百万 token -> 5000 tokens
  assert.equal(affordableOutputTokens("deepseek-flash", 1000, 0.021, at), 5000);
  // 预算连输入都不够时返回 0（调用方会拒绝）
  assert.equal(affordableOutputTokens("deepseek-flash", 1000, 0.0005, at), 0);
  // 预算充足时返回一个很大的数，由调用方用档位 maxTokens 封顶
  assert.ok(affordableOutputTokens("deepseek-flash", 1000, 1, at) > 100_000);
});

test("modes: auto 为 快速(关闭) → 轻思考(low) → 深思考(high)", () => {
  const a = tierFor("auto", 1);
  assert.equal(a.thinking, false);
  assert.equal(a.model, config.model);
  assert.equal(a.effort, undefined);

  const b = tierFor("auto", 2);
  assert.equal(b.thinking, true);
  assert.equal(b.effort, "low");
  assert.ok(b.maxTokens >= config.maxTokens);

  const c = tierFor("auto", 3);
  assert.equal(c.thinking, true);
  assert.equal(c.effort, "high");
  assert.ok(c.maxTokens >= b.maxTokens);

  // 超过 3 次仍停在最高档
  assert.equal(tierFor("auto", 5).effort, "high");
});

test("modes: chat 使用独立模型并温度递增", () => {
  const a = tierFor("chat", 1);
  assert.equal(a.model, config.chatModel);
  assert.equal(a.thinking, false);
  assert.equal(a.temperature, config.temperature);
  assert.ok((tierFor("chat", 2).temperature ?? 0) > (a.temperature ?? 0));
});

test("modes: deep 首次 high，重试 max", () => {
  const a = tierFor("deep", 1);
  assert.equal(a.thinking, true);
  assert.equal(a.effort, "high");
  const b = tierFor("deep", 2);
  assert.equal(b.effort, "max");
  assert.ok(b.maxTokens >= 32768);
});

test("modes: 可按档位 key 单独调用（失败重试）", () => {
  assert.equal(tierForKey("fast").thinking, false);
  assert.equal(tierForKey("low").effort, "low");
  assert.equal(tierForKey("high").effort, "high");
  assert.equal(tierForKey("max").effort, "max");
  assert.equal(tierForKey("chat").model, config.chatModel);
  assert.equal(isTierKey("high"), true);
  assert.equal(isTierKey("nope"), false);
});

test("modes: 升级路径 chat/快速 → 轻思考 → 深思考 → max", () => {
  assert.equal(nextTierKey("chat"), "low");
  assert.equal(nextTierKey("fast"), "low");
  assert.equal(nextTierKey("low"), "high");
  assert.equal(nextTierKey("high"), "max");
  assert.equal(nextTierKey("max"), null);
});
