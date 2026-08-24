import { estimateLines, measureInkHeight } from './measure';
import { bleedFor } from './bleed';
import { fontStack } from './fonts';
import { LETTER_SPACING_EM, STEPS, activeText, type DocRect, type Unit } from './unit';
import { maxCharsAt } from './upgrade';

/**
 * §3.3 幾何量測。座標一律轉成 document 座標,
 * 所以捲動不需要重算 (§3.4 / D02 的代價僅限重排)。
 */
/**
 * 疊層該蓋住的範圍,document 座標。
 *
 * **量測與驗證必須用同一個函式**:measureUnit 存的是取過 max 的高度,
 * 而 auditPositions 若拿原始的 border-box 去比,那 62 個「內容比盒子高」的
 * 區塊會永遠被判定成漂移 → 重排 → 再判定,每 600ms 空轉一次。
 * (實際發生過:診斷 log 被 dh≈7.5 / dx=0 / dy=0 的 position-drift 洗版。)
 */
export function coverRect(unit: Unit): { rect: DocRect; overflows: boolean } {
  const r = unit.el.getBoundingClientRect();
  const el = unit.el as HTMLElement;
  const [bt, br, bb, bl] = unit.style.border;
  // 原文的內容可能比自己的 border-box 大:固定 height + overflow: visible,
  // 或子元素有負 margin。照 border-box 蓋就會漏(標題底下露出半個 g)。
  const contentH = (el.scrollHeight || 0) + bt + bb;
  const contentW = (el.scrollWidth || 0) + bl + br;
  return {
    rect: {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: Math.max(r.width, contentW),
      height: Math.max(r.height, contentH),
    },
    overflows: contentH > r.height + 1 || contentW > r.width + 1,
  };
}

export function measureUnit(unit: Unit, extraBleedPx = 0): void {
  const r = unit.el.getBoundingClientRect();
  const rects = unit.el.getClientRects();
  const sx = window.scrollX;
  const sy = window.scrollY;
  /*
   * 原文的內容可能比自己的 border-box 還大:元素設了固定 height 或
   * max-height 而 overflow 是 visible、或子元素有負 margin。
   * getBoundingClientRect() 只給 border-box,照它蓋就會漏 ——
   * 症狀是標題底下露出半個 g。scrollHeight / scrollWidth 是內容尺寸,
   * 取兩者的大者才蓋得住。
   *
   * §10.1:這幾個都是 layout 讀取,但和上面的 getBoundingClientRect()
   * 在同一個讀取批次裡,layout 已經是 clean 的,不會多觸發一次 reflow。
   */
  const cover = coverRect(unit);
  unit.rect = cover.rect;
  unit.overflowsBox = cover.overflows;
  // §4.7 提示線對齊第一個 client rect 的頂端,不是 border-box 頂端
  const first = rects.length > 0 ? rects[0]! : r;
  unit.firstRectTop = first.top + sy;
  // §4.4 單行元素走另一條路
  unit.singleLine = r.height <= unit.style.lineHeightPx * 1.5;
  // 原文的墨水可能超出 border-box(緊排標題),疊層要跟著往外撐
  const ink = measureInkHeight(
    unit.style.fontStyle,
    unit.style.sourceWeight,
    unit.style.fontSizePx,
    unit.style.sourceStack,
  );
  unit.bleed = bleedFor(ink, unit.style.lineHeightPx, extraBleedPx, unit.role);
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
  return maxCharsAtSize(unit, unit.style.fontSizePx);
}

/**
 * feature.md §4.4 / D20:L1 的 maxChars 以「L0 譯文所在容器在鎖定字級下的容量」
 * 計算,而不是以來源幾何。這樣 L1 譯文多數情況根本不會超出,
 * 長度預算從排版工具升級成替換穩定性工具。
 */
export function maxCharsForUpgrade(unit: Unit): number {
  const size = unit.lockedFontSize > 0 ? unit.lockedFontSize : unit.style.fontSizePx * unit.scale;
  return maxCharsAtSize(unit, size);
}

function maxCharsAtSize(unit: Unit, fontSizePx: number): number {
  return maxCharsAt(innerWidth(unit), innerHeight(unit), fontSizePx, unit.style.lineHeightPx);
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
    // feature.md §4.4 / D19:鎖定過的區塊不再參與分組,
    // 否則單一段落的 L1 替換會把整組正文的字級一起拖小
    if (u.lockedFontSize > 0) continue;
    const text = activeText(u);
    if (text === undefined) continue;
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
      const { index, overflow } = stepIndexFor(u, activeText(u) ?? '');
      u.overflowing = overflow;
      if (index > worst) worst = index;
    }
    // 取該組最壞情況的級距,整組統一套用
    const scale = STEPS[worst]!;
    for (const u of bucket) u.scale = scale;
  }
}

/**
 * feature.md §4.4 規則 1:字級分組在 L0 全部完成時定案並鎖定。
 * 之後 L1 替換只讓個別區塊垂直溢出,不動整組。
 */
export function lockScales(units: Unit[]): number {
  let locked = 0;
  for (const u of units) {
    if (u.lockedFontSize > 0) continue;
    if (activeText(u) === undefined) continue;
    u.lockedFontSize = u.style.fontSizePx * u.scale;
    locked++;
  }
  return locked;
}

/**
 * feature.md §4.4 規則 3:只有 resize、字型載入完成、SPA 換路由、
 * 使用者手動重新翻譯才解鎖重算。
 */
export function unlockScales(units: Iterable<Unit>): void {
  for (const u of units) u.lockedFontSize = 0;
}

/** 替換後個別區塊是否溢出(鎖定字級下),只用來在 debug 標記 */
export function checkOverflow(unit: Unit): boolean {
  const text = activeText(unit);
  if (text === undefined) return false;
  const size = unit.lockedFontSize > 0 ? unit.lockedFontSize : unit.style.fontSizePx * unit.scale;
  const family = fontStack(unit.style.isSerif, unit.style.sourceStack);
  const lines = estimateLines(
    text,
    innerWidth(unit),
    unit.style.fontStyle,
    unit.style.targetWeight,
    size,
    family,
    LETTER_SPACING_EM,
  );
  return lines * unit.style.lineHeightPx > innerHeight(unit) + 0.5;
}
