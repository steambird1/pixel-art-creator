import express from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { BudgetExceededError, GenerationError, generateWithRepair } from "./chat.js";
import { combineTiles, gridSize, renderDiffPNG, renderPNG } from "./render.js";
import { isTierKey, nextTierKey, tierForKey, type TierKey } from "./modes.js";
import { parseAIOutput, toCode } from "./parse.js";
import { paletteSignature, resolveEditedPalettes } from "./dslEdit.js";
import { validateResult } from "./validate.js";
import {
  DEFAULT_PALETTE,
  PRESET_PALETTES,
  PRESET_ORDER,
  paletteInfo,
  paletteRef,
  resolvePalette,
  rotatePalettes,
  validatePaletteColors,
  type Palette,
} from "./palettes.js";
import { EMPTY_USAGE } from "./pricing.js";
import { tracePNG } from "./trace.js";
import {
  toJs,
  parsedToGrid,
  splitGridToTiles,
  mergeTilesInLayout,
  mergeGroupsInLayout,
  diffGrids,
  type TileLayout,
} from "./tojs.js";
import {
  DEFAULT_MERGE_EPSILON,
  DEFAULT_MERGE_WEIGHTS,
  buildMergePlan,
  type TilePlan,
} from "./tilesim.js";
import { MAX_DIM, MAX_RENDER_SIDE, MIN_DIM } from "./limits.js";
import {
  backToTurn,
  countGenerationTurns,
  createSession,
  deleteSession,
  groupTurns,
  isGenerationMode,
  listSessions,
  loadSession,
  MAX_SESSION_TITLE,
  normalizeSessionTitle,
  renameSession,
  saveSession,
} from "./sessions.js";
import type { GenerationMode, Grid, MergeWeights, ParseResult, SessionState, TokenUsage, TurnRecord } from "./types.js";

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

/** 每次成功生成后重建该会话的 gallery.html；组图变体合并为一个 figure */
function rebuildGallery(s: SessionState): void {
  const items = groupTurns(s.turns)
    .map((variants, groupIndex) => {
      const first = variants[0];
      const groupCount = variants.length;
      const images = variants
        .map((t) => {
          const src = `${t.png}?v=${encodeURIComponent(t.updatedAt ?? t.createdAt)}`;
          const pal = t.palette ? escapeHTML(t.palette.label ?? t.palette.name) : "";
          return (
            `<span class="gallery-variant"><a href="${src}" target="_blank"><img src="${src}" alt="turn ${t.index}"></a>` +
            (pal ? `<small>${pal}</small>` : "") +
            `</span>`
          );
        })
        .join("");
      const tiles = first.tileStats ? ` · ${first.tileStats.total} tiles` : "";
      const pal = groupCount === 1 && first.palette ? ` · ${escapeHTML(first.palette.label ?? first.palette.name)}` : "";
      const srcTag = variants.some((t) => t.source === "trace") ? " · 描摹" : "";
      const edited = variants.some((t) => t.editedAt) ? " · 手动编辑" : "";
      const cost = variants.reduce((sum, t) => sum + (t.cost ?? 0), 0);
      return (
        `<figure><div class="gallery-imgs">${images}</div>` +
        `<figcaption>第 ${groupIndex + 1} 轮${groupCount > 1 ? ` · 组图 ${groupCount} 张` : ""} · ${first.width}×${first.height}${tiles}${pal}${srcTag}${edited} · ¥${cost.toFixed(4)}<br>${escapeHTML(first.prompt)}</figcaption></figure>`
      );
    })
    .join("\n");
  const sessionLabel = s.title ? `${escapeHTML(s.title)}（${s.id}）` : s.id;
  const pageTitle = s.title ? `${escapeHTML(s.title)} · gallery ${s.id}` : `gallery ${s.id}`;
  const html = `<!doctype html><meta charset="utf-8"><title>${pageTitle}</title>
<style>body{background:#14141c;color:#e0e0e0;font-family:system-ui;padding:24px}
h1{font-size:18px}main{display:flex;flex-wrap:wrap;gap:16px}
figure{margin:0;background:#1e1e2a;padding:10px;border-radius:8px;text-align:center}
.gallery-imgs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:576px}
.gallery-variant{display:flex;flex-direction:column;gap:4px;align-items:center}
.gallery-variant small{font-size:11px;color:#9a9ab0}
img{width:180px;image-rendering:pixelated;background:#fff}
figcaption{font-size:12px;margin-top:8px;color:#9a9ab0;max-width:576px;word-break:break-all}</style>
<h1>会话 ${sessionLabel} · 多轮画廊 · 累计 ¥${s.spend.toFixed(4)}</h1><main>${items || "<p>暂无生成记录</p>"}</main>`;
  mkdirSync(config.previewDir, { recursive: true });
  writeFileSync(join(config.previewDir, `gallery_${s.id}.html`), html, "utf8");
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function roundCost(n: number): number {
  return Number(n.toFixed(6));
}

/** 解析 UI 传入的画布尺寸；返回 null 表示未指定，字符串表示错误 */
function parseTargetSize(input: unknown): { width: number; height: number } | null | string {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object") return "size 必须是 { width, height }";
  const raw = input as { width?: unknown; height?: unknown };
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "画布宽高必须是整数";
  if (width < MIN_DIM || height < MIN_DIM || width > MAX_DIM || height > MAX_DIM) {
    return `画布 ${width}×${height} 超出范围（${MIN_DIM}..${MAX_DIM}）`;
  }
  return { width, height };
}

function sessionPalette(s: SessionState): Palette {
  return resolvePalette(s.settings.palette);
}

function pngFileOf(turn: TurnRecord): string {
  return String(turn.png).split("/").pop() || "";
}

/** 只计算 PNG，不写盘、不改动轮次；用于先完成全部校验/渲染再提交 */
function prepareTurnPng(
  turn: TurnRecord,
  grid: Grid,
  palette: Palette,
  width: number,
  height: number,
): { file: string; scale: number; buf: Buffer } {
  const file = pngFileOf(turn);
  if (!/^turn_\d+\.png$/.test(file)) throw new Error("预览图路径异常");
  const scaleCap = Math.max(1, Math.floor(MAX_RENDER_SIDE / Math.max(width, height)));
  const scale = Math.max(1, Math.min(turn.scale ?? config.defaultScale, scaleCap));
  return { file, scale, buf: renderPNG(grid, scale, palette) };
}

/** 用指定调色板重新渲染某一轮并写盘，同时更新 scale */
function renderTurnToPng(s: SessionState, turn: TurnRecord, grid: Grid, palette: Palette): Buffer {
  const prepared = prepareTurnPng(turn, grid, palette, turn.width, turn.height);
  writeFileSync(previewPath(s.id, prepared.file), prepared.buf);
  turn.scale = prepared.scale;
  return prepared.buf;
}

function zeroUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}

