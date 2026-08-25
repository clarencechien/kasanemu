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

/*
 * `getComputedStyle()` 不保證回 rgb()。
 *
 * 這一條是在 ClickHouse 部落格上學到的,而且代價是一整輪。Tailwind v4 會
 * 針對廣色域螢幕多輸出一份 `lab()`:
 *
 *   .rich-text-light { --heading-color: #fff; --paragraph-color: #dfdfdf; }
 *   @supports (color: lab(0% 0 0)) {
 *     .rich-text-light { --paragraph-color: lab(88.8292% 0 -.0000119209); }
 *   }
 *
 * 標題留在 `#fff`,內文變成 `lab(...)`。舊的 parseColor 只認得 rgb/rgba,
 * 於是內文的 color 解析失敗 → `lightText()` 回 false → 判定「這是淺色頁面」
 * → 挑了白底,配上頁面自己的淺灰字,整段看不見。
 * **同一頁的標題正常、內文全白**,而那個對比正是線索:差別不在版面,
 * 在顏色的寫法。
 *
 * 教訓:別用正規表示式去追 CSS 的顏色語法(lab / oklab / oklch / color() /
 * color-mix() / 相對顏色…,而且還會再增加)。瀏覽器本來就會算,問它就好。
 * 1×1 canvas 畫一次讀一個像素,任何它認得的顏色都能轉成 sRGB。
 */
const colorMemo = new Map<string, Rgb | null>();
let probeCtx: CanvasRenderingContext2D | null | undefined;

function colorProbe(): CanvasRenderingContext2D | null {
  if (probeCtx !== undefined) return probeCtx;
  probeCtx = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probeCtx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    probeCtx = null;
  }
  return probeCtx;
}

/**
 * 認不得的字串會讓 `fillStyle` **保持原值**,而不是丟錯 ——
 * 所以用兩個哨兵色:兩次都「沒變」才是真的認不得
 * (輸入剛好等於某一個哨兵的情況會被另一個抓到)。
 */
function paintable(ctx: CanvasRenderingContext2D, input: string): boolean {
  for (const sentinel of ['#ff00ff', '#00ff00']) {
    ctx.fillStyle = sentinel;
    ctx.fillStyle = input;
    if (ctx.fillStyle !== sentinel) return true;
  }
  return false;
}

function parseViaCanvas(input: string): Rgb | null {
  const ctx = colorProbe();
  if (!ctx) return null;
  try {
    if (!paintable(ctx, input)) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = input;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const a = (d[3] ?? 0) / 255;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a };
  } catch {
    return null;
  }
}

export function parseColor(input: string): Rgb | null {
  const s = input.trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const num = (v: string, scale: number): number =>
        v.endsWith('%') ? (Number.parseFloat(v) / 100) * scale : Number.parseFloat(v);
      const r = num(parts[0]!, 255);
      const g = num(parts[1]!, 255);
      const b = num(parts[2]!, 255);
      const a = parts[3] === undefined ? 1 : num(parts[3]!, 1);
      if (![r, g, b, a].some((v) => Number.isNaN(v))) return { r, g, b, a };
    }
  }
  // 慢路徑:交給瀏覽器。同一頁不同的顏色字串數量有限,記下來就好
  const hit = colorMemo.get(s);
  if (hit !== undefined) return hit;
  const out = parseViaCanvas(s);
  // 一頁裡不同的顏色字串是個位數到數十個;上限只是防呆
  if (colorMemo.size < 500) colorMemo.set(s, out);
  if (out === null) unparsed.add(s);
  return out;
}

/**
 * 連瀏覽器都不認得(或這個環境沒有 canvas)的顏色字串。
 * 診斷報告會帶上這一份 —— 「顏色解析失敗」原本是完全沉默的失敗,
 * 而沉默的失敗要靠使用者截圖才看得見。
 */
const unparsed = new Set<string>();

export function unparsedColors(): string[] {
  return [...unparsed].slice(0, 8);
}

export function resetColorCache(): void {
  colorMemo.clear();
  unparsed.clear();
  probeCtx = undefined;
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

/** 把 src 以 source-over 疊在 dst 上 */
export function over(src: Rgb, dst: Rgb): Rgb {
  const a = src.a + dst.a * (1 - src.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (s: number, d: number): number => (s * src.a + d * dst.a * (1 - src.a)) / a;
  return { r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a };
}

/** stack 由近而遠(index 0 是元素自己);先鋪最遠的,再一層層疊上來 */
export function composite(stack: Rgb[], base: Rgb): Rgb {
  let out = base;
  for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i]!, out);
  return out;
}

/**
 * §4.1 從來源元素往上走 parent chain,解出**畫面上實際看到的**背景色,
 * 再以完整不透明度套用。半透明不提供旋鈕:底下是活文字,
 * 兩層字會互相干擾 (D04)。
 *
 * 「解出實際看到的顏色」和舊版的「取第一個 alpha > 0.05 的顏色」不一樣,
 * 而那個差別在深色頁面上是致命的。ClickHouse 部落格的卡片寫
 * `background-color: rgba(255, 255, 255, 0.1)`,疊在近黑色的頁面上 ——
 * 畫面上是深灰。舊版看到 alpha 0.1 > 0.05,就把它當成「找到了」,
 * 以**全不透明的白**畫出去:深色頁面上冒出一塊刺眼的白底,
 * 配上頁面自己的淺灰字,等於看不見。使用者的原話是「選色錯誤了」。
 *
 * 半透明層不是答案,是**答案的一部分** —— 要一路收集到不透明的那一層
 * (或 UA canvas)才能合成出真正的顏色。
 */
