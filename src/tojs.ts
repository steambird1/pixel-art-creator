import { TILE_SIZE } from "./limits.js";
import { DEFAULT_PALETTE, type Palette } from "./palettes.js";
import { combineTiles } from "./render.js";
import { DEFAULT_MERGE_EPSILON, buildMergePlan } from "./tilesim.js";
import type { Grid, ParseResult, TileNearGroup, TileStats } from "./types.js";

export interface TileLayout {
  tilesX: number;
  tilesY: number;
  /** 去重后的唯一 tile */
  unique: Grid[];
  /** 每个 tile 位置引用的 unique 下标（0 基，行优先） */
  layout: number[];
}

export interface JsArtifact {
  /** 主要输出：旧版 JavaScript 程序（img / CombinedTiles） */
  code: string;
  /** tile 统计（仅当画布可按 16×16 切分时存在） */
  tileStats?: TileStats;
  /** 内部布局，用于手动合并/调试 */
  layout?: TileLayout;
}

export interface GridDiffStats {
  changedPixels: number;
  changedTiles: number;
  bounds: { x: number; y: number; w: number; h: number };
}

function gridKey(grid: Grid): string {
  return grid.rows.map((row) => row.join("")).join("\n");
}

function usageCounts(layout: number[], uniqueCount: number): number[] {
  const usage = Array<number>(uniqueCount).fill(0);
  for (const idx of layout) usage[idx]++;
  return usage;
}

function statsFor(unique: Grid[], layout: number[], palette: Palette): TileStats {
  const plan = buildMergePlan(unique, layout, palette, DEFAULT_MERGE_EPSILON);
  return {
    total: layout.length,
    unique: unique.length,
    reused: Math.max(0, layout.length - unique.length),
    nearGroups: plan.groups,
    epsilon: plan.epsilon,
  };
}

/** 把一张网格按 16×16 切开并做精确去重；不能整除时返回 null */
export function splitGridToTiles(grid: Grid, tileSize: number = TILE_SIZE): TileLayout | null {
  const height = grid.rows.length;
  const width = grid.rows[0]?.length ?? 0;
  if (!width || !height || width % tileSize !== 0 || height % tileSize !== 0) return null;
  const tilesX = width / tileSize;
  const tilesY = height / tileSize;
  if (tilesX * tilesY <= 1) return null;

  const unique: Grid[] = [];
  const index = new Map<string, number>();
  const layout: number[] = [];

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const rows: string[][] = [];
      for (let y = 0; y < tileSize; y++) {
        rows.push(grid.rows[ty * tileSize + y].slice(tx * tileSize, (tx + 1) * tileSize));
      }
      const tile: Grid = { rows };
      const key = gridKey(tile);
      let idx = index.get(key);
      if (idx === undefined) {
        idx = unique.length;
        unique.push(tile);
        index.set(key, idx);
      }
      layout.push(idx);
    }
  }
  return { tilesX, tilesY, unique, layout };
}

/** 把旧版 tiles 去重成 layout（tiles 已经是 16×16） */
function layoutFromTiles(tiles: Grid[], tilesX: number, tilesY: number): TileLayout {
  const unique: Grid[] = [];
  const index = new Map<string, number>();
  const layout: number[] = [];
  for (const tile of tiles) {
    const key = gridKey(tile);
    let idx = index.get(key);
    if (idx === undefined) {
      idx = unique.length;
      unique.push(tile);
      index.set(key, idx);
    }
    layout.push(idx);
  }
  return { tilesX, tilesY, unique, layout };
}

function gridLines(grid: Grid): string[] {
  return grid.rows.map((row) => row.join(" "));
}

function imgCode(name: string, grid: Grid): string {
  return [`const ${name} = img\``, ...gridLines(grid), "`;"].join("\n");
}