function sanitizeWeights(input: unknown): Partial<MergeWeights> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Partial<MergeWeights> = {};
  for (const k of ["edge", "flat", "mid", "alpha"] as const) {
    const v = Number((input as any)[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 合并计划的基准：首次合并前的代码（DSL 优先），保证可回退/换阈值重算 */
function baseParsedForTurn(turn: TurnRecord): ParseResult {
  const source = turn.baseCode ?? turn.dsl ?? turn.code;
  return parseAIOutput(source, { width: turn.width, height: turn.height });
}

/** 读取已保存 DSL 的 palette 声明；旧 DSL 解析失败时视为无法比较 */
function palettesOfDsl(dsl: string | undefined): Palette[] | undefined {
  if (!dsl) return undefined;
  try {
    const parsed = parseAIOutput(dsl, null);
    return parsed.format === "dsl" ? parsed.palettes : undefined;
  } catch {
    return undefined;
  }
}

interface PlanContext {
  turn: TurnRecord;
  base: ParseResult;
  baseGrid: Grid;
  layout: TileLayout;
  palette: Palette;
  plan: TilePlan;
  mergedGrid: Grid;
  js: ReturnType<typeof toJs>;
}

function planForTurn(
  s: SessionState,
  turn: TurnRecord,
  epsilonInput: unknown,
  weightsInput: unknown,
): PlanContext | { error: string } {
  let base: ParseResult;
  try {
    base = baseParsedForTurn(turn);
  } catch (e) {
    return { error: `无法解析基准代码：${e instanceof Error ? e.message : String(e)}` };
  }
  const baseGrid = parsedToGrid(base);
  const layout = splitGridToTiles(baseGrid);
  if (!layout) return { error: "当前轮次不能按 16×16 切分 tile" };
  const palette = resolvePalette(turn.palette ?? s.settings.palette);
  const weights = { ...DEFAULT_MERGE_WEIGHTS, ...(sanitizeWeights(weightsInput) ?? {}) };

  // 先跑默认阈值拿到完整曲线与拐点；未显式给 epsilon 时用拐点
  const auto = buildMergePlan(layout.unique, layout.layout, palette, DEFAULT_MERGE_EPSILON, weights);
  const epsRaw = Number(epsilonInput);
  const eps = Number.isFinite(epsRaw) && epsRaw >= 0
    ? epsRaw
    : auto.knee > 0
      ? auto.knee
      : DEFAULT_MERGE_EPSILON;
  const plan = eps === auto.epsilon
    ? auto
    : buildMergePlan(layout.unique, layout.layout, palette, eps, weights);

  const mergedGrid = mergeGroupsInLayout(layout, plan.groups);
  const js = toJs({ kind: "single", grid: mergedGrid }, palette);
  return { turn, base, baseGrid, layout, palette, plan, mergedGrid, js };
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

interface MergeContext {
  turn: TurnRecord;
  before: Grid;
  layout: TileLayout;
  merged: Grid;
  representative: number;
  members: number[];
}

/** 解析并校验一次手动合并请求（预览和确认共用，只读） */
function resolveMerge(
  s: SessionState,
  index: number,
  body: any,
): MergeContext | { error: string } {
  const turn = s.turns.find((t) => t.index === index);
  if (!turn) return { error: `第 ${index} 轮不存在` };

  const representative = Number(body?.representative);
  const membersRaw = body?.members;
  if (!Number.isInteger(representative) || !Array.isArray(membersRaw)) {
    return { error: "缺少 representative / members" };
  }
  const members = [...new Set(membersRaw.map(Number))].filter((m) => Number.isInteger(m));
  if (!members.length || members.includes(representative)) {
    return { error: "members 必须是非空整数数组，且不能包含 representative" };
  }

  let parsed;
  try {
    parsed = parseAIOutput(turn.code, { width: turn.width, height: turn.height });
  } catch (e) {
    return { error: `无法解析当前轮 JS：${e instanceof Error ? e.message : String(e)}` };
  }
  const before = parsedToGrid(parsed);
  const layout = splitGridToTiles(before);
  if (!layout) return { error: "当前轮次不能按 16×16 切分 tile" };

  const max = layout.unique.length;
  if (representative < 1 || representative > max || members.some((m) => m < 1 || m > max)) {
    return { error: `tile 编号必须在 1..${max}` };
  }

  const merged = mergeTilesInLayout(
    layout,
    representative - 1,
    members.map((m) => m - 1),
  );
  return { turn, before, layout, merged, representative, members };
}

/** 预览图缩放：最长边不超过 1024，避免 160×128 / 大画布返回过大的 base64 */
function previewScaleFor(width: number, height: number, scale: number | undefined): number {
  const cap = Math.max(1, Math.floor(1024 / Math.max(width, height)));
  return Math.max(1, Math.min(scale ?? config.defaultScale, cap, 16));
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

/** 重命名会话；空名称恢复默认显示（会话 ID） */
app.post("/api/session/:id/rename", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const { title } = req.body ?? {};
  if (typeof title !== "string") return res.status(400).json({ error: "title 必须是字符串" });
  if (normalizeSessionTitle(title).length > MAX_SESSION_TITLE) {
    return res.status(400).json({ error: `title 最多 ${MAX_SESSION_TITLE} 个字符` });
  }
  renameSession(s, title);
  try {
    rebuildGallery(s);
  } catch (e) {
    // 名称已保存；画廊刷新失败不应让前端误以为重命名失败
    console.warn(`[session ${s.id}] 重命名后刷新画廊失败:`, e);
  }
  res.json({ session: s });
});

/** 删除会话及其预览图 / 画廊文件 */
app.delete("/api/session/:id", (req, res) => {
  const id = req.params.id;
  const s = loadSession(id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  try {
    if (!deleteSession(id)) return res.status(404).json({ error: "会话不存在" });
  } catch (e) {
    return res.status(500).json({ error: `删除会话失败：${e instanceof Error ? e.message : String(e)}` });
  }
  try {
    rmSync(join(config.previewDir, id), { recursive: true, force: true });
    rmSync(join(config.previewDir, `gallery_${id}.html`), { force: true });
  } catch (e) {
    // 会话本身已删除；预览清理失败不应让前端误以为删除失败
    console.warn(`[session ${id}] 删除预览文件失败:`, e);
  }
  res.json({ ok: true, id });
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

/** 预设调色板列表 */
app.get("/api/palettes", (_req, res) => {
  res.json({ palettes: PRESET_ORDER.map((name) => paletteInfo(PRESET_PALETTES[name])) });
});

/** 设置会话调色板，并重渲染所有“会话来源”的轮次（显式组图变体保持不变） */
app.post("/api/session/:id/palette", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });

  const raw = req.body?.palette ?? req.body;
  if (raw && typeof raw === "object" && Array.isArray((raw as any).colors)) {
    const err = validatePaletteColors((raw as any).colors);
    if (err) return res.status(400).json({ error: err });
  }
  const palette = resolvePalette(raw);
  s.settings.palette = palette;

  let changed = 0;
  for (const turn of s.turns) {
    if (turn.paletteSource === "explicit") continue;
    try {
      const parsed = parseAIOutput(turn.code, { width: turn.width, height: turn.height });
      const grid = parsedToGrid(parsed);
      const js = toJs(parsed, palette);
      renderTurnToPng(s, turn, grid, palette);
      turn.tileStats = js.tileStats;
      turn.palette = palette;
      turn.paletteSource = "session";
      turn.updatedAt = new Date().toISOString();
      changed++;
    } catch (e) {
      console.warn(`[session ${s.id}] 调色板重渲染第 ${turn.index} 轮失败:`, e);
    }
  }
  saveSession(s);
  rebuildGallery(s);
  res.json({ session: s, palette: paletteRef(palette), changed });
});

/** 手动编辑 DSL：重新编译、渲染并同步对话历史；不调用模型、不计费 */
app.post("/api/session/:id/turn/:index/dsl", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });
  if (!turn.dsl) {
    return res.status(400).json({ error: "该轮没有可编辑的 DSL（旧版 img / 本地描摹轮次不支持）" });
  }

  const dsl = typeof req.body?.dsl === "string" ? req.body.dsl.trim() : "";
  if (!dsl) return res.status(400).json({ error: "DSL 不能为空" });
  if (dsl.length > 200_000) return res.status(400).json({ error: "DSL 过长（最多 200000 字符）" });
  if (!/(?:^|\n)\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}\b/i.test(dsl)) {
    return res.status(400).json({ error: "DSL 必须包含 size W H 行" });
  }

  let parsed: ParseResult;
  try {
    parsed = parseAIOutput(dsl, null);
  } catch (e) {
    return res.status(400).json({ error: `DSL 编译失败：${e instanceof Error ? e.message : String(e)}` });
  }
  if (parsed.format !== "dsl") {
    return res.status(400).json({ error: "这里只能保存 DSL，不能保存旧版 img / CombinedTiles 代码" });
  }

  const grid = parsedToGrid(parsed);
  const { width, height } = gridSize(grid);
  const invalid = validateResult(parsed, { width, height });
  if (invalid) return res.status(400).json({ error: invalid });

  const canonical = toCode(parsed);
  const oldPalettes = palettesOfDsl(turn.dsl);
  const newPalettes = parsed.palettes;
  const members = turn.groupId
    ? s.turns.filter((t) => t.groupId === turn.groupId).sort((a, b) => a.index - b.index)
    : [turn];
  const currentPalettes = members.map((m) => resolvePalette(m.palette ?? s.settings.palette));
  const resolved = resolveEditedPalettes(
    oldPalettes,
    newPalettes,
    currentPalettes,
    sessionPalette(s),
  );
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });

  const now = new Date().toISOString();
  try {
    // 先完成整组的 JS 计算；任何一张编译失败都不会改动会话或写盘。
    const prepared = members.map((member, i) => {
      const palette = resolved.palettes[i] ?? currentPalettes[i];
      return { member, palette, js: toJs(parsed, palette) };
    });
    for (const { member, palette, js } of prepared) {
      const png = prepareTurnPng(member, grid, palette, width, height);
      writeFileSync(previewPath(s.id, png.file), png.buf);
      member.dsl = canonical;
      member.format = "dsl";
      member.width = width;
      member.height = height;
      member.code = js.code;
      member.tileStats = js.tileStats;
      member.palette = palette;
      member.scale = png.scale;
      if (resolved.changed) member.paletteSource = resolved.source;
      delete member.mergePlan;
      delete member.baseCode;
      delete member.merged;
      member.updatedAt = now;
      member.editedAt = now;
    }
  } catch (e) {
    return res.status(500).json({ error: `重新渲染失败：${e instanceof Error ? e.message : String(e)}` });
  }

  const historyIndex = turn.msgLen - 1;
  const historyUpdated =
    historyIndex >= 0 &&
    historyIndex < s.messages.length &&
    s.messages[historyIndex]?.role === "assistant";
  if (historyUpdated) s.messages[historyIndex].content = canonical;

  saveSession(s);
  rebuildGallery(s);
  res.json({
    turn,
    turns: members,
    historyUpdated,
    ...(historyUpdated ? {} : { warning: "未能定位对应的对话历史消息；后续 AI 修改可能仍基于旧 DSL。" }),
    session: s,
  });
});

