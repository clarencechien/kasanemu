import type { UnitRole } from '../shared/types';

/** §3.1 納入清單 */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
  'DD', 'DT', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY',
]);

/** §3.1 排除清單。script/style/svg 等本來也沒有可讀文字,一併擋掉子樹。 */
const EXCLUDE_TAGS = new Set([
  'FORM', 'BUTTON', 'SELECT', 'TEXTAREA',
  'CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT',
  'IFRAME', 'CANVAS', 'TEMPLATE', 'INPUT', 'OPTION', 'VIDEO', 'AUDIO', 'MATH',
]);

/**
 * 地標標籤。**不是排除清單** —— 和 CHROME_SELECTOR 同一級待遇:
 * 不畫常駐疊層,但 hover / 選取仍然翻得到。
 *
 * 它們原本在 EXCLUDE_TAGS 裡,結果同一份導覽用 `<nav>` 寫的比用
 * `<div role="navigation">` 寫的**待遇更差**:後者滑上去看得到,
 * 前者整棵消失。同一件事該有同一個答案。
 */
const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

/**
 * 排除的子樹。
 *
 * 前半是標準訊號(`aria-hidden`、`translate="no"`、`.notranslate`、
 * 以及搜尋引擎的 `robots-nocontent`)—— 頁面自己說了「這不是內容」。
 *
 * 後半是**以類別名稱猜**的分享 widget,和這個檔案其他規則的風格不同,
 * 所以刻意列窄:只收公認的外掛前綴,不用 `[class*="share"]` 那種
 * 會誤傷 `.shared-post` 的寬鬆比對。使用者的原話是
 * 「分享到 facebook 什麼的,這種就不用翻了」。
 */
/**
 * 應用程式的介面外殼(ARIA 地標與工具列角色)。
 *
 * 這是 `EXCLUDE_TAGS` 裡 NAV / HEADER / FOOTER / ASIDE 的 role 版本 ——
 * Gmail 這種單頁應用不用那些標籤,它用 `<div role="navigation">`。
 * 於是左側的「Mail」「Chat」「Meet」「Labels」變成內文單元被疊層蓋掉。
 *
 * 和 EXCLUDE_SELECTOR 的差別很重要:**這一層只擋疊翻,不擋加翻**。
 * 選單項目本來就是使用者可能想知道的東西(「有些是 menu 或是 link
 * 可能想知道」),所以滑上去、選起來仍然翻得到 ——
 * 不該被蓋掉的是版面,不是資訊。
 */
export const CHROME_SELECTOR =
  '[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],' +
  '[role="toolbar"],[role="menubar"],[role="menu"],[role="tablist"],[role="search"],' +
  '[role="tooltip"]';

export const EXCLUDE_SELECTOR =
  '[contenteditable],[contenteditable=""],[translate="no"],.notranslate,' +
  '.robots-nocontent,[class*="sharedaddy"],[class*="sd-sharing"],[class*="social-share"],' +
  '[class*="share-buttons"],[class*="addtoany"]';

/**
 * `aria-hidden="true"` **不等於看不見**。
 *
 * 這條規則以前寫在 EXCLUDE_SELECTOR 裡,結果是 anthropic.com 的主標題
 * 一個字都沒翻:
 *
 *   <h1 aria-label="Anthropic's approach to teaching and learning AI">
 *     <span class="word" aria-hidden="true">Anthropic's</span> …
 *
 * 這是逐字進場動畫的標準寫法 —— 把整句話放進 `aria-label` 給螢幕閱讀器,
 * 再把畫面上真正看得到的每一個字標成 `aria-hidden`,免得讀兩次。
 * 使用者的話是「這看起來是有點搞笑」:**整頁最大的那行字,
 * 因為對螢幕閱讀器隱藏,所以對眼睛也不翻了。**
 *
 * `aria-hidden` 的定義是「對輔助技術隱藏」,而 Kasanemu 疊的是**眼睛看到的東西**。
 * 兩者剛好相反。真正的「看不見」由 CSS 回答,而那個判斷本來就有
 * (`isInvisible` / sr-only / getClientRects)。
 *
 * 所以留下來的只有原本真正要擋的那一半:aria-hidden **而且畫面上也沒有**
 * —— Gmail 那個 `<div role="tooltip" aria-hidden="true">Download</div>`
 * 是 display:none 的,照樣擋得住。
 */
export function ariaHiddenSkip(el: Element): boolean {
  if (el.getAttribute('aria-hidden') !== 'true') return false;
  const cs = getComputedStyle(el);
  if (isInvisible(cs)) return true;
  // 沒有繪製面積 = 眼睛看不到,和 sr-only 同一個判準
  return el.getClientRects().length === 0;
}

/** 排除清單 + 「aria-hidden 而且真的看不見」 */
export function excluded(el: Element): boolean {
  return el.matches(EXCLUDE_SELECTOR) || ariaHiddenSkip(el);
}

/** 自己或任一祖先被排除(取代 `closest(EXCLUDE_SELECTOR)`) */
export function inExcluded(el: Element): boolean {
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (excluded(p)) return true;
  }
  return false;
}

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
 * 互動元素裡的**短**文字是 UI 標籤,不是內容。
 *
 * PRD §3.1 排除了 <button>,但沒排除 `<a class="button">` 這種連結型按鈕 ——
 * 「See pricing」「Contact sales」就是這樣被翻進來的,而按鈕又剛好是
 * 疊層最容易出事的地方(hover 位移、隱藏的行動版複本、輪播複製)。
 *
 * Margin(withmargin/margin-read)的做法更硬:導覽、表單、按鈕、widget
 * 整個不翻。這裡取中間值 —— 以**長度**分辨 UI 標籤與內容:
 * 卡片標題、文章裡的行內連結都是長文字,照翻;
 * 24 字以內的連結/按鈕當成 UI 元件,跳過。
 */
export const INTERACTIVE_SELECTOR =
  'a[href],button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="switch"],[role="option"]';
const UI_LABEL_MAX_CHARS = 24;

/**
 * 長度要量**看得見的文字**,不是 textContent。
 *
 * 分享按鈕的無障礙寫法是把長標籤藏在 `<span hidden>` 裡:
 *
 *   <a><span hidden>Share on Facebook (Opens in new window)</span><span>Facebook</span></a>
 *
 * textContent 是 47 字 → 超過 24 → 不算 UI 標籤 → 變成內文單元 →
 * 疊層把「分享至 Facebo…」蓋在分享列上。而畫面上其實只有「Facebook」8 個字。
 *
 * `skip` 是 walk() 沿路收集的 sr-only 元素;沒有傳的話退回 textContent,
 * 行為與舊版相同。
 */
