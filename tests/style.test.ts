import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bleedFor, inkOverflow } from '../src/content/bleed.ts';
import { isSerifStack, parseColor, rgbToCss, targetWeight } from '../src/content/styleprobe.ts';
import { cacheKey, maxCharsBucket } from '../src/shared/hash.ts';

test('parseColor 認得 rgb / rgba / transparent,認不得的回 null', () => {
  assert.deepEqual(parseColor('rgb(255, 255, 255)'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('color(srgb 1 0 0)'), null);
  assert.equal(parseColor('oklch(0.7 0.1 200)'), null);
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
