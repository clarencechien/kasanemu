import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findCandidates, isMeaningfulText, looksLikeTargetLang } from '../src/content/detect.ts';

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

function ids(body: Element): string[] {
  return findCandidates(body, () => false).map((c) => c.src);
}

before(() => {
  // 讓 detect.ts 在 import 之後才碰到 DOM
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