function generateJs(layout: TileLayout): string {
  const { unique, layout: refs, tilesX, tilesY } = layout;
  if (unique.length === 1 && refs.length === 1) {
    return `export const result = img\`\n${gridLines(unique[0]).join("\n")}\n\`;`;
  }

  const usage = usageCounts(refs, unique.length);
  const parts: string[] = [];
  unique.forEach((tile, i) => {
    parts.push(`// tile${i + 1}: used ${usage[i]} time${usage[i] === 1 ? "" : "s"}`);
    parts.push(imgCode(`tile${i + 1}`, tile));
  });

  const rows: string[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    const row = refs
      .slice(ty * tilesX, (ty + 1) * tilesX)
      .map((idx) => `tile${idx + 1}`)
      .join(", ");
    rows.push(`  ${row},`);
  }
  parts.push(
    `export const result = new CombinedTiles([\n${rows.join("\n")}\n], ${tilesX}, ${tilesY});`,
  );
  return parts.join("\n\n");
}

/** 从一个解析结果生成“旧版 JavaScript 程序”主产物 */
export function toJs(result: ParseResult, palette: Palette = DEFAULT_PALETTE): JsArtifact {
  if (result.kind === "tiles") {
    const layout = layoutFromTiles(result.tiles, result.width, result.height);
    return {
      code: generateJs(layout),
      tileStats: statsFor(layout.unique, layout.layout, palette),
      layout,
    };
  }

  const layout = splitGridToTiles(result.grid);
  if (layout) {
    return {
      code: generateJs(layout),
      tileStats: statsFor(layout.unique, layout.layout, palette),
      layout,
    };
  }

  const width = result.grid.rows[0]?.length ?? 0;
  const height = result.grid.rows.length;
  return {
    code: `export const result = img\`\n${gridLines(result.grid).join("\n")}\n\`;`,
    ...(width === TILE_SIZE && height === TILE_SIZE
      ? {
          tileStats: {
            total: 1,
            unique: 1,
            reused: 0,
            nearGroups: [],
          } satisfies TileStats,
        }
      : {}),
  };
}

/** 解析结果 -> 完整网格（旧版 tiles 会先拼接） */
export function parsedToGrid(result: ParseResult): Grid {
  if (result.kind === "single") return result.grid;
  return combineTiles(result.tiles, result.width, result.height);
}

/** 比较合并前后网格，返回像素/ tile / 包围盒统计 */
export function diffGrids(before: Grid, after: Grid, tileSize: number = TILE_SIZE): GridDiffStats {
  const h = Math.min(before.rows.length, after.rows.length);
  const w = Math.min(before.rows[0]?.length ?? 0, after.rows[0]?.length ?? 0);
  let changedPixels = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const changedTileSet = new Set<string>();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (before.rows[y][x] === after.rows[y][x]) continue;
      changedPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      changedTileSet.add(`${Math.floor(x / tileSize)},${Math.floor(y / tileSize)}`);
    }
  }

  return {
    changedPixels,
    changedTiles: changedTileSet.size,
    bounds:
      changedPixels > 0
        ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
        : { x: 0, y: 0, w: 0, h: 0 },
  };
}

function rebuildWithTileMap(layout: TileLayout, map: Map<number, number>): Grid {
  const newLayout = layout.layout.map((idx) => map.get(idx) ?? idx);
  const rows: string[][] = [];
  const tileH = layout.unique[0]?.rows.length ?? TILE_SIZE;
  const tileW = layout.unique[0]?.rows[0]?.length ?? TILE_SIZE;
  for (let ty = 0; ty < layout.tilesY; ty++) {
    for (let y = 0; y < tileH; y++) {
      const row: string[] = [];
      for (let tx = 0; tx < layout.tilesX; tx++) {
        const tile = layout.unique[newLayout[ty * layout.tilesX + tx]];
        row.push(...tile.rows[y]);
      }
      rows.push(row);
    }
  }
  return { rows };
}

/** 把 layout 中 members（0 基）替换成 representative（0 基），重建网格 */
export function mergeTilesInLayout(
  layout: TileLayout,
  representative: number,
  members: number[],
): Grid {
  const map = new Map<number, number>();
  for (const m of members) map.set(m, representative);
  return rebuildWithTileMap(layout, map);
}

/** 一次应用多组合并（TileNearGroup 使用 1 基编号） */
export function mergeGroupsInLayout(layout: TileLayout, groups: TileNearGroup[]): Grid {
  const map = new Map<number, number>();
  for (const g of groups) {
    const rep = g.representative - 1;
    for (const m of g.members) map.set(m - 1, rep);
  }
  return rebuildWithTileMap(layout, map);
}
