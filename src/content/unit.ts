import type { UnitKind, UnitRole, UnitTier } from '../shared/types';
import type { ProbedStyle } from './styleprobe';

export interface DocRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Unit {
  id: string;
  el: Element;
  /**
   * 這個單元用哪一種畫法(docs/plan-annotation.md)。
   * block = 不透明覆蓋、常駐;label = 旁邊的貼片、暫態。
   * 兩者共用 L0 → L1 管線、快取與 id 紀律,只有渲染與觸發不同。
   */
  kind: UnitKind;
  role: UnitRole;
  src: string;
  style: ProbedStyle;
  /** §3.5 bounding box 會蓋住浮動圖片 → 跳過該單元 */
  geometryRisk: boolean;
  /** §4.6 標註樣式 (背景取色失敗或使用者指定) */
  annotation: boolean;
  /** §4.4 單行元素:不加入字級分組,允許橫向溢出 (D15) */
  singleLine: boolean;
  /** §4.4 依 computed font-size 四捨五入分組 */
  sizeGroup: number;
  scale: number;
  maxChars: number;
  rect: DocRect;
  /** 疊層往外撐多少才蓋得住原文的墨水(見 bleed.ts) */
  bleed: { x: number; y: number };
  /** 原文的內容比自己的 border-box 大(固定高度 + overflow: visible) */
  overflowsBox: boolean;
  /** §4.7 提示線對齊第一個 client rect 的頂端 */
  firstRectTop: number;
  /**
   * 文字真正的最後一行底部(最後一個 client rect)。
   * 提示線用它,不能用 rect.height —— 那個為了蓋住溢出的墨水
   * 取了 max(border-box, scrollHeight),拿去畫線就會跑過頭。
   */
  lastRectBottom: number;
  /**
   * 譯文實際佔的高度(估算)。提示線用它。
   * 英文比中文長,原文區塊常常比譯文高一大截 —— 照原文高度畫線,
   * 線就會從譯文末尾繼續往下拖一段,看起來像壞掉。
   */
  textHeight: number;
  /** feature.md §4.1 區塊狀態機 */
  tier: UnitTier;
  failReason?: string;
  /** L0(Translator API)的譯文 */
  l0Text?: string;
  /** L1(Gemini / Gemma)的譯文 */
  l1Text?: string;
  /** 已排入 L1 佇列 */
  l1Queued: boolean;
  /** feature.md §4.2 排入佇列的時間,用來判斷是否卡住 */
  upgradeQueuedAt?: number;
  /**
   * feature.md §4.4 / D19 字級在 L0 完成時鎖定,L1 替換不重算分組。
   * 0 = 尚未鎖定(single 模式一直是 0,沿用 Phase 1 的每次重算)。
   */
  lockedFontSize: number;
  /** feature.md §4.2 第 2 條:進入可見區的時間戳,用來算停留時間 (D21) */
  inViewSince?: number;
  /** feature.md §4.3 等待替換的 L1 譯文(hover 中或剛捲動時延後) */
  pendingSwap?: string;
  /** §7.1 IntersectionObserver 決定翻譯順序 */
  inView: boolean;
  /** §4.4 到 0.80 仍容不下 → 允許垂直溢出,debug mode 標記 */
  overflowing: boolean;
  box?: HTMLDivElement;
  hint?: HTMLDivElement;
}

export const STEPS = [1.0, 0.95, 0.9, 0.85, 0.8] as const;
export const LETTER_SPACING_EM = 0.015;

/** 目前該顯示哪一份譯文。L1 在就用 L1,否則退回 L0。 */
export function activeText(u: Unit): string | undefined {
  return u.l1Text ?? u.l0Text;
}

/** 有沒有東西可以畫 */
export function hasText(u: Unit): boolean {
  return activeText(u) !== undefined;
}

/** 疊層實際採用的字級:鎖定後不再跟著分組變動 (§4.4) */
export function effectiveFontSize(u: Unit): number {
  return u.lockedFontSize > 0 ? u.lockedFontSize : u.style.fontSizePx * u.scale;
}