function visibleTextOf(el: Element, skip?: ReadonlySet<Element>): string {
  return normalizeText(skip ? ownText(el, skip) : (el.textContent ?? ''));
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * `role="heading"` 掛在非 heading 標籤上,而且很短 —— 應用程式的區塊標題。
 * 真正的文章用 `<h1>`–`<h6>`。
 */
function isAppHeading(el: Element): boolean {
  if (el.getAttribute('role') !== 'heading') return false;
  if (HEADING_TAGS.has(el.tagName)) return false;
  return normalizeText(el.textContent ?? '').length <= UI_LABEL_MAX_CHARS;
}

const LIST_TAGS = new Set(['UL', 'OL']);

/**
 * 清單項目自己那一行的文字,**不含巢狀子清單**。
 *
 * 判斷「這是目次還是選單」要看項目本身有多長。用 textContent 會把子清單
 * 的文字一起算進去,`<li>Products<ul><li>A</li><li>B</li></ul></li>`
 * 這種下拉選單就會被誤判成內容。
 */
function listItemText(li: Element, skip?: ReadonlySet<Element>): string {
  let out = '';
  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.nodeValue ?? '';
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const kid = node as Element;
    if (kid.tagName === 'UL' || kid.tagName === 'OL') continue;
    if (NON_TEXT_TAGS.has(kid.tagName)) continue;
    if (skip?.has(kid)) continue;
    if (excluded(kid)) continue;
    out += ownText(kid, skip);
  }
  return normalizeText(out);
}

/**
 * 這個互動元素在**內容清單**裡,不是選單裡。
 *
 * ClickHouse 的目次是 `<ul><li><a>Introduction</a></li>…</ul>`,同一份清單裡
 * 「Introduction」12 字、「Count aggregations in ClickHouse and Elasticsearch」49 字。
 * 照 24 字門檻逐項判斷,短的變成要 hover 的貼片、長的變成常駐疊層 ——
 * 同一份目次一半翻一半不翻,使用者的原話是「有些不翻 有些翻」。
 *
 * 門檻本身沒有錯,錯在**逐項套用**。清單是一個整體:裡面只要有一項長到
 * 明顯是內容(文章標題、目次條目),整份清單就是內容,不是導覽列。
 * 反過來說,Gmail 左欄與一般網站的選單每一項都短,結論不變。
 */
function inContentList(act: Element, skip?: ReadonlySet<Element>): boolean {
  const item = act.closest('li');
  const parent = item?.parentElement;
  if (!item || !parent || !LIST_TAGS.has(parent.tagName)) return false;
  let list: Element = parent;
  /*
   * 巢狀清單要看**整棵樹**,不是自己那一層。
   *
   * 目次的子清單常常每一項都短(Summary / Storage size / Aggregation
   * performance),只看自己那一層就會判定成選單 —— 於是同一份目次
   * 上半部翻了、縮排進去的三項沒翻。它們是同一份目次的一部分,
   * 判斷也該是同一個。
   */
  for (
    let up = list.parentElement?.closest('ul,ol');
    up;
    up = up.parentElement?.closest('ul,ol')
  ) {
    list = up;
  }
  const items = list.querySelectorAll('li');
  if (items.length < 3) return false;
  for (const li of items) {
    if (li === item) continue;
    /*
     * 量**項目自己那一行**,不是只量它裡面的連結。
     *
     * 只量連結會漏掉這種形狀:
     *   <li><p><strong>Query ①</strong> — 這是對整個資料集的全資料掃描…</p>
     *       <ul><li><a>ClickHouse SQL query</a></li>…</ul></li>
     * 每個連結都 ≤24 字,可是整份清單顯然是內容 —— 使用者看到的是
     * 段落翻了、底下三個連結沒翻。長度的證據在項目上,不在連結上。
     */
    if (listItemText(li, skip).length > UI_LABEL_MAX_CHARS) return true;
  }
  return false;
}

export function isUiLabel(el: Element, skip?: ReadonlySet<Element>): boolean {
  /*
   * `<div role="heading">Mail</div>` —— 應用程式的區塊標題。
   *
   * 真正的文章用 `<h1>`–`<h6>`;把 role 掛在 div / span 上幾乎只出現在
   * 自繪的 UI(Gmail 左欄的 Mail / Chat / Meet / Labels 就是這樣寫的)。
   * 加上和其他 UI 標籤同一個長度上限,誤判的代價也只是
   * 「要滑上去才看得到譯文」,不是看不到。
   */
  if (el.getAttribute('role') === 'heading' && !HEADING_TAGS.has(el.tagName)) {
    if (visibleTextOf(el, skip).length <= UI_LABEL_MAX_CHARS) return true;
  }
  /*
   * 內容清單整份一起判定,不逐項套長度門檻。
   *
   * 傳 el 本身也成立:`<li>` 的 closest('li') 就是它自己,所以
   * 「連結」與「只包著連結的 li」兩條路徑共用同一個結論 ——
   * 少了這一點,目次的短條目會在下面那條「文字全來自互動子孫」的規則
   * 再一次被判成 UI 標籤。
   */
  if (inContentList(el, skip)) return false;
  const act = el.closest(INTERACTIVE_SELECTOR);
  if (act) return visibleTextOf(act, skip).length <= UI_LABEL_MAX_CHARS;
  /*
   * 自己不是互動元素,但文字**全部**來自互動子孫 —— 那是按鈕列 / 連結列,
   * 不是段落。段落裡夾一個行內連結不會命中:那時連結外面還有文字。
   */
  /*
   * 只算**看得見文字的**互動子孫。
   *
   * ClickHouse 的圖片儲存格裡有一顆放大按鈕,它的無障礙名稱在
   * `aria-label` 上、畫面上一個字都沒有。把它算進來會讓長度預算
   * 憑空多 24 字(`UI_LABEL_MAX_CHARS * actives.length`),
   * 而它連一個字都沒有貢獻 —— 預算應該跟著文字走,不是跟著節點走。
   */
  const actives = [...el.querySelectorAll(INTERACTIVE_SELECTOR)].filter(
    (a) => visibleTextOf(a, skip).length > 0,
  );
  if (actives.length === 0) return false;
  const total = visibleTextOf(el, skip);
  if (total.length > UI_LABEL_MAX_CHARS * actives.length) return false;
  let inside = 0;
  for (const a of actives) inside += visibleTextOf(a, skip).length;
  return inside >= total.length - 2;
}

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
  /** 自己佔一行的媒體子節點 —— 疊層要在這裡收住(見 mediaSplitOf) */
  mediaSplit?: Element;
  /** 在 sticky / fixed 的子樹裡:捲動時 document 座標會跑,先藏起來 */
  pinned?: boolean;
  /**
   * 這個單元蓋的不是整個元素,而是元素裡的一段行內內容(見 inlineRuns)。
   * 幾何一律問 Range,不問元素。
   */
  range?: Range;
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
export function ownText(el: Element, skip?: ReadonlySet<Element>): string {
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
    // 螢幕閱讀器標籤的文字不算數:視覺上不存在的字不該讓祖先變成翻譯單元
    if (skip?.has(kid)) continue;
    /*
     * 排除清單的文字也不算數。少了這一條,Gmail 塞在段落裡的下載按鈕
     * (唯一的文字是 `<div role="tooltip" aria-hidden="true">Download</div>`)
     * 會讓它的父層變成一個內容是「Download」的翻譯單元。
     * 這是 sr-only 那個坑的第四次:**認出來還不夠,祖先也要扣掉。**
     */
    if (excluded(kid)) continue;
    out += ownText(kid, skip);
  }
  return out;
}

