/**
 * §4 視覺規格。核心原則:疊層不得有自己的視覺個性,
 * 所有樣式從來源元素的 computed style 推導。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ProbedStyle {
  fontSizePx: number;
  lineHeightPx: number;
  sourceWeight: number;
  targetWeight: number;
  isSerif: boolean;
  sourceStack: string;
  color: string;
  textAlign: string;
  direction: string;
  fontStyle: string;
  padding: [number, number, number, number];
  border: [number, number, number, number];
  borderRadius: string;
  /** 取不到不透明實色 → 降級為標註樣式 (§3.5 / §4.1) */
  background: string | null;
  backgroundRisk: boolean;
}

export function parseColor(input: string): Rgb | null {
  const s = input.trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (v: string, scale: number): number =>
    v.endsWith('%') ? (Number.parseFloat(v) / 100) * scale : Number.parseFloat(v);
  const r = num(parts[0]!, 255);
  const g = num(parts[1]!, 255);
  const b = num(parts[2]!, 255);
  const a = parts[3] === undefined ? 1 : num(parts[3]!, 1);
  if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
  return { r, g, b, a };
}

export function rgbToCss(c: Rgb, alpha = 1): string {
  const to = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return alpha >= 1
    ? `rgb(${to(c.r)}, ${to(c.g)}, ${to(c.b)})`
    : `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${alpha})`;
}

/**
 * UA canvas 的顏色。parent chain 走到根都沒有實色時,畫面上其實是
 * 瀏覽器畫的 canvas,不是「取不到」——那是可知的,所以不走 fallback。
 * 真正的「取不到」是背景圖、漸層、backdrop-filter。
 */
function canvasColor(): string {
  const rootCs = getComputedStyle(document.documentElement);
  const scheme = rootCs.colorScheme || '';
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = scheme.includes('dark') && (prefersDark || !scheme.includes('light'));
  return dark ? 'rgb(18, 18, 18)' : 'rgb(255, 255, 255)';
}

/**
 * §4.1 從來源元素往上走 parent chain,取第一個 alpha > 0.05 的
 * background-color,以完整不透明度套用。半透明不提供旋鈕:底下是活文字,
 * 兩層字會互相干擾 (D04)。
 */
export function resolveBackground(el: Element): { color: string | null; risk: boolean } {
  let node: Element | null = el;
  while (node && node !== document.documentElement.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.backgroundImage !== 'none') return { color: null, risk: true };
    if (cs.backdropFilter && cs.backdropFilter !== 'none') return { color: null, risk: true };
    const c = parseColor(cs.backgroundColor);
    if (!c) return { color: null, risk: true };
    if (c.a > 0.05) return { color: rgbToCss(c, 1), risk: false };
    node = node.parentElement;
  }
  return { color: canvasColor(), risk: false };
}

/**
 * §4.2 依 font-family 判定襯線與否。
 *
 * PRD 的式子是 /serif|georgia|…/.test(ff) && !/sans-serif/.test(ff.split(',')[0]),
 * 但那個負向條件只看 stack 的第一項,所以世界上最常見的
 * `system-ui, -apple-system, sans-serif` 會因為字串裡含有 "serif"
 * 而被判成襯線。這裡先把 sans-serif 從整個 stack 抽掉再測襯線關鍵字,
 * 第一項的守衛保留(`sans-serif, Georgia` 仍然算非襯線)。
 */
export function isSerifStack(ff: string): boolean {
  const first = (ff.split(',')[0] ?? '').trim();
  const withoutSans = ff.replace(/sans-serif/gi, '');
  return (
    /serif|georgia|times|garamond|charter|freight/i.test(withoutSans) &&
    !/sans-serif/i.test(first)
  );
}

/**
 * §4.3 中文比同字重的西文視覺上重量不足,而譯文是閱讀主體,
 * 所以往重的方向調。
 */
export function targetWeight(sourceWeight: number, fontSizePx: number, offset: number): number {
  let off = offset;
  if (fontSizePx < 13.5) off = 0; // 小字級加重會糊
  if (sourceWeight >= 600) off = 0; // 避免頂到 700 上限、壓縮階層差
  return Math.min(700, Math.max(300, sourceWeight + off));
}

function px(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function probeStyle(el: Element, weightOffset: number): ProbedStyle {
  const cs = getComputedStyle(el);
  const fontSizePx = px(cs.fontSize) || 16;
  // line-height 'normal' 沒有 px 值可繼承;CJK 需要比拉丁的 ~1.2 稍鬆
  const lineHeightPx = cs.lineHeight === 'normal' ? fontSizePx * 1.28 : px(cs.lineHeight) || fontSizePx * 1.28;
  const sourceWeight = Number.parseInt(cs.fontWeight, 10) || 400;
  const bg = resolveBackground(el);
  return {
    fontSizePx,
    lineHeightPx,
    sourceWeight,
    targetWeight: targetWeight(sourceWeight, fontSizePx, weightOffset),
    isSerif: isSerifStack(cs.fontFamily),
    sourceStack: cs.fontFamily,
    color: cs.color,
    textAlign: cs.textAlign,
    direction: cs.direction,
    fontStyle: cs.fontStyle,
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
    borderRadius: cs.borderRadius,
    background: bg.color,
    backgroundRisk: bg.risk,
  };
}

/** §4.7 提示線顏色:頁面自身第一個 <a> 的 color;無連結時用文字色 + 40% 透明 */
let cachedHint: string | null = null;
export function hintColor(fallbackColor: string): string {
  if (cachedHint) return cachedHint;
  const a = document.querySelector('a[href]');
  if (a) {
    const c = parseColor(getComputedStyle(a).color);
    if (c && c.a > 0.05) {
      cachedHint = rgbToCss(c, 1);
      return cachedHint;
    }
  }
  const f = parseColor(fallbackColor);
  cachedHint = f ? rgbToCss(f, 0.4) : 'rgba(128,128,128,0.4)';
  return cachedHint;
}

export function resetHintColor(): void {
  cachedHint = null;
}