/** 当前轮 × 预设调色板的缩略图（只读，不写盘） */
app.post("/api/session/:id/turn/:index/palette-preview", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });

  let grid: Grid;
  try {
    grid = parsedToGrid(parseAIOutput(turn.code, { width: turn.width, height: turn.height }));
  } catch (e) {
    return res.status(400).json({ error: `无法解析当前轮代码：${e instanceof Error ? e.message : String(e)}` });
  }

  const scale = previewScaleFor(turn.width, turn.height, turn.scale);
  const names: string[] =
    Array.isArray(req.body?.names) && req.body.names.length
      ? req.body.names.filter((n: unknown) => typeof n === "string" && PRESET_PALETTES[n])
      : PRESET_ORDER;

  const variants = names.map((name) => {
    const p = PRESET_PALETTES[name] ?? DEFAULT_PALETTE;
    const png = renderPNG(grid, scale, p);
    return {
      name: p.name,
      label: p.label ?? p.name,
      colors: p.colors,
      image: `data:image/png;base64,${png.toString("base64")}`,
    };
  });

  res.json({
    variants,
    previewScale: scale,
    current: turn.palette?.name ?? sessionPalette(s).name,
  });
});

/** 本地精确描摹：上传 PNG，后端量化成像素网格，不调用模型 */
app.post("/api/session/:id/trace", express.raw({ type: "image/png", limit: "24mb" }), (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) {
    return res.status(400).json({ error: "请上传 PNG（Content-Type: image/png）" });
  }

  const q = req.query;
  const opts = {
    ...(q.width ? { width: Number(q.width) } : {}),
    ...(q.height ? { height: Number(q.height) } : {}),
    mode: q.mode === "area" ? ("area" as const) : ("nearest" as const),
    dither: q.dither === "1" || q.dither === "true",
    alphaThreshold: q.alpha ? Number(q.alpha) : 128,
    adaptive: q.adaptive === "1" || q.adaptive === "true",
    maxSide: q.maxSide ? Number(q.maxSide) : 128,
  };

  let traced;
  try {
    traced = tracePNG(buf, sessionPalette(s), opts);
  } catch (e) {
    return res.status(400).json({ error: `PNG 解析/描摹失败：${e instanceof Error ? e.message : String(e)}` });
  }
  const visible = traced.grid.rows.some((row) => row.some((ch) => ch !== "."));
  if (!visible) {
    return res.status(400).json({ error: "描摹结果是全透明；请降低透明度阈值或换一张图" });
  }

  const js = toJs({ kind: "single", grid: traced.grid }, traced.palette);
  const turnIndex = s.turns.length + 1;
  const turnFile = `turn_${String(turnIndex).padStart(3, "0")}.png`;
  const requestedScale = Math.min(64, Math.max(4, Number(q.scale) || config.defaultScale));
  const scaleCap = Math.max(1, Math.floor(MAX_RENDER_SIDE / Math.max(traced.width, traced.height)));
  const scale = Math.max(1, Math.min(requestedScale, scaleCap));
  const pngBuf = renderPNG(traced.grid, scale, traced.palette);
  writeFileSync(previewPath(s.id, turnFile), pngBuf);

  const refFile = `ref_${Date.now()}.png`;
  writeFileSync(previewPath(s.id, refFile), buf);

  const name = typeof q.name === "string" ? q.name.slice(0, 80) : refFile;
  const prompt = `本地精确描摹 PNG：${name}`;
  s.messages.push({ role: "user", content: prompt });
  s.messages.push({ role: "assistant", content: js.code });

  const turn: TurnRecord = {
    index: turnIndex,
    prompt,
    code: js.code,
    png: `/preview/${s.id}/${turnFile}`,
    width: traced.width,
    height: traced.height,
    createdAt: new Date().toISOString(),
    scale,
    ...(js.tileStats ? { tileStats: js.tileStats } : {}),
    msgLen: s.messages.length,
    mode: "chat",
    cost: 0,
    usage: zeroUsage(),
    attempts: 1,
    tierLabel: "本地描摹",
    format: "img",
    palette: traced.palette,
    paletteSource: traced.adaptive ? "explicit" : "session",
    source: "trace",
  };
  s.turns.push(turn);
  saveSession(s);
  rebuildGallery(s);

  res.json({
    turn,
    session: s,
    palette: paletteRef(traced.palette),
    adaptive: traced.adaptive,
    refImage: `/preview/${s.id}/${refFile}`,
  });
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

/** 只读预览：返回合并前/后/差异高亮图与统计，不写盘 */
app.post("/api/session/:id/turn/:index/preview-merge-tiles", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const ctx = resolveMerge(s, Number(req.params.index), req.body);
  if ("error" in ctx) return res.status(400).json({ error: ctx.error });

  const { turn, before, merged, layout } = ctx;
  const palette = resolvePalette(turn.palette ?? s.settings.palette);
  const beforeJs = toJs({ kind: "single", grid: before }, palette);
  const afterJs = toJs({ kind: "single", grid: merged }, palette);
  const diff = diffGrids(before, merged);
  const scale = previewScaleFor(turn.width, turn.height, turn.scale);
  const beforePng = renderPNG(before, scale, palette);
  const afterPng = renderPNG(merged, scale, palette);
  const diffPng = renderDiffPNG(before, merged, scale);

  const totalBefore = beforeJs.tileStats?.total ?? layout.layout.length;
  const uniqueBefore = beforeJs.tileStats?.unique ?? layout.unique.length;
  const totalAfter = afterJs.tileStats?.total ?? totalBefore;
  const uniqueAfter = afterJs.tileStats?.unique ?? uniqueBefore;

  res.json({
    before: `data:image/png;base64,${beforePng.toString("base64")}`,
    after: `data:image/png;base64,${afterPng.toString("base64")}`,
    diff: `data:image/png;base64,${diffPng.toString("base64")}`,
    changedPixels: diff.changedPixels,
    changedTiles: diff.changedTiles,
    bounds: diff.bounds,
    uniqueBefore,
    uniqueAfter,
    reusedBefore: totalBefore - uniqueBefore,
    reusedAfter: totalAfter - uniqueAfter,
    previewScale: scale,
  });
});

