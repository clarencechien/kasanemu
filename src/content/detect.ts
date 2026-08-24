import type { UnitRole } from '../shared/types';

/** §3.1 納入清單 */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
  'DD', 'DT', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY',
]);

/** §3.1 排除清單。script/style/svg 等本來也沒有可讀文字,一併擋掉子樹。 */
const EXCLUDE_TAGS = new Set([
  'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA',
  'CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT',
  'IFRAME', 'CANVAS', 'TEMPLATE', 'INPUT', 'OPTION', 'VIDEO', 'AUDIO', 'MATH',
]);

const EXCLUDE_SELECTOR =
  '[aria-hidden="true"],[contenteditable],[contenteditable=""],[translate="no"],.notranslate';

const BLOCKISH_DISPLAY = new Set(['block', 'flex', 'grid', 'list-item', 'flow-root', 'table-cell', 'table-caption']);

/**
 * 結構性 block 標籤。這些東西出現在候選元素底下,就代表這個候選是「容器」
 * 而不是「段落」—— 即使它的子孫因為隱形、已是中文之類的理由沒有產生單元,
 * 也不可以退而求其次把整個容器當成一個單元。
 *
 * 實際踩到的坑:Webflow 的捲動動畫讓整篇文章的 <p> 初始 opacity: 0,
 * 於是每一段都被跳過,最後整篇文章變成一個涵蓋全頁的巨大疊層。
 */
const CONTAINER_TAGS =
  'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td,th,caption,summary,' +
  'div,section,article,main,aside,header,footer,nav,ul,ol,dl,table,figure,form,details';

/**
 * 一個翻譯單元的字數上限。段落不會這麼長,超過就一定是容器誤判 ——
 * 最後一道防線,擋掉所有還沒想到的結構。
 */
export const MAX_UNIT_CHARS = 1000;

/**
 * 「這根本不是給人讀的文字」的標籤,它們的內容不得進入 src。
 *
 * 刻意**不含** code / kbd / samp:那些是行內的、給人讀的,只是不該被翻譯,
 * 要留在句子裡(L1 靠 prompt、L0 靠 §3.4 的佔位符保護)。
 * 把它們剝掉會讓「Call compute() before rendering.」變成
 * 「Call before rendering.」—— 語意破碎比沒保護還糟。
 * pre 則相反:它是整塊的程式碼區,混進父段落只會汙染譯文。
 */
const NON_TEXT_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME',
  'VIDEO', 'AUDIO', 'MATH', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'PRE',
]);

const ROLE_BY_TAG: Record<string, UnitRole> = {
  H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  SUMMARY: 'heading',
  LI: 'list', DT: 'list',
  TD: 'cell', TH: 'cell', CAPTION: 'cell',
  FIGCAPTION: 'meta', DD: 'meta', SMALL: 'meta', TIME: 'meta',
};

export interface Candidate {
  el: Element;
  role: UnitRole;
  src: string;
  /** 來源元素含浮動子孫,bounding box 會蓋住圖片 (§3.5) */
  geometryRisk: boolean;
}

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LETTER = /\p{L}/u;

export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * 只收「這個元素真的會被讀到」的文字。
 *
 * 不能用 el.textContent:那會把 <style> / <script> 的內容一起吃進來。
 * 實際踩到的坑是 Webflow 在 body 內散佈 <style>,於是 CSS 原始碼被當成文章
 * 送去翻譯,頁面頂端出現一行
 * 「在多個作者之間添加 comman .blog_author_wrap > div…」。
 */
export function ownText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    // 用 nodeType 而不是 instanceof:content script 與測試環境的
    // Element 不是同一個 realm 的建構子
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.nodeValue ?? '';
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const kid = node as Element;
    if (NON_TEXT_TAGS.has(kid.tagName)) continue;
    out += ownText(kid);
  }
  return out;
}

/**
 * 底下還有帶文字的結構性 block → 這是容器,不是段落。
 * 只在準備建立單元時才呼叫,所以不會對整頁跑一遍。
 */
export function hasContainerChild(el: Element): boolean {
  for (const kid of Array.from(el.querySelectorAll(CONTAINER_TAGS))) {
    if (EXCLUDE_TAGS.has(kid.tagName)) continue;
    if ((kid.textContent ?? '').trim().length > 0) return true;
  }
  return false;
}

