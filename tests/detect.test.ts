import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  MAX_UNIT_CHARS,
  findCandidates,
  findLabels,
  findSvgTexts,
  hiddenByDisclosure,
  isMeaningfulText,
  looksLikeTargetLang,
  oversizedUnits,
  resetOversized,
} from '../src/content/detect.ts';

/**
 * §3.1 的規則密度最高,而 §12.2 的通過條件有一半是「什麼不該被翻」。
 * jsdom 沒有 layout,所以只驗選取規則,幾何交給瀏覽器人工驗收(docs/acceptance.md)。
 */
function mount(html: string): Element {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = dom.window.document;
  g['getComputedStyle'] = dom.window.getComputedStyle.bind(dom.window);
  // jsdom 沒有 layout,getClientRects() 一律空陣列 —— 補一個假的,
  // 否則所有候選都會被「沒有繪製面積」的檢查擋掉
  // jsdom 沒有 layout,Range 連 getClientRects 都沒有 —— 補一個假的,
  // 否則所有 Range 錨點的候選都會被「沒有繪製面積」擋掉
  const fakeRect = { top: 0, left: 0, width: 300, height: 20, bottom: 20, right: 300 };
  dom.window.Range.prototype.getClientRects = function () {
    return [fakeRect] as unknown as DOMRectList;
  };
  dom.window.Range.prototype.getBoundingClientRect = function () {
    return fakeRect as DOMRect;
  };
  dom.window.Element.prototype.getClientRects = function () {
    return [{ top: 0, left: 0, width: 300, height: 20 }] as unknown as DOMRectList;
  };
  return dom.window.document.body;
}

/**
 * jsdom 沒有 layout,client rect 是 mount() 補的假值。
 * 把指定元素改成 1×1,模擬 `.sr-only`(width:1px;height:1px;clip:rect(0,0,0,0))。
 */
function srOnly(body: Element, selector: string): void {
  for (const el of body.querySelectorAll(selector)) {
    el.getClientRects = () =>
      [{ top: 0, left: 0, width: 1, height: 1 }] as unknown as DOMRectList;
  }
}

function ids(body: Element): string[] {
  return findCandidates(body, () => false).map((c) => c.src);
}

before(() => {
  // 讓 detect.ts 在 import 之後才碰到 DOM

/** 在 jsdom 上跑一次選取 */
function collect(dom: JSDOM): Array<{ src: string }> {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g['document'];
  const prevWin = g['window'];
  g['document'] = dom.window.document;
  g['window'] = dom.window;
  g['getComputedStyle'] = dom.window.getComputedStyle.bind(dom.window);
  try {
    return findCandidates(dom.window.document.body, () => false);
  } finally {
    g['document'] = prevDoc;
    g['window'] = prevWin;
  }
}
});

test('§3.1 一句話被 inline 元素切碎時,整個 block 是一個單元', () => {
  const body = mount('<p>Roughly <a href="#">99 percent</a> of <em>traffic</em> goes undersea.</p>');
  assert.deepEqual(ids(body), ['Roughly 99 percent of traffic goes undersea.']);
});

test('§3.1 巢狀命中時不重複建立單元:wrapper 不會變成一個巨大單元', () => {
  const body = mount('<div><p>First paragraph here.</p><p>Second paragraph here.</p></div>');
  assert.deepEqual(ids(body), ['First paragraph here.', 'Second paragraph here.']);
});

test('§3.1 排除 nav / header / footer / aside / form / button', () => {
  const body = mount(
    '<nav><p>Skip navigation</p></nav>' +
      '<header><p>Site title here</p></header>' +
      '<footer><p>All rights reserved</p></footer>' +
      '<aside><p>Related reading</p></aside>' +
      '<form><p>Search this site</p></form>' +
      '<p>Real body text.</p>',
  );
  assert.deepEqual(ids(body), ['Real body text.']);
});

test('§12.2 code / pre / kbd / samp 區塊不得被翻譯', () => {
  const body = mount(
    '<pre><code>const x = compute(value);</code></pre>' +
      '<p>Call <code>compute()</code> before rendering.</p>',
  );
  // 段落照翻(裡面的 inline code 一起送去,prompt 要求原樣保留),pre 整塊跳過
  assert.deepEqual(ids(body), ['Call compute() before rendering.']);
});

test('§3.1 contenteditable / translate=no / .notranslate 一律排除', () => {
  const body = mount(
    '<p aria-hidden="true" style="display:none">Decorative text here</p>' +
      '<p contenteditable="">Editable text here</p>' +
      '<p translate="no">Brand Name Here</p>' +
      '<p class="notranslate">Do not touch this</p>' +
      '<p>Translate this one.</p>',
  );
  assert.deepEqual(ids(body), ['Translate this one.']);
});

test('aria-hidden 但畫面上看得到 → 照翻', () => {
  /*
   * 逐字進場動畫的標準寫法(anthropic.com 的主標題):整句放 aria-label
   * 給螢幕閱讀器,畫面上真正看得到的每個字標 aria-hidden 免得讀兩次。
   * 舊規則把 aria-hidden 當成「不是內容」,於是整頁最大的那行字不翻 ——
   * 使用者的話是「這看起來是有點搞笑」。
   *
   * aria-hidden 是「對輔助技術隱藏」,不是「看不見」;而這個擴充疊的是
   * 眼睛看到的東西。看不看得見由 CSS 回答,上一個測試就是那一半。
   */
  const body = mount(
    '<h1 aria-label="Anthropic approach to teaching and learning AI">' +
      '<span aria-hidden="true">Anthropic</span> <span aria-hidden="true">approach</span> ' +
      '<span aria-hidden="true">to</span> ' +
      '<span aria-hidden="true">teaching and learning AI</span></h1>',
  );
  assert.deepEqual(ids(body), ['Anthropic approach to teaching and learning AI']);
});

test('§3.1 純數字、純符號、長度 < 2 一律排除', () => {
  assert.equal(isMeaningfulText('42'), false);
  assert.equal(isMeaningfulText('—'), false);
  assert.equal(isMeaningfulText('a'), false);
  assert.equal(isMeaningfulText('%$#@!'), false);
  assert.equal(isMeaningfulText('12.5 MB'), true);
  const body = mount('<p>2026</p><p>—</p><p>Hi there</p>');
  assert.deepEqual(ids(body), ['Hi there']);
});

