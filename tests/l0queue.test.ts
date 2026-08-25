import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotPool } from '../src/content/queue.ts';

/**
 * 使用者在 ClickHouse 那篇 268 個區塊的長文上回報「連 L0 都不動了」:
 * 佇列一開場就有 179 個在排,而**優先度是入隊時算的** ——
 * 他往下捲之後正在看的段落帶著舊順序排在第 150 位,等了 65 秒。
 */

/** 讓已排定的 microtask 跑完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('併發未滿時直接放行,不進佇列', async () => {
  const pool = new SlotPool(2);
  await pool.acquire(0);
  await pool.acquire(0);
  assert.equal(pool.depth, 0);
  assert.equal(pool.busy, true);
});

test('優先度在出隊時才算 —— 捲動後排在後面的區塊會被提前', async () => {
  const pool = new SlotPool(1);
  await pool.acquire(0); // 佔滿

  const order: string[] = [];
  // 入隊時 far 最遠、near 最近
  const distance = { near: 10, mid: 50, far: 900 };
  void pool.acquire(() => distance.far).then(() => order.push('far'));
  void pool.acquire(() => distance.mid).then(() => order.push('mid'));
  void pool.acquire(() => distance.near).then(() => order.push('near'));
  await settle();
  assert.equal(pool.depth, 3, '三個都該在排隊');
  assert.deepEqual(order, []);

  distance.far = 0; // 使用者捲到 far 那裡了

  pool.release();
  await settle();
  assert.deepEqual(order, ['far'], '出隊時重算,捲到的那個先跑');

  pool.release();
  await settle();
  assert.deepEqual(order, ['far', 'near'], '接著才是原本就最近的');

  pool.release();
  await settle();
  assert.deepEqual(order, ['far', 'near', 'mid']);
  assert.equal(pool.depth, 0);
  assert.equal(pool.busy, true); // 最後一個還在跑
  pool.release();
  assert.equal(pool.busy, false);
});

test('固定數字的優先度照舊有效', async () => {
  const pool = new SlotPool(1);
  await pool.acquire(0);
  const order: number[] = [];
  for (const p of [30, 10, 20]) void pool.acquire(p).then(() => order.push(p));
  await settle();
  for (let i = 0; i < 3; i++) {
    pool.release();
    await settle();
  }
  assert.deepEqual(order, [10, 20, 30]);
});

test('併發被調低時,多出來的槽跑完就不補新的', async () => {
  const pool = new SlotPool(3);
  await pool.acquire(0);
  await pool.acquire(0);
  await pool.acquire(0);
  const order: string[] = [];
  void pool.acquire(0).then(() => order.push('queued'));
  await settle();
  assert.equal(pool.depth, 1);

  pool.limit = 2; // adapt() 判定機器慢,降併發
  pool.release(); // 還有 2 個在跑,已經到上限了
  await settle();
  assert.deepEqual(order, [], '降併發後不該立刻補人');

  pool.release();
  await settle();
  assert.deepEqual(order, ['queued']);
});

test('clear() 清空佇列與在跑的計數', async () => {
  const pool = new SlotPool(1);
  await pool.acquire(0);
  void pool.acquire(0);
  await settle();
  assert.equal(pool.depth, 1);
  pool.clear();
  assert.equal(pool.depth, 0);
  assert.equal(pool.busy, false);
});
