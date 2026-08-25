import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverRect } from '../src/content/cover.ts';
import type { Unit } from '../src/content/unit.ts';

/**
 * 只驗 coverRect 這一條規則,不需要真的 DOM ——
 * 假一個「有 scrollHeight 但沒有 client rect」的元素就夠了,
 * 而那正是收折的 <details> 與 content-visibility 被跳過的內容的樣子。
 */
function fakeUnit(opts: {
  rects: number;
  rect: { left: number; top: number; width: number; height: number };
  scrollWidth: number;
  scrollHeight: number;
  overflow?: string;
}): Unit {
  const el = {
    getClientRects: () => ({ length: opts.rects }),
    getBoundingClientRect: () => opts.rect,
    scrollWidth: opts.scrollWidth,
    scrollHeight: opts.scrollHeight,
  };
  const g = globalThis as Record<string, unknown>;
  g['getComputedStyle'] = () => ({
    overflowX: opts.overflow ?? 'visible',
    overflowY: opts.overflow ?? 'visible',
  });
  g['window'] = { scrollX: 0, scrollY: 1200 };
  return {
    el: el as unknown as Element,
    style: { border: [0, 0, 0, 0] },
  } as unknown as Unit;
}

test('沒有 client rect 就是沒被畫出來,一律回零', () => {
  /*
   * 這一條是「收折的 <details> 疊層堆到視窗左上角」的病根:
   * 佈局被跳過(rect 是 0×0),但 scrollHeight 保留著上一次的尺寸,
   * 於是盒子被撐成 W×H 而座標留在 (0,0) —— 換算成 document 座標
   * 就是視窗左上角,一整批全部疊在那裡蓋掉真正的內容。
   */
  const { rect, overflows } = coverRect(
    fakeUnit({
      rects: 0,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      scrollWidth: 620,
      scrollHeight: 84,
    }),
  );
  assert.deepEqual(rect, { left: 0, top: 0, width: 0, height: 0 });
  assert.equal(overflows, false);
});

test('有畫出來的時候,內容比 border-box 大仍然要撐開', () => {
  // 緊排標題:固定高度 + overflow: visible,照 border-box 蓋會露出半個 g
  const { rect, overflows } = coverRect(
    fakeUnit({
      rects: 1,
      rect: { left: 40, top: 100, width: 600, height: 30 },
      scrollWidth: 600,
      scrollHeight: 44,
    }),
  );
  assert.deepEqual(rect, { left: 40, top: 1300, width: 600, height: 44 });
  assert.equal(overflows, true);
});

test('元素自己會裁切時不撐開 —— scrollWidth 是沒被畫出來的內容', () => {
  const { rect } = coverRect(
    fakeUnit({
      rects: 1,
      rect: { left: 10, top: 20, width: 1, height: 1 },
      scrollWidth: 900,
      scrollHeight: 20,
      overflow: 'hidden',
    }),
  );
  assert.equal(rect.width, 1);
  assert.equal(rect.height, 1);
});
