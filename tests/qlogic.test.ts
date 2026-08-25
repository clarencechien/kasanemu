import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATE_MS,
  aggregateWaitMs,
  appendNew,
  backoffMs,
  itemKey,
  remove,
  takeBatch,
  type QueueItem,
} from '../src/worker/queuelogic.ts';

/**
 * queue 這一帶前後修了七八次,每一次都是使用者踩到才發現 ——
 * 因為決策和 chrome API 揉在一起,測試碰不到。抽出來之後,
 * 這裡把每一條修過的規則都釘住。
 */

let seq = 0;
function item(over: Partial<QueueItem> = {}): QueueItem {
  seq++;
  return {
    id: `u${seq}`,
    src: `第 ${seq} 段的原文,長度普通。`,
    maxChars: 80,
    role: 'body',
    tabId: 1,
    pageKey: 'pageA',
    tier: 'free',
    pipeline: 'progressive',
    attempts: 0,
    priority: 0,
    at: 1_000,
    ...over,
  } as QueueItem;
}

test('takeBatch 只切同 tab / 同 page / 同檔位 / 同管線的群組', () => {
  const q = [
    item({ pageKey: 'pageA' }),
    item({ pageKey: 'pageB' }),
    item({ pageKey: 'pageA' }),
    item({ tier: 'fast', pageKey: 'pageA' }),
  ];
  const got = takeBatch(q, 10, 100_000);
  assert.equal(got.length, 2);
  assert.ok(got.every((i) => i.pageKey === 'pageA' && i.tier === 'free'));
});

test('takeBatch 群組內照 priority 排(距視窗中心越近越先),群組本身照 FIFO', () => {
  const far = item({ priority: 900 });
  const near = item({ priority: 10 });
  const mid = item({ priority: 500 });
  const got = takeBatch([far, near, mid], 10, 100_000);
  assert.deepEqual(got.map((i) => i.priority), [10, 500, 900]);
});

test('takeBatch:一筆就超過 token 上限的長段落也要送得出去,不能永遠堵在佇列頭', () => {
  const long = item({ src: '很長的段落 '.repeat(400) });
  const got = takeBatch([long, item()], 10, 50);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.id, long.id);
});

test('takeBatch 受兩個上限夾:筆數與 token', () => {
  const q = Array.from({ length: 10 }, () => item());
  assert.equal(takeBatch(q, 3, 100_000).length, 3);
  // token 上限很小:第一筆照收,第二筆就停
  assert.equal(takeBatch(q, 10, 1).length, 1);
});

test('appendNew 以 tab:page:id 去重 —— 看門狗重排靠這條保證冪等', () => {
  const a = item();
  const { next, added } = appendNew([a], [a, item()], 2_000);
  assert.equal(added, 1);
  assert.equal(next.length, 2);
  // 相同 id 但不同 page 不算重複
  const other = { ...a, pageKey: 'pageB' };
  assert.equal(appendNew([a], [other], 2_000).added, 1);
});

test('appendNew 蓋上 attempts=0 與進佇列時間', () => {
  const { next } = appendNew([], [item({ at: 999_999, attempts: 3 } as Partial<QueueItem>)], 5_000);
  assert.equal(next[0]!.attempts, 0);
  assert.equal(next[0]!.at, 5_000);
});

test('remove 以複合鍵移除,不靠物件同一性', () => {
  const a = item();
  const clone = JSON.parse(JSON.stringify(a)) as QueueItem;
  assert.equal(remove([a], [clone]).length, 0);
  assert.equal(itemKey(a), itemKey(clone));
});

test('aggregateWaitMs:沒湊滿而且最舊的還沒等夠 → 等剩下的時間', () => {
  const b = [item({ at: 1_000 })];
  assert.equal(aggregateWaitMs(b, 6, 1_100), AGGREGATE_MS - 100);
  // 等夠了就送
  assert.equal(aggregateWaitMs(b, 6, 1_000 + AGGREGATE_MS), 0);
  // 湊滿了就送
  assert.equal(aggregateWaitMs(Array.from({ length: 6 }, () => item({ at: 1_000 })), 6, 1_001), 0);
});

test('aggregateWaitMs:重試的不等 —— 它們已經等過一輪了', () => {
  assert.equal(aggregateWaitMs([item({ at: 1_000, attempts: 1 })], 6, 1_001), 0);
});

test('backoffMs:base 2s、指數、上限 60s', () => {
  assert.equal(backoffMs(1), 2_000);
  assert.equal(backoffMs(2), 4_000);
  assert.equal(backoffMs(3), 8_000);
  assert.equal(backoffMs(10), 60_000);
});