/** 手动合并相似 tile：只影响当前轮的 JS/预览，不改写模型历史里的 DSL */
app.post("/api/session/:id/turn/:index/merge-tiles", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const ctx = resolveMerge(s, Number(req.params.index), req.body);
  if ("error" in ctx) return res.status(400).json({ error: ctx.error });

  const { turn, merged } = ctx;
  const palette = resolvePalette(turn.palette ?? s.settings.palette);
  const js = toJs({ kind: "single", grid: merged }, palette);
  const file = String(turn.png).split("/").pop() || "";
  if (!/^turn_\d+\.png$/.test(file)) {
    return res.status(500).json({ error: "预览图路径异常" });
  }
  const scaleCap = Math.max(1, Math.floor(MAX_RENDER_SIDE / Math.max(turn.width, turn.height)));
  const scale = Math.max(1, Math.min(turn.scale ?? config.defaultScale, scaleCap));
  writeFileSync(previewPath(s.id, file), renderPNG(merged, scale, palette));

  if (turn.mergePlan) {
    // 单组合并视为新的基准，避免与旧计划冲突；撤销会回到这次单组操作之前
    turn.baseCode = turn.code;
    delete turn.mergePlan;
  }
  if (!turn.baseCode) turn.baseCode = turn.dsl ?? turn.code;
  turn.code = js.code;
  turn.tileStats = js.tileStats;
  turn.palette = palette;
  turn.scale = scale;
  turn.merged = true;
  turn.updatedAt = new Date().toISOString();
  saveSession(s);
  rebuildGallery(s);
  res.json({ turn, session: s });
});

