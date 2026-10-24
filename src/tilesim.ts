import { charToRgb, rgbDistance, type Palette } from "./palettes.js";
import { TILE_SIZE } from "./limits.js";
import type { Grid, MergeWeights, TileNearGroup } from "./types.js";

/** 权重：边缘 >3×、平坦 <0.5×、透明变化单独放大 */
export const DEFAULT_MERGE_WEIGHTS: MergeWeights = {
  edge: 3,
  flat: 0.5,
  mid: 1,
  alpha: 1.5,
};

/**
 * 默认阈值（加权最大单像素误差）。
 * 0.5×平坦区的强色差约 93；3×边缘的强色差约 558；
 * 600 能覆盖“单个轮廓像素变化”，但不会把大面积重绘并进来。
 */
export const DEFAULT_MERGE_EPSILON = 600;

/**
 * 单对 tile 允许的最大变化像素数。
 * 防止“整块纯色换色”因为平坦区权重低而被误判为相似（这种变化虽然单像素误差低，但面积太大）。
 */
export const DEFAULT_MAX_CHANGED_PIXELS = Math.round((TILE_SIZE * TILE_SIZE) / 4);

const ALPHA_BASE = 255;

export interface TilePlanPoint {
  /** 合并后剩余的 cluster 数（= unique tile 数） */
  clusters: number;
  /** 当前最大加权单像素误差 */
  maxError: number;
}

export interface TilePlan {
  epsilon: number;
  weights: MergeWeights;
  groups: TileNearGroup[];
  /** tile 数 vs 最大误差曲线（从多到少） */
  curve: TilePlanPoint[];
  /** 曲线拐点建议阈值 */
  knee: number;
  uniqueBefore: number;
  uniqueAfter: number;
}

interface TileFeatures {
  edge: boolean[];
  flat: boolean[];
}

function featuresOf(tile: Grid): TileFeatures {
  const edge = Array<boolean>(TILE_SIZE * TILE_SIZE).fill(false);
  const flat = Array<boolean>(TILE_SIZE * TILE_SIZE).fill(false);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const ch = tile.rows[y]?.[x] ?? ".";
      let isEdge = false;
      let isFlat = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= TILE_SIZE || ny >= TILE_SIZE) continue;
          const nch = tile.rows[ny]?.[nx] ?? ".";
          if (nch !== ch) {
            isFlat = false;
            if (dx === 0 || dy === 0) isEdge = true; // 4 邻域决定边缘
          }
        }
      }
      edge[y * TILE_SIZE + x] = isEdge;
      flat[y * TILE_SIZE + x] = isFlat;
    }
  }
  return { edge, flat };
}

function pairErrorFromFeatures(
  a: Grid,
  b: Grid,
  fa: TileFeatures,
  fb: TileFeatures,
  palette: Palette,
  weights: MergeWeights,
): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const p = y * TILE_SIZE + x;
      const ca = a.rows[y]?.[x] ?? ".";
      const cb = b.rows[y]?.[x] ?? ".";
      if (ca === "." && cb === ".") continue;

      const spatial = fa.edge[p] || fb.edge[p]
        ? weights.edge
        : fa.flat[p] && fb.flat[p]
          ? weights.flat
          : weights.mid;

      let cost: number;
      if (ca === "." || cb === ".") {
        cost = spatial * weights.alpha * ALPHA_BASE;
      } else {
        const ra = charToRgb(ca, palette);
        const rb = charToRgb(cb, palette);
        if (!ra || !rb) continue;
        cost = spatial * rgbDistance(ra, rb);
      }
      sum += cost;
      if (cost > max) max = cost;
    }
  }
  return { max, mean: sum / (TILE_SIZE * TILE_SIZE) };
}

/** 两个 16×16 tile 的加权误差（max 用于阈值，mean 仅展示） */
export function pairError(
  a: Grid,
  b: Grid,
  palette: Palette,
  weightsInput?: Partial<MergeWeights>,
): { max: number; mean: number } {
  const weights = { ...DEFAULT_MERGE_WEIGHTS, ...weightsInput };
  return pairErrorFromFeatures(a, b, featuresOf(a), featuresOf(b), palette, weights);
}

function pixelDiff(a: Grid, b: Grid): number {
  let d = 0;
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      if ((a.rows[y]?.[x] ?? ".") !== (b.rows[y]?.[x] ?? ".")) d++;
    }
  }
  return d;
}

function usageCounts(layout: number[], uniqueCount: number): number[] {
  const usage = Array<number>(uniqueCount).fill(0);
  for (const idx of layout) usage[idx]++;
  return usage;
}

