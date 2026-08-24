import type { Pipeline, UnitTier } from '../shared/types';

/**
 * feature.md §4 升級管線的純判斷。
 * 刻意不碰 DOM、不 import 執行期模組 —— 這些是這個 feature 最容易寫錯
 * 也最需要被測到的規則。
 */

/** feature.md §4.2 第 2 條 / D21:可見且停留超過門檻才排入 L1 */
export function dwellReady(
  u: { tier: UnitTier; inView: boolean; inViewSince?: number; l1Queued: boolean },
  now: number,
  dwellMs: number,
  pipeline: Pipeline,
): boolean {
  if (pipeline !== 'progressive') return false;
  if (u.l1Queued) return false;
  if (!u.inView || u.inViewSince === undefined) return false;
  if (u.tier !== 'l0' && u.tier !== 'l0-failed') return false;
  return now - u.inViewSince >= dwellMs;
}

/** feature.md §4.2 佇列排序:距視窗中心越近越優先(數字越小越優先) */
export function priorityOf(
  rectTop: number,
  rectHeight: number,
  scrollY: number,
  viewportH: number,
): number {
  const center = scrollY + viewportH / 2;
  return Math.abs(rectTop + rectHeight / 2 - center);
}

/**
 * feature.md §4.3 不得替換使用者當前正在互動的區塊:
 * hover 中 → 等 mouseleave;在可見區中央三分之一且距上次捲動 < 400ms → 延後。
 */
export function swapAllowed(o: {
  isHovered: boolean;
  sinceScrollMs: number;
  rectTop: number;
  rectHeight: number;
  scrollY: number;
  viewportH: number;
}): boolean {
  if (o.isHovered) return false;
  if (o.sinceScrollMs >= 400) return true;
  const top = o.rectTop - o.scrollY;
  const bottom = top + o.rectHeight;
  const third = o.viewportH / 3;
  const inMiddleThird = bottom > third && top < third * 2;
  return !inMiddleThird;
}

/**
 * §6.2 / feature.md §4.4:容器能裝多少字。
 * L1 升級時 fontSizePx 傳鎖定字級,長度預算就從排版工具變成替換穩定性工具 (D20)。
 */
export function maxCharsAt(
  innerWidth: number,
  innerHeight: number,
  fontSizePx: number,
  lineHeightPx: number,
): number {
  const perLine = Math.floor(innerWidth / (fontSizePx * 1.02));
  const lines = Math.max(1, Math.floor(innerHeight / lineHeightPx));
  // 留 8% 餘裕給標點與換行禁則
  return Math.max(8, Math.floor(perLine * lines * 0.92));
}

/**
 * feature.md §5.1 / D22 提示線的階層色。
 * 這是安全需求不是美觀選項:L0 打底會讓 L1 的失敗變隱形,
 * 掃一眼就要能看出整頁是不是還停在 L0。
 */
export function hintClassFor(tier: UnitTier, hintLineOn: boolean): string | null {
  if (!hintLineOn) return null;
  switch (tier) {
    case 'l0':
      return 'l0'; // 連結色、虛線、更淡
    case 'l1':
      return 'l1'; // 連結色、實線(Phase 1 樣式)
    case 'l1-failed':
      return 'warn'; // 警示色、實線:有 L0 可讀,但升級管線死了
    case 'failed':
      return 'warn dashed'; // 警示色、虛線
    default:
      return null; // pending / l0-failed / skipped:還沒有結果,不畫
  }
}

/** feature.md §5.2:L1 一個都沒回來且佇列非空超過 10 秒 → 明確警示 */
export const STALL_MS = 10_000;
