/** 一个已按字符拆分的像素网格（rows[i][j] 为 `.`/`1`-`f` 单字符） */
export interface Grid {
  rows: string[][];
}

/** 解析产物 */
export type ParseResult =
  | { kind: "single"; grid: Grid }
  | { kind: "tiles"; tiles: Grid[]; width: number; height: number };

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
}

export interface SessionState {
  id: string;
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
  code: string;
  /** 相对 /preview/ 的 png 路径 */
  png: string;
  width: number;
  height: number;
  createdAt: string;
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
  /** 模型附带的简要介绍（若有；正常情况没有） */
  intro?: string;
  /** 成功那次调用的思维链（若有） */
  reasoning?: string;
}
