import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { parseAIOutput, toCode } from "./parse.js";
import { validateResult } from "./validate.js";
import { affordableOutputTokens, calcCost, estimateTokens, inputWorstCost } from "./pricing.js";
import { tierFor, tierForKey, type AttemptTier, type TierKey } from "./modes.js";
import { repairGrid } from "./repair.js";
import { looksLikeDSL } from "./dsl.js";
import { toJs } from "./tojs.js";
import { DEFAULT_PALETTE, resolvePalette, type Palette } from "./palettes.js";
import { extractIntro } from "./text.js";
import type { ChatTurn, GenerationMode, ParseResult, TileStats, TokenUsage } from "./types.js";

const SYSTEM_PROMPT = buildSystemPrompt();

function buildSystemPrompt(): string {
  const base = readFileSync("prompt.md", "utf8");
  return [
    base.trim(),
    "",
    "## 程序侧硬性要求（不满足会被拒绝）",
    "1. 只输出一个 ```dsl 代码块；第一行必须是 `size W H`；不要输出 img`...`、CombinedTiles、逐行像素或解释。",
    "2. `size` 必须与程序注入的目标尺寸一致；tile 固定 16×16（宽 10 tile、高 8 tile = 160×128）；未注入时默认 16 16；画布范围 4..256。不要从用户消息文字里猜测尺寸。",
    "3. 坐标从 0 开始，x 向右、y 向下；所有图形必须完全在画布内，越界会被拒绝。",
    "4. 颜色只允许 `.` 和 `1`-`f`；`rect` 是填充、`frame` 是边框；参数个数必须严格匹配示例。",
    "5. 只有程序要求“AI 指定调色板”时才可输出 `palette` 指令（预设名或 `palette custom` + 15 个 #RRGGBB）；否则不要输出。",
    "6. 颜色字符：`1` 白 / `2` 红 / `3` 粉 / `4` 橙 / `5` 黄 / `6` 青 / `7` 绿 / `8` 蓝 / `9` 浅蓝 / `a` 紫 / `b` 浅紫 / `c` 深紫 / `d` 浅棕 / `e` 深棕 / `f` 黑，`.` 透明。",
    "7. 必须画出可辨认的主体；禁止全透明、纯背景或占位符。",
    "8. 多轮修改输出**完整 DSL**，不要只给 diff；保留用户没有要求修改的指令。",
    "9. 若上一条消息指出 DSL 编译/校验错误，只修正对应问题，仍输出完整 ```dsl 代码块。",
    "10. 历史中可能出现旧版 img`...` 代码；把它当作参考画面即可，本轮仍必须输出 DSL。",
    "11. 多轮修改必须保持程序注入的 `size`；如需改变画布大小，请在界面中修改，不要在消息里写尺寸。",
    "12. 程序会把 DSL 编译成旧版 JavaScript（img/CombinedTiles）；你只输出 DSL，不要输出 JS。",
    "",
    "## 最小示例",
    "```dsl",
    "size 16 16",
    "bg .",
    "frame 3 5 10 8 e",
    "rect 4 6 8 6 5",
    "rect 4 6 8 2 4",
    "rect 7 8 2 3 2",
    "pixel 6 9 1",
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
  /** 本次实际发送的 max_tokens（可能因剩余预算被动态调小） */
  maxTokens?: number;
  error?: string;
  /** 本地维度修复说明（未重画） */
  repaired?: string;
}

/**
 * 动态输出上限的软下限：剩余预算很小时仍给模型留一点输出空间，
 * 最多只会比剩余额度多花几厘钱，避免“预算只差一点就直接拒绝对话”。
 */
const MIN_DYNAMIC_OUTPUT_TOKENS = 256;

export interface GenerationOutcome {
  /** 主产物：旧版 JavaScript 程序（img / CombinedTiles） */
  code: string;
  /** 写回模型历史的内容（DSL 优先；旧格式为 JS） */
  historyCode: string;
  /** 内部 DSL 源（新版本） */
  dsl?: string;
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
  /** tile 复用统计 */
  tileStats?: TileStats;
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
  /** UI 中指定的目标画布尺寸（优先级最高；不再从提示词里解析） */
  targetSize?: { width: number; height: number };
  /** 多轮修改时继承上一轮的画布尺寸 */
  defaultSize?: { width: number; height: number };
  /** 本轮会话调色板（影响 tile 相似度与渲染；模型只输出字符） */
  palette?: Palette;
  /** 允许模型用 `palette` 指令自行指定调色板（组图时每张一个） */
  paletteByAI?: boolean;
  /** 组图张数，仅用于提示模型应输出几个 palette（缺省 1） */
  paletteCount?: number;
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
  // 目标尺寸只来自 UI / 上一轮，不再从用户提示词中猜测
  const explicitHint = options.targetSize ?? null;
  const layoutHint = explicitHint ?? options.defaultSize ?? null;
  const hint = layoutHint ?? { width: 16, height: 16 };
  const palette = options.palette ?? resolvePalette(undefined);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];
  if (options.paletteByAI) {
    const count = Math.max(1, Math.min(9, Math.floor(options.paletteCount ?? 1)));
    messages.push({
      role: "user",
      content:
        `本轮允许你自行决定调色板（${count > 1 ? `组图 ${count} 张，每张一行` : "共 1 张"}）。` +
        "请在 `size` 行之后、绘图指令之前添加 palette 指令：\n" +
        "- 预设：`palette default` / `gameboy` / `nes` / `pastel` / `monochrome` / `sepia` / `neon` / `warm` / `cool`；\n" +
        "- 自定义：`palette custom #RRGGBB #RRGGBB ...`（必须正好 15 个颜色，依次对应 1-f）；\n" +
        `- ${count > 1 ? `组图请输出 ${count} 行 palette（也可以一行写多个预设名），顺序对应第 1..${count} 张；` : "单图只需 1 行 palette。"}` +
        "若用户没有特别要求，请选择与主题匹配、角色语义清晰的调色板，不要解释。",
    });
    if (palette.name !== DEFAULT_PALETTE.name) {
      const table = palette.colors
        .map((hex, i) => `${(i + 1).toString(16)}=${hex}`)
        .join(" ");
      messages.push({
        role: "user",
        content:
          `（参考）会话当前调色板「${palette.label ?? palette.name}」：${table}。` +
          "只有在你选择 `palette default` 或相同顺序的自定义色板时才需要遵循这套语义。",
      });
    }
  } else if (palette.name !== DEFAULT_PALETTE.name) {
    const table = palette.colors
      .map((hex, i) => `${(i + 1).toString(16)}=${hex}`)
      .join(" ");
    messages.push({
      role: "user",
      content:
        `本轮使用调色板「${palette.label ?? palette.name}」：${table}。` +
        "请按这套颜色的语义选择字符（1-f）；忽略 prompt.md 里固定的颜色名称/hex，以本轮表格为准。" +
        "仍然只输出 DSL，不要输出 hex 或 palette 指令。",
    });
  }
  const retryHint = options.retryError?.trim().slice(0, 1000);
  if (retryHint) {
    messages.push({
      role: "user",
      content:
        `上一次生成失败：${retryHint}\n` +
        "请针对该问题修正后重新输出完整代码；若只是格式/计数问题，请逐行核对像素数量，不要解释。",
    });
  }
  if (layoutHint) {
    messages.push({
      role: "user",
      content:
        `程序指定目标画布 ${layoutHint.width}×${layoutHint.height}` +
        `${explicitHint ? "（来自界面设置）" : "（多轮修改沿用上一轮尺寸）"}；` +
        `请在第一行使用 \`size ${layoutHint.width} ${layoutHint.height}\`，不要从消息文字里猜测尺寸，也不要自行缩放。`,
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

    // 不再用“最坏情况用满 max_tokens”直接拒绝；改为按剩余预算动态压缩输出上限。
    // 只有剩余额度连输入都不够时才拒绝（此时任何输出都会超预算）。
    let maxTokens = tier.maxTokens;
    if (remaining !== undefined) {
      const inputCost = inputWorstCost(tier.model, promptTokensEst);
      if (remaining < inputCost) {
        throw new BudgetExceededError(
          `费用上限不足：剩余额度 ¥${remaining.toFixed(6)} 连本次输入的保守估计 ¥${inputCost.toFixed(6)} 都不够。` +
            "请调高上限、改用更省的模式，或新建会话。",
          totalCost,
          totalUsage,
          attemptDetails,
        );
      }
      const affordable = affordableOutputTokens(tier.model, promptTokensEst, remaining);
      maxTokens = Math.min(tier.maxTokens, Math.max(MIN_DYNAMIC_OUTPUT_TOKENS, affordable));
    }

    const body: any = { model: tier.model, messages, max_tokens: maxTokens };
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
        maxTokens,
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

    logRawAttempt(attempt, tier, maxTokens, finish, usage, cost, raw);

    const record = (error?: string, repaired?: string) => {
      attemptDetails.push({
        key: tier.key,
        label: tier.label,
        model: tier.model,
        finish,
        cost,
        usage,
        maxTokens,
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

    const outcome = tryValidate(raw, hint.width, hint.height, layoutHint);
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
          ? outcome.format === "dsl"
            ? `你上一次输出的 **DSL 无法编译**：${outcome.error}\n` +
              "请只修复 DSL 指令（指令名、参数个数、坐标/尺寸越界、颜色字符等），保持整体构图和配色；" +
              "重新输出完整的 ```dsl 代码块，不要解释、不要改成逐行像素。"
            : `你上一次输出的**代码结构**无法解析：${outcome.error}\n` +
              "请只修复代码结构（img 围栏、CombinedTiles 参数、变量名等），**逐字保留所有像素行**，" +
              "不要重画、不要改变颜色/尺寸；然后重新输出完整代码，不要解释。"
          : outcome.format === "dsl"
            ? `你的 DSL 编译结果无效：${outcome.error}\n` +
              "请调整 DSL 的形状/坐标/尺寸/颜色，重新输出完整的 ```dsl 代码块；不要解释、不要改成逐行像素。"
            : `你的输出无效：${outcome.error}\n` +
              "请修正上述问题并重新输出**完整且真正有画面内容**的代码（不要任何解释、不要全透明占位符）。" +
              emptyHint;
      messages.push({ role: "user", content: repairPrompt });
      continue;
    }

    record(undefined, outcome.note);
    const intro = extractIntro(raw);
    const js = toJs(outcome.parsed, palette);
    return {
      code: js.code,
      historyCode: outcome.historyCode,
      ...(outcome.parsed.format === "dsl" && outcome.parsed.source
        ? { dsl: outcome.parsed.source }
        : {}),
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
      ...(js.tileStats ? { tileStats: js.tileStats } : {}),
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
): { historyCode: string; parsed: ParseResult; note?: string } | { error: string; kind: "parse" | "validate"; format?: "dsl" | "img" } {
  let parsed: ParseResult;
  try {
    parsed = parseAIOutput(raw, layoutHint);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg, kind: "parse", format: looksLikeDSL(raw) ? "dsl" : "img" };
  }

  // DSL 由编译器保证精确尺寸，不做“补透明格”这类本地修复
  const repaired = parsed.format === "dsl" ? { parsed } : repairParsed(parsed, width, height);
  const invalid = validateResult(repaired.parsed, { width, height });
  if (invalid) {
    return {
      error: invalid,
      kind: "validate",
      ...(repaired.parsed.format ? { format: repaired.parsed.format } : {}),
    };
  }
  return {
    historyCode: toCode(repaired.parsed),
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
  maxTokens: number,
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
        `max_tokens: ${maxTokens}${maxTokens < tier.maxTokens ? ` (动态压缩，档位上限 ${tier.maxTokens})` : ""}`,
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