test('§3.2 已是中文的區塊跳過,但日文(有假名)仍然翻', () => {
  assert.equal(looksLikeTargetLang('全球資料流量約有九成九走海底電纜'), true);
  assert.equal(looksLikeTargetLang('Roughly 99 percent of traffic'), false);
  assert.equal(looksLikeTargetLang('海底ケーブルを通って世界のデータ'), false);
  // 日文頁面的純漢字標題:逐塊看是「漢字 100%」,整頁層級知道那是日文
  assert.equal(looksLikeTargetLang('東京都知事選挙'), true);
  assert.equal(looksLikeTargetLang('東京都知事選挙', 'ja'), false);
  assert.equal(looksLikeTargetLang('海底電纜與網際網路', 'ja'), false);
  // 中文頁面(或判不出字集)時,行為不變
  assert.equal(looksLikeTargetLang('全球資料流量約有九成九走海底電纜', 'zh'), true);
  assert.equal(looksLikeTargetLang('Roughly 99 percent of traffic', 'ja'), false);
  const body = mount('<p>這一段已經是中文了,不用翻。</p><p>This one needs translating.</p>');
  assert.deepEqual(ids(body), ['This one needs translating.']);
});

test('§3.1 表格儲存格、清單、標題都是單元,並帶上 role', () => {
  const body = mount(
    '<h2>Known failure modes</h2>' +
      '<ul><li>Sticky elements drift</li></ul>' +
      '<table><caption>Budget</caption><tr><th>Tier</th><td>Balanced</td></tr></table>',
  );
  const got = findCandidates(body, () => false).map((c) => [c.src, c.role]);
  assert.deepEqual(got, [
    ['Known failure modes', 'heading'],
    ['Sticky elements drift', 'list'],
    ['Budget', 'cell'],
    ['Tier', 'cell'],
    ['Balanced', 'cell'],
  ]);
});

test('§3.5 sticky / fixed 不再整棵跳過,但要標記成 pinned', () => {
  /*
   * 舊版整棵跳過,理由是捲動時疊層會脫位 —— 那條規則寫在
   * 「動就先藏起來」那套機制之前。現在標記起來,捲動期間藏這幾個就好。
   * 整棵跳過的代價太大:浮動目次往往是整篇文章的導覽。
   */
  const body = mount(
    '<div style="position: sticky"><p>Sticky toolbar label</p></div>' +
      '<div style="position: fixed"><p>Fixed banner text</p></div>' +
      '<p>Normal flow text.</p>',
  );
  const got = findCandidates(body, () => false);
  assert.deepEqual(
    got.map((c) => [c.src, c.pinned === true]),
    [
      ['Sticky toolbar label', true],
      ['Fixed banner text', true],
      ['Normal flow text.', false],
    ],
  );
});
test('§3.1 display:none / visibility:hidden / opacity:0 的子樹跳過', () => {
  const body = mount(
    '<p style="display: none">Hidden by display</p>' +
      '<p style="visibility: hidden">Hidden by visibility</p>' +
      '<p style="opacity: 0">Hidden by opacity</p>' +
      '<p>Visible text here.</p>',
  );
  assert.deepEqual(ids(body), ['Visible text here.']);
});

test('已建立過單元的元素不會被重複收', () => {
  const body = mount('<p>Only once please.</p>');
  const first = findCandidates(body, () => false);
  assert.equal(first.length, 1);
  const again = findCandidates(body, () => true);
  assert.equal(again.length, 0);
});

/* -------------------------------------------------- 真實網站踩到的坑 */

test('<style> 的 CSS 不得被當成文章(claude.com/blog 實例)', () => {
  // Webflow 在 body 內散佈 <style>。父容器成為單元時,
  // textContent 會把 CSS 一起吃進來,頁面頂端就出現一行被翻譯的選擇器。
  const body = mount(
    '<div class="wrap">' +
      '<style>/* add comma between authors */ .blog_author_wrap > div:not(:last-child) .blog_author_text::after { content: ","; }</style>' +
      'Written by the Anthropic team.' +
      '</div>',
  );
  assert.deepEqual(ids(body), ['Written by the Anthropic team.']);
});

test('只含 <style> 的容器不產生任何單元', () => {
  const body = mount('<div><style>.a{color:red}.b{color:blue}</style></div>');
  assert.deepEqual(ids(body), []);
});

test('<script> 的內容同樣不得進入 src', () => {
  const body = mount(
    '<div>Read the announcement.<script>window.dataLayer=[{event:"page_view"}]</script></div>',
  );
  assert.deepEqual(ids(body), ['Read the announcement.']);
});

test('子孫因 opacity:0 全被跳過時,父容器不得變成一個巨大單元', () => {
  // Webflow 的捲動動畫:整篇文章的 <p> 初始 opacity: 0。
  // 舊行為是每一段都被跳過 → 父容器自己成為單元 → 整篇文章疊成一坨。
  const body = mount(
    '<div class="rich-text">' +
      '<p style="opacity: 0">First paragraph of the article.</p>' +
      '<p style="opacity: 0">Second paragraph of the article.</p>' +
      '</div>',
  );
  assert.deepEqual(ids(body), []);
});

test('子孫是隱形的 block 時,父容器一樣不吃下整包', () => {
  const body = mount(
    '<section><div style="display: none">Hidden block text</div>' +
      '<p style="visibility: hidden">Also hidden</p></section>',
  );
  assert.deepEqual(ids(body), []);
});

test('容器裡的段落正常時,單元仍然是段落而不是容器', () => {
  const body = mount('<div class="rich-text"><p>First para.</p><p>Second para.</p></div>');
  assert.deepEqual(ids(body), ['First para.', 'Second para.']);
});

test('超過字數上限的區塊不建立單元(擋還沒想到的結構,不是判斷段落)', () => {
  const long = 'This sentence is a filler used to exceed the unit cap. '.repeat(120);
  assert.ok(long.length > MAX_UNIT_CHARS);
  const body = mount(`<p>${long}</p>`);
  assert.deepEqual(ids(body), []);
  // 擋掉要留下痕跡 —— 上一版這條規則完全靜默
  assert.equal(oversizedUnits().length, 1);
  resetOversized();
  // 正常長度的段落不受影響
  const ok = mount('<p>A normal paragraph of reasonable length.</p>');
  assert.deepEqual(ids(ok), ['A normal paragraph of reasonable length.']);
});

test('1500 字的長引言是真的段落,要翻', () => {
  /*
   * stratechery 的引言區塊:貨真價實的 <p>,1576 字,一個子元素都沒有。
   * 舊的 1000 字上限說「段落不會這麼長,超過就一定是容器誤判」——
   * 那個前提是錯的,而且三條路全關著(疊翻撞 1000,hover 與選取撞 500),
   * 使用者看到的是「又一大段沒翻,前面都好好的?」
   *
   * 「是不是容器」有結構性的答案(hasContainerChild);長度只是
   * 最後一道防線,門檻該訂在真實散文絕對到不了的地方。
   */
  const quote =
    'This style of operating will be different now, but ultimately we need to invest in having AI agent red teaming that enables defenders to find and remediate vulnerabilities before attackers do. '.repeat(
      8,
    );
  assert.ok(quote.length > 1500 && quote.length < MAX_UNIT_CHARS);
  const body = mount(`<blockquote><p class="wp-block-paragraph">${quote}</p></blockquote>`);
  assert.equal(ids(body).length, 1, '整段要成為一個單元');
  assert.equal(oversizedUnits().length, 0, '不該被記成疑似容器');
});

