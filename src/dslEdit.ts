import type { Palette } from "./palettes.js";

/** 用于判断手动编辑是否改动了 palette 声明（只比较名称与颜色） */
export function paletteSignature(palettes: Palette[] | undefined): string {
  return JSON.stringify((palettes ?? []).map((p) => [p.name, [...p.colors]]));
}

export type EditedPaletteResult =
  | { changed: false; palettes: Palette[] }
  | { changed: true; palettes: Palette[]; source: "session" | "explicit" }
  | { error: string };

/**
 * 手动编辑 DSL 后决定每张图使用什么调色板。
 *
 * 规则：
 * - palette 行未改动：保留当前每张图的调色板（不覆盖 UI 里改过的颜色）；
 * - 改为 0 个 palette：全部回到会话调色板；
 * - 改为 1 个 palette：单图或整组统一使用它；
 * - 改为与组图张数相同的多个 palette：按顺序一一对应；
 * - 其他数量：拒绝，避免静默错配。
 */
export function resolveEditedPalettes(
  oldPalettes: Palette[] | undefined,
  newPalettes: Palette[] | undefined,
  currentPalettes: Palette[],
  sessionPalette: Palette,
): EditedPaletteResult {
  if (paletteSignature(oldPalettes) === paletteSignature(newPalettes)) {
    return { changed: false, palettes: currentPalettes };
  }

  const next = newPalettes ?? [];
  if (next.length === 0) {
    return {
      changed: true,
      palettes: currentPalettes.map(() => sessionPalette),
      source: "session",
    };
  }
  if (next.length === 1) {
    return {
      changed: true,
      palettes: currentPalettes.map(() => next[0]),
      source: "explicit",
    };
  }
  if (next.length === currentPalettes.length) {
    return { changed: true, palettes: [...next], source: "explicit" };
  }

  const hint = currentPalettes.length === 1
    ? `单图最多只能有 1 个 palette（当前 ${next.length} 个）`
    : `组图共 ${currentPalettes.length} 张，palette 行必须为 0、1 或 ${currentPalettes.length} 个（当前 ${next.length} 个）`;
  return { error: hint };
}
