import { VALID_CHARS } from "./palette.js";
import { MAX_DIM as LIMIT_DIM } from "./limits.js";
import {
  PALETTE_SLOT_COUNT,
  PRESET_PALETTES,
  clonePalette,
  isHexColor,
  normalizeHex,
  type Palette,
} from "./palettes.js";
import type { Grid } from "./types.js";

/** DSL 编译失败：错误信息会回传模型修复 */
export class DslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DslError";
  }
}

export interface DslCompileResult {
  grid: Grid;
  /** 规范化后的 DSL 源码（写回历史 / 前端展示） */
  source: string;
  width: number;
  height: number;
  /** `palette` 指令指定的调色板（组图按顺序对应每张） */
  palettes?: Palette[];
}

/** 组图最多 9 张，对应最多 9 个 palette 指令 */
const MAX_PALETTES = 9;

interface SizeHint {
  width: number;
  height: number;
}

const MIN_DIM = 4;
const MAX_DIM = LIMIT_DIM;
const DEFAULT_DIM = 16;

const OP_NAMES = [
  "size",
  "canvas",
  "bg",
  "background",
  "rect",
  "frame",
  "outline",
  "line",
  "hline",
  "vline",
  "pixel",
  "fill",
  "ellipse",
  "circle",
  "mirror",
  "palette",
];

