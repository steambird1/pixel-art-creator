import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { DEFAULT_PALETTE, clonePalette, resolvePalette } from "./palettes.js";
import type { ChatTurn, GenerationMode, SessionSettings, SessionState, TokenUsage, TurnRecord } from "./types.js";

const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

function sessionsDir(): string {
  mkdirSync(config.sessionsDir, { recursive: true });
  return config.sessionsDir;
}

export function isGenerationMode(v: unknown): v is GenerationMode {
  return v === "chat" || v === "auto" || v === "deep";
}

export function defaultSettings(): SessionSettings {
  return { mode: "auto", costLimit: config.defaultCostLimit, palette: clonePalette(DEFAULT_PALETTE) };
}

/** 会话名称最大长度（字符） */
export const MAX_SESSION_TITLE = 80;

/** 规范化会话名称：折叠空白并去掉首尾空格；非字符串视为空名称 */
export function normalizeSessionTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/** 兼容旧会话文件：缺字段时补默认值，并按轮次费用重算累计花费 */
function normalizeSession(raw: any): SessionState {
  const turns: TurnRecord[] = Array.isArray(raw.turns) ? raw.turns : [];
  for (const t of turns) {
    t.cost = Number.isFinite(t.cost) ? t.cost : 0;
    t.mode = isGenerationMode(t.mode) ? t.mode : "chat";
    t.usage = t.usage ?? { ...EMPTY_USAGE };
    t.attempts = Number.isFinite(t.attempts) ? t.attempts : 1;
  }
  const settings = raw.settings ?? {};
  const costLimit = Number(settings.costLimit);
  return {
    id: String(raw.id ?? ""),
    title: normalizeSessionTitle(raw.title).slice(0, MAX_SESSION_TITLE),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    turns,
    spend: Number.isFinite(raw.spend)
      ? raw.spend
      : turns.reduce((sum, t) => sum + (t.cost ?? 0), 0),
    settings: {
      mode: isGenerationMode(settings.mode) ? settings.mode : "auto",
      costLimit: Number.isFinite(costLimit) && costLimit >= 0 ? costLimit : config.defaultCostLimit,
      palette: resolvePalette(settings.palette),
    },
  };
}

export function createSession(settings?: Partial<SessionSettings>): SessionState {
  const base = defaultSettings();
  const s: SessionState = {
    id: randomUUID().slice(0, 8),
    title: "",
    createdAt: new Date().toISOString(),
    messages: [],
    turns: [],
    spend: 0,
    settings: {
      mode: isGenerationMode(settings?.mode) ? settings.mode : base.mode,
      costLimit:
        Number.isFinite(settings?.costLimit) && (settings!.costLimit as number) >= 0
          ? (settings!.costLimit as number)
          : base.costLimit,
      palette: resolvePalette(settings?.palette),
    },
  };
  saveSession(s);
  return s;
}

export function saveSession(s: SessionState): void {
  writeFileSync(join(sessionsDir(), `${s.id}.json`), JSON.stringify(s, null, 2), "utf8");
}

export function loadSession(id: string): SessionState | null {
  if (!/^[\w-]{1,32}$/.test(id)) return null;
  const p = join(sessionsDir(), `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return normalizeSession(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  if (!/^[\w-]{1,32}$/.test(id)) return false;
  const p = join(sessionsDir(), `${id}.json`);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

/** 把组图变体合并成逻辑轮次：同一 groupId 只算一轮 */
export function groupTurns(turns: TurnRecord[]): TurnRecord[][] {
  const groups: TurnRecord[][] = [];
  const byId = new Map<string, TurnRecord[]>();
  for (const t of turns) {
    if (t.groupId) {
      const existing = byId.get(t.groupId);
      if (existing) {
        existing.push(t);
        continue;
      }
    }
    const group = [t];
    groups.push(group);
    if (t.groupId) byId.set(t.groupId, group);
  }
  return groups;
}

export function countGenerationTurns(turns: TurnRecord[]): number {
  return groupTurns(turns).length;
}

export function listSessions(): Array<{
  id: string;
  title: string;
  createdAt: string;
  turns: number;
  images: number;
  spend: number;
}> {
  return readdirSync(sessionsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const s = loadSession(f.replace(/\.json$/, ""));
      return s
        ? {
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            turns: countGenerationTurns(s.turns),
            images: s.turns.length,
            spend: s.spend,
          }
        : null;
    })
    .filter(
      (x): x is { id: string; title: string; createdAt: string; turns: number; images: number; spend: number } =>
        x !== null,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 设置会话名称并落盘；空名称表示恢复默认显示 */
export function renameSession(s: SessionState, title: string): SessionState {
  s.title = normalizeSessionTitle(title).slice(0, MAX_SESSION_TITLE);
  saveSession(s);
  return s;
}

export function appendTurn(s: SessionState, turn: TurnRecord): void {
  s.turns.push(turn);
  saveSession(s);
}

/**
 * 回到某一轮：截断对话历史到该轮生成前的状态，并删除其后的轮次记录。
 * turnIndex 为目标轮次（1 基），截断后会话将从该图之后继续修改。
 *
 * 注意：`spend` 是**累计消费**，回滚只删除轮次记录，不退还/扣减已经花掉的费用。
 * 被丢弃轮次的费用仍然占用本会话费用上限，避免通过反复回滚绕过预算。
 */
export function backToTurn(s: SessionState, turnIndex: number): SessionState | null {
  const t = s.turns.find((x) => x.index === turnIndex);
  if (!t) return null;
  s.messages = s.messages.slice(0, t.msgLen);
  const groupId = t.groupId;
  // 组图的 N 个变体共享同一条对话消息；回到组内任一轮都保留整组，避免图片/历史错位
  s.turns = s.turns.filter(
    (x) => x.index <= turnIndex || (!!groupId && x.groupId === groupId),
  );
  // 不回退 s.spend：费用上限按累计消费计算（旧版本会在这里重算并“退还”费用）
  saveSession(s);
  return s;
}