/** 曲线拐点：离首尾连线最远的点（归一化前后都适用） */
function kneeOf(curve: TilePlanPoint[]): number {
  if (curve.length < 3) return 0;
  const first = curve[0];
  const last = curve[curve.length - 1];
  const dx = last.clusters - first.clusters;
  const dy = last.maxError - first.maxError;
  const den = Math.hypot(dx, dy);
  if (den === 0) return 0;
  let best = 0;
  let bestDist = -1;
  for (const p of curve) {
    const num = Math.abs(dy * p.clusters - dx * p.maxError + last.clusters * first.maxError - last.maxError * first.clusters);
    const d = num / den;
    if (d > bestDist) {
      bestDist = d;
      best = p.maxError;
    }
  }
  return best;
}

/**
 * 层次聚合（complete linkage）+ 阈值剪枝。
 * 不预设 k；返回完整合并序列与给定 epsilon 下的分组。
 */
export function buildMergePlan(
  unique: Grid[],
  layout: number[],
  palette: Palette,
  epsilon: number,
  weightsInput?: Partial<MergeWeights>,
): TilePlan {
  const weights = { ...DEFAULT_MERGE_WEIGHTS, ...weightsInput };
  const n = unique.length;
  const usage = usageCounts(layout, n);
  const curve: TilePlanPoint[] = [{ clusters: n, maxError: 0 }];
  if (n < 2) {
    return {
      epsilon,
      weights,
      groups: [],
      curve,
      knee: 0,
      uniqueBefore: n,
      uniqueAfter: n,
    };
  }

  const features = unique.map((t) => featuresOf(t));
  const pairMax: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const pairMean: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const changed = pixelDiff(unique[i], unique[j]);
      if (changed > DEFAULT_MAX_CHANGED_PIXELS) {
        pairMax[i][j] = pairMax[j][i] = Infinity;
        pairMean[i][j] = pairMean[j][i] = Infinity;
        continue;
      }
      const e = pairErrorFromFeatures(unique[i], unique[j], features[i], features[j], palette, weights);
      pairMax[i][j] = pairMax[j][i] = e.max;
      pairMean[i][j] = pairMean[j][i] = e.mean;
    }
  }

  // 初始 cluster 距离 = complete linkage 的 pairwise max
  const dist: number[][] = pairMax.map((row) => [...row]);
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const error: number[] = Array<number>(n).fill(0);
  const active = new Set<number>(Array.from({ length: n }, (_, i) => i));
  const mergeSeq: Array<{ a: number; b: number; error: number }> = [];
  let remaining = n;

  while (remaining > 1) {
    let bestA = -1;
    let bestB = -1;
    let best = Infinity;
    const ids = [...active];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const d = dist[a][b];
        if (d < best) {
          best = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || bestB < 0) break;
    if (!Number.isFinite(best)) break; // 剩余 tile 都超过变化像素上限，不再合并

    const newError = Math.max(error[bestA], error[bestB], best);
    members[bestA].push(...members[bestB]);
    error[bestA] = newError;
    for (const k of active) {
      if (k === bestA || k === bestB) continue;
      const d = Math.max(dist[bestA][k], dist[bestB][k]);
      dist[bestA][k] = dist[k][bestA] = d;
    }
    active.delete(bestB);
    remaining--;
    mergeSeq.push({ a: bestA, b: bestB, error: newError });
    curve.push({ clusters: remaining, maxError: newError });
  }

  // 按 epsilon 重放合并序列（并查集）
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== x) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const m of mergeSeq) {
    if (m.error > epsilon) break;
    union(m.a, m.b);
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = buckets.get(r);
    if (list) list.push(i);
    else buckets.set(r, [i]);
  }

  const groups: TileNearGroup[] = [];
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    // 代表：使用次数最多；tie 取最小下标
    let rep = ids[0];
    for (const i of ids) {
      if (usage[i] > usage[rep] || (usage[i] === usage[rep] && i < rep)) rep = i;
    }
    const others = ids.filter((i) => i !== rep);
    let maxError = 0;
    let maxDiff = 0;
    let meanError = 0;
    for (const i of ids) {
      for (const j of ids) {
        if (i < j) maxError = Math.max(maxError, pairMax[i][j]);
      }
      if (i !== rep) {
        maxDiff = Math.max(maxDiff, pixelDiff(unique[rep], unique[i]));
        meanError += pairMean[rep][i];
      }
    }
    meanError /= others.length || 1;
    groups.push({
      representative: rep + 1,
      members: others.map((i) => i + 1),
      maxDiff,
      maxError,
      meanError,
      usage: ids.reduce((sum, i) => sum + usage[i], 0),
    });
  }
  groups.sort((a, b) => b.usage - a.usage || a.representative - b.representative);

  return {
    epsilon,
    weights,
    groups,
    curve,
    knee: kneeOf(curve),
    uniqueBefore: n,
    uniqueAfter: buckets.size,
  };
}
