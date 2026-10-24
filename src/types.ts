import type { Palette } from "./palettes.js";

/** 一个已按字符拆分的像素网格（rows[i][j] 为 `.`/`1`-`f` 单字符） */
export interface Grid {
  rows: string[][];
}

/** 解析产物 */
export type OutputFormat = "dsl" | "img";

interface ParseMeta {
  /** 规范化后的 DSL 源码（仅 DSL 产物；写回历史 / 前端展示） */
  source?: string;
  /** 产物格式：新版本优先 dsl；旧会话/回退为 img */
  format?: OutputFormat;
  /** 模型通过 `palette` 指令自行指定的调色板（组图按顺序对应每张） */
  palettes?: Palette[];
}

export type ParseResult =
  | ({ kind: "single"; grid: Grid } & ParseMeta)
  | ({ kind: "tiles"; tiles: Grid[]; width: number; height: number } & ParseMeta);

export interface TileNearGroup {
  /** 代表 tile 的 1 基编号（对应 JS 里的 tileN） */
  representative: number;
  /** 相似 tile 的 1 基编号 */
  members: number[];
  /** 组内最大像素差异（字符不同数量，兼容旧字段） */
  maxDiff: number;
  /** 加权最大单像素误差（0..255 量级） */
  maxError: number;
  /** 加权平均误差 */
  meanError: number;
  /** 组内所有 tile 的总使用次数 */
  usage: number;
}

export interface TileStats {
  /** tile 总数（例如 10×8 = 80） */
  total: number;
  /** 精确去重后的唯一 tile 数 */
  unique: number;
  /** 被复用的 tile 数 = total - unique */
  reused: number;
  /** 相似 tile 组（不会自动合并，仅提示/手动合并） */
  nearGroups: TileNearGroup[];
  /** 生成 nearGroups 时使用的误差阈值（加权） */
  epsilon?: number;
}

/** 智能合并的权重配置 */
export interface MergeWeights {
  /** 边缘/轮廓像素 */
  edge: number;
  /** 平坦区 */
  flat: number;
  /** 其余像素 */
  mid: number;
  /** 透明/不透明变化 */
  alpha: number;
}

/** 可回退的合并计划：从基准代码重新派生当前 code/PNG */
export interface MergePlan {
  /** 最大加权单像素误差阈值 */
  epsilon: number;
  /** 若缺省使用默认权重 */
  weights?: MergeWeights;
}

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 生成模式：仅 chat / 自动升级 / 深度思考 */
export type GenerationMode = "chat" | "auto" | "deep";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface SessionSettings {
  mode: GenerationMode;
  /** 会话费用上限（人民币元） */
  costLimit: number;
  /** 会话调色板（15 个不透明色 + 透明） */
  palette?: Palette;
}

export interface SessionState {
  id: string;
  /** 用户自定义名称；空字符串表示使用“会话 <id>”默认名 */
  title: string;
  createdAt: string;
  messages: ChatTurn[];
  turns: TurnRecord[];
  /** 本会话累计实际费用（元） */
  spend: number;
  settings: SessionSettings;
}

/** 一轮成功生成的记录 */
export interface TurnRecord {
  index: number;
  prompt: string;
  /** 主产物：旧版 JavaScript 程序（img / CombinedTiles） */
  code: string;
  /** 内部 DSL 源（新版本；用于多轮编辑/调试） */
  dsl?: string;
  /** 相对 /preview/ 的 png 路径 */
  png: string;
  width: number;
  height: number;
  createdAt: string;
  /** 手动合并 tile / 编辑 DSL 后更新时间（用于预览图防缓存） */
  updatedAt?: string;
  /** 最近一次手动编辑 DSL 的时间 */
  editedAt?: string;
  /** 实际渲染使用的放大倍数 */
  scale?: number;
  /** 手动合并过相似 tile */
  merged?: boolean;
  /** tile 复用统计 */
  tileStats?: TileStats;
  /** 该轮生成后 s.messages 的长度，用于“回到此轮”截断历史 */
  msgLen: number;
  mode: GenerationMode;
  cost: number;
  usage: TokenUsage;
  attempts: number;
  /** 实际使用的最后一档（如 "high" / "max"），用于“按当前档位重试” */
  tierKey?: string;
  /** 实际使用的最后一档的中文标签（如 "深思考"） */
  tierLabel?: string;
  /** 该轮产物格式：dsl（新版本）/ img（旧版本或回退） */
  format?: OutputFormat;
  /** 该轮渲染使用的调色板 */
  palette?: Palette;
  /** 调色板来源：会话设置 / 组图里显式指定 */
  paletteSource?: "session" | "explicit";
  /** 组图共享 id（同一轮请求生成的 N 个调色板变体） */
  groupId?: string;
  /** 本地描摹产物（未调用模型） */
  source?: "model" | "trace";
  /** 可回退的合并计划（若存在，code 由基准 + plan 派生） */
  mergePlan?: MergePlan;
  /** 首次合并前的基准代码（没有 DSL 时用于回退/重算） */
  baseCode?: string;
  /** 模型附带的简要介绍（若有；正常情况没有） */
  intro?: string;
  /** 成功那次调用的思维链（若有） */
  reasoning?: string;
}
