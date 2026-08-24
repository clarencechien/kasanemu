import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { hasPua, mask, protectedFragments } from '../src/content/mask.ts';
import { normalizeSourceLang, toTranslatorTarget } from '../src/content/lang.ts';
import {
  dwellReady,
  hintClassFor,
  maxCharsAt,
  priorityOf,
  swapAllowed,
} from '../src/content/upgrade.ts';

/* ------------------------------------------------ §3.4 佔位符保護 */

const PH0 = '';
const PH1 = '';

test('§3.4 佔位符是單一私用區字元,不是 __CODE_1__(開放問題 3)', () => {
  const m = mask('Run npm install before the build.', ['npm install']);
  assert.equal(m.text, `Run ${PH0} before the build.`);
  assert.equal(m.tokens.length, 1);
  assert.ok(!/[A-Za-z_]/.test(PH0));
});

test('還原:譯文裡的佔位符換回原文片段', () => {
  const m = mask('Run npm install first.', ['npm install']);
  assert.equal(m.restore(`請先執行 ${PH0}。`), '請先執行 npm install。');
});

test('佔位符遺失 → 回 null,不交出少了程式碼的譯文', () => {
  const m = mask('Run npm install first.', ['npm install']);
  assert.equal(m.restore('請先執行安裝指令。'), null);
});

test('長片段先換,短片段不會把長片段切碎', () => {
  const m = mask('Chrome OS and Chrome differ.', ['Chrome', 'Chrome OS']);
  // Chrome OS 先被換掉,剩下的 Chrome 才換
  assert.equal(m.tokens[0], 'Chrome OS');
  assert.equal(m.text, `${PH0} and ${PH1} differ.`);
  assert.equal(m.restore(`${PH0} 與 ${PH1} 不同。`), 'Chrome OS 與 Chrome 不同。');
});

test('同一片段出現多次都會被保護,還原時全部換回', () => {
  const m = mask('git push, then git push again.', ['git push']);
  assert.equal(m.text, `${PH0}, then ${PH0} again.`);
  assert.equal(m.restore(`先 ${PH0},再 ${PH0} 一次。`), '先 git push,再 git push 一次。');
});

test('來源本來就含私用區字元 → 放棄保護,不製造撞號', () => {
  assert.equal(hasPua(`weird ${PH0} text`), true);
  const m = mask(`weird ${PH0} npm install`, ['npm install']);
  assert.equal(m.tokens.length, 0);
  assert.equal(m.text, `weird ${PH0} npm install`);
  // 沒有佔位符要還原,原樣回傳
  assert.equal(m.restore('奇怪的文字'), '奇怪的文字');
});

test('沒有東西要保護時,text 與原文相同', () => {
  const m = mask('Plain sentence.', []);
  assert.equal(m.text, 'Plain sentence.');
  assert.equal(m.restore('普通句子。'), '普通句子。');
});

test('§3.4 行內 code / kbd / samp 自動納入保護,加上不翻清單', () => {
  const dom = new JSDOM(
    '<!doctype html><body><p>Call <code>refreshOrigin()</code> then press <kbd>Alt+T</kbd> in Kasanemu.</p></body>',
  );
  const p = dom.window.document.querySelector('p')!;
  const frags = protectedFragments(p, ['Kasanemu']);
  assert.deepEqual(frags, ['refreshOrigin()', 'Alt+T', 'Kasanemu']);
});

/* ------------------------------------------------ 來源 / 目標語言 */

test('來源語言取 <html lang> 的主語言碼,取不到用預設', () => {
  assert.equal(normalizeSourceLang('en-US', 'xx'), 'en');
  assert.equal(normalizeSourceLang('  JA  ', 'xx'), 'ja');
  assert.equal(normalizeSourceLang('zh_Hant_TW', 'xx'), 'zh');
  assert.equal(normalizeSourceLang('', 'en'), 'en');
  assert.equal(normalizeSourceLang('x', 'en'), 'en');
});

test('目標語言轉成 Translator API 的 script subtag', () => {
  assert.equal(toTranslatorTarget('zh-TW'), 'zh-Hant');
  assert.equal(toTranslatorTarget('zh-Hant'), 'zh-Hant');
  assert.equal(toTranslatorTarget('zh-CN'), 'zh-Hans');
  assert.equal(toTranslatorTarget('zh-Hans'), 'zh-Hans');
  assert.equal(toTranslatorTarget('ja'), 'ja');
});

/* ------------------------------------------------ §4.2 升級資格 (D21) */

const base = { tier: 'l0' as const, inView: true, inViewSince: 1000, l1Queued: false };

