import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeByText,
  labelBudget,
  overlaps,
  place,
  resolveAnchor,
} from '../src/content/annotate.ts';

const VIEW = { width: 1280, height: 800 };
const CHIP = { width: 90, height: 26 };

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

test('放置:預設放在標籤下方,左緣對齊', () => {
  const anchor = rect(300, 200, 120, 20);
  const at = place({ rect: anchor }, CHIP, VIEW);
  assert.equal(at.left, 300);
  assert.equal(at.top, 224); // 200 + 20 + GAP(4)
});

test('放置:下方放不下就翻到上方', () => {
  // 標籤貼著視窗底部
  const anchor = rect(300, 770, 120, 20);
  const at = place({ rect: anchor }, CHIP, VIEW);
  assert.equal(at.top, 770 - CHIP.height - 4);
});

test('放置:不蓋住它自己在解釋的那個標籤', () => {
  // 窄視窗:左右都放不下,只剩上下
  const narrow = { width: 150, height: 400 };
  for (const top of [12, 200, 360]) {
    const anchor = rect(10, top, 120, 20);
    const at = place({ rect: anchor }, CHIP, narrow);
    assert.equal(overlaps(at, anchor), false, `top=${top}`);
  }
});

test('放置:視窗矮到幾何上無解時,取蓋得比較少的那一邊,而且仍在視窗內', () => {
  // 標籤 20 + 間距 4 + 貼片 26 = 50,再加上下邊距已經超過 60:無解
  const tiny = { width: 140, height: 60 };
  const anchor = rect(10, 18, 120, 20);
  const at = place({ rect: anchor }, CHIP, tiny);
  assert.ok(at.top >= 0 && at.top + at.height <= tiny.height, 'still in viewport');
  assert.ok(at.left >= 0 && at.left + at.width <= tiny.width, 'still in viewport');
});

test('放置:永遠不出視窗', () => {
  for (const anchor of [rect(0, 0, 60, 18), rect(1240, 780, 40, 18), rect(-20, 400, 60, 18)]) {
    const at = place({ rect: anchor }, CHIP, VIEW);
    assert.ok(at.left >= 0, `left ${at.left}`);
    assert.ok(at.top >= 0, `top ${at.top}`);
    assert.ok(at.left + at.width <= VIEW.width, `right ${at.left + at.width}`);
    assert.ok(at.top + at.height <= VIEW.height, `bottom ${at.top + at.height}`);
  }
});

test('放置:已經放好的貼片會被讓開(Alt 掃視一整條導覽列)', () => {
  const a = place({ rect: rect(300, 200, 120, 20) }, CHIP, VIEW);
  // 第二個標籤緊鄰第一個,寬度不足以讓貼片錯開
  const b = place({ rect: rect(340, 200, 120, 20) }, CHIP, VIEW, 'chip', [a]);
  assert.equal(overlaps(a, b), false);
});

test('放置:patch 模式就是要蓋在錨點上(圖片裡的一塊字)', () => {
  const img = rect(100, 100, 400, 300);
  // 圖片中央偏下的一塊字
  const at = place({ rect: img, sub: [0.25, 0.5, 0.5, 0.1] }, { width: 200, height: 30 }, VIEW, 'patch');
  assert.equal(at.left, 200); // 100 + 0.25 * 400
  assert.equal(at.top, 250); // 100 + 0.5 * 300
});

test('正規化子矩形換算成視窗座標', () => {
  const at = resolveAnchor({ rect: rect(100, 100, 400, 300), sub: [0.5, 0.25, 0.25, 0.5] });
  assert.deepEqual(at, { left: 300, top: 175, width: 100, height: 150 });
});

test('標籤的譯文預算:限的是簡潔,不是塞不塞得下', () => {
  // 「Settings」不該變成「設定與偏好選項」
  assert.equal(labelBudget('Settings'), 6);
  assert.equal(labelBudget('Contact sales'), 8);
  // 再短也給得下最少的字數
  assert.equal(labelBudget('OK'), 6);
});

test('同一段文字只送一次,但每個元素都保有自己的單元', () => {
  const cards = [
    { id: 'a', src: '詳細を見る' },
    { id: 'b', src: '詳細を見る' },
    { id: 'c', src: 'もっと詳しく' },
    { id: 'd', src: '詳細を見る' },
  ];
  const sent = dedupeByText(cards, new Set());
  assert.deepEqual(sent.map((u) => u.id), ['a', 'c']);
});

test('已經送過或已經有譯文的不再送', () => {
  const units = [
    { id: 'a', src: 'Pricing' },
    { id: 'b', src: 'Docs', l1Text: '文件' },
    { id: 'c', src: 'Support' },
  ];
  const sent = dedupeByText(units, new Set(['Pricing']));
  assert.deepEqual(sent.map((u) => u.id), ['c']);
});