/** 智能合并计划：返回曲线、拐点与指定阈值下的分组（只读） */
app.post("/api/session/:id/turn/:index/tile-plan", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });

  const ctx = planForTurn(s, turn, req.body?.epsilon, req.body?.weights);
  if ("error" in ctx) return res.status(400).json({ error: ctx.error });
  res.json({
    epsilon: ctx.plan.epsilon,
    knee: ctx.plan.knee,
    weights: ctx.plan.weights,
    curve: ctx.plan.curve,
    groups: ctx.plan.groups,
    uniqueBefore: ctx.plan.uniqueBefore,
    uniqueAfter: ctx.plan.uniqueAfter,
    mergePlan: turn.mergePlan ?? null,
  });
});

/** 批量合并预览：合并前后/差异图 + 汇总统计（只读） */
app.post("/api/session/:id/turn/:index/preview-merge-batch", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });

  const ctx = planForTurn(s, turn, req.body?.epsilon, req.body?.weights);
  if ("error" in ctx) return res.status(400).json({ error: ctx.error });

  const diff = diffGrids(ctx.baseGrid, ctx.mergedGrid);
  const scale = previewScaleFor(turn.width, turn.height, turn.scale);
  const beforeStats = toJs(ctx.base, ctx.palette).tileStats;
  const afterStats = ctx.js.tileStats;
  const beforePng = renderPNG(ctx.baseGrid, scale, ctx.palette);
  const afterPng = renderPNG(ctx.mergedGrid, scale, ctx.palette);
  const diffPng = renderDiffPNG(ctx.baseGrid, ctx.mergedGrid, scale);
  const totalBefore = beforeStats?.total ?? ctx.layout.layout.length;
  const uniqueBefore = beforeStats?.unique ?? ctx.layout.unique.length;
  const totalAfter = afterStats?.total ?? totalBefore;
  const uniqueAfter = afterStats?.unique ?? uniqueBefore;

  res.json({
    before: `data:image/png;base64,${beforePng.toString("base64")}`,
    after: `data:image/png;base64,${afterPng.toString("base64")}`,
    diff: `data:image/png;base64,${diffPng.toString("base64")}`,
    changedPixels: diff.changedPixels,
    changedTiles: diff.changedTiles,
    bounds: diff.bounds,
    uniqueBefore,
    uniqueAfter,
    reusedBefore: totalBefore - uniqueBefore,
    reusedAfter: totalAfter - uniqueAfter,
    previewScale: scale,
    epsilon: ctx.plan.epsilon,
    knee: ctx.plan.knee,
    groups: ctx.plan.groups,
  });
});