test('行內 code 留在句子裡(§3.4 靠佔位符保護,不是靠剝掉)', () => {
  const body = mount('<p>Call <code>compute()</code> before <kbd>Ctrl+S</kbd>.</p>');
  assert.deepEqual(ids(body), ['Call compute() before Ctrl+S.']);
});

/* ---------------- 互動元素裡的短文字是 UI 標籤,不是內容 ---------------- */

test('連結型按鈕不翻:PRD 只排除 <button>,漏掉 <a class="button">', () => {
  const body = mount(
    '<a href="/pricing" class="button">See pricing</a>' +
      '<a href="/sales" role="button">Contact sales</a>',
  );
  assert.deepEqual(ids(body), []);
});

test('連結裡的長文字是內容,照翻(卡片標題、文章行內連結)', () => {
  const body = mount(
    '<a href="/post"><h3>Bringing the cybersecurity capabilities of Claude to more defenders</h3></a>',
  );
  const out = ids(body);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /cybersecurity/);
});

test('段落裡夾一個短連結不影響整段', () => {
  const body = mount('<p>Read the <a href="/docs">docs</a> before you start the migration.</p>');
  const out = ids(body);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /migration/);
});

/* -------- 螢幕閱讀器標籤:自己不翻,也不能讓祖先變成單元 -------- */

test('sr-only 標籤本身不翻', () => {
  const body = mount('<p><span class="sr-only">Skip to main content of this article</span></p>');
  srOnly(body, '.sr-only');
  assert.deepEqual(ids(body), []);
});

test('包著 sr-only 的 stretched link 也不翻(否則疊層蓋掉整張卡)', () => {
  const body = mount(
    '<a href="/post" class="clickable_link">' +
      '<span class="sr-only">Bringing the cybersecurity capabilities of Claude to more defenders</span>' +
      '</a>',
  );
  srOnly(body, '.sr-only');
  assert.deepEqual(ids(body), []);
});

test('同一個容器裡還有看得見的文字時,那段照翻', () => {
  const body = mount(
    '<div><span class="sr-only">Opens in a new window</span>' +
      '<p>The visible paragraph that should still be translated.</p></div>',
  );
  srOnly(body, '.sr-only');
  const out = ids(body);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /visible paragraph/);
});

test('加翻候選:UI 標籤被收進來,而不是被丟掉', () => {
  const body = mount(`
    <nav>
      <a href="/pricing">Pricing</a>
      <a href="/docs">Documentation</a>
      <button>Start free trial</button>
    </nav>
    <p>Roughly ninety nine percent of intercontinental traffic runs on undersea cables.</p>
  `);
  const labels = findLabels(body, 200).map((c) => c.src);
  assert.deepEqual(labels, ['Pricing', 'Documentation', 'Start free trial']);
  // 內文段落仍然走疊翻,不會同時變成標籤
  assert.equal(labels.some((t) => t.startsWith('Roughly')), false);
  for (const c of findLabels(body, 200)) assert.equal(c.role, 'label');
});

test('加翻候選:重複的文字每個都要收(卡片牆上十二張卡都要能 hover)', () => {
  // 去重做在翻譯層(labelMemo),不在偵測層 —— 偵測層去重會讓
  // 除了第一張以外的卡片 hover 沒反應,那正是回報的「只會翻一個」
  const body = mount(`
    <a href="/a">詳細を見る</a>
    <a href="/b">詳細を見る</a>
    <a href="/c">詳細を見る</a>
  `);
  assert.deepEqual(findLabels(body, 200).map((c) => c.src), [
    '詳細を見る',
    '詳細を見る',
    '詳細を見る',
  ]);
});

test('加翻候選:巢狀互動元素只取最內層', () => {
  const body = mount('<div role="menuitem"><a href="/x">Export</a></div>');
  assert.deepEqual(findLabels(body, 200).map((c) => c.src), ['Export']);
});

test('加翻候選:太長的連結是內容,不是標籤', () => {
  const body = mount('<a href="/x">Why undersea cables still carry the internet</a>');
  assert.deepEqual(findLabels(body, 200), []);
});

test('加翻候選:sr-only 的文字不算標籤', () => {
  const body = mount('<a href="/x"><span class="u-sr-only">Open menu</span></a>');
  srOnly(body, '.u-sr-only');
  assert.deepEqual(findLabels(body, 200), []);
});

