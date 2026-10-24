import { config } from "./config.js";
import type { GenerationMode } from "./types.js";

/** 可单独指定的调用档位（用于失败后的“按当前档位/升级后重试”） */
export type TierKey = "chat" | "fast" | "low" | "high" | "max";

const TIER_KEYS: readonly TierKey[] = ["chat", "fast", "low", "high", "max"];

export function isTierKey(v: unknown): v is TierKey {
  return typeof v === "string" && (TIER_KEYS as readonly string[]).includes(v);
}

export interface AttemptTier {
  key: TierKey;
  label: string;
  model: string;
  thinking: boolean;
  effort?: "low" | "high" | "max";
  maxTokens: number;
  temperature?: number;
}

export function tierForKey(key: TierKey): AttemptTier {
  switch (key) {
    case "chat":
      return {
        key,
        label: "chat",
        model: config.chatModel,
        thinking: false,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      };
    case "fast":
      return {
        key,
        label: "快速",
        model: config.model,
        thinking: false,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      };
    case "low":
      return {
        key,
        label: "轻思考",
        model: config.model,
        thinking: true,
        effort: "low",
        maxTokens: config.thinkingMaxTokens,
      };
    case "high":
      return {
        key,
        label: "深思考",
        model: config.model,
        thinking: true,
        effort: "high",
        maxTokens: config.deepThinkingMaxTokens,
      };
    case "max":
      return {
        key,
        label: "深度思考+",
        model: config.model,
        thinking: true,
        effort: "max",
        maxTokens: Math.max(config.deepThinkingMaxTokens, 32768),
      };
  }
}

/** 失败后“升级”的目标档位：chat/快速 → 轻思考 → 深思考 → max */
export function nextTierKey(key: TierKey): TierKey | null {
  switch (key) {
    case "chat":
    case "fast":
      return "low";
    case "low":
      return "high";
    case "high":
      return "max";
    case "max":
      return null;
  }
}

/** 正常请求的默认计划：chat 固定；auto 逐次升级；deep 直接 high→max */
export function tierFor(mode: GenerationMode, attempt: number): AttemptTier {
  if (mode === "chat") {
    const tier = tierForKey("chat");
    return {
      ...tier,
      temperature:
        attempt <= 1 ? config.temperature : Math.min(1, config.temperature + 0.3 * (attempt - 1)),
    };
  }
  if (mode === "auto") {
    if (attempt <= 1) return tierForKey("fast");
    if (attempt === 2) return tierForKey("low");
    return tierForKey("high");
  }
  return attempt <= 1 ? tierForKey("high") : tierForKey("max");
}
