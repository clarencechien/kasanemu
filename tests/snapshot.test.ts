import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pathOf, resolvePath } from '../src/content/snapshot.ts';

/**
 * 快照把譯文寫進 DOM 的**複本**,而複本與本體的樹形一樣 ——
 * 所以「這個節點在哪裡」可以用 childNode 索引路徑表達,兩邊通用。
 * 這裡驗的就是那個對應關係(整份快照的行為由瀏覽器驗收,見 scripts/)。
 */
function tree(html: string): { root: Element; clone: Element } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const root = dom.window.document.documentElement;
  return { root, clone: root.cloneNode(true) as Element };
}

test('路徑在複本上指到同一個節點', () => {
  const { root, clone } = tree('<div><p>one</p><p id="two">two</p></div>');
  const target = root.querySelector('#two')!;
  const path = pathOf(target, root);
  assert.ok(path);
  const found = resolvePath(path, clone) as Element;
  assert.equal(found.id, 'two');
  assert.notEqual(found, target, '拿到的必須是複本上的那一個');
});

test('文字節點也有路徑 —— 鬆散文字的錨點就在那裡', () => {
  const { root, clone } = tree('<div><p>block</p>loose text here</div>');
  const div = root.querySelector('div')!;
  const loose = div.childNodes[1]!;
  assert.equal(loose.nodeType, 3);
  const path = pathOf(loose, root);
  assert.ok(path);
  assert.equal(resolvePath(path, clone)?.nodeValue, 'loose text here');
});

test('不在這棵樹裡的節點回 null,不是亂猜一個', () => {
  const { root } = tree('<p>x</p>');
  const other = new JSDOM('<!doctype html><body><p>y</p>').window.document.querySelector('p')!;
  assert.equal(pathOf(other, root), null);
});

test('路徑走不通就回 null —— 複本被改過的時候不能硬套', () => {
  const { root, clone } = tree('<div><p>one</p><p>two</p></div>');
  const path = pathOf(root.querySelectorAll('p')[1]!, root);
  clone.querySelector('div')!.innerHTML = '';
  assert.equal(resolvePath(path!, clone), null);
});