test('加翻候選:上限會擋住病態頁面', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<a href="/x${i}">Item ${i}</a>`).join('');
  const body = mount(many);
  assert.equal(findLabels(body, 8).length, 8);
});

/** jsdom 沒有 layout,`hidden` 不會變成 display:none —— 手動補上 */
function displayNone(body: Element, selector: string): void {
  for (const el of body.querySelectorAll(selector)) {
    el.setAttribute('style', 'display: none');
    el.getClientRects = () => [] as unknown as DOMRectList;
  }
}

test('分享按鈕:藏起來的無障礙標籤不算長度,整塊當 UI 標籤排除', () => {
  // 回報的真實 DOM:Jetpack 的分享列。textContent 是 47 字(超過 24),
  // 但畫面上只有「Facebook」8 個字 —— 用 textContent 量會讓它變成內文單元,
  // 疊層把「分享至 Facebo…」蓋在分享列上
  const body = mount(`
    <div class="sharedaddy"><div class="sd-content"><ul>
      <li class="share-facebook"><a href="https://x.test/?share=facebook">
        <span id="sharing-facebook-19725" hidden>Share on Facebook (Opens in new window)</span>
        <span>Facebook</span>
      </a></li>
      <li class="share-email"><a href="mailto:?subject=x">
        <span id="sharing-email-19725" hidden>Email a link to a friend (Opens in new window)</span>
        <span>Email</span>
      </a></li>
    </ul></div></div>
  `);
  displayNone(body, 'span[hidden]');
  assert.deepEqual(ids(body), []);
});

test('分享按鈕的可見標籤仍然收得到(hover 想知道還是問得到)', () => {
  const body = mount(`
    <a href="https://x.test/?share=facebook">
      <span id="s1" hidden>Share on Facebook (Opens in new window)</span>
      <span>Facebook</span>
    </a>
  `);
  displayNone(body, 'span[hidden]');
  assert.deepEqual(findLabels(body, 200).map((c) => c.src), ['Facebook']);
});

test('收折的 <details>:內容沒有繪製面積,不建立單元', () => {
  const body = mount(`
    <details>
      <summary>Can I read Stratechery via RSS?</summary>
      <p>Yes! Create a Stratechery Passport account, go to Delivery Preferences.</p>
    </details>
  `);
  displayNone(body, 'details > p');
  assert.deepEqual(ids(body), ['Can I read Stratechery via RSS?']);
});

test('展開的 <details>:問與答都是單元', () => {
  const body = mount(`
    <details open>
      <summary>Can I read Stratechery via RSS?</summary>
      <p>Yes! Create a Stratechery Passport account, go to Delivery Preferences.</p>
    </details>
  `);
  assert.deepEqual(ids(body), [
    'Can I read Stratechery via RSS?',
    'Yes! Create a Stratechery Passport account, go to Delivery Preferences.',
  ]);
});

test('分享 widget 整塊排除 —— 連「Share」標題與 hover 貼片都不要', () => {
  // 回報的真實 DOM 有 robots-nocontent,那是「這不是內容」的標準訊號
  const body = mount(`
    <div class="sharedaddy sd-sharing-enabled"><div class="robots-nocontent sd-sharing">
      <h3 class="sd-title">Share</h3>
      <ul><li><a href="https://x.test/?share=facebook"><span>Facebook</span></a></li></ul>
    </div></div>
    <p>Stripe acquiring OpenRouter changes how AI inference gets billed.</p>
  `);
  assert.deepEqual(ids(body), ['Stripe acquiring OpenRouter changes how AI inference gets billed.']);
  assert.deepEqual(findLabels(body, 200), []);
});

test('排除清單對加翻層同樣有效', () => {
  const body = mount('<div class="notranslate"><a href="/x">Export</a></div>');
  assert.deepEqual(findLabels(body, 200), []);
});

test('應用程式外殼:ARIA 地標角色不蓋疊層(Gmail 的左欄)', () => {
  const body = mount(`
    <div role="navigation">
      <div class="apW" role="heading" aria-level="2">Mail</div>
      <div class="apW" role="heading" aria-level="2">Chat</div>
      <a href="#inbox">Inbox</a>
    </div>
    <div role="main"><p>Last week, Zipline and Uber announced a partnership targeting one million drone deliveries per day.</p></div>
  `);
  assert.deepEqual(ids(body), [
    'Last week, Zipline and Uber announced a partnership targeting one million drone deliveries per day.',
  ]);
});

test('div role="heading" 是應用程式的 UI 標籤,不是文章標題', () => {
  // Gmail 左欄的真實寫法。真正的文章用 <h1>–<h6>
  const body = mount(`
    <div class="apW" role="heading" aria-level="2">Mail</div>
    <span class="aAv" role="heading">Labels</span>
    <h2>Drone Delivery Is Scaling Rapidly In The US</h2>
  `);
  assert.deepEqual(ids(body), ['Drone Delivery Is Scaling Rapidly In The US']);
});

test('地標排除只擋疊翻,不擋加翻 —— 選單項目滑上去還是問得到', () => {
  const body = mount('<div role="navigation"><a href="#inbox">Inbox</a></div>');
  assert.deepEqual(ids(body), []);
  assert.deepEqual(findLabels(body, 200).map((c) => c.src), ['Inbox']);
});

test('收折的 <details>:只有 summary 進得來,內容不進來', () => {
  // 使用者的觀察:「打開跟關起來的 element 看起來長的一樣」。
  // 現代 Chrome 用 content-visibility: hidden 收折,佈局狀態被保留 ——
  // rect、client rects、computed style 全部回展開時的值,所有量測都說謊。
  // 唯一誠實的來源是 DOM:祖先有沒有一個沒帶 open 的 <details>。
  const body = mount(`
    <details>
      <summary>Can I read Stratechery via RSS?</summary>
      <p>Yes! Create a Stratechery Passport account, go to Delivery Preferences.</p>
    </details>
  `);
  assert.deepEqual(ids(body), ['Can I read Stratechery via RSS?']);
});

test('展開的 <details>:問與答都進得來', () => {
  const body = mount(`
    <details open>
      <summary>Can I read Stratechery via RSS?</summary>
      <p>Yes! Create a Stratechery Passport account, go to Delivery Preferences.</p>
    </details>
  `);
  assert.deepEqual(ids(body), [
    'Can I read Stratechery via RSS?',
    'Yes! Create a Stratechery Passport account, go to Delivery Preferences.',
  ]);
});

test('hiddenByDisclosure:summary 看得見,內容看不見,展開後都看得見', () => {
  const body = mount(`
    <details id="shut">
      <summary id="s1"><span id="s1b">Can I read Stratechery via RSS?</span></summary>
      <p id="p1">Yes! Create a Stratechery Passport account.</p>
    </details>
    <details id="open" open>
      <summary id="s2">Another question</summary>
      <p id="p2">Another answer that is long enough to matter.</p>
    </details>
  `);
  const at = (id: string) => body.querySelector(`#${id}`)!;
  assert.equal(hiddenByDisclosure(at('s1')), false);
  assert.equal(hiddenByDisclosure(at('s1b')), false, 'summary 的子孫也看得見');
  assert.equal(hiddenByDisclosure(at('p1')), true);
  assert.equal(hiddenByDisclosure(at('s2')), false);
  assert.equal(hiddenByDisclosure(at('p2')), false);
});

test('Gmail 的「Labels」:inline 的 role=heading,祖先也不能撿走它的文字', () => {
  // isUiLabel 只在元素「像 block」時才會被問到,而 <span> 是 inline ——
  // 於是外層的 div 撿走「Labels」變成翻譯單元。要跟 sr-only 一樣登記起來。
  const body = mount(`
    <div class="aAw FgKVne">
      <span class="aAv" role="heading">Labels</span>
      <div class="aAu arN" aria-label="Create new label" role="button" tabindex="0"></div>
    </div>
    <p>Drone delivery is scaling rapidly in the United States this year.</p>
  `);
  assert.deepEqual(ids(body), ['Drone delivery is scaling rapidly in the United States this year.']);
});

