import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { ParseError, parseAIOutput, toCode } from "./parse.js";
import { sizeHintFrom, validateResult } from "./validate.js";
import { calcCost, estimateTokens, worstCaseCost } from "./pricing.js";
import { tierFor, tierForKey, type AttemptTier, type TierKey } from "./modes.js";
import { repairGrid } from "./repair.js";
import { extractIntro } from "./text.js";
import type { ChatTurn, GenerationMode, ParseResult, TokenUsage } from "./types.js";

const SYSTEM_PROMPT = buildSystemPrompt();

function buildSystemPrompt(): string {
  const base = readFileSync("prompt.md", "utf8");
  return [
    base.trim(),
    "",
    "## 输出前必须自查（否则程序会拒绝并要求你重做）",
    "1. 每一行像素必须恰好包含指定宽度个字符，字符之间用单个空格分隔，行与行之间用换行分隔；输出前逐行计数。",
    "2. 只允许字符 `.`（透明）和 `1`-`f`（小写），禁止颜色名、`#`、逗号或其他符号。",
    "3. 单图默认 16*16；用户消息里若显式指定了尺寸（如 32*32），必须严格按该尺寸输出。",
    "4. 复杂场景必须拆成 16*16 图块并用 `new CombinedTiles([...], 宽, 高)` 拼接，图块变量必须先声明、引用名完全一致，图块总数 = 宽 * 高，顺序为从上到下、从左到右；图块总数不要超过 16（即 4x4），场景更大时用更少、更概括的图块。",
    "5. **必须真正画出内容**：禁止输出全透明图块、空白图块或用 `.` 占位符敷衍。每个图块都要包含可辨认的图形元素；整图必须有清晰主体。",
    "6. 不要在代码之外写解释、不要把代码拆成多次输出、不要只给骨架。先在心里规划布局，然后一次性输出完整代码。",
    "7. 若上一条消息指出你的输出有错误（格式错误、空图、被截断等），只修复对应问题并重新输出完整代码。",
    "",
    "## 格式示例（仅示意格式，非实际任务；注意每格都有内容而不是占位符）",
    "```",
    "export const result = img`",
    "1 1 2 2",
    "1 2 2 2",
    "2 2 8 8",
    "2 2 8 8",
    "`;",
    "```",
  ].join("\n");
}

export interface AttemptDetail {
  key: TierKey;
  label: string;
  model: string;
  finish: string;
  cost: number;
  usage: TokenUsage;
  error?: string;
  /** 本地维度修复说明（未重画） */
  repaired?: string;
}

export interface GenerationOutcome {
  code: string;
  parsed: ParseResult;
  attempts: number;
  errors: string[];
  hintReturn: { width: number; height: number };
  mode: GenerationMode;
  /** 本轮所有尝试（含失败）累计费用（元） */
  cost: number;
  /** 本轮所有尝试（含失败）累计用量 */
  usage: TokenUsage;
  attemptDetails: AttemptDetail[];
  /** 本地修复说明（若触发） */
  repaired?: string;
  /** 成功那次的思维链（若有） */
  reasoning?: string;
  /** 模型附带的简要介绍（若有） */
  intro?: string;
  finishReason?: string;
}

export class BudgetExceededError extends Error {
  cost: number;
  usage: TokenUsage;
  attemptDetails: AttemptDetail[];

  constructor(message: string, cost: number, usage: TokenUsage, attemptDetails: AttemptDetail[]) {
    super(message);
    this.name = "BudgetExceededError";
    this.cost = cost;
    this.usage = usage;
    this.attemptDetails = attemptDetails;
  }
}

/** 生成最终失败（但仍可能已产生费用） */
export class GenerationError extends Error {
  cost: number;
  usage: TokenUsage;
  attemptDetails: AttemptDetail[];

  constructor(message: string, cost: number, usage: TokenUsage, attemptDetails: AttemptDetail[]) {
    super(message);
    this.name = "GenerationError";
    this.cost = cost;
    this.usage = usage;
    this.attemptDetails = attemptDetails;
  }
}

export interface GenerateOptions {
  mode: GenerationMode;
  /** 剩余可用费用（元）；undefined 表示不限制 */
  budgetRemaining?: number;
  /** 指定起始档位（失败后的“按当前档位/升级后重试”）；缺省按 mode 的计划 */
  startTier?: TierKey;
  /** 本次最多尝试次数；缺省用 config.maxRepairAttempts。重试通常只跑 1 次 */
  maxAttempts?: number;
  /** 上一次失败原因（仅用于本次重试的提示，不写入历史） */
  retryError?: string;
  onProgress?: (attempt: number, label: string, error: string) => void;
}

const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
const MAX_REPAIR_CONTEXT = 6000;

