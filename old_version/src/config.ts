import "dotenv/config";

/** 全局配置：全部来自 .env，缺省值保证开箱即用 */
export const config = {
  /** DeepSeek OpenAI 兼容端点 */
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  /** 快速/思考档使用的模型（官方现名 deepseek-flash，支持 thinking） */
  model: process.env.DEEPSEEK_THINKING_MODEL ?? "deepseek-flash",
  /** “仅 chat”档使用的模型（兼容旧配置：DEEPSEEK_MODEL 仍生效） */
  chatModel: process.env.DEEPSEEK_CHAT_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  /** 解析校验失败后的自动重试次数（auto 档下同时是“快速→轻思考→深思考”的升级次数） */
  maxRepairAttempts: Number(process.env.MAX_REPAIR ?? "3"),
  /** 单次输出 token 上限（非思考/轻思考档） */
  maxTokens: Number(process.env.MAX_TOKENS ?? "8192"),
  /** 轻思考档 token 上限 */
  thinkingMaxTokens: Number(process.env.THINKING_MAX_TOKENS ?? "16384"),
  /** 深思考档 token 上限（过小会被思考吃光导致截断） */
  deepThinkingMaxTokens: Number(process.env.DEEP_THINKING_MAX_TOKENS ?? "24576"),
  /** 普通模式首次尝试温度；重试自动升温 */
  temperature: Number(process.env.TEMPERATURE ?? "0.3"),
  /** 新会话默认费用上限（元） */
  defaultCostLimit: Number(process.env.DEFAULT_COST_LIMIT ?? "0.50"),
  /** 原始模型输出落盘目录（排查截断/退化问题） */
  logsDir: process.env.LOGS_DIR ?? "logs",
  /** 预览图默认放大倍数（前端可切换 8/16/32/64） */
  defaultScale: Number(process.env.PREVIEW_SCALE ?? "16"),
  port: Number(process.env.PORT ?? "3000"),
  /** 会话与预览图落盘目录 */
  sessionsDir: process.env.SESSIONS_DIR ?? "sessions",
  previewDir: process.env.PREVIEW_DIR ?? "preview",
};