test('隱形的注入元素不該讓段落被當成容器,文字也不該外洩給祖先', () => {
  // Gmail 在每個含圖片的 <p> 裡塞一個下載按鈕(用 DOM API 塞的,所以
  // <div> 真的在 <p> 裡面),裡面唯一的文字是 aria-hidden 的 tooltip
  // 「Download」—— 於是那個 <p> 被當成容器,整段圖表註解從來沒被翻過
  const body = mount('<p id="fig"></p>');
  const doc = body.ownerDocument;
  const p = body.querySelector('#fig')!;
  const btn = doc.createElement('div');
  btn.className = 'a6S';
  const tip = doc.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  tip.textContent = 'Download';
  btn.appendChild(tip);
  p.appendChild(btn);
  const note = doc.createElement('span');
  note.textContent =
    'Note: Cost decline percentages are rounded to the nearest 5%. Source: ARK Investment Management LLC.';
  p.appendChild(note);

  assert.deepEqual(ids(body), [
    'Note: Cost decline percentages are rounded to the nearest 5%. Source: ARK Investment Management LLC.',
  ]);
});

test('圖文混排:圖不翻,圖旁邊的文字翻(在媒體處切段)', () => {
  /*
   * 舊版整段放棄 —— 而那是維基百科的日常:一段文字裡夾三個行內公式,
   * 於是整段一個字都不翻。放棄的粒度錯了:該放棄的是媒體節點,
   * 不是它前後的文字。段的聯集矩形蓋到媒體時仍然放棄(probe 有反例)。
   */
  const body = mount(`
    <p id="fig"><img id="chart" /><span>Note: cost decline percentages are rounded to the nearest 5%.</span></p>
    <p>Drone delivery is scaling rapidly in the United States this year.</p>
  `);
  // jsdom 沒有 layout,手動給圖表一個面積(mount 的假 rect 在 0,0~300,20,
  // 把圖放到不相交的位置)
  const chart = body.querySelector('#chart')!;
  chart.getBoundingClientRect = () =>
    ({ top: 100, left: 0, width: 450, height: 300, bottom: 400, right: 450 }) as unknown as DOMRect;
  assert.deepEqual(ids(body), [
    'Note: cost decline percentages are rounded to the nearest 5%.',
    'Drone delivery is scaling rapidly in the United States this year.',
  ]);
});

test('行內小圖示不算圖文混排', () => {
  const body = mount('<p id="p"><img id="icon" />Drone delivery is scaling rapidly in the US.</p>');
  const icon = body.querySelector('#icon')!;
  icon.getBoundingClientRect = () => ({ width: 14, height: 14 }) as unknown as DOMRect;
  assert.deepEqual(ids(body), ['Drone delivery is scaling rapidly in the US.']);
});

/*
 * ClickHouse 部落格的目次:同一份 <ul> 裡短的 12 字、長的 49 字。
 * 逐項套 24 字門檻的話,短的變貼片、長的變疊層 —— 一半翻一半不翻。
 */
const TOC = `<article><ul>
  <li><a href="#a">Introduction</a></li>
  <li><a href="#b">Count aggregations in ClickHouse and Elasticsearch</a></li>
  <li><a href="#c">Benchmark setup</a></li>
  <li><a href="#d">Benchmark queries</a></li>
</ul></article>`;

test('內容清單裡的短連結歸內文層,整份目次一致', () => {
  const root = mount(TOC);
  const texts = findCandidates(root, () => false).map((c) => c.src);
  assert.ok(texts.includes('Introduction'), `短條目也要進內文層,實得 ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('Benchmark setup'));
  assert.ok(texts.includes('Count aggregations in ClickHouse and Elasticsearch'));
});

test('內容清單裡的短連結不再被加翻層收走,避免同一份清單兩種畫法', () => {
  const root = mount(TOC);
  const labels = findLabels(root, 50).map((c) => c.src);
  assert.deepEqual(labels, [], `目次不該產生貼片,實得 ${JSON.stringify(labels)}`);
});

test('每項都短的清單仍然是選單,照舊走加翻層', () => {
  const root = mount(
    `<nav><ul>
      <li><a href="#1">Mail</a></li>
      <li><a href="#2">Chat</a></li>
      <li><a href="#3">Meet</a></li>
      <li><a href="#4">Contacts</a></li>
    </ul></nav>`,
  );
  assert.deepEqual(findCandidates(root, () => false).map((c) => c.src), []);
  assert.deepEqual(findLabels(root, 50).map((c) => c.src), ['Mail', 'Chat', 'Meet', 'Contacts']);
});

test('兩項的清單不算清單 —— 樣本太小,不足以推翻長度門檻', () => {
  const root = mount(
    `<ul>
      <li><a href="#1">Docs</a></li>
      <li><a href="#2">A rather long link label that is content</a></li>
    </ul>`,
  );
  assert.deepEqual(findLabels(root, 50).map((c) => c.src), ['Docs']);
});

/* -------- 目次:巢狀清單與「容器自己還帶著一行字」 -------- */

const NESTED_TOC = `<article><ul>
  <li><a href="#a">Introduction</a></li>
  <li><a href="#b">Count aggregations in ClickHouse and Elasticsearch</a></li>
  <li><a href="#c">Benchmark results</a>
    <ul>
      <li><a href="#c1">Summary</a></li>
      <li><a href="#c2">Storage size</a></li>
      <li><a href="#c3">Aggregation performance</a></li>
    </ul>
  </li>
  <li><a href="#d">Summary</a></li>
</ul></article>`;

test('子清單跟著整棵樹判定,不會自己那一層全是短的就變成選單', () => {
  const root = mount(NESTED_TOC);
  const texts = findCandidates(root, () => false).map((c) => c.src);
  for (const want of ['Summary', 'Storage size', 'Aggregation performance']) {
    assert.ok(texts.includes(want), `子項 ${want} 該進內文層,實得 ${JSON.stringify(texts)}`);
  }
});

test('清單項目自己那一行也要翻,即使它底下還包著子清單', () => {
  const root = mount(NESTED_TOC);
  const found = findCandidates(root, () => false);
  const hit = found.find((c) => c.src === 'Benchmark results');
  assert.ok(hit, `「Benchmark results」不能整行消失,實得 ${JSON.stringify(found.map((c) => c.src))}`);
  assert.equal(hit.el.tagName, 'A', '單元要落在 <a> 上,不是 <li> —— <li> 的盒子蓋住整份子清單');
});

test('承載元素本身還有容器子孫就不收 —— 免得跟子孫的單元疊兩層', () => {
  // <a><h3>…</h3></a>:<h3> 已經是單元了
  const root = mount('<a href="/post"><h3>Bringing the capabilities of Claude to defenders</h3></a>');
  const found = findCandidates(root, () => false);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.el.tagName, 'H3');
});

test('表格不會因為 tbody / tr 不在容器清單裡就被收成一個大單元', () => {
  const root = mount('<table><tr><th>Tier</th><td>Balanced</td></tr></table>');
  const texts = findCandidates(root, () => false).map((c) => c.src);
  assert.deepEqual(texts, ['Tier', 'Balanced']);
});

/* -------- 外殼還是內容:同一個證據,同一個結論 -------- */

const SIDEBAR_TOC = `<nav><ul>
  <li><a href="#1">Introduction</a></li>
  <li><a href="#2">Count aggregations in ClickHouse and Elasticsearch</a></li>
  <li><a href="#3">Benchmark setup</a></li>
  <li><a href="#4">Summary</a></li>
</ul></nav>`;

test('<nav> 不再整棵排除 —— 裡面是目次的話照翻', () => {
  const texts = findCandidates(mount(SIDEBAR_TOC), () => false).map((c) => c.src);
  assert.ok(texts.includes('Introduction'), `實得 ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('Summary'));
});

