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
  BOX_SCALE,
  LOW_CONFIDENCE,
  MIN_PATCH_FONT_PX,
  fontSizeFor,
  patchable,
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
  /** 疊字才有意義的字級 */
  fontPx: number;
  text: string;
  zh: string;
  /** 版面信心低於門檻:框線換警示色,提醒使用者自己看原圖 */
  low: boolean;
  vertical: boolean;
  /** 疊字(veil)還是編號錨點(pin)—— 唯一的量尺是字級 */
  kind: 'veil' | 'pin';
  /** pin 的編號,從 1 開始;veil 是 0 */
  n: number;
}

/**
 * 一組區塊 → 一組畫得出來的東西。
 *
 * **同一份資料在不同顯示尺寸下會得到不同結果**,而這正是設計的一部分
 * (`docs/plan-images.md` §2.3):繞圖的 340px 縮圖上全是錨點,
 * 點開放大檢視就自動鋪成疊字 —— 不必重問模型,只是換個 `box` 再算一次。
 */
export function placeBlocks(
  blocks: readonly ImageBlockLike[],
  drawn: Rect,
  clip: { w: number; h: number },
): PlacedBlock[] {
  // 第一輪:只算幾何。**這時候還不決定形式** —— 形式是整張圖的性質。
  const cand: {
    b: ImageBlockLike;
    r: Rect;
    label: string;
    chars: number;
    fontPx: number;
    fits: boolean;
  }[] = [];
  for (const b of blocks) {
    // code 樣式的字不加註:程式碼原樣留著才有用(§3.2)
    if (b.kind === 'code') continue;
    const r = mapBox(b.box, drawn, clip);
    if (!r) continue;
    const label = b.zh || b.text;
    if (label.length === 0) continue;
    // 譯完等於沒譯、或原文本來就是數字符號 —— 蓋上去只是遮住原圖
    if (!worthAnnotating(b.text, label)) continue;
    const chars = [...label].length;
    const fontPx = fontSizeFor(r.w, r.h, chars, b.v === true);
    cand.push({ b, r, label, chars, fontPx, fits: patchable(fontPx) });
  }
  if (cand.length === 0) return [];

  const mode = imageMode(cand.map((c) => c.fits));
  const out: PlacedBlock[] = [];
  let pin = 0;
  for (const c of cand) {
    const common = {
      text: c.b.text,
      zh: c.label,
      low: c.b.c < LOW_CONFIDENCE,
      vertical: c.b.v === true,
    };
    if (mode === 'pin') {
      pin++;
      out.push({ ...c.r, fontPx: c.fontPx, ...common, kind: 'pin', n: pin });
      continue;
    }
    /*
     * 疊字模式:少數塞不下的**把字級拉到下限,框不動**。
     *
     * 早一版是把框撐大到放得下 —— 那是「譯文站在玻璃上」時的做法。
     * 現在譯文有自己的貼片(overlay 的 `.itx`),貼片的寬度由字決定、
     * 而且允許長出框外(§3.2),所以撐大玻璃反而會蓋掉旁邊本來看得到的
     * 圖 —— 玻璃該蓋的只有原文那一塊。
     */
    out.push({
      ...c.r,
      fontPx: Math.max(c.fontPx, MIN_PATCH_FONT_PX),
      ...common,
      kind: 'veil',
      n: 0,
    });
  }
  return out;
}

/**
 * 疊字要佔多少比例,整張圖才走疊字。
 *
 * 不是調出來的數字,是「例外」的定義:七成以上塞得下,剩下的就是例外,
 * 把它們的框撐大比換一種語彙便宜。低於七成就反過來 —— 那張圖本來就是
 * 小字為主(截圖、密集表格),硬疊只會糊成一片。
 */
export const VEIL_MAJORITY = 0.7;

/**
 * 一張圖只能有一種加註語彙。
 *
 * 使用者回報的原話是「一下有疊字 一下註解 不太統一」。逐塊判斷在單看
 * 一塊時每次都是對的,合起來看卻是兩套視覺語言插在同一張圖上 ——
 * 讀圖的人得同時維持兩種閱讀模式。門檻本身沒錯,錯在**它的作用域**:
 * 量尺是字級(§2.3),但決定要落在整張圖上。
 */
export function imageMode(fits: readonly boolean[]): 'veil' | 'pin' {
  if (fits.length === 0) return 'veil';
  const ok = fits.filter(Boolean).length;
  return ok / fits.length >= VEIL_MAJORITY ? 'veil' : 'pin';
}


/** `placeBlocks` 只讀這幾個欄位,不必綁死整個 ImageBlock */
export interface ImageBlockLike {
  box: [number, number, number, number];
  text: string;
  zh: string;
  c: number;
  v?: boolean;
  kind?: 'text' | 'code';
}

/**
 * 游標落在哪個錨點上。
 *
 * 疊層是 `pointer-events: none`,所以**錨點自己收不到滑鼠事件** ——
 * 命中測試只能由 content script 拿座標算。這不是繞路,是那條硬規則
 * 的必然結果:頁面永遠比疊層先拿到事件。
 *
 * 半徑放寬到 14px:錨點畫出來只有 14px 寬,要求精準命中太苛。
 */
export const PIN_HIT_RADIUS = 14;

export function pinAt(
  placed: readonly PlacedBlock[],
  localX: number,
  localY: number,
): PlacedBlock | null {
  let best: PlacedBlock | null = null;
  let bestD = PIN_HIT_RADIUS * PIN_HIT_RADIUS;
  for (const p of placed) {
    if (p.kind !== 'pin') continue;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const d = (localX - cx) ** 2 + (localY - cy) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