/** 应用批量合并计划（可回退：code 由 baseCode + mergePlan 派生） */
app.post("/api/session/:id/turn/:index/merge-tiles-batch", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });

  const ctx = planForTurn(s, turn, req.body?.epsilon, req.body?.weights);
  if ("error" in ctx) return res.status(400).json({ error: ctx.error });
  if (!ctx.plan.groups.length) {
    return res.status(400).json({ error: "当前阈值下没有可合并的 tile" });
  }

  if (!turn.baseCode) turn.baseCode = turn.dsl ?? turn.code;
  turn.code = ctx.js.code;
  turn.tileStats = ctx.js.tileStats;
  turn.mergePlan = { epsilon: ctx.plan.epsilon, weights: ctx.plan.weights };
  turn.merged = true;
  turn.palette = ctx.palette;
  turn.updatedAt = new Date().toISOString();
  renderTurnToPng(s, turn, ctx.mergedGrid, ctx.palette);
  saveSession(s);
  rebuildGallery(s);

  res.json({
    turn,
    session: s,
    plan: {
      epsilon: ctx.plan.epsilon,
      uniqueBefore: ctx.plan.uniqueBefore,
      uniqueAfter: ctx.plan.uniqueAfter,
      groups: ctx.plan.groups.length,
    },
  });
});

