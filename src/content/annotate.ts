/**
 * 加翻層的放置策略(docs/plan-annotation.md §4.2)。
 *
 * 純函式、不碰 DOM:這是整個功能唯一有邊界條件的部分(四個方向 + 視窗夾取),
 * 也是**圖片翻譯要重用的那一塊** —— 圖片裡的一塊文字就是一個帶正規化子矩形
 * 的錨點,放置規則換成 patch,其他完全相同。
 */

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * 錨點。`sub` 是錨點矩形內的正規化子矩形 [x, y, w, h],
 * 給圖片用(視覺模型回傳的座標是相對於圖片的比例)。
 */
export interface Anchor {
  rect: ViewRect;
  sub?: [number, number, number, number];
}

export type PlaceMode = 'chip' | 'patch';

/** 貼片與來源之間的間距 */
const GAP = 4;
/** 夾回視窗時保留的邊距 */
const EDGE = 6;

export function resolveAnchor(anchor: Anchor): ViewRect {
  const { rect, sub } = anchor;
  if (!sub) return rect;
  const [x, y, w, h] = sub;
  return {
    left: rect.left + x * rect.width,
    top: rect.top + y * rect.height,
    width: w * rect.width,
    height: h * rect.height,
  };
}

function clampToViewport(r: ViewRect, viewport: Size): ViewRect {
  const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, viewport.width - r.width - EDGE));
  const top = Math.min(Math.max(EDGE, r.top), Math.max(EDGE, viewport.height - r.height - EDGE));
  return { left, top, width: r.width, height: r.height };
}

function fits(r: ViewRect, viewport: Size): boolean {
  return (
    r.left >= EDGE &&
    r.top >= EDGE &&
    r.left + r.width <= viewport.width - EDGE &&
    r.top + r.height <= viewport.height - EDGE
  );
}

/**
 * 決定貼片畫在哪裡。座標是**視窗座標**(position: fixed)。
 *
 * chip:依序試下、上、右、左,第一個完整放得進視窗的就用;
 * 都不行才夾回視窗內。**永遠不會回傳蓋在錨點上的矩形** ——
 * 那就變成疊翻,而加翻的第一條原則是不蓋原文。
 *
 * patch:就是要蓋在錨點上(圖片裡的一塊字),只夾視窗。
 */
export function place(
  anchor: Anchor,
  chip: Size,
  viewport: Size,
  mode: PlaceMode = 'chip',
  avoid: readonly ViewRect[] = [],
): ViewRect {
  const a = resolveAnchor(anchor);
  if (mode === 'patch') {
    return clampToViewport({ left: a.left, top: a.top, width: chip.width, height: chip.height }, viewport);
  }

  const midY = a.top + (a.height - chip.height) / 2;
  const candidates: ViewRect[] = [
    // 下方,左緣對齊 —— 最自然的閱讀順序:先看標籤,視線往下就是譯文
    { left: a.left, top: a.top + a.height + GAP, width: chip.width, height: chip.height },
    { left: a.left, top: a.top - chip.height - GAP, width: chip.width, height: chip.height },
    { left: a.left + a.width + GAP, top: midY, width: chip.width, height: chip.height },
    { left: a.left - chip.width - GAP, top: midY, width: chip.width, height: chip.height },
  ];
  const inView = candidates.filter((c) => fits(c, viewport));
  // 先找「放得進視窗**而且**不撞到已經放好的貼片」的方向
  for (const c of inView) if (!hits(c, avoid)) return c;

  /*
   * 撞不開的話往下推。Alt 掃視時一整條導覽列的貼片都在同一個 Y,
   * 譯文比原文短所以多半不會撞,真的撞了就疊成兩層,而不是互相蓋住。
   */
  if (inView.length > 0) {
    const base = inView[0]!;
    for (let i = 1; i <= 4; i++) {
      const pushed = { ...base, top: base.top + i * (chip.height + 2) };
      if (fits(pushed, viewport) && !hits(pushed, avoid)) return pushed;
    }
    return base;
  }

  /*
   * 四個方向都放不進視窗(視窗很小、或標籤貼著角落)。
   * 夾回視窗,但夾完之後仍然要避開錨點本身,
   * 否則會蓋住它自己在解釋的那個標籤。
   */
  const below = clampToViewport(candidates[0]!, viewport);
  const above = clampToViewport(candidates[1]!, viewport);
  /*
   * 視窗矮到連「標籤 + 間距 + 貼片」都放不下時,兩邊都會蓋到標籤 ——
   * 那是幾何上無解,不是策略問題。這時取蓋得比較少的那一邊,
   * 而且無論如何都留在視窗內(跑到摺線下就等於沒有)。
   */
  return overlapArea(above, a) < overlapArea(below, a) ? above : below;
}

function overlapArea(a: ViewRect, b: ViewRect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function hits(r: ViewRect, avoid: readonly ViewRect[]): boolean {
  for (const o of avoid) if (overlaps(r, o)) return true;
  return false;
}

export function overlaps(a: ViewRect, b: ViewRect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/**
 * 譯文長度預算。
 *
 * 和內文不同:貼片的寬度是內容決定的,沒有幾何上限,所以這裡限的是**簡潔**,
 * 不是「塞不塞得下」。UI 標籤翻成中文通常只要原文一半的字數,
 * 給太多預算會讓模型把「Settings」翻成「設定與偏好選項」。
 */
export function labelBudget(src: string): number {
  return Math.max(6, Math.round(src.length * 0.6));
}
