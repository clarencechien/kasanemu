/**
 * 圖片座標的換算 —— 純函式,不碰 DOM。
 *
 * 模型看到的是**點陣圖**,使用者看到的是**被 CSS 擺過的那個盒子**。
 * 兩者之間差著 `object-fit` 與 `object-position`:`cover` 會把圖裁掉一塊,
 * `contain` 會在旁邊留白。把 0–1000 的框直接乘上元素寬高,在這兩種情況下
 * 都會歪 —— 而網頁上的圖有一半是 `cover`(卡片縮圖、hero 圖)。
 *
 * 規格:`docs/plan-images.md` §4。
 */

// 副檔名是刻意的:node --experimental-strip-types 解不了無副檔名的**值**匯入,
// 而這個檔要被 node:test 直接載入(queuelogic.ts 因為同一個理由這樣寫)
import {
  BIG_CANVAS_W,
  BOX_SCALE,
  LOW_CONFIDENCE,
  MAX_PLATES,
  PLATE_BUDGET,
  TEXT_HEAVY_BLOCKS,
  fontSizeFor,
  plateSize,
  platesOverlap,
  worthAnnotating,
} from '../shared/imageblocks.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';

/**
 * `object-position` 的一個軸。CSS 的規則和 background-position 一樣:
 * 百分比 P 是「圖的 P% 對齊盒子的 P%」,所以位移是 `(盒 - 圖) × P`,
 * 長度則是直接的位移量。
 */
export interface PositionAxis {
  /** 0–1 的比例(百分比 / 關鍵字換算來的) */
  pct?: number;
  /** 絕對長度(px) */
  px?: number;
}

/** `getComputedStyle().objectPosition` 的一個軸 → PositionAxis */
export function parsePositionAxis(raw: string, axis: 'x' | 'y'): PositionAxis {
  const v = raw.trim().toLowerCase();
  if (v === 'center') return { pct: 0.5 };
  if (v === (axis === 'x' ? 'left' : 'top')) return { pct: 0 };
  if (v === (axis === 'x' ? 'right' : 'bottom')) return { pct: 1 };
  if (v.endsWith('%')) {
    const n = Number.parseFloat(v);
    return { pct: Number.isFinite(n) ? n / 100 : 0.5 };
  }
  const n = Number.parseFloat(v);
  // 單位不是 px 的(em/rem/vw)computed style 已經換算過了;真的看不懂就置中
  return Number.isFinite(n) && v.endsWith('px') ? { px: n } : { pct: 0.5 };
}

/** `objectPosition` 字串(computed 一定是兩個值)→ 兩軸 */
export function parsePosition(raw: string): { x: PositionAxis; y: PositionAxis } {
  const parts = raw.trim().split(/\s+/);
  const first = parts[0] ?? '50%';
  const second = parts[1] ?? '50%';
  return { x: parsePositionAxis(first, 'x'), y: parsePositionAxis(second, 'y') };
}

function offsetFor(box: number, drawn: number, p: PositionAxis): number {
  if (p.px !== undefined) return p.px;
  return (box - drawn) * (p.pct ?? 0.5);
}

/**
 * 點陣圖實際被畫在元素 content box 的哪裡。
 *
 * 回傳的是**元素本地座標**(左上角為原點),`cover` 時會是負值 / 超出盒子 ——
 * 那正是被裁掉的部分,呼叫端靠這個知道哪些框看不見。
 */
export function drawnRect(
  natural: { w: number; h: number },
  box: { w: number; h: number },
  fit: ObjectFit,
  pos: { x: PositionAxis; y: PositionAxis },
): Rect {
  const { w: nw, h: nh } = natural;
  if (nw <= 0 || nh <= 0 || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };

  let w: number;
  let h: number;
  switch (fit) {
    case 'fill':
      // 拉伸填滿:兩軸各自縮放,圖會變形 —— 框跟著變形是對的
      return { x: 0, y: 0, w: box.w, h: box.h };
    case 'none':
      w = nw;
      h = nh;
      break;
    case 'cover': {
      const s = Math.max(box.w / nw, box.h / nh);
      w = nw * s;
      h = nh * s;
      break;
    }
    case 'scale-down': {
      const s = Math.min(box.w / nw, box.h / nh, 1);
      w = nw * s;
      h = nh * s;
      break;
    }
    case 'contain':
    default: {
      const s = Math.min(box.w / nw, box.h / nh);
      w = nw * s;
      h = nh * s;
      break;
    }
  }
  return { x: offsetFor(box.w, w, pos.x), y: offsetFor(box.h, h, pos.y), w, h };
}

