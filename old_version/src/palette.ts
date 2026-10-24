/**
 * prompt.md 规定的调色板：
 * 透明色用 `.` 表示，其余颜色按 prompt.md 给出的顺序用 1(f 白色->黑色) 的十六进制数表示。
 * 下标即字符编码：char = index === 0 ? '.' : index.toString(16)
 */
export const PALETTE: readonly string[] = [
  "#00000000", // 0: 透明色 '.'
  "#FFFFFF", // 1: 白色
  "#FF2121", // 2: 红色
  "#FF93C4", // 3: 粉色
  "#FF8135", // 4: 橙色
  "#FFF609", // 5: 黄色
  "#249CA3", // 6: 青色
  "#78DC52", // 7: 绿色
  "#003FAD", // 8: 蓝色
  "#87F2FF", // 9: 浅蓝色
  "#8E2EC4", // a: 紫色
  "#A4839F", // b: 浅紫色
  "#5C406C", // c: 深紫色
  "#E5CDC4", // d: 浅棕色
  "#91463D", // e: 深棕色
  "#000000", // f: 黑色
];

/** 合法像素字符集合 */
export const VALID_CHARS = new Set([".", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]);

/** 字符 -> 索引（`.` 为 0，`1`-`f` 为 1-15） */
export function charToIndex(ch: string): number {
  return ch === "." ? 0 : parseInt(ch, 16);
}

/** 字符 -> RGBA 四元组 */
export function charToRGBA(ch: string): [number, number, number, number] {
  if (ch === ".") return [0, 0, 0, 0]; // 透明
  const hex = PALETTE[charToIndex(ch)] ?? PALETTE[0];
  const rgb = hex.slice(1, 7);
  return [parseInt(rgb.slice(0, 2), 16), parseInt(rgb.slice(2, 4), 16), parseInt(rgb.slice(4, 6), 16), 255];
}