/**
 * 底下還有帶文字的結構性 block → 這是容器,不是段落。
 * 只在準備建立單元時才呼叫,所以不會對整頁跑一遍。
 */
/**
 * 這個元素在畫面上真的有文字嗎(扣掉排除清單與 aria-hidden 的子樹)。
 *
 * `textContent` 會把不該算的東西一起吃進來。實例:Gmail 在每個含圖片的
 * `<p>` 裡塞一個下載按鈕 `<div class="a6S">`,裡面唯一的文字是
 * `<div role="tooltip" aria-hidden="true">Download</div>` ——
 * 於是 `hasContainerChild()` 判定那個 `<p>` 是「容器」,整段圖表註解就
 * 從來沒被翻過。回報的那段 Note 就是這樣消失的。
 */
export function hasContainerChild(el: Element): boolean {
  for (const kid of Array.from(el.querySelectorAll(CONTAINER_TAGS))) {
    if (EXCLUDE_TAGS.has(kid.tagName)) continue;
    if (excluded(kid)) continue;
    if (ownText(kid).trim().length > 0) return true;
  }
  return false;
}

/**
 * 底下有夠大的圖片 / 影片 —— 這是圖文混排的容器,不是段落。
 *
 * §3.5 已經處理過浮動圖片(bounding box 會蓋住它),但**不浮動的**圖片
 * 一樣會被蓋掉:ARK 電子報的 `<p><img 圖表><span>Note: …</span></p>`
 * 一旦被當成單元,不透明的疊層就把整張圖表蓋掉了。
 *
 * 門檻取 20×20:行內的小圖示不算,真的圖表才算。
 */
const MEDIA_TAGS = 'img,video,canvas,svg,picture,iframe';
const MEDIA_MIN_AREA = 400;

export function hasMediaChild(el: Element, includeSelf = false): boolean {
  if (includeSelf && el.matches(MEDIA_TAGS)) {
    const own = el.getBoundingClientRect();
    if (own.width * own.height >= MEDIA_MIN_AREA) return true;
  }
  const kids = el.querySelectorAll(MEDIA_TAGS);
  for (let i = 0; i < kids.length && i < 12; i++) {
    const r = kids[i]!.getBoundingClientRect();
    if (r.width * r.height >= MEDIA_MIN_AREA) return true;
  }
  return false;
}

/**
 * 帶著大圖、但圖片**自己佔一整行**的子節點。
 *
 * ClickHouse 的部落格每張圖都寫在段落裡:
 *
 *   <p>文字…<span class="relative flex w-full"><img …></span></p>
 *
 * `hasMediaChild()` 看到 <img> 就整段放棄,於是圖多的文章一半不翻 ——
 * 使用者的原話是「看起來文字跟著圖的 就不會翻」。可是這種版面上
 * 文字與圖片是**上下分開**的,疊層只要蓋到圖片之前就好。
 *
 * 三個條件缺一不可,少一個就會蓋到圖:
 *  1. 只有一處媒體(兩處以上表示文字被切成好幾段,單一矩形蓋不住)
 *  2. 它在第一個或最後一個(夾在中間同樣把文字切成兩段)
 *  3. 它自己佔一行(真正的行內圖片就在文字行裡,一定會被蓋到)
 */
export function mediaSplitOf(el: Element): Element | null {
  /*
   * 要走 childNodes,不是 children。
   *
   * 踩過一次:`<p>文字<span class="flex"><img></span>文字</p>` 的**元素**子節點
   * 只有那個 span,所以「它是第一個也是最後一個」成立,程式判定圖片靠在邊上 ——
   * 而畫面上圖片正夾在兩段文字中間。文字節點沒有元素身分,但它在版面上占位;
   * 量版面就不能只看元素。
   */
  const kids = Array.from(el.childNodes);
  const carries = (n: Node): boolean => {
    if (n.nodeType !== 1) return false;
    const kid = n as Element;
    return (
      kid.matches(MEDIA_TAGS) ||
      [...kid.querySelectorAll(MEDIA_TAGS)].some((m) => {
        const r = m.getBoundingClientRect();
        return r.width * r.height >= MEDIA_MIN_AREA;
      })
    );
  };
  const at = kids.map(carries);
  const first = at.indexOf(true);
  if (first < 0) return null;
  const last = at.lastIndexOf(true);
  /*
   * 頭尾**連續一段**都算,不是只有一個 —— ClickHouse 的圖表段落常常是
   * 「一段文字 + 兩張並排的圖」(Query ① 與 Query ②)。
   * 真正的條件是**文字沒有被圖切成兩半**。
   */
  for (let i = first; i <= last; i++) if (!at[i]) return null;
  const hasText = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      const n = kids[i]!;
      if (n.nodeType === 3) {
        if (normalizeText(n.nodeValue ?? '').length > 0) return true;
      } else if (n.nodeType === 1 && normalizeText((n as Element).textContent ?? '').length > 0) {
        return true;
      }
    }
    return false;
  };
  if (hasText(0, first) && hasText(last + 1, kids.length)) return null;
  // 每一塊都要自己佔一行,否則圖就在文字行裡
  for (let i = first; i <= last; i++) {
    if (!BLOCKISH_DISPLAY.has(getComputedStyle(kids[i] as Element).display)) return null;
  }
  // 邊界取靠近文字的那一端
  return (first === 0 ? kids[last] : kids[first]) as Element;
}