/**
 * 一塊 0–1000 的框 → 元素本地的 px 矩形。
 *
 * 被裁掉(`cover`)或落在留白區之外的框回 `null`:那一塊使用者根本看不到,
 * 畫上去就是憑空多出來的加註。部分可見的會被**裁到可見範圍**,
 * 因為加註要蓋在看得見的那半上。
 */
export function mapBox(
  boxNorm: readonly [number, number, number, number],
  drawn: Rect,
  clip: { w: number; h: number },
): Rect | null {
  if (drawn.w <= 0 || drawn.h <= 0) return null;
  const [y0, x0, y1, x1] = boxNorm;
  const left = drawn.x + (x0 / BOX_SCALE) * drawn.w;
  const top = drawn.y + (y0 / BOX_SCALE) * drawn.h;
  const right = drawn.x + (x1 / BOX_SCALE) * drawn.w;
  const bottom = drawn.y + (y1 / BOX_SCALE) * drawn.h;

  const cl = Math.max(0, left);
  const ct = Math.max(0, top);
  const cr = Math.min(clip.w, right);
  const cb = Math.min(clip.h, bottom);
  if (cr - cl < 1 || cb - ct < 1) return null;
  return { x: cl, y: ct, w: cr - cl, h: cb - ct };
}

/**
 * 這張圖值得問模型嗎。
 *
 * 顯示面積是門檻,不是原始尺寸:2042px 的圖縮在 120px 的縮圖格裡,
 * 上面的字使用者一個都讀不到,翻了也是白花錢。
 */
export const IMAGE_MIN_W = 200;
export const IMAGE_MIN_H = 100;

export function worthTranslating(rect: { w: number; h: number }): boolean {
  return rect.w >= IMAGE_MIN_W && rect.h >= IMAGE_MIN_H;
}

/* ----------------------------------------------------- 區塊 → 畫得出來的東西 */

/** 一塊加註在圖片本地座標上的最終樣子 */
export interface PlacedBlock {
  /** 相對圖片 content box 左上角的 px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 譯文實際會用的字級(有 MIN_PATCH_FONT_PX 的地板) */
  fontPx: number;
  text: string;
  zh: string;
  /** 版面信心低於門檻:毛玻璃染成警示色,提醒使用者自己看原圖 */
  low: boolean;
  vertical: boolean;
}

/** `placeBlocks` 的完整結果 —— 畫什麼,以及沒畫的有幾塊、為什麼 */
export interface Placement {
  placed: PlacedBlock[];
  /** 值得翻、但這個尺寸放不下的塊數。> 0 就值得給放大檢視的入口 */
  left: number;
  /**
   * 為什麼是這個結果:
   * - `'ok'` 正常,預算內能放多少放多少
   * - `'text-heavy'` 扣掉沒必要翻的還有一大堆 —— 這是文件不是圖,行內不畫
   * - `'nothing'` 沒有一塊需要翻
   */
  why: 'ok' | 'text-heavy' | 'nothing';
}

/**
 * 一組區塊 → 一組畫得出來的東西。
 *
 * **一張圖只有一種語彙,而且就是疊字**(§DW)。編號錨點退場了 ——
 * 使用者的話是「這樣標註幾乎是退場了 需要標註的 應該是另一個題目
 * 像 sukemu 的題目」:錨點解的是「字太小疊不下」,而那在**拍照翻譯**
 * 才是主場;網頁上的圖是別人排好版的,字小的那些多半也不重要。
 *
 * 取捨是「**只翻標題**」,而它有三道閘門,依框的大小由大到小加進來:
 *
 * 1. `MAX_PLATES` —— 最多幾塊。「標題」是個數量不是比例,和圖多大無關。
 * 2. `PLATE_BUDGET` —— 譯文佔畫面的比例,**小圖的保險絲**。
 * 3. 不與已選上的貼片重疊 —— 長標籤在字級地板上又寬又薄,
 *    面積很便宜卻橫著壓過旁邊兩塊(§13-9-ter)。
 *
 * 三道都是量出來的,而且**互相補位**:只有面積的那一版在 1102px 的
 * 產品截圖上疊了 21 塊(帳面才 13%),在 340px 的小圖表上一塊都放不下(§DX)。
 *
 * **同一份資料在不同顯示尺寸下會放下不同的塊數**,而這是設計的一部分:
 * 繞圖的縮圖只放得下標題,點開放大檢視就多出十幾塊 —— 不必重問模型。
 * 而語彙**永遠不會翻面**,這正是舊的多數決做不到的事。
 */
