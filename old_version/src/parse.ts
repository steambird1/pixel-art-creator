import type { Grid, ParseResult } from "./types.js";

/** 解析失败时抛出，message 会回传给模型做自动修复 */
export class ParseError extends Error {}

const IMG_BLOCK = /(?:export\s+const\s+result\s*=|const\s+[A-Za-z_$][\w$]*\s*=)\s*img`([\s\S]*?)`/g;
const VAR_NAME = /const\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

interface GridSizeHint {
  width: number;
  height: number;
}

/** 解析 CombinedTiles(...) 的调用参数；容忍多行、尾随逗号、缺 new、width=/height= 写法 */
function findCombinedCall(text: string): { refs: string[]; width: number; height: number } | null {
  const match = /CombinedTiles\s*\(/.exec(text);
  if (!match) return null;
  const open = text.indexOf("(", match.index);
  if (open < 0) return null;

  // 括号配对，避免把嵌套调用的 ) 当成结尾
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;

  const inner = text.slice(open + 1, close);
  const arr = /\[([\s\S]*?)\]/.exec(inner);
  if (!arr) return null;
  const refs = arr[1]
    .split(",")
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter(Boolean);

  // 数组之后的剩余参数里取前两个数字（支持 width=2, height=2）
  const rest = inner.slice(arr.index + arr[0].length);
  const nums = (rest.match(/\d+/g) ?? []).map((n) => parseInt(n, 10));
  if (refs.length === 0 || nums.length < 2) return null;
  return { refs, width: nums[0], height: nums[1] };
}

/**
 * 多个图块但缺少/写坏 CombinedTiles 时，按用户显式尺寸或图块数量推断布局。
 * 只做无歧义推断：显式尺寸能整除，或无尺寸时图块数为完全平方数（2×2、3×3…）。
 */
function inferLayout(
  grids: Grid[],
  hint: GridSizeHint | null,
): { width: number; height: number } | null {
  const n = grids.length;
  if (n < 2 || n > 16) return null;
  const tileW = grids[0].rows[0]?.length ?? 0;
  const tileH = grids[0].rows.length;
  if (!tileW || !tileH) return null;
  const sameShape = grids.every(
    (g) => g.rows.length === tileH && g.rows.every((r) => r.length === tileW),
  );
  if (!sameShape) return null;

  if (hint) {
    if (hint.width % tileW !== 0 || hint.height % tileH !== 0) return null;
    const cols = hint.width / tileW;
    const rows = hint.height / tileH;
    return cols * rows === n ? { width: cols, height: rows } : null;
  }

  const side = Math.round(Math.sqrt(n));
  return side * side === n ? { width: side, height: side } : null;
}

/** 把一行文本拆成像素字符（容忍模型省略空格或使用逗号分隔） */
function lineToCells(line: string): string[] {
  const cleaned = line.replace(/,/g, " ").trim();
  if (cleaned === "") return [];
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const cells: string[] = [];
  for (const tok of tokens) {
    if (tok.length === 1) {
      cells.push(tok.toLowerCase());
    } else {
      // 无空格的一整行/多字符 token：按字符展开，非法字符留给 validate 报错
      for (const ch of tok.toLowerCase()) cells.push(ch);
    }
  }
  return cells;
}

/** 把 img`...` 内容解析为网格 */
function parseGrid(content: string, label: string): Grid {
  const rows: string[][] = [];
  for (const line of content.split(/\r?\n/)) {
    const cells = lineToCells(line);
    if (cells.length === 0) continue;
    rows.push(cells);
  }
  if (rows.length === 0) throw new ParseError(`${label}：img 围栏内没有有效行`);
  return { rows };
}

/**
 * 从模型原始输出中提取 img`...` / CombinedTiles 产物。
 * 抛出 ParseError 表示完全提取不到（错误信息回传模型修复）。
 */
export function parseAIOutput(text: string, hint: GridSizeHint | null = null): ParseResult {
  const named = new Map<string, Grid>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(IMG_BLOCK.source, "g");
  while ((m = re.exec(text)) !== null) {
    const decl = m[0].slice(0, m[0].indexOf("img`"));
    const nameMatch = decl.match(VAR_NAME);
    const name = nameMatch ? nameMatch[1] : "result";
    named.set(name, parseGrid(m[1], `const ${name}`));
    order.push(name);
  }
  if (named.size === 0) {
    throw new ParseError("输出中找不到任何 img`...` 代码块，请严格按 prompt.md 的格式输出代码");
  }

  const combined = findCombinedCall(text);
  if (combined) {
    const { refs, width, height } = combined;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new ParseError(`CombinedTiles 的宽度/高度无效：${width}, ${height}`);
    }
    if (refs.length !== width * height) {
      throw new ParseError(
        `CombinedTiles 引用了 ${refs.length} 个图块，但声明的布局是 ${width}x${height}=${width * height} 个`,
      );
    }
    const tiles: Grid[] = [];
    for (const ref of refs) {
      const key = ref.replace(/^["'`]|["'`]$/g, "");
      const g = named.get(key);
      if (!g) throw new ParseError(`CombinedTiles 引用了不存在的变量：${key}`);
      tiles.push(g);
    }
    return { kind: "tiles", tiles, width, height };
  }

  // 未使用 CombinedTiles：若声明了多个图块但没拼接，尝试本地推断布局
  const single = named.get("result");
  if (single) return { kind: "single", grid: single };
  if (order.length === 1) return { kind: "single", grid: named.get(order[0])! };

  const allTileLike = order.every((name) => /tile/i.test(name));
  if (allTileLike) {
    const grids = order.map((name) => named.get(name)!);
    const layout = inferLayout(grids, hint);
    if (layout) return { kind: "tiles", tiles: grids, width: layout.width, height: layout.height };
  }

  if (/CombinedTiles\s*\(/.test(text)) {
    throw new ParseError(
      "检测到 `CombinedTiles(`，但参数无法解析。请使用 `new CombinedTiles([tile1, tile2, ...], 宽, 高)` 格式（可多行，允许尾随逗号）。",
    );
  }
  throw new ParseError(
    "声明了多个图块但缺少可用的 `new CombinedTiles([...], 宽, 高)` 拼接代码（程序也无法从图块数量与用户尺寸推断布局）",
  );
}

/** 从规范化产物重建干净代码（写回会话历史，保证多轮上下文整洁） */
export function toCode(result: ParseResult): string {
  if (result.kind === "single") {
    return ["export const result = img`", ...gridLines(result.grid), "`;"].join("\n");
  }
  const parts: string[] = [];
  result.tiles.forEach((tile, i) => {
    parts.push(["const tile" + (i + 1) + " = img`", ...gridLines(tile), "`;"].join("\n"));
  });
  parts.push(
    `export const result = new CombinedTiles(\n  [${result.tiles.map((_, i) => "tile" + (i + 1)).join(", ")}], ` +
      `${result.width}, ${result.height},\n);`,
  );
  return parts.join("\n\n");
}

function gridLines(grid: Grid): string[] {
  return grid.rows.map((row) => row.join(" "));
}