/**
 * el 自己的文字,**不含區塊子節點的**。
 *
 * `ownText()` 會一路遞迴下去,所以 `<li><a>標題</a><ul>…</ul></li>`
 * 拿到的是標題加上整份子清單。要判斷「這個容器自己還帶著一段文字嗎」,
 * 就得先把歸屬於子區塊的部分扣掉。
 */
function inlineOwnText(el: Element, skip?: ReadonlySet<Element>): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.nodeValue ?? '';
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const kid = node as Element;
    if (NON_TEXT_TAGS.has(kid.tagName)) continue;
    if (skip?.has(kid)) continue;
    if (excluded(kid)) continue;
    if (kid.matches(CONTAINER_TAGS)) continue;
    out += ownText(kid, skip);
  }
  return out;
}

/**
 * 整頁的字集(由 lang.ts 的 sniffScript 判定,start() 時設定一次)。
 *
 * 逐塊判斷「這塊是不是已經是中文」在日文頁面上會出錯:
 * 標題常常是純漢字、一個假名都沒有(「東京都知事選挙」),
 * 逐塊看就變成「漢字比例 100% → 已是中文 → 跳過」,
 * 於是日文站的標題全部不翻。整頁層級知道這是日文,那一塊就該翻。
 */
let pageScript: 'ja' | 'ko' | 'zh' | null = null;

export function setPageScript(s: 'ja' | 'ko' | 'zh' | null): void {
  pageScript = s;
}

/**
 * §3.2 語言判定:以 Unicode script 比例判斷,不呼叫語言偵測 API。
 * 對 PRD 的一處收斂:漢字比例高但假名也出現時視為日文,仍然翻譯。
 * 純看漢字比例會讓所有日文頁面被誤判成「已是中文」。
 */
export function looksLikeTargetLang(text: string, script = pageScript): boolean {
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
  // 整頁是日文 / 韓文時,漢字堆不是中文,是漢字詞
  if (script === 'ja' || script === 'ko') return false;
  return han / visible > 0.3;
}

/** §3.1 純數字、純符號、長度 < 2 一律排除 */
export function isMeaningfulText(text: string): boolean {
  if (text.length < 2) return false;
  if (!LETTER.test(text)) return false;
  return true;
}

/**
 * 螢幕閱讀器專用標籤(`.sr-only` / `.visually-hidden` / `.u-sr-only`)。
 *
 * 經典寫法是 `position:absolute; width:1px; height:1px; overflow:hidden;
 * clip:rect(0,0,0,0)` —— 對視覺使用者完全不存在,但 §3.1 的檢查全部漏掉它:
 * 不是 display:none、不是 visibility:hidden、opacity 是 1、
 * `getClientRects()` 還會回一個 1×1 的矩形,「有繪製面積」也過關。
 *
 * 實例(claude.com 的相關文章卡片):
 *   <a class="clickable_link"><span class="u-sr-only">Build production agents…</span></a>
 *
 * 疊層在這種元素上特別糟:1×1 的盒子配上 nowrap 的長句,
 * `scrollWidth` 是整句話的寬度,於是長出一條橫跨整張卡的譯文貼在卡片頂端。
 *
 * 判定看 computed style 的特徵,不看 class 名稱 —— 各家命名不同,行為一樣。
 */