test('<nav> 裡是真的選單就維持外殼待遇:不畫疊層,但滑上去看得到', () => {
  const menu = `<nav><ul>
    <li><a href="#1">Products</a></li>
    <li><a href="#2">Pricing</a></li>
    <li><a href="#3">Docs</a></li>
    <li><a href="#4">Contact</a></li>
  </ul></nav>`;
  const root = mount(menu);
  assert.deepEqual(findCandidates(root, () => false).map((c) => c.src), []);
  assert.deepEqual(findLabels(root, 50).map((c) => c.src), [
    'Products', 'Pricing', 'Docs', 'Contact',
  ]);
});

test('下拉選單不會因為子選單的字加起來很長就被當成內容', () => {
  const root = mount(`<nav><ul>
    <li><a href="#1">Products</a><ul><li><a href="#a">Cloud</a></li><li><a href="#b">Local</a></li></ul></li>
    <li><a href="#2">Pricing</a></li>
    <li><a href="#3">Docs</a></li>
  </ul></nav>`);
  assert.deepEqual(findCandidates(root, () => false).map((c) => c.src), []);
});

test('清單的長度證據看項目本身,不是只看裡面的連結', () => {
  /*
   * 每個連結都 ≤24 字,但項目本身有一整段說明 —— 那是內容清單。
   * 只量連結的話,段落翻了、底下三個連結不翻。
   */
  const root = mount(`<article><ul>
    <li><p><strong>Query 1</strong>: this is a full data scan aggregating the whole data set.</p>
      <ul>
        <li><a href="#a">ClickHouse SQL query</a></li>
        <li><a href="#b">Elasticsearch DSL query</a></li>
        <li><a href="#c">Elasticsearch ESQL query</a></li>
      </ul></li>
    <li><p><strong>Query 2</strong>: this one filters the data set before aggregating.</p>
      <ul>
        <li><a href="#d">ClickHouse SQL query</a></li>
        <li><a href="#e">Elasticsearch DSL query</a></li>
        <li><a href="#f">Elasticsearch ESQL query</a></li>
      </ul></li>
  </ul></article>`);
  const texts = findCandidates(root, () => false).map((c) => c.src);
  for (const want of ['ClickHouse SQL query', 'Elasticsearch DSL query', 'Elasticsearch ESQL query']) {
    assert.ok(texts.includes(want), `子連結 ${want} 該翻,實得 ${JSON.stringify(texts)}`);
  }
});

/* -------- 走捷徑的路徑要自己補上主路徑的每一道關卡 -------- */

test('容器自己那行字的承載元素也要遵守排除清單', () => {
  /*
   * ClickHouse 的頂部導覽是 <div><button>Products</button>…</div>。
   * <button> 在排除清單上,walk() 早就跳過了 —— captureInlineText
   * 不能從父層把它撿回來。
   */
  const root = mount('<div><button>Products</button><p>Some actual paragraph text here.</p></div>');
  const texts = findCandidates(root, () => false).map((c) => c.src);
  assert.deepEqual(texts, ['Some actual paragraph text here.']);
});

test('外殼角色的承載元素同樣不撿', () => {
  const root = mount(
    '<div><span role="toolbar">Share</span><p>Some actual paragraph text here.</p></div>',
  );
  const texts = findCandidates(root, () => false).map((c) => c.src);
  assert.deepEqual(texts, ['Some actual paragraph text here.']);
});

test('「裡面是目次就當內容」的例外不給頁首 —— mega menu 幾乎一定有長項目', () => {
  const megaMenu = `<ul>
    <li><a href="#1">Cloud — run ClickHouse without operating it yourself</a></li>
    <li><a href="#2">Docs</a></li>
    <li><a href="#3">Pricing</a></li>
  </ul>`;
  // 頁首:永遠是外殼
  assert.deepEqual(findCandidates(mount(`<header>${megaMenu}</header>`), () => false), []);
  assert.deepEqual(findCandidates(mount(`<footer>${megaMenu}</footer>`), () => false), []);
  // 導覽 / 側欄:目次會出現在這裡,照翻
  const inNav = findCandidates(mount(`<nav>${megaMenu}</nav>`), () => false).map((c) => c.src);
  assert.ok(inNav.includes('Docs'), `實得 ${JSON.stringify(inNav)}`);
  const inAside = findCandidates(mount(`<aside>${megaMenu}</aside>`), () => false).map((c) => c.src);
  assert.ok(inAside.includes('Pricing'));
});

/* ---- 頂層 <header> 裡的頁面標題:外殼還是內容(§DM) ---- */

const PAGE_HEAD = `<header class="masthead">
  <div class="eyebrow">Companion to the blog post</div>
  <h1>Know your unknowns</h1>
  <p class="intro">The map is not the territory — the gap between them is your unknowns.
    Eleven self-contained artifacts for discovering them before, during, and after
    implementation.</p>
  <nav class="toc"><a href="#pre">Pre-implementation</a><a href="#post">Post-implementation</a></nav>
</header>`;

test('頂層 <header> 裝著頁面的標題與導言 —— 那是內容,不是站台外殼', () => {
  /*
   * **使用者回報「整塊都沒翻到」的就是這個。**
   *
   * §CH 為 Wired / BBC 開的例外只蓋到 `<article><header>`。而靜態網站
   * 產生器與大多數部落格的寫法是頂層的 `<header>` 直接裝著 h1 與導言,
   * 外面沒有 `<article>` —— 於是整頁最重要的兩行字被當成外殼跳過。
   */
  const texts = findCandidates(mount(PAGE_HEAD), () => false).map((c) => c.src);
  assert.ok(texts.includes('Know your unknowns'), `h1 沒撿到:${JSON.stringify(texts)}`);
  assert.ok(
    texts.some((t) => t.startsWith('The map is not the territory')),
    `導言沒撿到:${JSON.stringify(texts)}`,
  );
});