function extractUsage(u: any): TokenUsage {
  const prompt = u?.prompt_tokens ?? 0;
  const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return {
    promptTokens: prompt,
    completionTokens: u?.completion_tokens ?? 0,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
  };
}

/** 多轮对话：历史 + 本轮用户消息 -> 规范化网格代码（带思考升级与费用统计） */
export async function generateWithRepair(
  history: ChatTurn[],
  userMessage: string,
  options: GenerateOptions,
): Promise<GenerationOutcome> {
  const hint = sizeHintFrom(userMessage) ?? { width: 16, height: 16 };
  const explicitHint = sizeHintFrom(userMessage);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];
  const retryHint = options.retryError?.trim().slice(0, 1000);
  if (retryHint) {
    messages.push({
      role: "user",
      content:
        `上一次生成失败：${retryHint}\n` +
        "请针对该问题修正后重新输出完整代码；若只是格式/计数问题，请逐行核对像素数量，不要解释。",
    });
  }

  const errors: string[] = [];
  const attemptDetails: AttemptDetail[] = [];
  const max = Math.max(1, options.maxAttempts ?? config.maxRepairAttempts);
  let totalCost = 0;
  let totalUsage: TokenUsage = {
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
  };
  let remaining = options.budgetRemaining;
  let lastFinish: string | undefined;

  for (let attempt = 1; attempt <= max; attempt++) {
    const tier = options.startTier ? tierForKey(options.startTier) : tierFor(options.mode, attempt);
    const promptTokensEst = estimateTokens(messages.map((m) => String(m.content ?? "")).join("\n"));

    if (remaining !== undefined) {
      const projected = worstCaseCost(tier.model, promptTokensEst, tier.maxTokens);
      if (projected > remaining) {
        throw new BudgetExceededError(
          `费用上限不足：本次「${tier.label}」预计最坏需 ¥${projected.toFixed(4)}，剩余额度 ¥${remaining.toFixed(6)}。请调高上限或改用更省的模式。`,
          totalCost,
          totalUsage,
          attemptDetails,
        );
      }
    }

    const body: any = { model: tier.model, messages, max_tokens: tier.maxTokens };
    if (tier.thinking) {
      body.thinking = { type: "enabled" };
      if (tier.effort) body.reasoning_effort = tier.effort;
    } else if (tier.model !== config.chatModel) {
      body.thinking = { type: "disabled" };
      body.temperature = tier.temperature;
    } else {
      body.temperature = tier.temperature;
    }

    let res: any;
    try {
      res = await client.chat.completions.create(body);
    } catch (e) {
      const detail: AttemptDetail = {
        key: tier.key, label: tier.label, model: tier.model, finish: "request-error", cost: 0,
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        error: String(e).slice(0, 200),
      };
      attemptDetails.push(detail);
      throw new GenerationError(
        `调用模型失败：${e instanceof Error ? e.message : String(e)}`,
        totalCost,
        totalUsage,
        attemptDetails,
      );
    }

    const choice = res.choices[0];
    const raw = choice?.message?.content ?? "";
    const reasoningRaw = (choice?.message as any)?.reasoning_content ?? "";
    const reasoningText = typeof reasoningRaw === "string" ? reasoningRaw.trim() : "";
    // 思维链可能非常长，限制存储/回传体积（不影响计费）
    const reasoning = reasoningText
      ? reasoningText.length > 20000
        ? `${reasoningText.slice(0, 20000)}\n…（思维链过长，已截断）`
        : reasoningText
      : undefined;
    const finish = choice?.finish_reason ?? "unknown";
    lastFinish = finish;
    const usage = extractUsage(res.usage);
    const cost = calcCost(tier.model, usage);
    totalCost += cost;
    totalUsage = addUsage(totalUsage, usage);
    if (remaining !== undefined) remaining = Math.max(0, remaining - cost);

    logRawAttempt(attempt, tier, finish, usage, cost, raw);

    const record = (error?: string, repaired?: string) => {
      attemptDetails.push({
        key: tier.key,
        label: tier.label,
        model: tier.model,
        finish,
        cost,
        usage,
        ...(error ? { error } : {}),
        ...(repaired ? { repaired } : {}),
      });
    };

    if (finish === "length") {
      const err =
        `上一次「${tier.label}」输出因长度上限被截断（finish_reason=length）。` +
        "请删除全部解释文字、直接输出完整代码；复杂场景可减少图块数量或使用更概括的布局。";
      errors.push(err);
      record(err);
      options.onProgress?.(attempt, tier.label, err);
      messages.push({ role: "assistant", content: "（上一次输出因长度上限被截断，内容已省略）" });
      messages.push({ role: "user", content: `${err}\n请重新输出完整代码。` });
      continue;
    }

    const outcome = tryValidate(raw, hint.width, hint.height, explicitHint);
    if ("error" in outcome) {
      errors.push(outcome.error);
      record(outcome.error);
      options.onProgress?.(attempt, tier.label, outcome.error);
      const context =
        raw.length > MAX_REPAIR_CONTEXT ? raw.slice(0, MAX_REPAIR_CONTEXT) + "\n（后文过长已省略）" : raw;
      const emptyHint = outcome.error.includes("透明色")
        ? "\n提示：把对象具体化（形状、颜色、部件），逐格绘制真实像素，不要只输出空白网格或占位符。"
        : "";
      messages.push({ role: "assistant", content: context });
      const repairPrompt =
        outcome.kind === "parse"
          ? `你上一次输出的**代码结构**无法解析：${outcome.error}\n` +
            "请只修复代码结构（img 围栏、CombinedTiles 参数、变量名等），**逐字保留所有像素行**，" +
            "不要重画、不要改变颜色/尺寸；然后重新输出完整代码，不要解释。"
          : `你的输出无效：${outcome.error}\n` +
            "请修正上述问题并重新输出**完整且真正有画面内容**的代码（不要任何解释、不要全透明占位符）。" +
            emptyHint;
      messages.push({ role: "user", content: repairPrompt });
      continue;
    }

    record(undefined, outcome.note);
    const intro = extractIntro(raw);
    return {
      code: outcome.code,
      parsed: outcome.parsed,
      attempts: attempt,
      errors,
      hintReturn: hint,
      mode: options.mode,
      cost: totalCost,
      usage: totalUsage,
      attemptDetails,
      ...(outcome.note ? { repaired: outcome.note } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(intro ? { intro } : {}),
      finishReason: finish,
    };
  }

  throw new GenerationError(
    `模型连续 ${max} 次输出无效，最后一次错误：${errors[errors.length - 1] ?? "未知"}（finish_reason=${lastFinish}）`,
    totalCost,
    totalUsage,
    attemptDetails,
  );
}