export function placeBlocks(
  blocks: readonly ImageBlockLike[],
  drawn: Rect,
  clip: { w: number; h: number },
  /** 行內的塊數上限(settings.imageMaxPlates)。大畫布自動放兩倍(§EA) */
  maxPlates: number = MAX_PLATES,
): Placement {
  const cand: { r: Rect; label: string; fontPx: number; b: ImageBlockLike }[] = [];
  for (const b of blocks) {
    // code 樣式的字不加註:程式碼原樣留著才有用(§3.2)
    if (b.kind === 'code') continue;
    const r = mapBox(b.box, drawn, clip);
    if (!r) continue;
    const label = b.zh || b.text;
    if (label.length === 0) continue;
    // 譯完等於沒譯、或原文本來就是數字符號 —— 蓋上去只是遮住原圖
    if (!worthAnnotating(b.text, label)) continue;
    cand.push({ r, label, fontPx: fontSizeFor(r.w, r.h, [...label].length, b.v === true), b });
  }
  if (cand.length === 0) return { placed: [], left: 0, why: 'nothing' };

  /*
   * **扣完還一堆 = 這是文件不是圖。**
   *
   * 行內不畫任何東西:網頁截圖、手機截圖蓋上十幾片玻璃只是把它變得更難讀。
   * 不是死路 —— 放大檢視照畫,那裡畫得下,而且是使用者自己點開的。
   */
  if (cand.length >= TEXT_HEAVY_BLOCKS && clip.w < DENSE_ZOOM_W) {
    return { placed: [], left: cand.length, why: 'text-heavy' };
  }

  const area = clip.w * clip.h;
  // 大的先進來:框的大小就是版面自己標好的重要性
  const order = [...cand].sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const placed: PlacedBlock[] = [];
  let used = 0;
  // 大畫布(放大檢視、站方 lightbox)是使用者自己點開的「我要讀」—— 放兩倍
  const cap = clip.w >= BIG_CANVAS_W ? maxPlates * 2 : maxPlates;
  for (const c of order) {
    // 「只要標題」是個數量,不是比例 —— 圖多大都一樣(§DX)
    if (placed.length >= cap) break;
    const pl = plateSize(c.label, c.fontPx);
    /*
     * 預算算**含光暈的**(那是畫面上最顯眼的部分),
     * 重疊判斷算**不含光暈的** —— 兩團光暈互相疊沒關係,字疊在一起才不行。
     */
    const box = {
      x: c.r.x + c.r.w / 2 - pl.boxW / 2,
      y: c.r.y + c.r.h / 2 - pl.boxH / 2,
      w: pl.boxW,
      h: pl.boxH,
    };
    // 跳過而不是中斷:放不下的是**這一塊**,後面比較小的還有機會
    if (used + (pl.w * pl.h) / area > PLATE_BUDGET) continue;
    if (taken.some((t) => platesOverlap(t, box))) continue;
    taken.push(box);
    used += (pl.w * pl.h) / area;
    placed.push({
      x: c.r.x,
      y: c.r.y,
      w: c.r.w,
      h: c.r.h,
      fontPx: pl.fs,
      text: c.b.text,
      zh: c.label,
      low: c.b.c < LOW_CONFIDENCE,
      vertical: c.b.v === true,
    });
  }
  return { placed, left: cand.length - placed.length, why: 'ok' };
}

/**
 * 密集的圖在**多寬以上**就照畫。
 *
 * 「這是文件不是圖」那條只擋行內。放大檢視把圖攤到視窗大小,
 * 預算換算出來放得下十幾塊,而且是使用者自己點開的 —— 他要讀。
 */
export const DENSE_ZOOM_W = 900;

/** `placeBlocks` 只讀這幾個欄位,不必綁死整個 ImageBlock */
export interface ImageBlockLike {
  box: [number, number, number, number];
  text: string;
  zh: string;
  c: number;
  v?: boolean;
  kind?: 'text' | 'code';
}
