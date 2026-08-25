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

/** 這一階是「翻不出來」的紅色狀態 */
export function isFailedTier(tier: UnitTier): boolean {
  return tier === 'failed' || tier === 'l1-failed' || tier === 'l0-failed';
}

/**
 * hover 是否該把這塊重新排隊。
 *
 * 只有紅的才重試,而且每塊有次數上限 —— 使用者滑鼠掃過一整片失敗的區塊
 * 不該變成一整批 L1 請求(那是要錢的)。真正壞掉的頁面重試也救不了,
 * 兩次之後就算了,別把帳單燒在同一塊上。
 */
export function hoverRetryReady(
  u: { tier: UnitTier; maxChars: number },
  attemptsUsed: number,
  max: number,
): boolean {
  if (!isFailedTier(u.tier)) return false;
  if (u.maxChars <= 0) return false;
  return attemptsUsed < max;
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
 * feature.md §4.3「不得替換使用者當前正在互動的區塊」。
 *
 * 規格的字面規則有個洞:它只保護 hover 中、以及「在中央三分之一**且**
 * 距上次捲動 < 400ms」的區塊。停著讀的時候沒有捲動,400ms 早就過了,
 * 於是正在讀的那一段會在眼前被換掉 —— 那正是 §4.3 標題要防的事,
 * 只是「互動」被寫成了「剛捲過」。
 *
 * 收斂成:**視線帶(可見區中央三分之一)內一律不換**,等它離開那一帶
 * 或使用者捲走再說。加上捲動中(< 400ms)一律不換,因為畫面本來就在動。
 *
 * 代價寫在明處:一直不捲動的話,那一段會停在 L0 直到你捲走。
 * 花了錢的 L1 譯文可能沒被看到 —— 這正是 §2.2 要量的
 * 「L0 讀完就沒再看 L1」的比例,代價本來就在規格的視野裡。
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
  // 捲動中畫面本來就在動,再換內容會更明顯
  if (o.sinceScrollMs < 400) return false;
  const top = o.rectTop - o.scrollY;
  const bottom = top + o.rectHeight;
  const third = o.viewportH / 3;
  // 視線帶:使用者正在讀的那一段,不動它
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

/**
 * 「跑完了沒」。
 *
 * 這一條先前是錯的:busy 的判準是「整頁還有 pending 的區塊」,
 * 而 progressive 只翻視窗上下各 1500px —— 長文章底下永遠有一堆
 * 還沒輪到的區塊,於是狀態列永遠停在「待翻 N」,永遠不會說完成、
 * 也永遠不會淡出。
 *
 * 沒捲到的區塊**不是「在等」,是「還沒要」**。所以:
 *  - busy:有請求在飛,或畫面上還有沒翻好的
 *  - screen-done:這一屏好了,但頁面下面還有沒翻的(捲下去會繼續)
 *  - all-done:整頁都處理完了
 */
export function translationPhase(s: {
  /** 已送出 L1、還沒回來 */
  waiting: number;
  /** 在畫面上、還沒有譯文 */
  nearPending: number;
  /** 不在畫面上、還沒輪到 */
  farPending: number;
  /** L0 還有呼叫在跑或在排隊 */
  l0Busy: boolean;
}): 'busy' | 'screen-done' | 'all-done' {
  if (s.waiting > 0 || s.nearPending > 0 || s.l0Busy) return 'busy';
  return s.farPending > 0 ? 'screen-done' : 'all-done';
}