/** 撤销合并计划，恢复到基准画面 */
app.post("/api/session/:id/turn/:index/merge-plan/undo", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "会话不存在" });
  const turn = s.turns.find((t) => t.index === Number(req.params.index));
  if (!turn) return res.status(404).json({ error: "该轮不存在" });

  let parsed: ParseResult;
  try {
    parsed = baseParsedForTurn(turn);
  } catch (e) {
    return res.status(400).json({ error: `无法恢复基准代码：${e instanceof Error ? e.message : String(e)}` });
  }
  const grid = parsedToGrid(parsed);
  const palette = resolvePalette(turn.palette ?? s.settings.palette);
  const js = toJs(parsed, palette);
  turn.code = js.code;
  turn.tileStats = js.tileStats;
  delete turn.mergePlan;
  delete turn.merged;
  turn.updatedAt = new Date().toISOString();
  renderTurnToPng(s, turn, grid, palette);
  saveSession(s);
  rebuildGallery(s);
  res.json({ turn, session: s });
});

/** 生成：多轮对话核心入口（服务端含自动修复闭环、思考升级与费用守卫） */
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message 不能为空" });
  }
  const s = loadSession(sessionId);
  if (!s) return res.status(404).json({ error: "会话不存在" });

  const targetSizeParsed = parseTargetSize(req.body?.size);
  if (typeof targetSizeParsed === "string") {
    return res.status(400).json({ error: targetSizeParsed });
  }
  const targetSize = targetSizeParsed ?? undefined;
  const paletteByAI = req.body?.paletteByAI === true;

  const modeInput = req.body?.mode ?? s.settings.mode;
  if (!isGenerationMode(modeInput)) {
    return res.status(400).json({ error: "mode 必须是 chat / auto / deep" });
  }
  const limit = Number(req.body?.costLimit ?? s.settings.costLimit);
  if (!Number.isFinite(limit) || limit < 0) {
    return res.status(400).json({ error: "费用上限必须是非负数（元）" });
  }
  const mode = modeInput;
  s.settings = { ...s.settings, mode, costLimit: limit };
  saveSession(s);

  // 组图参数：同一份 DSL × N 个调色板；允许 1 张，也允许由 AI 自行指定调色板
  const groupReq = req.body?.group;
  const requestedGroupCount = groupReq
    ? Math.max(1, Math.min(9, Math.floor(Number(groupReq?.count) || 1)))
    : 1;
  const groupRequested = !!groupReq;
  const paletteInputs: unknown[] = Array.isArray(groupReq?.palettes) ? groupReq.palettes : [];
  for (let i = 0; i < Math.min(paletteInputs.length, requestedGroupCount); i++) {
    const raw = paletteInputs[i];
    if (raw && typeof raw === "object" && Array.isArray((raw as any).colors)) {
      const err = validatePaletteColors((raw as any).colors);
      if (err) return res.status(400).json({ error: `组图第 ${i + 1} 张调色板：${err}` });
    }
  }
  const sessionPal = sessionPalette(s);
  const autoPalettes = requestedGroupCount > 1 ? rotatePalettes(sessionPal, requestedGroupCount) : [];
  const explicitPalettes: Array<Palette | null> = Array.from({ length: requestedGroupCount }, (_, i) => {
    const raw = paletteInputs[i];
    if (raw) return resolvePalette(raw);
    return autoPalettes[i] ?? null;
  });

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
  const lastTurn = s.turns[s.turns.length - 1];
  try {
    const outcome = await generateWithRepair(s.messages, message.trim(), {
      mode,
      ...(startTier ? { startTier, maxAttempts: 1 } : {}),
      ...(retryError ? { retryError } : {}),
      ...(targetSize ? { targetSize } : {}),
      ...(lastTurn ? { defaultSize: { width: lastTurn.width, height: lastTurn.height } } : {}),
      palette: sessionPal,
      ...(paletteByAI ? { paletteByAI: true, paletteCount: requestedGroupCount } : {}),
      budgetRemaining: remaining,
      onProgress: (attempt, label, error) => {
        attemptLog.push({ attempt, label, error });
        console.log(`[session ${s.id}] 尝试 ${attempt}（${label}）失败: ${error}`);
      },
    });

    // 渲染：同一份网格 × N 个调色板（组图时不重复调用模型）
    const grid =
      outcome.parsed.kind === "single"
        ? outcome.parsed.grid
        : combineTiles(outcome.parsed.tiles, outcome.parsed.width, outcome.parsed.height);
    const { width, height } = gridSize(grid);
    const requestedScale = Math.min(64, Math.max(4, Number(req.body?.scale) || config.defaultScale));
    const scaleCap = Math.max(1, Math.floor(MAX_RENDER_SIDE / Math.max(width, height)));
    const baseScale = Math.max(1, Math.min(requestedScale, scaleCap));

    // AI 自行指定的 palette 优先；组图时张数以模型输出的 palette 行数为准（最多 9）。
    const aiPalettes = paletteByAI ? outcome.parsed.palettes?.slice(0, 9) ?? [] : [];
    const groupCount = paletteByAI && groupRequested && aiPalettes.length
      ? aiPalettes.length
      : requestedGroupCount;
    const groupId = groupCount > 1 ? randomUUID().slice(0, 8) : undefined;
    const turnPalettes: Array<Palette | null> = Array.from(
      { length: groupCount },
      (_, i) => aiPalettes[i] ?? explicitPalettes[i] ?? null,
    );

    const lastDetail = outcome.attemptDetails[outcome.attemptDetails.length - 1];
    const lastTier = lastDetail?.label ?? MODE_LABEL[mode];
    const nextTier = lastDetail ? nextTierKey(lastDetail.key) : null;
    const msgLen = s.messages.length + 2;
    const turns: TurnRecord[] = [];
    let firstPng: Buffer | null = null;

    for (let i = 0; i < groupCount; i++) {
      const palette = turnPalettes[i] ?? sessionPal;
      const paletteSource: "session" | "explicit" = turnPalettes[i] ? "explicit" : "session";
      const js = toJs(outcome.parsed, palette);
      const turnIndex = s.turns.length + 1;
      const file = `turn_${String(turnIndex).padStart(3, "0")}.png`;
      const pngBuf = renderPNG(grid, baseScale, palette);
      writeFileSync(previewPath(s.id, file), pngBuf);
      const png = `/preview/${s.id}/${file}`;
      const turn: TurnRecord = {
        index: turnIndex,
        prompt: message.trim(),
        code: js.code,
        ...(outcome.dsl ? { dsl: outcome.dsl } : {}),
        png,
        width,
        height,
        createdAt: new Date().toISOString(),
        scale: baseScale,
        ...(js.tileStats ? { tileStats: js.tileStats } : {}),
        msgLen,
        mode,
        cost: i === 0 ? roundCost(outcome.cost) : 0,
        usage: i === 0 ? outcome.usage : zeroUsage(),
        attempts: outcome.attempts,
        ...(lastDetail?.key ? { tierKey: lastDetail.key } : {}),
        tierLabel: lastTier,
        format: outcome.parsed.format ?? "img",
        palette,
        paletteSource,
        source: "model",
        ...(groupId ? { groupId } : {}),
        ...(i === 0 && outcome.intro ? { intro: outcome.intro } : {}),
        ...(i === 0 && outcome.reasoning ? { reasoning: outcome.reasoning } : {}),
      };
      s.turns.push(turn);
      turns.push(turn);
      if (!firstPng) firstPng = pngBuf;
    }

    // 写回干净的历史（用户消息 + DSL/旧版代码）；组图只写一次
    s.messages.push({ role: "user", content: message.trim() });
    s.messages.push({ role: "assistant", content: outcome.historyCode });

    s.spend = roundCost(s.spend + outcome.cost);
    saveSession(s);
    rebuildGallery(s);

    const first = turns[0];
    const displayTurn = countGenerationTurns(s.turns);
    const repairNote = outcome.attempts > 1 ? `，尝试 ${outcome.attempts} 次（${lastTier}）` : "";
    if (outcome.repaired) {
      console.log(`[session ${s.id}] 本地修复：${outcome.repaired}`);
    }
    res.json({
      turn: first,
      turns,
      groupId: groupId ?? null,
      mode,
      attempts: outcome.attempts,
      tier: lastTier,
      tierKey: lastDetail?.key ?? null,
      nextTier,
      nextTierLabel: nextTier ? tierForKey(nextTier).label : null,
      format: first.format,
      intro: first.intro ?? null,
      reasoning: first.reasoning ?? null,
      repairs: attemptLog,
      attemptDetails: outcome.attemptDetails,
      repaired: outcome.repaired,
      usage: outcome.usage,
      cost: first.cost,
      spend: s.spend,
      limit,
      reply:
        `已生成第 ${displayTurn} 轮预览（${width}×${height}` +
        `${groupCount > 1 ? `，组图 ${groupCount} 张` : ""}${repairNote}，${lastTier}，本次 ¥${outcome.cost.toFixed(4)}）` +
        (outcome.repaired ? `；本地修正：${outcome.repaired}` : ""),
      image: `data:image/png;base64,${(firstPng ?? Buffer.alloc(0)).toString("base64")}`,
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
