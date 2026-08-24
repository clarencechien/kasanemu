import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  MAX_UNIT_CHARS,
  findCandidates,
  findLabels,
  isMeaningfulText,
  looksLikeTargetLang,
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

test('§3.1 aria-hidden / contenteditable / translate=no / .notranslate 一律排除', () => {
  const body = mount(
    '<p aria-hidden="true">Decorative text here</p>' +
      '<p contenteditable="">Editable text here</p>' +
      '<p translate="no">Brand Name Here</p>' +
      '<p class="notranslate">Do not touch this</p>' +
      '<p>Translate this one.</p>',
  );
  assert.deepEqual(ids(body), ['Translate this one.']);
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

test('§3.5 position: sticky / fixed 的元素及其子樹跳過', () => {
  const body = mount(
    '<div style="position: sticky"><p>Sticky toolbar label</p></div>' +
      '<div style="position: fixed"><p>Fixed banner text</p></div>' +
      '<p>Normal flow text.</p>',
  );
  assert.deepEqual(ids(body), ['Normal flow text.']);
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

test('超過字數上限的區塊不建立單元(容器誤判的最後防線)', () => {
  const long = 'This sentence is a filler used to exceed the unit cap. '.repeat(30);
  assert.ok(long.length > MAX_UNIT_CHARS);
  const body = mount(`<p>${long}</p>`);
  assert.deepEqual(ids(body), []);
  // 正常長度的段落不受影響
  const ok = mount('<p>A normal paragraph of reasonable length.</p>');
  assert.deepEqual(ids(ok), ['A normal paragraph of reasonable length.']);
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

test('加翻候選:行動版的重複導覽列不會被收第二次', () => {
  const body = mount(`
    <nav class="desktop"><a href="/pricing">Pricing</a></nav>
    <nav class="mobile"><a href="/pricing">Pricing</a></nav>
  `);
  assert.deepEqual(findLabels(body, 200).map((c) => c.src), ['Pricing']);
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