export function resolveBackground(el: Element): { color: string | null; risk: boolean } {
  const stack: Rgb[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.backgroundImage !== 'none') return { color: null, risk: true };
    if (cs.backdropFilter && cs.backdropFilter !== 'none') return { color: null, risk: true };
    const c = parseColor(cs.backgroundColor);
    // 認不得的顏色語法(oklab / color-mix 的計算值)—— 不猜
    if (!c) return { color: null, risk: true };
    // 不透明:底定了,把沿路收集的半透明層疊回去
    if (c.a >= 0.999) return { color: rgbToCss(composite(stack, c), 1), risk: false };
    if (c.a > 0.004) stack.push(c);
    node = node.parentElement;
  }
  const base = parseColor(canvasColor()) ?? { r: 255, g: 255, b: 255, a: 1 };
  return { color: rgbToCss(composite(stack, base), 1), risk: false };
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

/**
 * 取不到不透明背景時,**依文字顏色的亮度**挑一個。
 *
 * §4.1 原本的降級是固定的標註樣式(淺藍底 + 褐字)。那條規則的理由是
 * 「不要猜」—— 但固定用淺色底**本身就是一種猜**,而且在深色版面上猜錯得
 * 很難看:ARK 電子報的深藍底橫幅上冒出一塊淺藍色方塊配橘字,
 * 使用者的原話是「選色也有點怪怪的,不是選藍底嗎?」
 *
 * 文字顏色是我們**確定**知道的東西,而它必然與背景有對比。
 * 白字 → 底一定是深的;深字 → 底一定是淺的。這個推論比「假設頁面是淺色」
 * 可靠得多,而且在深色橫幅、深色模式、彩色卡片上都成立。
 */
export function backgroundForText(color: string): string {
  return lightText(color) ? 'rgb(20, 24, 29)' : 'rgb(246, 248, 250)';
}

/** 文字本身是亮的 → 它底下的版面必然是深的 */
export function lightText(color: string): boolean {
  const c = parseColor(color);
  if (!c) return false;
  return (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255 > 0.6;
}

/*
 * §4.6 標註樣式的配色。
 *
 * 這一組顏色是**刻意**與頁面不同的 —— 標註的意思是「這是我加上去的,
 * 不是原本就有的」,所以它需要自己的識別。但「有識別」不等於「寫死」:
 * 淺藍底配褐字在淺色頁面上是恰到好處的便條紙,在 ClickHouse 那種
 * 近黑色的版面上就是一塊刺眼的白斑。
 *
 * 兩套配色,對比度相當,依頁面明暗擇一。
 */
export function annotBg(textColor: string): string {
  return lightText(textColor) ? 'rgba(24, 31, 40, 0.94)' : 'rgba(230, 241, 251, 0.94)';
}

export function annotFg(textColor: string): string {
  return lightText(textColor) ? '#F0A868' : '#993C1D';
}

/** 這個節點自己有沒有非空白的文字子節點 */
function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && (node.nodeValue ?? '').trim().length > 0) return true;
  }
  return false;
}

/**
 * 真正把字畫出來的那個元素。
 *
 * `<li><a>Introduction</a></li>` 的墨水顏色是 `<a>` 的(目次是黃字),
 * 但單元建在 `<li>` 上 —— 照 `<li>` 的 computed color 畫就變成白字。
 * 同一份目次裡,包著子清單那一項的單元剛好落在 `<a>` 上(見
 * detect.ts 的 captureInlineText),於是**一份目次裡兩種顏色**,
 * 使用者的原話是「有些有黃字 有些有白字 不是相同 class 嗎」。
 *
 * class 一樣,我們問的元素不一樣。文字整段裝在單一子元素裡的時候,
 * 就往下問到那一層為止 —— 有直接文字節點就停(段落裡夾一個連結時,
 * 主色仍然是段落的)。
 *
 * **只取顏色。** padding / border / 圓角要留給單元自己那個盒子,
 * 混用會讓譯文相對原文位移(`<a class="block py-1">` 有上下內距,
 * 它的 `<li>` 沒有)。
 */
function inkSource(el: Element): Element {
  let node = el;
  // 四層夠了:再深就不是「整段裝在一個元素裡」,是我們認錯了
  for (let i = 0; i < 4; i++) {
    if (hasDirectText(node)) break;
    const kids = node.children;
    if (kids.length !== 1) break;
    node = kids[0]!;
  }
  return node;
}

export function probeStyle(el: Element, weightOffset: number): ProbedStyle {
  const cs = getComputedStyle(el);
  const ink = inkSource(el);
  const color = ink === el ? cs.color : getComputedStyle(ink).color;
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
    color,
    textAlign: cs.textAlign,
    direction: cs.direction,
    fontStyle: cs.fontStyle,
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
    borderRadius: cs.borderRadius,
    // 取不到就依文字亮度挑一個對比色,不要固定用淺色底(見 backgroundForText)
    background: bg.color ?? backgroundForText(color),
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