/**
 * §3.2 語言判定:以 Unicode script 比例判斷,不呼叫語言偵測 API。
 * 對 PRD 的一處收斂:漢字比例高但假名也出現時視為日文,仍然翻譯。
 * 純看漢字比例會讓所有日文頁面被誤判成「已是中文」。
 */
export function looksLikeTargetLang(text: string): boolean {
  let han = 0;
  let kana = 0;
  let visible = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    visible++;
    if (HAN.test(ch)) han++;
    else if (KANA.test(ch)) kana++;
  }
  if (visible === 0) return true;
  if (kana / visible > 0.05) return false;
  return han / visible > 0.3;
}

/** §3.1 純數字、純符號、長度 < 2 一律排除 */
export function isMeaningfulText(text: string): boolean {
  if (text.length < 2) return false;
  if (!LETTER.test(text)) return false;
  return true;
}

function isInvisible(cs: CSSStyleDeclaration): boolean {
  return (
    cs.display === 'none' ||
    cs.visibility === 'hidden' ||
    cs.visibility === 'collapse' ||
    Number(cs.opacity) === 0
  );
}

function roleOf(el: Element, cs: CSSStyleDeclaration): UnitRole {
  const byTag = ROLE_BY_TAG[el.tagName];
  if (byTag) return byTag;
  if (Number.parseFloat(cs.fontSize) >= 24 && Number.parseInt(cs.fontWeight, 10) >= 600) return 'heading';
  return 'body';
}

function hasFloatDescendant(el: Element): boolean {
  // 只看有繪製面積的候選子孫,深度限制避免大子樹掃描成本
  const kids = el.querySelectorAll('img,figure,picture,svg,video,aside,div,span');
  for (let i = 0; i < kids.length && i < 24; i++) {
    const k = kids[i]!;
    const f = getComputedStyle(k).float;
    if (f === 'left' || f === 'right') return true;
  }
  return false;
}

interface WalkCtx {
  seen: (el: Element) => boolean;
  out: Candidate[];
  root: Element;
}

/**
 * §3.1 巢狀規則:一路往下找到「沒有其他 block 候選子孫」的 block 元素,
 * 那才是一個翻譯單元。這樣 <div><p>…</p><p>…</p></div> 會產生兩個單元
 * 而不是一個巨大的 div 單元,同時一句話被 <a>/<em>/<span> 切碎時
 * 仍然整段一起翻。
 */
function walk(el: Element, ctx: WalkCtx): boolean {
  if (EXCLUDE_TAGS.has(el.tagName)) return false;
  if (el.matches(EXCLUDE_SELECTOR)) return false;
  // 無文字的子樹直接剪掉,省下大量 getComputedStyle。
  // 這裡用 textContent 是刻意的:只是剪枝,精確的文字晚一點用 ownText 取。
  if (!(el.textContent ?? '').trim()) return false;

  const cs = getComputedStyle(el);
  if (isInvisible(cs)) return false;
  // §3.5 sticky / fixed 元素捲動時疊層會脫位,跳過該元素及其子樹
  if (cs.position === 'sticky' || cs.position === 'fixed') return false;

  let produced = false;
  for (const child of Array.from(el.children)) {
    if (walk(child, ctx)) produced = true;
  }
  if (produced) return true;

  const blockish = BLOCK_TAGS.has(el.tagName) || BLOCKISH_DISPLAY.has(cs.display);
  if (!blockish) return false;
  // 子孫沒產生單元不代表可以退而求其次把容器整個吃下來
  if (hasContainerChild(el)) return false;

  const text = normalizeText(ownText(el));
  if (!isMeaningfulText(text)) return false;
  // 最後一道防線:段落不會有一千字
  if (text.length > MAX_UNIT_CHARS) return false;
  if (looksLikeTargetLang(text)) return false;
  if (ctx.seen(el)) return true; // 已建立過單元,視為已命中,不重複
  if (el.getClientRects().length === 0) return false;

  ctx.out.push({ el, role: roleOf(el, cs), src: text, geometryRisk: hasFloatDescendant(el) });
  return true;
}

export function findCandidates(root: Element, seen: (el: Element) => boolean): Candidate[] {
  const out: Candidate[] = [];
  walk(root, { seen, out, root });
  return out;
}
