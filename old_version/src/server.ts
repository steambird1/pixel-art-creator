import express from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { BudgetExceededError, GenerationError, generateWithRepair } from "./chat.js";
import { combineTiles, gridSize, renderPNG } from "./render.js";
import { isTierKey, nextTierKey, tierForKey, type TierKey } from "./modes.js";
import {
  appendTurn,
  backToTurn,
  createSession,
  isGenerationMode,
  listSessions,
  loadSession,
  saveSession,
} from "./sessions.js";
import type { GenerationMode, SessionState, TurnRecord } from "./types.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static("public"));
app.use("/preview", express.static(config.previewDir));

const MODE_LABEL: Record<GenerationMode, string> = {
  chat: "仅 chat",
  auto: "自动升级",
  deep: "深度思考",
};

function previewPath(sessionId: string, file: string): string {
  const dir = join(config.previewDir, sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, file);
}

/** 每次成功生成后重建该会话的 gallery.html */
function rebuildGallery(s: SessionState): void {
  const items = s.turns
    .map(
      (t) =>
        `<figure><a href="${t.png}" target="_blank"><img src="${t.png}" alt="turn ${t.index}"></a>` +
        `<figcaption>#${t.index} · ${t.width}×${t.height} · ¥${(t.cost ?? 0).toFixed(4)}<br>${escapeHTML(t.prompt)}</figcaption></figure>`,
    )
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>gallery ${s.id}</title>
<style>body{background:#14141c;color:#e0e0e0;font-family:system-ui;padding:24px}
h1{font-size:18px}main{display:flex;flex-wrap:wrap;gap:16px}
figure{margin:0;background:#1e1e2a;padding:10px;border-radius:8px;text-align:center}
img{width:256px;image-rendering:pixelated;background:#fff}
figcaption{font-size:12px;margin-top:6px;color:#9a9ab0;max-width:256px;word-break:break-all}</style>
<h1>会话 ${s.id} · 多轮画廊 · 累计 ¥${s.spend.toFixed(4)}</h1><main>${items || "<p>暂无生成记录</p>"}</main>`;
  writeFileSync(join(config.previewDir, `gallery_${s.id}.html`), html, "utf8");
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function roundCost(n: number): number {
  return Number(n.toFixed(6));
}

/** 组装“按当前档位/升级后重试”所需的档位信息 */
function retryInfo(details: Array<{ key?: TierKey; label?: string }> | undefined) {
  const last = details?.[details.length - 1];
  if (!last?.key) return null;
  const next = nextTierKey(last.key);
  return {
    lastTier: last.key,
    lastTierLabel: last.label ?? tierForKey(last.key).label,
    nextTier: next,
    nextTierLabel: next ? tierForKey(next).label : null,
  };
}

app.post("/api/session", (req, res) => {
  const { mode, costLimit } = req.body ?? {};
  res.json({
    session: createSession({
      mode: isGenerationMode(mode) ? mode : undefined,
      costLimit: Number.isFinite(Number(costLimit)) ? Number(costLimit) : undefined,
    }),
  });
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.get("/api/session/:id", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  res.json({ session: s });
});

/** 保存会话设置（模式 / 费用上限） */
app.post("/api/session/:id/settings", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const { mode, costLimit } = req.body ?? {};

  if (mode !== undefined) {
    if (!isGenerationMode(mode)) return res.status(400).json({ error: "mode 必须是 chat / auto / deep" });
    s.settings.mode = mode;
  }
  if (costLimit !== undefined) {
    const v = Number(costLimit);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "costLimit 必须是非负数（元）" });
    s.settings.costLimit = v;
  }
  saveSession(s);
  res.json({ session: s });
});

/** 回到某一轮：截断历史，丢弃其后的轮次 */
app.post("/api/session/:id/back", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = Number(req.body?.turn);
  if (!Number.isFinite(turn)) return res.status(400).json({ error: "缺少 turn" });
  const updated = backToTurn(s, turn);
  if (!updated) return res.status(400).json({ error: `第 ${turn} 轮不存在` });
  // 清理该轮之后的预览图与画廊（文件保留无害，但画廊需要重建）
  rebuildGallery(updated);
  res.json({ session: updated });
});

/** 生成：多轮对话核心入口（服务端含自动修复闭环、思考升级与费用守卫） */
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message 不能为空" });
  }
  const s = loadSession(sessionId);
  if (!s) return res.status(404).json({ error: "会话不存在" });

  const modeInput = req.body?.mode ?? s.settings.mode;
  if (!isGenerationMode(modeInput)) {
    return res.status(400).json({ error: "mode 必须是 chat / auto / deep" });
  }
  const limit = Number(req.body?.costLimit ?? s.settings.costLimit);
  if (!Number.isFinite(limit) || limit < 0) {
    return res.status(400).json({ error: "费用上限必须是非负数（元）" });
  }
  const mode = modeInput;
  s.settings = { mode, costLimit: limit };
  saveSession(s);

  const startTierInput = req.body?.startTier;
  if (startTierInput !== undefined && !isTierKey(startTierInput)) {
    return res.status(400).json({ error: "startTier 必须是 chat / fast / low / high / max" });
  }
  const startTier = isTierKey(startTierInput) ? startTierInput : undefined;
  const retryError = typeof req.body?.retryError === "string" ? req.body.retryError.slice(0, 1000) : undefined;

  const spendBefore = s.spend;
  const remaining = Math.max(0, limit - spendBefore);
  if (remaining <= 0) {
    return res.status(402).json({
      error: `本会话已花费 ¥${spendBefore.toFixed(4)}，达到费用上限 ¥${limit.toFixed(4)}。请调高上限或新建会话。`,
      spend: spendBefore,
      limit,
    });
  }

  const attemptLog: Array<{ attempt: number; label: string; error: string }> = [];
  try {
    const outcome = await generateWithRepair(s.messages, message.trim(), {
      mode,
      ...(startTier ? { startTier, maxAttempts: 1 } : {}),
      ...(retryError ? { retryError } : {}),
      budgetRemaining: remaining,
      onProgress: (attempt, label, error) => {
        attemptLog.push({ attempt, label, error });
        console.log(`[session ${s.id}] 尝试 ${attempt}（${label}）失败: ${error}`);
      },
    });

    // 渲染
    const grid =
      outcome.parsed.kind === "single"
        ? outcome.parsed.grid
        : combineTiles(outcome.parsed.tiles, outcome.parsed.width, outcome.parsed.height);
    const { width, height } = gridSize(grid);
    const scale = Math.min(64, Math.max(4, Number(req.body?.scale) || config.defaultScale));
    const pngBuf = renderPNG(grid, scale);

    const turnIndex = s.turns.length + 1;
    const file = `turn_${String(turnIndex).padStart(3, "0")}.png`;
    writeFileSync(previewPath(s.id, file), pngBuf);
    const png = `/preview/${s.id}/${file}`;

    // 写回干净的历史（用户消息 + 规范化代码）
    s.messages.push({ role: "user", content: message.trim() });
    s.messages.push({ role: "assistant", content: outcome.code });

    const lastDetail = outcome.attemptDetails[outcome.attemptDetails.length - 1];
    const lastTier = lastDetail?.label ?? MODE_LABEL[mode];
    const nextTier = lastDetail ? nextTierKey(lastDetail.key) : null;
    const turn: TurnRecord = {
      index: turnIndex,
      prompt: message.trim(),
      code: outcome.code,
      png,
      width,
      height,
      createdAt: new Date().toISOString(),
      msgLen: s.messages.length,
      mode,
      cost: roundCost(outcome.cost),
      usage: outcome.usage,
      attempts: outcome.attempts,
      ...(lastDetail?.key ? { tierKey: lastDetail.key } : {}),
      tierLabel: lastTier,
      ...(outcome.intro ? { intro: outcome.intro } : {}),
      ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {}),
    };
    s.spend = roundCost(s.spend + outcome.cost);
    appendTurn(s, turn);
    rebuildGallery(s);

    const repairNote = outcome.attempts > 1 ? `，尝试 ${outcome.attempts} 次（${lastTier}）` : "";
    if (outcome.repaired) {
      console.log(`[session ${s.id}] 本地修复：${outcome.repaired}`);
    }
    res.json({
      turn,
      mode,
      attempts: outcome.attempts,
      tier: lastTier,
      tierKey: lastDetail?.key ?? null,
      nextTier,
      nextTierLabel: nextTier ? tierForKey(nextTier).label : null,
      intro: outcome.intro ?? null,
      reasoning: outcome.reasoning ?? null,
      repairs: attemptLog,
      attemptDetails: outcome.attemptDetails,
      repaired: outcome.repaired,
      usage: outcome.usage,
      cost: turn.cost,
      spend: s.spend,
      limit,
      reply:
        `已生成第 ${turnIndex} 轮预览（${width}×${height}${repairNote}，${lastTier}，本次 ¥${turn.cost.toFixed(4)}）` +
        (outcome.repaired ? `；本地修正：${outcome.repaired}` : ""),
      image: `data:image/png;base64,${pngBuf.toString("base64")}`,
      gallery: `/preview/gallery_${s.id}.html`,
    });
  } catch (e) {
    console.error(`[session ${s.id}] 生成失败:`, e);
    const known = e instanceof BudgetExceededError || e instanceof GenerationError;
    if (known) {
      // 失败尝试也可能已产生费用（思考/多轮重试），同样计入会话
      s.spend = roundCost(s.spend + e.cost);
      saveSession(s);
    }
    const status = e instanceof BudgetExceededError ? 402 : 502;
    // 402（费用不足）不给重试按钮；502 允许按当前档位 / 升级档位重试
    const retry = known && status === 502 ? retryInfo(e.attemptDetails) : null;
    return res.status(status).json({
      error: e instanceof Error ? e.message : String(e),
      spend: s.spend,
      limit,
      repairs: attemptLog,
      ...(known ? { cost: e.cost, usage: e.usage, attemptDetails: e.attemptDetails } : {}),
      ...(retry ? { retry } : {}),
    });
  }
});

const port = config.port;
app.listen(port, () => {
  console.log(
    `drawing_util 已启动: http://localhost:${port}  (chat=${config.chatModel}, 思考=${config.model}, 默认上限=¥${config.defaultCostLimit})`,
  );
  if (!config.apiKey) console.warn("警告：未配置 DEEPSEEK_API_KEY，请检查 .env");
});
