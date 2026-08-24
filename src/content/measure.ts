import { FALLBACK_INK_RATIO } from './bleed';

/**
 * §10.1 量測不得逐塊 reflow。
 * canvas.measureText 完全在 DOM 之外,不觸發 layout。
 */
const canvasEl = document.createElement('canvas');
const ctx2d = canvasEl.getContext('2d');

const widthCache = new Map<string, number>();
const inkCache = new Map<string, number>();

function fontShorthand(style: string, weight: number, sizePx: number, family: string): string {
  return `${style} ${weight} ${sizePx}px ${family}`;
}

export function measureTextWidth(
  text: string,
  style: string,
  weight: number,
  sizePx: number,
  family: string,
): number {
  if (!ctx2d) return text.length * sizePx * 0.98; // 拿不到 2d context 時的粗估
  const font = fontShorthand(style, weight, sizePx, family);
  const key = `${font} ${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  ctx2d.font = font;
  const w = ctx2d.measureText(text).width;
  if (widthCache.size < 4000) widthCache.set(key, w);
  return w;
}

/**
 * 一行文字的墨水高度(ascent + descent)。
 * 用來算出原文超出 border-box 多少 —— 見 bleed.ts。
 * 同樣走 canvas,不碰 DOM、不觸發 layout。
 */
export function measureInkHeight(
  style: string,
  weight: number,
  sizePx: number,
  family: string,
): number {
  const font = fontShorthand(style, weight, sizePx, family);
  const hit = inkCache.get(font);
  if (hit !== undefined) return hit;
  let ink = sizePx * FALLBACK_INK_RATIO;
  if (ctx2d) {
    ctx2d.font = font;
    // 取一串同時有 ascender、descender、大寫與 CJK 的字,量這個字型的行盒
    const m = ctx2d.measureText('Hxgÿ字');
    const a = m.fontBoundingBoxAscent;
    const d = m.fontBoundingBoxDescent;
    if (Number.isFinite(a) && Number.isFinite(d) && a + d > 0) ink = a + d;
  }
  if (inkCache.size < 200) inkCache.set(font, ink);
  return ink;
}

/**
 * 中文幾乎逐字可斷行,所以「總寬度 / 可用寬度」是夠好的行數估計。
 * letter-spacing 由呼叫端加回來,canvas 不套 letter-spacing。
 */
export function estimateLines(
  text: string,
  availWidth: number,
  style: string,
  weight: number,
  sizePx: number,
  family: string,
  letterSpacingEm: number,
): number {
  if (availWidth <= 1) return 1;
  const base = measureTextWidth(text, style, weight, sizePx, family);
  const spacing = text.length * letterSpacingEm * sizePx;
  return Math.max(1, Math.ceil((base + spacing) / availWidth));
}

export function clearMeasureCache(): void {
  widthCache.clear();
  inkCache.clear();
}
