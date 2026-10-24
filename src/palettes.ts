import type { Grid } from "./types.js";

/** 每张图可用 15 个不透明色（字符 1..f）+ 1 个透明色（字符 .） */
export const PALETTE_SLOT_COUNT = 15;

export interface Palette {
  /** 稳定标识（预设名或 custom） */
  name: string;
  /** 展示名 */
  label?: string;
  /** 15 个不透明色，#RRGGBB；字符 1..f 依次对应 */
  colors: string[];
}

export type RGB = [number, number, number];

export const DEFAULT_PALETTE_NAME = "default";

/**
 * 预设调色板。
 * 注意：槽位顺序只影响字符语义；换板时默认按 RGB 最近色重映射。
 */
export const PRESET_PALETTES: Record<string, Palette> = {
  default: {
    name: "default",
    label: "默认",
    colors: [
      "#FFFFFF", "#FF2121", "#FF93C4", "#FF8135", "#FFF609",
      "#249CA3", "#78DC52", "#003FAD", "#87F2FF", "#8E2EC4",
      "#A4839F", "#5C406C", "#E5CDC4", "#91463D", "#000000",
    ],
  },
  gameboy: {
    name: "gameboy",
    label: "Game Boy",
    colors: [
      "#0B1A0B", "#10240F", "#163014", "#1C3C18", "#234A1D",
      "#2A5722", "#316727", "#39752C", "#418431", "#4A9336",
      "#5DA23F", "#6FB24B", "#82C158", "#95D066", "#A8E070",
    ],
  },
  nes: {
    name: "nes",
    label: "NES",
    colors: [
      "#000000", "#FCFCFC", "#BCBCBC", "#7C7C7C", "#A4E4FC",
      "#3CBCFC", "#0078F8", "#0000FC", "#B8B8F8", "#6888FC",
      "#0058F8", "#F8B8F8", "#F878F8", "#F85898", "#F83800",
    ],
  },
  pastel: {
    name: "pastel",
    label: "马卡龙",
    colors: [
      "#FFD1DC", "#FFE5B4", "#FFF5BA", "#D4F0F0", "#C1E1C1",
      "#B5EAD7", "#AEC6CF", "#C3B1E1", "#E6C9E6", "#F7C6C7",
      "#FDE2E4", "#E2ECE9", "#BEE1E6", "#DFE7FD", "#CDEAC0",
    ],
  },
  monochrome: {
    name: "monochrome",
    label: "灰度",
    colors: [
      "#000000", "#111111", "#222222", "#333333", "#444444",
      "#555555", "#666666", "#777777", "#888888", "#999999",
      "#AAAAAA", "#BBBBBB", "#CCCCCC", "#DDDDDD", "#FFFFFF",
    ],
  },
  sepia: {
    name: "sepia",
    label: "复古棕",
    colors: [
      "#1A120B", "#2B1D10", "#3D2A16", "#4F371C", "#614423",
      "#735127", "#85602D", "#976E33", "#A97D39", "#BB8B3F",
      "#C99A4E", "#D6AA62", "#E0BA7A", "#EAD09A", "#F5E6C8",
    ],
  },
  neon: {
    name: "neon",
    label: "霓虹",
    colors: [
      "#FF00FF", "#00FFFF", "#00FF00", "#FFFF00", "#FF0000",
      "#FF6600", "#FF0099", "#9900FF", "#00FF99", "#66FF00",
      "#00CCFF", "#FF33CC", "#CCFF00", "#00FFCC", "#FFCC00",
    ],
  },
  warm: {
    name: "warm",
    label: "暖色",
    colors: [
      "#FFF3E0", "#FFE0B2", "#FFCC80", "#FFB74D", "#FFA726",
      "#FF9800", "#FB8C00", "#F57C00", "#EF6C00", "#E65100",
      "#D84315", "#BF360C", "#8D2B0B", "#5D1E08", "#2E0F04",
    ],
  },
  cool: {
    name: "cool",
    label: "冷色",
    colors: [
      "#E0F7FA", "#B2EBF2", "#80DEEA", "#4DD0E1", "#26C6DA",
      "#00BCD4", "#00ACC1", "#0097A7", "#00838F", "#006064",
      "#1A237E", "#283593", "#303F9F", "#3949AB", "#3F51B5",
    ],
  },
};

export const PRESET_ORDER: string[] = [
  "default", "gameboy", "nes", "pastel", "monochrome", "sepia", "neon", "warm", "cool",
];

export const DEFAULT_PALETTE: Palette = PRESET_PALETTES[DEFAULT_PALETTE_NAME];