test('分辨的訊號是散文,不是「有沒有 h1」—— logo 包在 h1 裡的橫幅照樣是外殼', () => {
  /*
   * 只看 h1 會把「站名包在 h1 裡」的正常橫幅全部誤判成內容。
   * 所以兩個條件都要:有標題,而且有一段長到不可能是標語的字。
   */
  const banner = `<header>
    <h1><a href="/">Acme</a></h1>
    <p class="tagline">Ship faster</p>
    <nav><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
  </header>`;
  assert.deepEqual(findCandidates(mount(banner), () => false), []);
});

test('mega menu 的長說明不算散文 —— 導覽區裡的東西不列入判斷', () => {
  /*
   * 下拉選單的說明文字動輒上百字。如果拿它當「這是頁面標題區」的證據,
   * 每一個有 mega menu 的站台橫幅都會被誤判成內容 —— 那是最糟的方向,
   * 因為橫幅在每一頁都出現。
   */
  const megaHead = `<header>
    <h2>Acme</h2>
    <nav><ul>
      <li><a href="#1">Cloud — run everything without operating any of it yourself, with
        automatic scaling, backups and monitoring included from day one</a></li>
      <li><a href="#2">Docs</a></li>
    </ul></nav>
  </header>`;
  assert.deepEqual(findCandidates(mount(megaHead), () => false), []);
});

test('頁首裡的標籤仍然滑得到 —— 不畫疊層不等於整棵消失', () => {
  const root = mount('<header><nav><a href="#1">Products</a><a href="#2">Pricing</a></nav></header>');
  assert.deepEqual(findCandidates(root, () => false), []);
  assert.deepEqual(findLabels(root, 50).map((c) => c.src), ['Products', 'Pricing']);
});

/* -------- 圖文儲存格:同一張表不能兩種行為 -------- */

test('圖片自己佔一行時,短連結不再被判成 UI 標籤', () => {
  /*
   * ClickHouse 的圖表表格:<th>Storage size</th> 翻了,同一張表的
   * <td><a>Link</a><span><img></span></td> 沒翻 —— 因為後者的文字
   * 全部來自一個連結。UI 標籤那條規則的理由是幾何(緊湊導覽列),
   * 而 mediaSplit 的存在本身就證明這裡不是那種版面。
   */
  const root = mount(
    '<table><thead><tr><th>Storage size</th></tr></thead>' +
      '<tbody><tr><td><a href="#x">Link</a>' +
      '<span style="display:flex"><img alt="" src="x.png"></span></td></tr></tbody></table>',
  );
  // jsdom 沒有 layout:媒體的面積門檻要自己餵一個真的矩形進去
  const img = root.querySelector('img')!;
  img.getBoundingClientRect = () =>
    ({ top: 20, left: 0, width: 400, height: 200, bottom: 220, right: 400 }) as DOMRect;
  const got = findCandidates(root, () => false);
  const texts = got.map((c) => c.src);
  assert.ok(texts.includes('Storage size'));
  assert.ok(texts.includes('Link'), `圖文儲存格也該翻,實得 ${JSON.stringify(texts)}`);
  assert.equal(got.find((c) => c.src === 'Link')?.mediaSplit?.tagName, 'SPAN');
});

test('沒有圖片的短連結還是 UI 標籤 —— 規則本身沒有變鬆', () => {
  const root = mount('<div><a href="#a">Docs</a><a href="#b">Pricing</a><a href="#c">Blog</a></div>');
  assert.deepEqual(findCandidates(root, () => false).map((c) => c.src), []);
});

test('沒有可見文字的互動子孫不佔長度預算', () => {
  /*
   * 放大按鈕的名稱在 aria-label 上,畫面一個字都沒有。
   * 把它算進來會讓預算憑空多 24 字 —— 預算要跟著文字走,不是跟著節點走。
   */
  const root = mount(
    '<div><a href="#x">A fairly long link label that is content</a>' +
      '<button aria-label="Enlarge image"></button></div>',
  );
  const texts = findCandidates(root, () => false).map((c) => c.src);
  assert.ok(
    texts.some((t) => t.includes('fairly long link label')),
    `實得 ${JSON.stringify(texts)}`,
  );
});

/* -------- 換錨點:沒有元素包著的文字 -------- */

test('鬆散文字節點也要翻 —— 用 Range 當錨點', () => {
  /*
   * markdown 轉出來的常見形狀:段落文字直接掛在容器上,沒有 <p> 包著。
   * 拿容器當單元會蓋掉整篇文章,所以改成圈住那一段。
   */
  const root = mount(
    '<div><div><p>A table lives here.</p></div>' +
      'ClickHouse requires 12 times less disk space than Elasticsearch to store the data.' +
      '<div><p>Another block.</p></div>' +
      'When the data set is pre-aggregated, ClickHouse needs 10 times less disk space.' +
      '</div>',
  );
  const got = findCandidates(root, () => false);
  const ranged = got.filter((c) => c.range !== undefined).map((c) => c.src);
  assert.equal(ranged.length, 2, `兩段鬆散文字各一個單元,實得 ${JSON.stringify(ranged)}`);
  assert.ok(ranged[0]!.startsWith('ClickHouse requires 12 times'));
  assert.ok(ranged[1]!.startsWith('When the data set is pre-aggregated'));
});

test('容器整體太長不能擋掉個別段落 —— 長度要一段一段量', () => {
  const long = 'x'.repeat(MAX_UNIT_CHARS - 40);
  const root = mount(
    `<div><p>${long}</p>` +
      'Short loose paragraph that still deserves a translation of its own.' +
      `<p>${long}</p>` +
      'Another loose paragraph living between two blocks.' +
      '</div>',
  );
  const ranged = findCandidates(root, () => false)
    .filter((c) => c.range !== undefined)
    .map((c) => c.src);
  assert.equal(ranged.length, 2, `實得 ${JSON.stringify(ranged)}`);
});

test('圖片夾在段落中間 —— 切成前後兩段,而不是整段放棄', () => {
  const root = mount(
    '<p>Runtimes of running the query over the pre-aggregated data set:' +
      '<span style="display:flex"><img alt="" src="c.png"></span>' +
      'As discussed, ESQL currently does not support the flattened field type.</p>',
  );
  const img = root.querySelector('img')!;
  img.getBoundingClientRect = () =>
    ({ top: 40, left: 0, width: 400, height: 200, bottom: 240, right: 400 }) as DOMRect;
  const ranged = findCandidates(root, () => false)
    .filter((c) => c.range !== undefined)
    .map((c) => c.src);
  assert.equal(ranged.length, 2, `實得 ${JSON.stringify(ranged)}`);
  assert.ok(ranged[0]!.startsWith('Runtimes of running'));
  assert.ok(ranged[1]!.startsWith('As discussed'));
});

