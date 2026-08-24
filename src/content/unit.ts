import type { UnitRole } from '../shared/types';
import type { ProbedStyle } from './styleprobe';

export type UnitStatus = 'new' | 'queued' | 'done' | 'failed' | 'skipped';

export interface DocRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Unit {
  id: string;
  el: Element;
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
  /** §4.7 提示線對齊第一個 client rect 的頂端 */
  firstRectTop: number;
  status: UnitStatus;
  failReason?: string;
  translation?: string;
  /** §7.1 IntersectionObserver 決定翻譯順序 */
  inView: boolean;
  /** §4.4 到 0.80 仍容不下 → 允許垂直溢出,debug mode 標記 */
  overflowing: boolean;
  box?: HTMLDivElement;
  hint?: HTMLDivElement;
}

export const STEPS = [1.0, 0.95, 0.9, 0.85, 0.8] as const;
export const LETTER_SPACING_EM = 0.015;