/** 是否像 DSL（用于 parse 分派；宁可误判，后续编译会给出精确错误） */
export function looksLikeDSL(text: string): boolean {
  return (
    /```[ \t]*dsl\b/i.test(text) ||
    /(?:^|\n)\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}\b/i.test(text)
  );
}

function looksLikeDSLBody(body: string): boolean {
  return (
    /^\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}\b/im.test(body) ||
    /^\s*(?:bg|background|rect|frame|outline|line|hline|vline|pixel|fill|ellipse|circle|mirror)\b/im.test(
      body,
    )
  );
}

/** 从模型输出中提取 DSL 代码块（fenced 优先，其次从 size/canvas 行开始） */
export function extractDSLBlock(text: string): string | null {
  const fences = [...text.matchAll(/```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g)];
  for (const f of fences) {
    const lang = (f[1] || "").toLowerCase();
    const body = f[2];
    if (lang === "dsl" || looksLikeDSLBody(body)) return body.trim();
  }

  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}\b/i.test(l),
  );
  if (start < 0) return null;

  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) break;
    // 没有围栏时，遇到中文说明/旧格式代码就停止，避免把后文当指令
    if (i > start && /[\u4e00-\u9fff]/.test(line) && !/^\s*[#/]/.test(line)) break;
    if (i > start && /^\s*(?:export|import|const|let|var)\b/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** 把一行拆成 token；容忍 rect(x,y,w,h,c) / 逗号 / 分号 */
function splitTokens(line: string): string[] {
  return line
    .replace(/[(),;\[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function intToken(tok: string, lineNo: number, what: string): number {
  if (!/^-?\d+$/.test(tok)) {
    throw new DslError(`第 ${lineNo} 行：${what} 必须是整数，收到 "${tok}"`);
  }
  const n = Number(tok);
  if (!Number.isSafeInteger(n)) {
    throw new DslError(`第 ${lineNo} 行：${what} 数值过大：${tok}`);
  }
  return n;
}

function colorToken(tok: string, lineNo: number): string {
  const c = tok.toLowerCase();
  if (!VALID_CHARS.has(c)) {
    throw new DslError(`第 ${lineNo} 行：颜色 "${tok}" 非法，只允许 . 和 1-f`);
  }
  return c;
}

function checkDim(w: number, h: number, lineNo: number): void {
  if (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) {
    throw new DslError(
      `第 ${lineNo} 行：画布 ${w}×${h} 超出范围（${MIN_DIM}..${MAX_DIM}）`,
    );
  }
}

function makeRows(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array<string>(width).fill("."));
}

export function compileDSL(source: string, hint: SizeHint | null = null): DslCompileResult {
  let width = hint?.width ?? DEFAULT_DIM;
  let height = hint?.height ?? DEFAULT_DIM;
  checkDim(width, height, 0);

  let sizeSeen = false;
  let rows: string[][] | null = null;
  const canonicalOps: string[] = [];
  const canonicalPalettes: string[] = [];
  const palettes: Palette[] = [];
  let shapeOpCount = 0;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]
      .replace(/\/\/.*$/, "")
      // `#` 注释：保留 #RRGGBB 形式的颜色（自定义调色板要用）
      .replace(/(^|\s)#(?![0-9a-fA-F]{6}\b).*$/, "$1")
      .trim();
    if (!line) continue;

    const tokens = splitTokens(line);
    const op = (tokens[0] || "").toLowerCase().replace(/:$/, "");
    if (!OP_NAMES.includes(op)) {
      throw new DslError(
        `第 ${lineNo} 行：未知指令 "${tokens[0]}"。可用：size/bg/rect/frame/line/hline/vline/pixel/fill/ellipse/circle/mirror/palette`,
      );
    }

    if (op === "size" || op === "canvas") {
      if (rows) throw new DslError(`第 ${lineNo} 行：size 必须放在所有绘图指令之前`);
      if (sizeSeen) throw new DslError(`第 ${lineNo} 行：size 只能出现一次`);
      if (tokens.length !== 3) {
        throw new DslError(`第 ${lineNo} 行：size 需要两个参数，例如 size 16 16`);
      }
      const w = intToken(tokens[1], lineNo, "画布宽度");
      const h = intToken(tokens[2], lineNo, "画布高度");
      checkDim(w, h, lineNo);
      if (hint && (w !== hint.width || h !== hint.height)) {
        throw new DslError(
          `第 ${lineNo} 行：画布尺寸 ${w}×${h} 与期望的 ${hint.width}×${hint.height} 不一致。` +
            "目标尺寸由界面指定并在请求中注入；请严格使用注入的 size，不要自行改变画布大小",
        );
      }
      width = w;
      height = h;
      sizeSeen = true;
      continue;
    }

    if (op === "palette") {
      if (!sizeSeen) {
        throw new DslError(`第 ${lineNo} 行：palette 必须放在 size 之后`);
      }
      const parsed = parsePaletteDirective(tokens.slice(1), lineNo, palettes.length + 1);
      for (const p of parsed) {
        if (palettes.length >= MAX_PALETTES) {
          throw new DslError(`palette 数量超过上限 ${MAX_PALETTES}（组图最多 ${MAX_PALETTES} 张）`);
        }
        palettes.push(p);
        canonicalPalettes.push(canonicalPaletteLine(p));
      }
      continue;
    }

    if (!rows) rows = makeRows(width, height);

    switch (op) {
      case "bg":
      case "background": {
        if (tokens.length !== 2) throw new DslError(`第 ${lineNo} 行：bg 需要一个颜色参数`);
        const c = colorToken(tokens[1], lineNo);
        for (const row of rows) row.fill(c);
        canonicalOps.push(`bg ${c}`);
        break;
      }

      case "rect": {
        const { x, y, w, h } = rectArgs(tokens, lineNo, width, height);
        const c = colorToken(tokens[5], lineNo);
        for (let py = y; py < y + h; py++) {
          for (let px = x; px < x + w; px++) rows[py][px] = c;
        }
        canonicalOps.push(`rect ${x} ${y} ${w} ${h} ${c}`);
        shapeOpCount++;
        break;
      }

      case "frame":
      case "outline": {
        const { x, y, w, h } = rectArgs(tokens, lineNo, width, height);
        const c = colorToken(tokens[5], lineNo);
        for (let px = x; px < x + w; px++) {
          rows[y][px] = c;
          rows[y + h - 1][px] = c;
        }
        for (let py = y; py < y + h; py++) {
          rows[py][x] = c;
          rows[py][x + w - 1] = c;
        }
        canonicalOps.push(`frame ${x} ${y} ${w} ${h} ${c}`);
        shapeOpCount++;
        break;
      }

      case "line": {
        if (tokens.length !== 6) {
          throw new DslError(`第 ${lineNo} 行：line 需要 x1 y1 x2 y2 颜色 五个参数`);
        }
        const x1 = intToken(tokens[1], lineNo, "x1");
        const y1 = intToken(tokens[2], lineNo, "y1");
        const x2 = intToken(tokens[3], lineNo, "x2");
        const y2 = intToken(tokens[4], lineNo, "y2");
        const c = colorToken(tokens[5], lineNo);
        assertPoint(x1, y1, width, height, lineNo);
        assertPoint(x2, y2, width, height, lineNo);
        drawLine(rows, x1, y1, x2, y2, c);
        canonicalOps.push(`line ${x1} ${y1} ${x2} ${y2} ${c}`);
        shapeOpCount++;
        break;
      }

      case "hline": {
        if (tokens.length !== 5) {
          throw new DslError(`第 ${lineNo} 行：hline 需要 x y 宽度 颜色 四个参数`);
        }
        const x = intToken(tokens[1], lineNo, "x");
        const y = intToken(tokens[2], lineNo, "y");
        const w = intToken(tokens[3], lineNo, "宽度");
        const c = colorToken(tokens[4], lineNo);
        if (w <= 0 || x < 0 || y < 0 || x + w > width || y >= height) {
          throw new DslError(`第 ${lineNo} 行：hline 超出画布`);
        }
        for (let px = x; px < x + w; px++) rows[y][px] = c;
        canonicalOps.push(`hline ${x} ${y} ${w} ${c}`);
        shapeOpCount++;
        break;
      }

      case "vline": {
        if (tokens.length !== 5) {
          throw new DslError(`第 ${lineNo} 行：vline 需要 x y 高度 颜色 四个参数`);
        }
        const x = intToken(tokens[1], lineNo, "x");
        const y = intToken(tokens[2], lineNo, "y");
        const h = intToken(tokens[3], lineNo, "高度");
        const c = colorToken(tokens[4], lineNo);
        if (h <= 0 || x < 0 || y < 0 || y + h > height || x >= width) {
          throw new DslError(`第 ${lineNo} 行：vline 超出画布`);
        }
        for (let py = y; py < y + h; py++) rows[py][x] = c;
        canonicalOps.push(`vline ${x} ${y} ${h} ${c}`);
        shapeOpCount++;
        break;
      }

      case "pixel": {
        if (tokens.length !== 4) throw new DslError(`第 ${lineNo} 行：pixel 需要 x y 颜色 三个参数`);
        const x = intToken(tokens[1], lineNo, "x");
        const y = intToken(tokens[2], lineNo, "y");
        const c = colorToken(tokens[3], lineNo);
        assertPoint(x, y, width, height, lineNo);
        rows[y][x] = c;
        canonicalOps.push(`pixel ${x} ${y} ${c}`);
        shapeOpCount++;
        break;
      }

      case "fill": {
        if (tokens.length !== 4) throw new DslError(`第 ${lineNo} 行：fill 需要 x y 颜色 三个参数`);
        const x = intToken(tokens[1], lineNo, "x");
        const y = intToken(tokens[2], lineNo, "y");
        const c = colorToken(tokens[3], lineNo);
        assertPoint(x, y, width, height, lineNo);
        floodFill(rows, x, y, c);
        canonicalOps.push(`fill ${x} ${y} ${c}`);
        // fill 只填充已有区域，不单独算“画了形状”；避免 bg + fill 变成纯色空图
        break;
      }

      case "ellipse": {
        if (tokens.length !== 6) {
          throw new DslError(`第 ${lineNo} 行：ellipse 需要 x y 宽 高 颜色 五个参数`);
        }
        const { x, y, w, h } = rectArgs(tokens, lineNo, width, height);
        const c = colorToken(tokens[5], lineNo);
        drawEllipse(rows, x, y, w, h, c);
        canonicalOps.push(`ellipse ${x} ${y} ${w} ${h} ${c}`);
        shapeOpCount++;
        break;
      }

      case "circle": {
        if (tokens.length !== 5) {
          throw new DslError(`第 ${lineNo} 行：circle 需要 cx cy 半径 颜色 四个参数`);
        }
        const cx = intToken(tokens[1], lineNo, "cx");
        const cy = intToken(tokens[2], lineNo, "cy");
        const r = intToken(tokens[3], lineNo, "半径");
        const c = colorToken(tokens[4], lineNo);
        if (r < 0) throw new DslError(`第 ${lineNo} 行：半径不能为负`);
        const x = cx - r;
        const y = cy - r;
        const size = r * 2 + 1;
        if (x < 0 || y < 0 || x + size > width || y + size > height) {
          throw new DslError(`第 ${lineNo} 行：circle 超出画布`);
        }
        if (r === 0) {
          rows[cy][cx] = c;
        } else if (r === 1) {
          // 像素画小圆：半径 1 用“十字”而不是 3×3 方块
          rows[cy][cx] = c;
          rows[cy - 1][cx] = c;
          rows[cy + 1][cx] = c;
          rows[cy][cx - 1] = c;
          rows[cy][cx + 1] = c;
        } else {
          drawEllipse(rows, x, y, size, size, c);
        }
        canonicalOps.push(`circle ${cx} ${cy} ${r} ${c}`);
        shapeOpCount++;
        break;
      }

      case "mirror": {
        if (tokens.length !== 2 || !["x", "y"].includes(tokens[1].toLowerCase())) {
          throw new DslError(`第 ${lineNo} 行：mirror 需要 x 或 y 参数`);
        }
        const axis = tokens[1].toLowerCase() as "x" | "y";
        mirror(rows, axis);
        canonicalOps.push(`mirror ${axis}`);
        // mirror 本身不产生新内容，不计入 shapeOpCount
        break;
      }

      default:
        throw new DslError(`第 ${lineNo} 行：未实现的指令 "${op}"`);
    }
  }

  if (!rows) {
    throw new DslError("DSL 中没有任何绘图指令；至少需要一条 rect/frame/line/pixel 等指令");
  }
  if (shapeOpCount === 0) {
    throw new DslError("DSL 中没有实际绘制形状；请至少使用 rect/frame/line/pixel/ellipse/circle 画一个主体");
  }

  return {
    grid: { rows },
    source: [`size ${width} ${height}`, ...canonicalPalettes, ...canonicalOps].join("\n"),
    width,
    height,
    ...(palettes.length ? { palettes } : {}),
  };
}

/**
 * 解析 `palette ...` 参数：
 * - `palette gameboy nes` -> 两个预设（一行可写多个，按顺序）
 * - `palette custom #FFFFFF ...` -> 一个 15 色自定义板
 * - `palette #FFFFFF ...` -> 省略 custom 的自定义板
 */
function parsePaletteDirective(args: string[], lineNo: number, startIndex: number): Palette[] {
  if (!args.length) {
    throw new DslError(`第 ${lineNo} 行：palette 至少需要一个预设名或 15 个 #RRGGBB 颜色`);
  }
  const cleaned = args.map((x) => x.trim()).filter(Boolean);
  const colorTokens = cleaned.filter((x) => x.startsWith("#"));
  if (colorTokens.length) {
    const withoutKeyword = cleaned[0]?.toLowerCase() === "custom" ? cleaned.slice(1) : cleaned;
    if (withoutKeyword.length !== PALETTE_SLOT_COUNT || withoutKeyword.some((c) => !isHexColor(c))) {
      throw new DslError(
        `第 ${lineNo} 行：自定义 palette 需要正好 ${PALETTE_SLOT_COUNT} 个 #RRGGBB 颜色（依次对应 1-f），` +
          `当前收到 ${withoutKeyword.length} 个`,
      );
    }
    const name = startIndex === 1 ? "ai-custom" : `ai-custom-${startIndex}`;
    return [
      {
        name,
        label: startIndex === 1 ? "AI 自定义" : `AI 自定义 ${startIndex}`,
        colors: withoutKeyword.map((c) => normalizeHex(c)),
      },
    ];
  }

  const names = cleaned.map((x) => x.toLowerCase());
  const unknown = names.filter((n) => !PRESET_PALETTES[n]);
  if (unknown.length) {
    throw new DslError(
      `第 ${lineNo} 行：未知调色板 ${unknown.map((n) => `"${n}"`).join(", ")}；` +
        `可用预设：${Object.keys(PRESET_PALETTES).join(" / ")}，或 palette custom + 15 个 #RRGGBB`,
    );
  }
  return names.map((n) => clonePalette(PRESET_PALETTES[n]));
}

function canonicalPaletteLine(p: Palette): string {
  // 预设统一写成 palette <name>，自定义写成 palette custom <15 hex>
  if (PRESET_PALETTES[p.name]?.colors.join() === p.colors.join()) return `palette ${p.name}`;
  return `palette custom ${p.colors.join(" ")}`;
}

function rectArgs(
  tokens: string[],
  lineNo: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  if (tokens.length !== 6) {
    throw new DslError(`第 ${lineNo} 行：${tokens[0]} 需要 x y 宽 高 颜色 五个参数`);
  }
  const x = intToken(tokens[1], lineNo, "x");
  const y = intToken(tokens[2], lineNo, "y");
  const w = intToken(tokens[3], lineNo, "宽度");
  const h = intToken(tokens[4], lineNo, "高度");
  if (w <= 0 || h <= 0) throw new DslError(`第 ${lineNo} 行：宽度和高度必须为正数`);
  if (x < 0 || y < 0 || x + w > width || y + h > height) {
    throw new DslError(`第 ${lineNo} 行：${tokens[0]} 超出 ${width}×${height} 画布`);
  }
  return { x, y, w, h };
}

function assertPoint(x: number, y: number, width: number, height: number, lineNo: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new DslError(`第 ${lineNo} 行：坐标 (${x}, ${y}) 超出 ${width}×${height} 画布`);
  }
}

function drawLine(
  rows: string[][],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  c: string,
): void {
  let x = x1;
  let y = y1;
  const dx = Math.abs(x2 - x1);
  const sx = x1 < x2 ? 1 : -1;
  const dy = -Math.abs(y2 - y1);
  const sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    rows[y][x] = c;
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function floodFill(rows: string[][], x: number, y: number, c: string): void {
  const target = rows[y][x];
  if (target === c) return;
  const height = rows.length;
  const width = rows[0].length;
  const stack: Array<[number, number]> = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height || rows[cy][cx] !== target) continue;
    rows[cy][cx] = c;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

function drawEllipse(
  rows: string[][],
  x: number,
  y: number,
  w: number,
  h: number,
  c: string,
): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const nx = (px + 0.5 - cx) / rx;
      const ny = (py + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1 + 1e-9) rows[py][px] = c;
    }
  }
}

function mirror(rows: string[][], axis: "x" | "y"): void {
  const height = rows.length;
  const width = rows[0].length;
  if (axis === "x") {
    const half = Math.floor(width / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < half; x++) rows[y][width - 1 - x] = rows[y][x];
    }
  } else {
    const half = Math.floor(height / 2);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < width; x++) rows[height - 1 - y][x] = rows[y][x];
    }
  }
}