test('§4.2 / D21:可見且停留超過門檻才排入 L1', () => {
  assert.equal(dwellReady(base, 2500, 1500, 'progressive'), true);
  assert.equal(dwellReady(base, 2400, 1500, 'progressive'), false);
});

test('純粹滑過去的區塊留在 L0,不花錢', () => {
  // 離開可見區時 inViewSince 被清掉
  assert.equal(
    dwellReady({ ...base, inView: false, inViewSince: undefined }, 9999, 1500, 'progressive'),
    false,
  );
});

test('只有 progressive 會升級;single 走自己的路,l0-only 永遠不升級', () => {
  assert.equal(dwellReady(base, 9999, 1500, 'single'), false);
  assert.equal(dwellReady(base, 9999, 1500, 'l0-only'), false);
});

test('已排過的不重複排;已經是 l1 的不再升級;l0-failed 仍要升級', () => {
  assert.equal(dwellReady({ ...base, l1Queued: true }, 9999, 1500, 'progressive'), false);
  assert.equal(dwellReady({ ...base, tier: 'l1' }, 9999, 1500, 'progressive'), false);
  assert.equal(dwellReady({ ...base, tier: 'l0-failed' }, 9999, 1500, 'progressive'), true);
  assert.equal(dwellReady({ ...base, tier: 'pending' }, 9999, 1500, 'progressive'), false);
});

test('§4.2 佇列排序:距視窗中心越近越優先', () => {
  // 視窗 0–800,中心 400
  const near = priorityOf(380, 40, 0, 800);
  const far = priorityOf(1200, 40, 0, 800);
  assert.ok(near < far);
  assert.equal(priorityOf(380, 40, 0, 800), 0);
  // 捲動之後同一個區塊的優先序會變 —— 這就是「捲動時重排佇列」的依據
  assert.ok(priorityOf(1200, 40, 1000, 800) < far);
});

/* ------------------------------------------------ §4.3 替換時機 */

const swapBase = {
  isHovered: false,
  sinceScrollMs: 1000,
  rectTop: 100,
  rectHeight: 50,
  scrollY: 0,
  viewportH: 900,
};

test('§4.3 hover 中的區塊不被替換', () => {
  assert.equal(swapAllowed({ ...swapBase, isHovered: true }), false);
  assert.equal(swapAllowed(swapBase), true);
});

test('§4.3 剛捲動 < 400ms 且在中央三分之一 → 延後', () => {
  // 中央三分之一 = 300–600
  const middle = { ...swapBase, sinceScrollMs: 100, rectTop: 400 };
  assert.equal(swapAllowed(middle), false);
  // 同樣剛捲動,但不在中央三分之一 → 可以換
  assert.equal(swapAllowed({ ...middle, rectTop: 50, rectHeight: 20 }), true);
  // 捲動已經停了 → 中央也可以換
  assert.equal(swapAllowed({ ...middle, sinceScrollMs: 500 }), true);
});

/* ------------------------------------------------ §4.4 長度預算 (D20) */

test('§4.4 / D20:鎖定字級越小,容得下的字數越多', () => {
  const w = 600;
  const h = 96;
  const lh = 24;
  const at16 = maxCharsAt(w, h, 16, lh);
  const at13 = maxCharsAt(w, h, 12.8, lh); // 16 × 0.8
  assert.ok(at13 > at16);
  // 36 字/行 × 4 行 × 0.92
  assert.equal(at16, Math.floor(Math.floor(600 / 16.32) * 4 * 0.92));
});

test('極小容器至少給 8 個字的預算', () => {
  assert.equal(maxCharsAt(10, 10, 16, 24), 8);
});

/* ------------------------------------------------ §5.1 提示線階層 (D22) */

test('§5.1 / D22:提示線以虛實與顏色區分階層', () => {
  assert.equal(hintClassFor('l0', true), 'l0');
  assert.equal(hintClassFor('l1', true), 'l1');
  assert.equal(hintClassFor('l1-failed', true), 'warn');
  assert.equal(hintClassFor('failed', true), 'warn dashed');
});

test('還沒有結果的區塊不畫提示線;關掉提示線時一律不畫', () => {
  assert.equal(hintClassFor('pending', true), null);
  assert.equal(hintClassFor('l0-failed', true), null);
  assert.equal(hintClassFor('skipped', true), null);
  assert.equal(hintClassFor('l0', false), null);
  assert.equal(hintClassFor('failed', false), null);
});

test('L1 死掉時不會看起來像正常運作:l1 與 l1-failed 的樣式必須不同', () => {
  assert.notEqual(hintClassFor('l1', true), hintClassFor('l1-failed', true));
  assert.notEqual(hintClassFor('l1', true), hintClassFor('l0', true));
});
