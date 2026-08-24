import type { UnitRole } from '../shared/types';

/**
 * 出血(bleed):把疊層盒子往外撐一點,好蓋住原文超出 border-box 的墨水。
 *
 * 為什麼需要:`getBoundingClientRect()` 給的是 **border-box**,而字的墨水範圍
 * 由字型的 ascent / descent 決定。當 `line-height` 小於墨水高度(緊排的大標
 * 常見,claude.com/blog 的 h1 就是),第一行的頂端與最後一行的 descender
 * 會落在 box 外面 —— 疊層精準貼合 border-box,那兩截就露出來,
 * 看起來像「蓋不乾淨」:標題上方一排小點、下方孤零零一個 g 的尾巴。
 *
 * 這裡不是猜一個固定值往外加,而是用字型度量算出**實際超出多少**:
 * 溢出量 = 墨水高度 − 行高,上下各一半。line-height 正常的段落算出來是 0,
 * 完全不會動到相鄰疊層。
 */
export interface Bleed {
  x: number;
  y: number;
}

/** 沒有量到字型度量時的保守估計:多數西文字型的墨水高約 1.16 em */
export const FALLBACK_INK_RATIO = 1.16;

export function inkOverflow(inkHeightPx: number, lineHeightPx: number): number {
  return Math.max(0, inkHeightPx - lineHeightPx) / 2;
}

/**
 * @param inkHeightPx  一行文字的墨水高度(fontBoundingBoxAscent + Descent)
 * @param lineHeightPx 來源元素的 computed line-height
 * @param extraPx      使用者在 options 加的固定出血,對付 text-shadow、
 *                     斜體尾巴、次像素捨入這類量不到的東西
 * @param role         表格儲存格左右緊貼鄰居,水平方向不出血 ——
 *                     蓋掉相鄰資料比露出一點點更糟(PRD §14 開放問題 5)
 */
export function bleedFor(
  inkHeightPx: number,
  lineHeightPx: number,
  extraPx: number,
  role: UnitRole,
): Bleed {
  const vertical = Math.ceil(inkOverflow(inkHeightPx, lineHeightPx)) + extraPx;
  const horizontal = role === 'cell' ? 0 : extraPx;
  return { x: Math.max(0, horizontal), y: Math.max(0, vertical) };
}
