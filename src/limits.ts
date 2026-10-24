/** 全局像素限制 */
export const MIN_DIM = 4;
export const MAX_DIM = 256;

/** 一个 tile 的逻辑尺寸（UI/prompt 约定） */
export const TILE_SIZE = 16;

/** 旧版 CombinedTiles 的图块数量上限（仅旧格式） */
export const MAX_LEGACY_TILES = 16;

/** 单张 PNG 最长边上限，避免大画布 + 高倍率把内存打爆 */
export const MAX_RENDER_SIDE = 4096;

/** 两个 16×16 tile 相差多少像素以内算“相似”（不会自动合并） */
export const NEAR_TILE_DIFF = 4;
