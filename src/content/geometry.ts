import { estimateLines } from './measure';
import { fontStack } from './fonts';
import { LETTER_SPACING_EM, STEPS, type Unit } from './unit';

/**
 * §3.3 幾何量測。座標一律轉成 document 座標,
 * 所以捲動不需要重算 (§3.4 / D02 的代價僅限重排)。
 */
export function measureUnit(unit: Unit): void {
  const r = unit.el.getBoundingClientRect();
  const rects = unit.el.getClientRects();
  const sx = window.scrollX;
  const sy = window.scrollY;
  unit.rect = { left: r.left + sx, top: r.top + sy, width: r.width, height: r.height };
  // §4.7 提示線對齊第一個 client rect 的頂端,不是 border-box 頂端
  const first = rects.length > 0 ? rects[0]! : r;
  unit.firstRectTop = first.top + sy;
  // §4.4 單行元素走另一條路
  unit.singleLine = r.height <= unit.style.lineHeightPx * 1.5;
}

function innerWidth(unit: Unit): number {
  const [, pr, , pl] = unit.style.padding;
  const [, br, , bl] = unit.style.border;
  return Math.max(1, unit.rect.width - pr - pl - br - bl);
}

function innerHeight(unit: Unit): number {
  const [pt, , pb] = unit.style.padding;
  const [bt, , bb] = unit.style.border;
  return Math.max(1, unit.rect.height - pt - pb - bt - bb);
}

/**
 * §6.2 長度預算。這是網頁疊層相對於圖片疊層的獨有槓桿:
 * 送出翻譯前就知道容器有多大 (D10)。
 * 事前控制長度比事後縮字級乾淨得多。
 */
export function computeMaxChars(unit: Unit): number {
  const s = unit.style;
  const perLine = Math.floor(innerWidth(unit) / (s.fontSizePx * 1.02));
  const lines = Math.max(1, Math.floor(innerHeight(unit) / s.lineHeightPx));
  // 留 8% 餘裕給標點與換行禁則
  const budget = Math.floor(perLine * lines * 0.92);
  return Math.max(8, budget);
}

function stepIndexFor(unit: Unit, text: string): { index: number; overflow: boolean } {
  const s = unit.style;
  const avail = innerHeight(unit);
  const width = innerWidth(unit);
  const family = fontStack(s.isSerif, s.sourceStack);
  for (let i = 0; i < STEPS.length; i++) {
    const size = s.fontSizePx * STEPS[i]!;
    const lines = estimateLines(text, width, s.fontStyle, s.targetWeight, size, family, LETTER_SPACING_EM);
    // §4.5 行高不隨字級縮放,維持原本的垂直節奏
    if (lines * s.lineHeightPx <= avail + 0.5) return { index: i, overflow: false };
  }
  // §4.4 到 0.80 仍容不下 → 允許垂直溢出,並在 debug mode 標記
  return { index: STEPS.length - 1, overflow: true };
}

/**
 * §4.4 字級:分組統一。字級決策以「排版角色」為單位,不是逐區塊——
 * 逐區塊各自貼合會造成整頁字級參差,完成度看起來很低 (D08)。
 * 級距刻意只有五級,連續縮放會讓每個網站長得不一樣。
 */
export function assignScales(units: Unit[]): void {
  const groups = new Map<number, Unit[]>();
  for (const u of units) {
    if (!u.translation) continue;
    if (u.singleLine) {
      // 一個長標題不該把整組正文都拖小 (D15)
      u.scale = 1;
      u.overflowing = false;
      continue;
    }
    u.sizeGroup = Math.round(u.style.fontSizePx);
    const bucket = groups.get(u.sizeGroup);
    if (bucket) bucket.push(u);
    else groups.set(u.sizeGroup, [u]);
  }
  for (const bucket of groups.values()) {
    let worst = 0;
    for (const u of bucket) {
      const { index, overflow } = stepIndexFor(u, u.translation!);
      u.overflowing = overflow;
      if (index > worst) worst = index;
    }
    // 取該組最壞情況的級距,整組統一套用
    const scale = STEPS[worst]!;
    for (const u of bucket) u.scale = scale;
  }
}