export function clonePalette(p: Palette): Palette {
  return { name: p.name, ...(p.label ? { label: p.label } : {}), colors: [...p.colors] };
}

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

export function normalizeHex(hex: string): string {
  return `#${hex.slice(1).toUpperCase()}`;
}

/** 返回 null 表示合法 */
export function validatePaletteColors(colors: unknown): string | null {
  if (!Array.isArray(colors) || colors.length !== PALETTE_SLOT_COUNT) {
    return `调色板必须正好 ${PALETTE_SLOT_COUNT} 个不透明色（另有 1 个透明色）`;
  }
  for (let i = 0; i < colors.length; i++) {
    if (!isHexColor(colors[i])) return `第 ${i + 1} 个颜色必须是 #RRGGBB，收到 ${String(colors[i])}`;
  }
  return null;
}

/**
 * 解析会话里保存的调色板引用。
 * - 有合法 colors 时以此为准（自定义/冻结的预设）
 * - 否则按 name 找预设
 * - 都没有则回退默认
 */
export function resolvePalette(ref: unknown): Palette {
  if (!ref || typeof ref !== "object") return clonePalette(DEFAULT_PALETTE);
  const r = ref as { name?: unknown; colors?: unknown };
  if (Array.isArray(r.colors) && validatePaletteColors(r.colors) === null) {
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "custom";
    const preset = PRESET_PALETTES[name];
    return {
      name,
      label: preset?.label ?? (name === "custom" ? "自定义" : name),
      colors: r.colors.map((c) => normalizeHex(String(c))),
    };
  }
  if (typeof r.name === "string" && PRESET_PALETTES[r.name]) {
    return clonePalette(PRESET_PALETTES[r.name]);
  }
  return clonePalette(DEFAULT_PALETTE);
}

/** 会话里应该保存的引用（预设也带上 colors，避免预设将来变化影响旧会话） */
export function paletteRef(p: Palette): { name: string; label?: string; colors: string[] } {
  return { name: p.name, ...(p.label ? { label: p.label } : {}), colors: [...p.colors] };
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** 亮度加权 RGB 距离（0..255） */
export function rgbDistance(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
}

/** 字符 -> RGB；透明或非法字符返回 null */
export function charToRgb(ch: string, palette: Palette): RGB | null {
  if (ch === ".") return null;
  const idx = parseInt(ch, 16);
  if (!Number.isFinite(idx) || idx < 1 || idx > PALETTE_SLOT_COUNT) return null;
  const hex = palette.colors[idx - 1];
  return hex ? hexToRgb(hex) : null;
}

/** 给定 RGB，返回当前调色板中最接近的槽位与颜色 */
export function nearestColor(rgb: RGB, palette: Palette): { char: string; rgb: RGB; index: number } {
  let best = 1;
  let bestD = Infinity;
  let bestRgb: RGB = hexToRgb(palette.colors[0] ?? "#000000");
  for (let i = 0; i < palette.colors.length; i++) {
    const candidate = hexToRgb(palette.colors[i]);
    const d = rgbDistance(rgb, candidate);
    if (d < bestD) {
      bestD = d;
      best = i + 1;
      bestRgb = candidate;
    }
  }
  return { char: best.toString(16), rgb: bestRgb, index: best };
}

/** 给定 RGB，返回当前调色板中最接近的字符（1..f） */
export function nearestChar(rgb: RGB, palette: Palette): string {
  return nearestColor(rgb, palette).char;
}

/** 把一张网格从 from 调色板按最近色重映射到 to 调色板（透明保持不变） */
export function remapGrid(grid: Grid, from: Palette, to: Palette): Grid {
  const rows = grid.rows.map((row) =>
    row.map((ch) => {
      const rgb = charToRgb(ch, from);
      return rgb ? nearestChar(rgb, to) : ch;
    }),
  );
  return { rows };
}

/** 给前端展示的精简信息 */
export function paletteInfo(p: Palette): { name: string; label: string; colors: string[] } {
  return { name: p.name, label: p.label ?? p.name, colors: [...p.colors] };
}

/**
 * 组图自动调色板：第一张用会话调色板，其余按预设顺序轮换。
 * 用于用户只勾选“组图”但没有逐张指定调色板时。
 */
export function rotatePalettes(sessionPalette: Palette, count: number): Palette[] {
  const n = Math.max(1, Math.floor(count));
  const rotate = PRESET_ORDER.filter((name) => name !== sessionPalette.name);
  return Array.from({ length: n }, (_, i) =>
    i === 0
      ? clonePalette(sessionPalette)
      : resolvePalette({ name: rotate[(i - 1) % rotate.length] }),
  );
}