test('段的聯集矩形蓋到媒體 → 那一段放棄(不蓋圖是底線)', () => {
  // mount 的假 Range rect 在 0,0~300,20;把圖放在同一塊 → 相交 → 放棄
  const root = mount('<p><img id="i" alt="" src="c.png">Note: percentages are rounded to 5%.</p>');
  const img = root.querySelector('#i')!;
  img.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 400, height: 200, bottom: 200, right: 400 }) as DOMRect;
  assert.deepEqual(findCandidates(root, () => false).map((c) => c.src), []);
});

test('已經有主人的文字不再收一次 —— <a> 包 <h3> 只出一個單元', () => {
  const root = mount('<a href="/post"><h3>Bringing the capabilities of Claude to defenders</h3></a>');
  const got = findCandidates(root, () => false);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.el.tagName, 'H3');
  assert.equal(got[0]!.range, undefined);
});

test('掃過的元素不會每一輪重新產生 range 候選', () => {
  /*
   * 這一條沒有的話,scan 會永遠回報 found > 0,掃描間隔就一直停在最短的
   * 400ms —— 每 0.4 秒對整棵樹跑一次 getComputedStyle。單元不會重複
   * (index.ts 會濾掉),但頁面會慢得像卡住。
   */
  const root = mount(
    '<div><div><p>A table lives here.</p></div>' +
      'ClickHouse requires 12 times less disk space than Elasticsearch to store the data.' +
      '</div>',
  );
  const seen = new Set<Element>();
  const first = findCandidates(root, (el) => seen.has(el));
  assert.ok(first.some((c) => c.range !== undefined), '第一輪要收到鬆散文字');
  for (const c of first) seen.add(c.el);
  assert.deepEqual(findCandidates(root, (el) => seen.has(el)), [], '第二輪不該再找到任何東西');
});

test('文章標題本身是永久連結 —— 標題標籤是內容,不是 UI 標籤', () => {
  /*
   * stratechery(以及每個 WordPress 版型)的寫法:
   *   <h2 class="entry-title"><a href="…">Autonomy and Innovation</a></h2>
   * 「文字全部來自互動子孫」那條規則看到「一個連結、23 字、沒超過 24」,
   * 於是整篇文章的標題被判成按鈕列,只剩滑上去才看得到譯文。
   */
  const body = mount(
    '<article><h2 class="entry-title"><a href="/p/">Autonomy and Innovation</a></h2>' +
      '<p>Not every Western followed the cliche, but the shorthand was consistent.</p></article>',
  );
  assert.ok(ids(body).includes('Autonomy and Innovation'), '標題要成為內文單元');
});

test('自繪 UI 的 role="heading" 仍然是 UI 標籤', () => {
  // 上一條的反面:24 字門檻是為了 Gmail 左欄那種 <div role="heading"> 調的
  const body = mount('<div><div role="heading" aria-level="2">Labels</div><a href="#l">Starred</a></div>');
  assert.deepEqual(ids(body), []);
});

/* ------------------------------------------------ foreign element(svg / math) */

/**
 * jsdom 的 `getBoundingClientRect()` 一律回 0 —— 而 svg 走的是尺寸分流
 * (行內圖示 vs 圖表)。給指定元素一個真的尺寸。
 */
function sized(body: Element, selector: string, w: number, h: number): void {
  for (const el of body.querySelectorAll(selector)) {
    el.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: w, height: h, bottom: h, right: w }) as DOMRect;
    el.getClientRects = () =>
      [{ top: 0, left: 0, width: w, height: h }] as unknown as DOMRectList;
  }
}

/*
 * 這四條全部來自同一個病根:SVG / MathML 是 foreign element,`tagName`
 * 保留原始大小寫,所以 `EXCLUDE_TAGS` / `NON_TEXT_TAGS` 裡大寫的
 * 'SVG'、'MATH' **從來沒有比對成功過**(`docs/deviations.md` §DE)。
 * 症狀有四種,看起來毫不相干 —— 所以四條都要留著。
 */

test('行內 svg 不該把段落切成兩半 —— 前半句不可以消失', () => {
  const body = mount(
    '<p>Throughput reached <svg viewBox="0 0 40 16"><text>99%</text></svg>' +
      ' during the sustained load test run.</p>',
  );
  sized(body, 'svg', 40, 16); // 徽章尺寸:面積過了 400,但高度只有 16
  const got = ids(body);
  assert.equal(got.length, 1, '一個段落就是一個單元');
  assert.ok(got[0]!.startsWith('Throughput reached'), `前半句不見了:${got[0]}`);
  assert.ok(got[0]!.includes('sustained load'), '後半句也要在');
});

test('圖示 svg 的 <title> 是 tooltip,不是句子的一部分', () => {
  const body = mount(
    '<p>Click the <svg viewBox="0 0 16 16"><title>Settings icon</title></svg>' +
      ' button to open settings for your workspace.</p>',
  );
  sized(body, 'svg', 16, 16);
  const got = ids(body);
  assert.equal(got.length, 1);
  assert.ok(!got[0]!.includes('Settings icon'), `無障礙描述漏進句子:${got[0]}`);
});

test('圖表 svg 不成為內文單元 —— 圖上文字歸 findSvgTexts,不重複覆蓋', () => {
  const body = mount(
    '<div><svg viewBox="0 0 620 200">' +
      '<text>Ingest pipeline</text><text>Merge tree</text><text>Query engine</text>' +
      '</svg></div>',
  );
  sized(body, 'svg', 620, 200);
  sized(body, 'text', 120, 18);
  assert.deepEqual(ids(body), [], 'svg 與它的 <text> 都不該是內文單元');
  assert.deepEqual(
    findSvgTexts(body, 100).map((c) => c.src),
    ['Ingest pipeline', 'Merge tree', 'Query engine'],
    '圖上文字要走 label 貼片(零視覺模型成本)',
  );
});

test('行內小 svg 的文字留在句子裡,不被 findSvgTexts 再收一次', () => {
  const body = mount('<p>Throughput reached <svg viewBox="0 0 40 16"><text>99%</text></svg> today.</p>');
  sized(body, 'svg', 40, 16);
  sized(body, 'text', 30, 12);
  assert.deepEqual(findSvgTexts(body, 100), [], '收兩次就是雙重覆蓋的另一種寫法');
});

test('MathML 的記號留在句子裡(靠佔位符保護),不被剝掉', () => {
  const body = mount(
    '<p>The bound is <math><mi>O</mi><mo>(</mo><mi>n</mi><mo>)</mo></math>' +
      ' for every input distribution we tested.</p>',
  );
  const got = ids(body);
  assert.equal(got.length, 1);
  assert.ok(got[0]!.includes('O(n)'), `記號被剝掉,句子破碎:${got[0]}`);
  assert.ok(got[0]!.includes('every input distribution'), '後半句要在');
});