function isScreenReaderOnly(el: Element, cs: CSSStyleDeclaration): boolean {
  const clip = cs.clip;
  if (clip && clip !== 'auto' && /rect\(\s*0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?\s*\)/.test(clip)) {
    return true;
  }
  const clipPath = cs.clipPath;
  if (clipPath && clipPath !== 'none' && /inset\(\s*(?:50|100)%/.test(clipPath)) return true;
  // 用 client rects 而不是 bounding box:inline 元素的 bounding box
  // 會把換行後的空白也算進去,client rects 才是真正畫出來的那幾塊
  const rects = el.getClientRects();
  let w = 0;
  let h = 0;
  for (const r of rects) {
    if (r.width > w) w = r.width;
    if (r.height > h) h = r.height;
  }
  // 幾乎沒有面積:蓋不蓋都沒有意義,而算出來的盒子只會亂跑
  return w <= 4 || h <= 4;
}

/**
 * 在收折的 `<details>` 裡面(而且不是它的 `<summary>`)。
 *
 * 使用者的觀察是對的:**打開跟關起來的 element 看起來長得一模一樣**。
 * `<p>` 上沒有任何屬性或 class 改變,computed style 的 display 與
 * visibility 也都不變 —— 現代 Chrome 用 `content-visibility: hidden`
 * 收折,而那會**保留佈局狀態**:
 *
 *   getBoundingClientRect() → 展開時的位置與大小(不是零!)
 *   getClientRects()        → 一樣有東西
 *   getComputedStyle()      → display: block, visibility: visible
 *
 * 也就是說,**所有量測都在說謊**,而且說得前後一致 ——
 * 所以座標稽核也抓不到漂移(診斷 log 裡 position-drift 是零筆)。
 * 這是前三輪一直修不好的原因:我一直在問「量到的值對不對」,
 * 但每一種量法都回同一個錯的值。
 *
 * 唯一誠實的來源是 DOM 本身:祖先有沒有一個沒帶 `open` 的 `<details>`。
 * 這不是啟發式,是規格定義的行為。
 */
export function hiddenByDisclosure(el: Element): boolean {
  let child: Element = el;
  for (let p = el.parentElement; p; child = p, p = p.parentElement) {
    // <summary> 在收折時仍然看得見,它的子孫也是
    if (p.tagName === 'DETAILS' && !p.hasAttribute('open') && child.tagName !== 'SUMMARY') {
      return true;
    }
  }
  return false;
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

/**
 * 外殼,還是內容?
 *
 * 地標標籤與 ARIA 角色是**版面上的位置**,不是內容的性質。文章的目次
 * 常常就放在 `<nav>` 或 `<aside>` 裡 —— ClickHouse 右側那份浮動目次是
 * 整篇文章的導覽,使用者的原話是「右邊的 table of contents 完全沒翻」。
 *
 * 分辨的方法和 §BX 的清單規則同一條:裡面有沒有長到明顯是內容的項目。
 * 目次有(「Count aggregations in ClickHouse and Elasticsearch」49 字),
 * Gmail 左欄沒有(每一項都 ≤24 字)。**同一個證據,同一個結論。**
 */
/**
 * 「裡面是目次就當內容」這個例外只給**導覽型**的地標。
 *
 * 站台頁首不是目次,永遠不是。而它的 mega menu 裡幾乎一定有一項長到
 * 超過 24 字(產品說明),於是 hasContentList() 一律成立 ——
 * 整個 sticky 頁首被當成內容,長出六個內文單元。
 * 例外要窄:目次會出現在 <nav> / <aside>,不會出現在 <header> / <footer>。
 */
const TOC_HOSTS = 'nav,aside,[role="navigation"],[role="complementary"]';

function isAppChrome(el: Element): boolean {
  if (!CHROME_TAGS.has(el.tagName) && !el.matches(CHROME_SELECTOR)) return false;
  if (!el.matches(TOC_HOSTS)) return true;
  return !hasContentList(el);
}

/** 底下有沒有「目次型」的清單:三項以上,而且至少一項長到不像選單 */
function hasContentList(el: Element): boolean {
  for (const list of el.querySelectorAll('ul,ol')) {
    const items = list.querySelectorAll('li');
    if (items.length < 3) continue;
    for (const li of items) {
      if (listItemText(li).length > UI_LABEL_MAX_CHARS) return true;
    }
  }
  return false;
}

interface WalkCtx {
  /**
   * 已認定為螢幕閱讀器專用的元素。
   *
   * walk 是先遞迴子節點、再評估自己,所以父層評估時這個集合已經填好了。
   * 沒有這一步的話,跳過 sr-only 的 <span> 只會把問題往上搬一層:
   * 包著它的 stretched link(覆蓋整張卡片的 <a>)接著變成翻譯單元,
   * 疊層就蓋掉整張圖 —— 實際發生過。
   */
  srOnly: Set<Element>;
  seen: (el: Element) => boolean;
  out: Candidate[];
  /** 這一趟已經建過單元的元素 —— seen() 只知道**上一趟**的結果 */
  made: Set<Element>;
  root: Element;
}

/**
 * §3.1 巢狀規則:一路往下找到「沒有其他 block 候選子孫」的 block 元素,
 * 那才是一個翻譯單元。這樣 <div><p>…</p><p>…</p></div> 會產生兩個單元
 * 而不是一個巨大的 div 單元,同時一句話被 <a>/<em>/<span> 切碎時
 * 仍然整段一起翻。
 */
function walk(el: Element, ctx: WalkCtx, pinned = false): boolean {
  if (EXCLUDE_TAGS.has(el.tagName)) return false;
  if (excluded(el)) return false;
  // 應用程式外殼:不蓋疊層,但 hover / 選取仍然翻得到(見 CHROME_SELECTOR)
  if (isAppChrome(el)) return false;
  // 無文字的子樹直接剪掉,省下大量 getComputedStyle。
  // 這裡用 textContent 是刻意的:只是剪枝,精確的文字晚一點用 ownText 取。
  if (!(el.textContent ?? '').trim()) return false;

  // 收折的 <details>:所有量測都會說謊,只有 DOM 說實話
  if (el.tagName === 'DETAILS' && !el.hasAttribute('open')) {
    for (const kid of Array.from(el.children)) {
      if (kid.tagName === 'SUMMARY' && walk(kid, ctx, pinned)) return true;
    }
    return false;
  }
  const cs = getComputedStyle(el);
  if (isInvisible(cs)) {
    /*
     * 看不見的文字**祖先也不能繼承**,理由和 sr-only 完全一樣。
     * 只是 return false 的話,分享按鈕的 `<span hidden>Share on Facebook
     * (Opens in new window)</span>` 仍然算進 <a> 的長度,把它從 UI 標籤
     * 推成內文單元 —— 畫面上明明只有「Facebook」8 個字。
     */
    ctx.srOnly.add(el);
    return false;
  }
  /*
   * §3.5 原本是「sticky / fixed 的元素及其子樹整棵跳過」,理由是捲動時
   * 疊層會脫位 —— 疊層在 document 座標,而釘住的元素在 document 座標裡
   * 一直在動。那是**寫在還沒有「動就先藏起來」這套機制之前**的規則。
   *
   * 現在有了:內層捲動時 markAllStale(),靜下來再一次量、一次顯示。
   * 釘住的元素是同一類問題,用同一個答案就好 —— 標記起來,
   * 捲動期間藏這幾個,停下來再放出來。整棵跳過的代價太大:
   * ClickHouse 右側那份浮動目次是整篇文章的導覽,使用者的原話是
   * 「右邊的 table of contents 完全沒翻」。
   */
  const inFlow = pinned || cs.position === 'sticky' || cs.position === 'fixed';
  /*
   * 螢幕閱讀器專用標籤:整棵跳過,並登記起來讓祖先扣掉它的文字。
   * walk 先遞迴子節點再評估自己,所以父層評估時這個集合已經填好。
   * 少了登記這一步,跳過 sr-only 的 <span> 只會把問題往上搬一層 ——
   * 包著它的 stretched link(覆蓋整張卡片的 <a>)接著變成翻譯單元,
   * 疊層蓋掉整張圖。實際發生過。
   */
  if (isScreenReaderOnly(el, cs)) {
    ctx.srOnly.add(el);
    return false;
  }
  /*
   * 應用程式自繪的區塊標題,而且**祖先也不能繼承它的文字**。
   *
   * `isUiLabel()` 已經認得 `<div role="heading">`,但那條檢查只在元素
   * 「像 block」時才會走到。Gmail 的寫法是
   *
   *   <div class="aAw"><span role="heading">Labels</span><div role="button"/></div>
   *
   * inline 的 `<span>` 在 blockish 判斷就 return false 了,於是外層的 div
   * 撿走「Labels」變成翻譯單元 —— 左欄那個「標籤」就是這樣來的。
   * 和 sr-only 一樣要登記起來,不然只是把問題往上搬一層。
   */
  if (isAppHeading(el)) {
    ctx.srOnly.add(el);
    return false;
  }

  let produced = false;
  for (const child of Array.from(el.children)) {
    if (walk(child, ctx, inFlow)) produced = true;
  }
  // 子孫產生了單元,但自己還帶著一段沒人認領的文字 —— 見 captureInlineText
  if (produced) {
    captureInlineText(el, ctx, inFlow);
    return true;
  }

  const blockish = BLOCK_TAGS.has(el.tagName) || BLOCKISH_DISPLAY.has(cs.display);
  if (!blockish) return false;
  // 子孫沒產生單元不代表可以退而求其次把容器整個吃下來
  if (hasContainerChild(el)) return captureInlineText(el, ctx, inFlow);
  /*
   * 圖文混排:蓋下去會把圖一起蓋掉(§3.5 的非浮動版本)。
   * 但圖片自己佔一行的話,文字與圖片是上下分開的 —— 那種不必放棄,
   * 記下界線,疊層蓋到那裡為止(見 mediaSplitOf)。
   */
  const split = mediaSplitOf(el);
  /*
   * 圖片夾在文字中間(前後都有字)—— 一個矩形蓋不住,但兩個可以。
   * 區塊層級的圖片本來就是分隔線,交給 inlineRuns 依它切段。
   */
  if (!split && hasMediaChild(el)) return captureRuns(el, ctx, inFlow);
  const skip = split ? new Set([...ctx.srOnly, split]) : ctx.srOnly;

  const text = normalizeText(ownText(el, skip));
  if (!isMeaningfulText(text)) return false;
  /*
   * 互動元素裡的短文字是 UI 標籤,不是內容(長度只算看得見的字)。
   *
   * **但有 mediaSplit 的元素不算。** 那條規則的理由是幾何:譯文比原文短,
   * 蓋在緊湊的導覽列上要嘛吃掉項目間距、要嘛讓原文從右邊露出來。
   * 而 mediaSplit 的存在本身就證明了這裡不是那種版面 —— 圖片自己佔一行,
   * 表示文字也自己佔一行,蓋上去很安全。
   *
   * 實例是 ClickHouse 的圖表表格:`<th>Storage size</th>` 翻了,
   * 同一張表的 `<td><a>Link</a><span><img></span></td>` 沒翻,
   * 因為後者的文字全部來自一個連結。同一張表兩種行為。
   */
  if (!split && isUiLabel(el, ctx.srOnly)) return false;
  // 最後一道防線:段落不會有一千字
  if (text.length > MAX_UNIT_CHARS) return false;
  if (looksLikeTargetLang(text)) return false;
  if (ctx.seen(el)) return true; // 已建立過單元,視為已命中,不重複
  if (el.getClientRects().length === 0) return false;

  ctx.out.push({
    el,
    role: roleOf(el, cs),
    src: text,
    geometryRisk: hasFloatDescendant(el),
    ...(split ? { mediaSplit: split } : {}),
    ...(inFlow ? { pinned: true } : {}),
  });
  ctx.made.add(el);
  return true;
}

/**
 * 容器自己帶著一段文字,而那段文字整段裝在一個行內元素裡 —— 拿那個元素當單元。
 *
 * 目次的巢狀項目就是這個形狀:
 *
 *   <li><a>Benchmark results</a><ul><li><a>Summary</a></li>…</ul></li>
 *
 * 拿 <li> 當單元不行:它的 bounding box 蓋住整個子清單。可是不做任何事
 * 也不對 —— 舊版就是這樣,「Benchmark results」那一行**不產生任何單元**,
 * 既不是內文也不是貼片,滑上去也沒反應。使用者看到的是目次翻一半。
 *
 * <a> 的幾何剛剛好,語意也對。條件很緊:整段文字要恰好等於某一個
 * 非區塊子元素的文字,有一點對不上就不做 —— 寧可少翻一行,
 * 不要蓋錯地方。
 */
/**
 * 容器裡「不屬於任何區塊子節點」的連續行內內容,一段一個。
 *
 * 有兩種很常見的版面,單靠元素當錨點永遠接不住:
 *
 *   <div class="rich-text">
 *     <div>…表格…</div>
 *     ClickHouse requires 12 times less disk space than Elasticsearch…
 *   </div>
 *
 *   <p>文字…<span class="flex"><img></span>As discussed, ESQL currently…</p>
 *
 * 第一種的文字**沒有任何元素包著**(markdown 轉出來的鬆散文字節點);
 * 第二種的圖片夾在中間,把文字切成兩段。兩種都不可能用一個元素矩形蓋住。
 *
 * 答案是換錨點:用 Range 圈住那一段,幾何問 `range.getClientRects()`。
 * 區塊子節點是天然的分隔線 —— 兩段之間必然換行,所以每一段的矩形都是
 * 完整的幾行,不會出現「從半行開始」那種難蓋的形狀。
 */
export function inlineRuns(el: Element): Array<{ range: Range; nodes: Node[] }> {
  const out: Array<{ range: Range; nodes: Node[] }> = [];
  let run: Node[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const range = document.createRange();
    range.setStartBefore(run[0]!);
    range.setEndAfter(run[run.length - 1]!);
    if (normalizeText(range.toString()).length > 0) out.push({ range, nodes: run });
    run = [];
  };
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const kid = node as Element;
      const blockish =
        kid.matches(CONTAINER_TAGS) || BLOCKISH_DISPLAY.has(getComputedStyle(kid).display);
      if (blockish) {
        flush();
        continue;
      }
      if (NON_TEXT_TAGS.has(kid.tagName) || excluded(kid)) continue;
    } else if (node.nodeType !== 3 /* TEXT_NODE */) {
      continue;
    }
    run.push(node);
  }
  flush();
  return out;
}

