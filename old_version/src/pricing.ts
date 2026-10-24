import type { TokenUsage } from "./types.js";

/**
 * 官方价格（人民币元 / 百万 tokens）
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 空闲时段价格；高峰时段 = 空闲 × 2。
 */
export interface ModelPrice {
  inputMiss: number;
  inputHit: number;
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "deepseek-flash": { inputMiss: 1, inputHit: 0.02, output: 4 },
  // 旧别名，按 flash 档计费
  "deepseek-chat": { inputMiss: 1, inputHit: 0.02, output: 4 },
  "deepseek-v4-pro": { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  // 兜底：未知模型按 flash 价格估算，避免费用统计失效
  unknown: { inputMiss: 1, inputHit: 0.02, output: 4 },
};

/** 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00（不含法定节假日，按工作日近似） */
export function isPeak(at: Date = new Date()): boolean {
  const bj = new Date(at.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay(); // 0=周日
  const h = bj.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}

export function unitPrices(model: string, at: Date = new Date()): ModelPrice {
  const base = MODEL_PRICES[model] ?? MODEL_PRICES.unknown;
  const factor = isPeak(at) ? 2 : 1;
  return { inputMiss: base.inputMiss * factor, inputHit: base.inputHit * factor, output: base.output * factor };
}

/** 单次调用的实际费用（元） */
export function calcCost(model: string, usage: TokenUsage, at: Date = new Date()): number {
  const p = unitPrices(model, at);
  const hit = Math.max(0, usage.cacheHitTokens);
  const miss = Math.max(0, usage.cacheMissTokens || usage.promptTokens - hit);
  return (miss * p.inputMiss + hit * p.inputHit + usage.completionTokens * p.output) / 1_000_000;
}

/** 粗略 token 估算：中文约 1 字 1 token，代码空格较多约 2 字符 1 token，取 0.7 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.7);
}

/** 最坏情况费用：输入全部未命中缓存 + 用满 max_tokens */
export function worstCaseCost(model: string, promptTokens: number, maxTokens: number, at: Date = new Date()): number {
  const p = unitPrices(model, at);
  return (promptTokens * p.inputMiss + maxTokens * p.output) / 1_000_000;
}

/** 空 usage（请求失败时使用） */
export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};