function tryValidate(
  raw: string,
  width: number,
  height: number,
  layoutHint: { width: number; height: number } | null,
): { code: string; parsed: ParseResult; note?: string } | { error: string; kind: "parse" | "validate" } {
  let parsed: ParseResult;
  try {
    parsed = parseAIOutput(raw, layoutHint);
  } catch (e) {
    return { error: e instanceof ParseError ? e.message : String(e), kind: "parse" };
  }

  const repaired = repairParsed(parsed, width, height);
  const invalid = validateResult(repaired.parsed, { width, height });
  if (invalid) return { error: invalid, kind: "validate" };
  return {
    code: toCode(repaired.parsed),
    parsed: repaired.parsed,
    ...(repaired.note ? { note: repaired.note } : {}),
  };
}

/** 对解析结果做差 1~2 个透明格的本地修复；修复后仍必须通过 validateResult */
function repairParsed(
  parsed: ParseResult,
  width: number,
  height: number,
): { parsed: ParseResult; note?: string } {
  if (parsed.kind === "single") {
    const r = repairGrid(parsed.grid, width, height);
    return r
      ? { parsed: { kind: "single", grid: r.grid }, note: r.notes.join("；") }
      : { parsed };
  }

  const notes: string[] = [];
  const tiles = parsed.tiles.map((tile, i) => {
    const r = repairGrid(tile, 16, 16);
    if (!r) return tile;
    notes.push(`tile${i + 1}：${r.notes.join("、")}`);
    return r.grid;
  });
  return notes.length
    ? {
        parsed: { kind: "tiles", tiles, width: parsed.width, height: parsed.height },
        note: notes.join("；"),
      }
    : { parsed };
}

/** 每次尝试的原始输出 + 档位 + 用量落盘，便于复盘截断/退化 */
function logRawAttempt(
  attempt: number,
  tier: AttemptTier,
  finish: string,
  usage: TokenUsage,
  cost: number,
  raw: string,
): void {
  try {
    mkdirSync(config.logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(config.logsDir, `${stamp}_attempt${attempt}.txt`);
    writeFileSync(
      file,
      [
        `model: ${tier.model}`,
        `tier: ${tier.label}`,
        `thinking: ${tier.thinking}${tier.effort ? ` (${tier.effort})` : ""}`,
        `max_tokens: ${tier.maxTokens}`,
        `finish_reason: ${finish}`,
        `usage: prompt=${usage.promptTokens} completion=${usage.completionTokens} reasoning=${usage.reasoningTokens} cache_hit=${usage.cacheHitTokens}`,
        `cost: ¥${cost.toFixed(6)}`,
        "",
        raw,
      ].join("\n"),
      "utf8",
    );
  } catch (e) {
    console.warn("写入原始输出日志失败:", e);
  }
}