/**
 * 把行內段落收成單元。**一個元素可以產生好幾個**,所以下游的
 * 「這個元素做過了沒」不能再假設一對一(見 index.ts 的 unitByEl)。
 */
function captureRuns(el: Element, ctx: WalkCtx, pinned: boolean): boolean {
  /*
   * **上一輪就做過了就別再做。**
   *
   * 元素錨點那條路徑在 `walk()` 裡有 `ctx.seen(el)` 擋著,而這條捷徑漏了 ——
   * 於是每一次 scan 都重新產生同一批 range 候選。它們在 index.ts 會被
   * 「這個元素上一輪就有單元」濾掉,所以不會變成重複的疊層,
   * **但 scan 永遠回報 found > 0**,於是掃描間隔一直停在最短的 400ms,
   * 每 0.4 秒對整棵樹跑一次 getComputedStyle。診斷 log 裡那排
   * `scan {"found":9}` 就是這樣來的,而使用者感覺到的是「卡住了」。
   *
   * 這是 §CF「走捷徑的路徑要自己補上主路徑的每一道關卡」的第二次。
   */
  if (ctx.seen(el)) return true;
  const cs = getComputedStyle(el);
  let made = false;
  for (const { range, nodes } of inlineRuns(el)) {
    /*
     * 這一段的文字**已經有主人了嗎**。
     *
     * `<a><h3>卡片標題</h3></a>` 的 `<a>` 是行內的,所以整個會被收進一段 run,
     * 而那段文字早就由 `<h3>` 的單元蓋著了 —— 再收一次就是兩層疊層。
     * 單元一律建在容器上,所以「這段裡有容器」就等於「有主人」。
     */
    const owned = nodes.some((n) => {
      if (n.nodeType !== 1) return false;
      const e = n as Element;
      return ctx.made.has(e) || e.matches(CONTAINER_TAGS) || e.querySelector(CONTAINER_TAGS) !== null;
    });
    if (owned) continue;
    /*
     * 這一段裡還夾著大圖 —— 那是真正的行內圖片(不是自己佔一行的那種,
     * 那種會在上面被當成分隔線切開),疊層一定會蓋到它。整段放棄。
     * 少了這一條,`<p><img><span>說明</span></p>` 會長出一塊蓋住圖的疊層。
     */
    if (nodes.some((n) => n.nodeType === 1 && hasMediaChild(n as Element, true))) continue;
    const text = normalizeText(range.toString());
    if (!isMeaningfulText(text) || text.length > MAX_UNIT_CHARS) continue;
    if (looksLikeTargetLang(text)) continue;
    // 整段都在互動元素裡的短文字仍然是 UI 標籤
    if (text.length <= UI_LABEL_MAX_CHARS && range.startContainer === range.endContainer) continue;
    if (range.getClientRects().length === 0) continue;
    ctx.out.push({
      el,
      role: roleOf(el, cs),
      src: text,
      geometryRisk: false,
      range,
      ...(pinned ? { pinned: true } : {}),
    });
    made = true;
  }
  if (made) ctx.made.add(el);
  return made;
}

