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
  // 無文字的子樹直接剪掉,省下大量 getComputedStyle
  const raw = el.textContent ?? '';
  if (!raw.trim()) return false;

  const cs = getComputedStyle(el);
  if (isInvisible(cs)) return false;
  // §3.5 sticky / fixed 元素捲動時疊層會脫位,跳過該元素及其子樹
  if (cs.position === 'sticky' || cs.position === 'fixed') return false;

  let produced = false;
  for (const child of Array.from(el.children)) {
    if (walk(child, ctx)) produced = true;
  }
  if (produced) return true;

  const text = normalizeText(raw);
  const blockish = BLOCK_TAGS.has(el.tagName) || BLOCKISH_DISPLAY.has(cs.display);
  if (!blockish) return false;
  if (!isMeaningfulText(text)) return false;
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
