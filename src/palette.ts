import { DEFAULT_PALETTE, type Palette } from "./palettes.js";

/**
 * 默认调色板（prompt.md 规定的 15 色 + 透明）：
 * 透明色用 `.` 表示，其余颜色按顺序用 1..f 的十六进制字符表示。
 * 下标即字符编码：char = index === 0 ? '.' : index.toString(16)
 */
export const PALETTE: readonly string[] = ["#00000000", ...DEFAULT_PALETTE.colors];

/** 合法像素字符集合 */
export const VALID_CHARS = new Set([".", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]);

/** 字符 -> 索引（`.` 为 0，`1`-`f` 为 1-15） */
export function charToIndex(ch: string): number {
  return ch === "." ? 0 : parseInt(ch, 16);
}

/** 字符 -> RGBA 四元组（palette 决定具体 RGB） */
export function charToRGBA(ch: string, palette: Palette = DEFAULT_PALETTE): [number, number, number, number] {
  if (ch === ".") return [0, 0, 0, 0]; // 透明
  const idx = charToIndex(ch);
  const hex = palette.colors[idx - 1] ?? DEFAULT_PALETTE.colors[14];
  const rgb = hex.replace("#", "");
  return [
    parseInt(rgb.slice(0, 2), 16),
    parseInt(rgb.slice(2, 4), 16),
    parseInt(rgb.slice(4, 6), 16),
    255,
  ];
}