function captureInlineText(el: Element, ctx: WalkCtx, pinned: boolean): boolean {
  const text = normalizeText(inlineOwnText(el, ctx.srOnly));
  if (!isMeaningfulText(text)) return false;
  /*
   * 長度與語言的檢查只擋**單一承載元素**那條捷徑,不能擋掉整個函式。
   *
   * 這裡踩過一次:`<div class="rich-text">` 底下有五段鬆散文字,
   * `inlineOwnText()` 把五段接成一條 3000 字的字串,於是
   * `text.length > MAX_UNIT_CHARS` 直接 return —— 連 Range 的路都沒走到。
   * 而那五段各自都是正常長度的段落。**把整體拿去量,擋掉的是每一個個體。**
   */
  const single = text.length <= MAX_UNIT_CHARS && !looksLikeTargetLang(text);
  for (const kid of single ? Array.from(el.children) : []) {
    if (kid.matches(CONTAINER_TAGS)) continue;
    /*
     * 承載元素必須自己就是**葉子**。
     *
     * `<a><h3>卡片標題</h3></a>` 的 <h3> 已經是單元了,再拿 <a> 收一次
     * 就是兩層疊層疊在一起;`<tbody>` / `<tr>` 也一樣 —— 它們不在
     * CONTAINER_TAGS 裡(那是「像段落的容器」的清單),但底下有 <td>。
     * 用「有沒有容器子孫」判斷比繼續往 CONTAINER_TAGS 塞標籤可靠。
     */
    if (kid.querySelector(CONTAINER_TAGS)) continue;
    /*
     * 承載元素也要走一次排除清單。
     *
     * 這一步漏掉的代價是**把已經擋掉的東西救回來**:ClickHouse 的頂部
     * 導覽是 `<div><button>Products</button>…</div>`,`<button>` 在
     * EXCLUDE_TAGS 裡、walk() 早就跳過了,但 captureInlineText 直接
     * 從父層撿走它 —— 站台導覽因此變成六個內文單元。
     * 走捷徑的路徑要自己補上主路徑的每一道關卡。
     */
    if (EXCLUDE_TAGS.has(kid.tagName)) continue;
    if (excluded(kid) || kid.matches(CHROME_SELECTOR)) continue;
    if (normalizeText(ownText(kid, ctx.srOnly)) !== text) continue;
    if (ctx.made.has(kid) || ctx.seen(kid)) return true;
    const kcs = getComputedStyle(kid);
    if (isInvisible(kcs)) return false;
    if (isScreenReaderOnly(kid, kcs) || isUiLabel(kid, ctx.srOnly)) return false;
    if (hasMediaChild(kid)) return false;
    if (kid.getClientRects().length === 0) return false;
    ctx.out.push({
      el: kid,
      role: roleOf(kid, kcs),
      src: text,
      geometryRisk: false,
      ...(pinned ? { pinned: true } : {}),
    });
    ctx.made.add(kid);
    return true;
  }
  /*
   * 沒有單一承載元素 —— 文字是鬆散的文字節點加行內標籤的混合。
   * 那就別找元素了,直接圈範圍。
   */
  return captureRuns(el, ctx, pinned);
}

/**
 * 加翻層的候選:UI 標籤、選單項目、連結(docs/plan-annotation.md §6.2)。
 *
 * `isUiLabel()` 從「排除條件」升級成「分類器」—— 命中的不再丟掉,
 * 而是收進這裡,交給另一種畫法(旁邊的貼片,不覆蓋)。
 * **判定規則一字不改**:那個 24 字門檻是在真頁面上調出來的,
 * 不要在同一次改動裡動兩件事。
 */
