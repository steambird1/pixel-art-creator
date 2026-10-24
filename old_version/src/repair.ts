import type { Grid } from "./types.js";

/**
 * 受限的“维度修复”：只处理模型常见的差 1~2 个透明格问题。
 * 原则：
 * - 只增删**透明**像素/空白行，绝不删除或移动有内容的像素；
 * - 超出 ±2 的差异不修，交给校验流程回传模型；
 * - 修复后仍需通过完整校验（含空图检查）。
 */
export interface GridRepair {
  grid: Grid;
  notes: string[];
}

const MAX_DELTA = 2;

function isBlankRow(row: string[]): boolean {
  return row.every((ch) => ch === ".");
}

function leadingDots(row: string[]): number {
  let i = 0;
  while (i < row.length && row[i] === ".") i++;
  return i;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function repairGrid(grid: Grid, expW: number, expH: number): GridRepair | null {
  if (expW <= 0 || expH <= 0 || grid.rows.length === 0) return null;
  const notes: string[] = [];
  let rows = grid.rows.map((r) => [...r]);

  // 1) 行数：只删除末尾多余空白行 / 在末尾补空白行
  if (rows.length > expH) {
    const extra = rows.length - expH;
    if (extra > MAX_DELTA) return null;
    let removable = 0;
    for (let i = rows.length - 1; i >= 0 && removable < extra; i--) {
      if (!isBlankRow(rows[i])) break;
      removable++;
    }
    if (removable < extra) return null;
    rows = rows.slice(0, rows.length - extra);
    notes.push(`删除 ${extra} 行多余空白行`);
  } else if (rows.length < expH) {
    const missing = expH - rows.length;
    if (missing > MAX_DELTA) return null;
    for (let i = 0; i < missing; i++) rows.push(Array(expW).fill("."));
    notes.push(`补齐 ${missing} 行空白行`);
  }

  // 2) 列数：以“正常行”的前导透明格数量为参考，决定在左侧还是右侧补/删透明格
  const referenceLead = median(
    rows.filter((r) => r.length === expW && !isBlankRow(r)).map((r) => leadingDots(r)),
  );
  let padded = 0;
  let trimmed = 0;

  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    const diff = expW - row.length;
    if (diff === 0) continue;

    if (Math.abs(diff) > MAX_DELTA) return null;

    if (diff > 0) {
      // 少像素：若该行前导透明格明显少于参考行，说明缺的是左侧；否则补在右侧
      const padLeft = leadingDots(row) < referenceLead - 1;
      const pad = Array(diff).fill(".");
      rows[y] = padLeft ? [...pad, ...row] : [...row, ...pad];
      padded += diff;
    } else {
      // 多像素：只允许删除右侧多余透明格；其他情况不猜测（避免把内容整体左移）
      const extra = -diff;
      const trailing = row.slice(row.length - extra);
      if (trailing.every((ch) => ch === ".")) {
        rows[y] = row.slice(0, row.length - extra);
        trimmed += extra;
      } else {
        return null;
      }
    }
  }

  if (padded > 0) notes.push(`补齐 ${padded} 个缺失的透明像素`);
  if (trimmed > 0) notes.push(`删除 ${trimmed} 个多余的透明像素`);
  if (notes.length === 0) return null;

  return { grid: { rows }, notes };
}
