import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { bleedFor, inkOverflow } from '../src/content/bleed.ts';
import {
  annotBg,
  annotFg,
  composite,
  isSerifStack,
  lightText,
  parseColor,
  probeStyle,
  resetColorCache,
  rgbToCss,
  targetWeight,
  unparsedColors,
} from '../src/content/styleprobe.ts';
import { cacheKey, maxCharsBucket } from '../src/shared/hash.ts';

test('parseColor 的快路徑認得 rgb / rgba / transparent', () => {
  assert.deepEqual(parseColor('rgb(255, 255, 255)'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
});

/*
 * lab() / oklch() / color-mix() 走 canvas 慢路徑,在 node 裡沒有 canvas
 * 所以回 null —— 這裡驗的是「沒有 canvas 也不會炸、也不會亂猜」。
 * 真正的轉換由瀏覽器負責,人工驗收見 docs/acceptance.md。
 */
test('新式顏色語法在沒有 canvas 的環境安全地回 null,並且被記下來', () => {
  resetColorCache();
  assert.equal(parseColor('lab(88.8292% 0 -.0000119209)'), null);
  assert.equal(parseColor('oklch(0.7 0.1 200)'), null);
  assert.equal(parseColor('這根本不是顏色'), null);
  const bad = unparsedColors();
  assert.ok(bad.includes('oklch(0.7 0.1 200)'), `應該記下來,實得 ${JSON.stringify(bad)}`);
});

test('rgb 快路徑不會被記成解析失敗', () => {
  resetColorCache();
  parseColor('rgb(1, 2, 3)');
  parseColor('transparent');
  assert.deepEqual(unparsedColors(), []);
});

test('§4.1 背景一律以完整不透明度套用', () => {
  const c = parseColor('rgba(18, 24, 30, 0.4)')!;
  assert.equal(rgbToCss(c, 1), 'rgb(18, 24, 30)');
});

test('§4.2 襯線判定看整個 stack,但 sans-serif 開頭的不算襯線', () => {
  assert.equal(isSerifStack('Georgia, "Times New Roman", serif'), true);
  assert.equal(isSerifStack('"Source Serif Pro", serif'), true);
  assert.equal(isSerifStack('sans-serif, Georgia'), false);
  assert.equal(isSerifStack('system-ui, -apple-system, sans-serif'), false);
  assert.equal(isSerifStack('Inter, Helvetica, Arial'), false);
});

test('§4.3 字重 +100,但小字級與已經 600 以上的不加', () => {
  assert.equal(targetWeight(400, 16, 100), 500);
  assert.equal(targetWeight(400, 16, 200), 600);
  assert.equal(targetWeight(400, 16, 0), 400);
  // 小字級加重會糊
  assert.equal(targetWeight(400, 13, 100), 400);
  // 避免頂到 700 上限、壓縮與正文的階層差
  assert.equal(targetWeight(700, 32, 100), 700);
  assert.equal(targetWeight(600, 32, 100), 600);
  // clamp 下限
  assert.equal(targetWeight(100, 20, 100), 300);
});

test('§9 maxChars 以 16 字為一級分桶', () => {
  assert.equal(maxCharsBucket(0), 1);
  assert.equal(maxCharsBucket(15), 1);
  assert.equal(maxCharsBucket(16), 1);
  assert.equal(maxCharsBucket(31), 1);
  assert.equal(maxCharsBucket(32), 2);
});

test('§9 快取 key 由 src / 語言 / 模型 / 長度桶 四者決定', async () => {
  const a = await cacheKey('hello', 'zh-TW', 'gemini-3.5-flash-lite', 40);
  const same = await cacheKey('hello', 'zh-TW', 'gemini-3.5-flash-lite', 46);
  const otherModel = await cacheKey('hello', 'zh-TW', 'gemini-3.5-flash', 40);
  const otherBucket = await cacheKey('hello', 'zh-TW', 'gemini-3.5-flash-lite', 96);
  assert.equal(a, same); // 同一個長度桶不必各存一份
  assert.notEqual(a, otherModel);
  assert.notEqual(a, otherBucket);
  assert.match(a, /^[0-9a-f]{64}$/);
});

/* -------------------------------------------------- 出血:蓋住原文的墨水 */

test('行距壓得比墨水高度小時,上下各補一半的溢出量', () => {
  // claude.com/blog 的 h1:64px 字、line-height 64px,墨水約 1.16 em = 74px
  const ink = 64 * 1.16;
  assert.equal(inkOverflow(ink, 64), (74.24 - 64) / 2);
  const b = bleedFor(ink, 64, 0, 'heading');
  assert.equal(b.y, Math.ceil((74.24 - 64) / 2)); // 6px:g 的尾巴不再露出來
});

test('行距正常的段落不出血,不會蓋到相鄰區塊', () => {
  const ink = 16 * 1.16; // 18.56
  const b = bleedFor(ink, 26, 0, 'body');
  assert.equal(b.y, 0);
  assert.equal(b.x, 0);
});

test('options 的固定出血一律加上去,量不到的東西靠它', () => {
  const b = bleedFor(16 * 1.16, 26, 2, 'body');
  assert.equal(b.y, 2);
  assert.equal(b.x, 2);
});

test('表格儲存格左右不出血:蓋掉相鄰資料比露一點更糟', () => {
  const b = bleedFor(16 * 1.16, 12, 3, 'cell');
  assert.equal(b.x, 0);
  assert.ok(b.y > 0);
});

test('出血永遠不是負的', () => {
  const b = bleedFor(10, 40, 0, 'body');
  assert.equal(b.y, 0);
  assert.equal(b.x, 0);
});

/*
 * ClickHouse 部落格的迴歸:深色頁面上的半透明白卡片。
 *
 * `rgba(255,255,255,0.1)` 疊在近黑色的版面上,畫面是深灰;
 * 舊版把它當成「找到不透明色了」直接以全白畫出去,配上頁面自己的
 * 淺灰字就是使用者說的「選色錯誤了」。合成才是對的答案。
 */
test('半透明背景要合成到底下的實色,不能直接當成不透明', () => {
  const card = parseColor('rgba(255, 255, 255, 0.1)')!;
  const page = parseColor('rgb(19, 19, 18)')!;
  const out = composite([card], page);
  assert.ok(out.r < 60, `合成後應該還是深色,得到 ${rgbToCss(out, 1)}`);
  assert.ok(out.r > 19, '但要比純底色亮一點');
});

test('多層半透明由遠而近疊,結果落在兩端之間', () => {
  const base = parseColor('rgb(0, 0, 0)')!;
  const one = composite([parseColor('rgba(255,255,255,0.1)')!], base);
  const two = composite(
    [parseColor('rgba(255,255,255,0.1)')!, parseColor('rgba(255,255,255,0.1)')!],
    base,
  );
  assert.ok(two.r > one.r, '兩層比一層亮');
  assert.ok(two.r < 255, '仍然遠離純白');
});

test('標註配色跟著頁面明暗走,不寫死淺色', () => {
  // 深色頁面(亮字)
  assert.equal(lightText('rgb(223, 223, 223)'), true);
  assert.ok(annotBg('rgb(223, 223, 223)').startsWith('rgba(24'));
  assert.equal(annotFg('rgb(223, 223, 223)'), '#F0A868');
  // 淺色頁面(暗字)—— 維持原本的便條紙配色
  assert.equal(lightText('rgb(36, 41, 47)'), false);
  assert.ok(annotBg('rgb(36, 41, 47)').startsWith('rgba(230'));
  assert.equal(annotFg('rgb(36, 41, 47)'), '#993C1D');
});

/*
 * 目次一半黃字一半白字:class 一樣,我們問的元素不一樣。
 * `<li><a>Introduction</a></li>` 的墨水是 <a> 的,單元卻建在 <li> 上。
 */
test('文字整段裝在單一子元素裡時,顏色取那一層', () => {
  const dom = new JSDOM(
    '<!doctype html><body>' +
      '<li id="wrapped"><a style="color: rgb(250, 255, 105)">Introduction</a></li>' +
      '<p id="mixed" style="color: rgb(223, 223, 223)">Read the <a style="color: rgb(250, 255, 105)">docs</a> first.</p>' +
      '<li id="two"><a style="color: rgb(250, 255, 105)">A</a><span style="color: red">B</span></li>' +
      '</body>',
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = dom.window.document;
  g['getComputedStyle'] = dom.window.getComputedStyle.bind(dom.window);
  g['matchMedia'] = () => ({ matches: false });
  const at = (id: string): string => probeStyle(dom.window.document.getElementById(id)!, 100).color;

  assert.equal(at('wrapped'), 'rgb(250, 255, 105)', '整段裝在 <a> 裡 → 取 <a> 的黃');
  assert.equal(at('mixed'), 'rgb(223, 223, 223)', '段落自己有文字 → 主色仍然是段落的');
  assert.equal(at('two'), 'rgb(0, 0, 0)', '兩個子元素 → 不猜,用自己的');
});

test('LAYER_CSS 的註解裡不可以有反引號', () => {
  /*
   * 這條看起來很蠢,而我在同一個地方踩了三次。
   *
   * LAYER_CSS 是一個 template literal,而我習慣在註解裡用反引號標記
   * 程式碼(`.imgwrap`、`brightness(1.16)`)—— 那會**把字串提前關掉**,
   * 後面幾百行 CSS 就被當成 JS 解析。錯誤訊息出現在幾百行之外
   * (「An identifier or keyword cannot immediately follow a numeric literal」),
   * 完全指不到病根。
   *
   * typecheck 抓得到,但它說的話沒有人看得懂。這條測試說得懂。
   */
  const src = readFileSync(new URL('../src/content/overlay.ts', import.meta.url), 'utf8');
  const open = src.indexOf('export const LAYER_CSS = `');
  assert.ok(open >= 0, '找不到 LAYER_CSS');
  const body = src.slice(open + 'export const LAYER_CSS = `'.length);
  const end = body.indexOf('\n`;');
  assert.ok(end > 0, '找不到 LAYER_CSS 的結尾');
  const css = body.slice(0, end);
  const bad = css.split('\n').filter((l) => l.includes('`'));
  assert.deepEqual(
    bad,
    [],
    `CSS 裡有反引號會把 template literal 提前關掉,改用「」或直接寫:\n  ${bad.join('\n  ')}`,
  );
});

test('「祖先會不會裁切」只能有一份定義 —— 第三份就是 §DZ 的事故', () => {
  /*
   * 同一條規則(overflow ≠ visible 的祖先會裁掉內容,但傳播給視窗的那層
   * 不算)已經出過兩次事:§DV 修了 clippedAway 的那份,§DZ 發現 clippers()
   * 還有一份沒跟著修 —— 同一個站、同一個症狀第三次回來。
   *
   * 這裡用 grep 把它變成機械的:src/content 裡凡是問「overflow 是不是
   * visible」的地方,只允許 occlusion.ts(定義的家)和 cover.ts 的 spills
   * (那是在問**元素自己**會不會把內容溢出去,不是祖先裁不裁 ——
   * 另一個問題,合法)。新的呼叫者請 import clipsContent。
   */
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allowed = new Set(['occlusion.ts', 'cover.ts']);
  const dir = path.join(root, 'src', 'content');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    if (allowed.has(f)) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.equal(
      /overflow[XY]\s*[!=]==?\s*'visible'/.test(src),
      false,
      `${f} 自己另寫了一份「overflow 裁不裁」的判斷 —— 用 occlusion.ts 的 clipsContent`,
    );
  }
});

test('「這顆鍵是不是 Alt」只能有一份定義 —— keys.ts(§EB)', () => {
  /*
   * §EA 補右 Alt(AltGraph)時 isAltKey 住在 index.ts;§EB 把按鍵決策
   * 抽成 keys.ts 之後它搬了家。散寫的 `key === 'Alt'` 就是下一個
   * 「只認左邊那顆」—— 用 grep 擋住。
   *
   * snapshot.ts 合法:那是塞進除錯快照頁的獨立腳本,跑在另一個
   * document 裡,import 不到這邊的模組。
   */
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allowed = new Set(['keys.ts', 'snapshot.ts']);
  const dir = path.join(root, 'src', 'content');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    if (allowed.has(f)) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.equal(
      /key\s*[!=]==?\s*'Alt(Graph)?'/.test(src),
      false,
      `${f} 自己另寫了一份「是不是 Alt」的判斷 —— 用 keys.ts 的 isAltKey`,
    );
  }
});