export function findLabels(
  root: Element,
  cap: number,
  seen: (el: Element) => boolean = () => false,
): Candidate[] {
  const out: Candidate[] = [];
  const all = root.querySelectorAll(INTERACTIVE_SELECTOR);
  for (const el of all) {
    if (out.length >= cap) break;
    /*
     * 已經建過單元的先跳掉,再做任何 getComputedStyle。
     * scan() 在動態頁面上跑得很勤,而這個函式對每個互動元素都要問樣式 ——
     * 不先擋掉已知的,無限捲動的頁面會把時間全花在重算同一批導覽列上。
     */
    if (seen(el)) continue;
    // 排除清單對加翻層同樣有效 —— 先前只有內文單元遵守它,
    // 於是 .notranslate / translate="no" 裡的連結照樣被翻
    if (inExcluded(el)) continue;
    // 巢狀互動元素只取最內層(連結包按鈕、按鈕包連結)
    if (el.querySelector(INTERACTIVE_SELECTOR) !== null) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (isScreenReaderOnly(el, cs)) continue;
    const srOnly = new Set<Element>();
    if (el.children.length > 0) {
      const kids = el.querySelectorAll('*');
      // 標籤裡不會有幾十層結構;掃到第 8 個就夠了,再多是成本不是正確性
      for (let i = 0; i < kids.length && i < 8; i++) {
        const kid = kids[i]!;
        const kcs = getComputedStyle(kid);
        // display:none / hidden 的無障礙標籤與 sr-only 同一類:看不見就不算
        if (isInvisible(kcs) || isScreenReaderOnly(kid, kcs)) srOnly.add(kid);
      }
    }
    const text = normalizeText(ownText(el, srOnly));
    if (text.length === 0 || text.length > UI_LABEL_MAX_CHARS) continue;
    // 內容清單裡的短連結交給內文層畫常駐疊層,不要在這裡收成貼片 ——
    // 否則同一份目次會一半貼片一半疊層(見 inContentList)
    if (inContentList(el, srOnly)) continue;
    if (!isMeaningfulText(text)) continue;
    if (looksLikeTargetLang(text)) continue;
    if (el.getClientRects().length === 0) continue;
    /*
     * **不**在這裡對重複文字去重。
     *
     * 上一版會只留第一個 —— 那是錯的:卡片牆上十二張卡都寫「詳細を見る」,
     * 十二個都要能 hover;「お問い合わせ」在導覽列與段落標題各一次,
     * 使用者指的往往是後者。去重要做在翻譯層(index.ts 的 labelMemo):
     * 每個元素都有自己的單元,但同一段文字只送一次 API。
     */
    out.push({ el, role: 'label', src: text, geometryRisk: false });
  }
  return out;
}

export function findCandidates(root: Element, seen: (el: Element) => boolean): Candidate[] {
  const out: Candidate[] = [];
  walk(root, { seen, out, root, srOnly: new Set<Element>(), made: new Set<Element>() });
  return out;
}

/**
 * 除錯用:問「這個元素為什麼沒有被當成翻譯單元」。
 *
 * 規則有十幾條,分散在 walk() 的各個 return false,線上出問題時
 * 從 console 一條條試很痛苦。這裡把同一組規則重跑一遍並回報**第一條**
 * 擋住它的規則,包含被排除的祖先(祖先被擋掉時整個子樹都不會走到)。
 *
 * 用法:content script 的 isolated world 裡
 *   __ksnm.explain(document.querySelector('h1'))
 */
export function explainCandidate(el: Element): string[] {
  const reasons: string[] = [];

  // 祖先鏈:被擋掉的祖先會讓整個子樹跳過
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (EXCLUDE_TAGS.has(p.tagName)) reasons.push(`祖先 <${p.tagName.toLowerCase()}> 在排除清單上`);
    else if (excluded(p)) reasons.push(`祖先 <${p.tagName.toLowerCase()}> 命中排除選擇器`);
    else {
      const pcs = getComputedStyle(p);
      if (isInvisible(pcs)) reasons.push(`祖先 <${p.tagName.toLowerCase()}> 不可見 (${pcs.display}/${pcs.visibility}/${pcs.opacity})`);
    }
    if (reasons.length > 0) return reasons;
  }

  if (EXCLUDE_TAGS.has(el.tagName)) return [`<${el.tagName.toLowerCase()}> 在排除清單上`];
  if (el.matches(EXCLUDE_SELECTOR)) return ['命中排除選擇器 (contenteditable / translate=no / .notranslate)'];
  if (ariaHiddenSkip(el)) return ['aria-hidden="true" 而且畫面上沒有繪製面積'];
  if (!(el.textContent ?? '').trim()) return ['沒有文字'];

  const cs = getComputedStyle(el);
  if (isInvisible(cs)) return [`不可見 (display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity})`];
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    if (isAppChrome(n)) {
      return [
        `祖先 <${n.tagName.toLowerCase()}> 是應用程式外殼 —— 不畫疊層,但滑上去仍然翻得到`,
      ];
    }
  }

  const blockish = BLOCK_TAGS.has(el.tagName) || BLOCKISH_DISPLAY.has(cs.display);
  if (!blockish) return [`不是 block 級 (display: ${cs.display}),文字會併進最近的 block 祖先`];
  if (hasContainerChild(el)) return ['底下還有帶文字的 block —— 這是容器不是段落,單元會建在更裡面'];
  if (!mediaSplitOf(el) && hasMediaChild(el)) {
    return ['圖文混排且圖片沒有自己佔一行 —— 疊層一定會蓋到圖,整段跳過'];
  }

  const text = normalizeText(ownText(el));
  if (!isMeaningfulText(text)) return [`文字沒有意義:${JSON.stringify(text.slice(0, 40))}`];
  if (text.length > MAX_UNIT_CHARS) return [`文字 ${text.length} 字,超過單元上限 ${MAX_UNIT_CHARS}`];
  if (looksLikeTargetLang(text)) return ['判定為已是目標語言 (CJK 比例 > 30%)'];
  if (el.getClientRects().length === 0) return ['沒有繪製面積 (getClientRects 為空)'];
  if (isScreenReaderOnly(el, cs)) return ['螢幕閱讀器專用標籤(sr-only:1×1 + clip),視覺上不存在'];
  /*
   * isUiLabel 要放在最後、而且**不能漏**。
   *
   * 漏掉的代價是這支工具會說謊:查 ClickHouse 圖表儲存格為什麼不翻,
   * 它回「符合所有規則 —— 應該會成為翻譯單元」,而實際上是被這一關擋掉的。
   * 會說謊的儀表比沒有儀表更糟,因為它讓人往錯的方向找。
   */
  if (!mediaSplitOf(el) && isUiLabel(el)) {
    return ['判定為 UI 標籤(互動元素裡 24 字以內的文字)—— 交給加翻層,滑上去會顯示貼片'];
  }
  return ['符合所有規則 —— 應該會成為翻譯單元'];
}
