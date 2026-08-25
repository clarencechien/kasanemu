import type { Tier } from '../shared/models';
import type { Pipeline, UnitRequest } from '../shared/types';
import { estimateTokens } from './protocol.ts';

/**
 * L1 佇列的**純決策邏輯**:切批、去重、退避、湊批等待。
 *
 * 為什麼獨立成檔:queue 這一帶前後修了七八次(missing-id 補送、
 * 空回應重送、看門狗對帳、優先序活算),每一次都是使用者踩到才發現 ——
 * 因為決策和 chrome.storage / chrome.tabs 揉在同一支檔案裡,
 * 測試碰不到。這裡刻意一行 chrome API 都沒有,node:test 直接測。
 * 執行期的讀寫序列化(mutateQueue)留在 scheduler.ts。
 */

export interface QueueItem extends UnitRequest {
  tabId: number;
  pageKey: string;
  tier: Tier;
  attempts: number;
  /** feature.md §2.2 花費按模式分開累計 */
  pipeline: Pipeline;
  /** feature.md §4.2 距視窗中心的距離,越小越先送 */
  priority: number;
  /** 進佇列的時間,用來湊 batch(見 AGGREGATE_MS) */
  at: number;
}

/** §7.3 指數退避,base 2s,上限 60s,最多 4 次 */
export const MAX_ATTEMPTS = 4;
const BACKOFF_BASE = 2_000;
const BACKOFF_CAP = 60_000;

/**
 * 升級是零星觸發的(停留滿 1.5 秒的區塊一個一個到期),照單全收的話
 * 每個段落各發一次 API 請求 —— §5.4 給 free 檔的 6 塊/batch 從來沒湊滿過,
 * 而且單筆請求更容易讓小模型回出格式不對的東西(實測 got:0 的空陣列)。
 * 代價是第一批 L1 晚 600ms —— 反正 L0 已經在畫面上了。
 */
export const AGGREGATE_MS = 600;

export function itemKey(i: Pick<QueueItem, 'tabId' | 'pageKey' | 'id'>): string {
  return `${i.tabId}:${i.pageKey}:${i.id}`;
}

/** 每筆估算的 token:內容 + JSON 包裝的固定開銷 */
export function itemTokens(i: Pick<QueueItem, 'src'>): number {
  return estimateTokens(i.src) + 24;
}

/** enqueue 的去重附加:已經在佇列裡的 id 不重複收(看門狗重排靠這條保證冪等) */
export function appendNew(
  q: QueueItem[],
  items: Array<Omit<QueueItem, 'attempts' | 'at'>>,
  now: number,
): { next: QueueItem[]; added: number } {
  const known = new Set(q.map(itemKey));
  const next = [...q];
  let added = 0;
  for (const it of items) {
    if (known.has(itemKey(it))) continue;
    known.add(itemKey(it));
    next.push({ ...it, attempts: 0, at: now });
    added++;
  }
  return { next, added };
}

/** 從佇列裡切出一個 batch:同 tab / 同 page / 同檔位,受 §5.4 的兩個上限夾 */
export function takeBatch(q: QueueItem[], maxUnits: number, maxTokens: number): QueueItem[] {
  const head = q[0];
  if (!head) return [];
  // feature.md §4.2 佇列排序:距視窗中心越近越優先。
  // 只在同一個 tab / page / 檔位 / 管線的群組內排序,群組本身照 FIFO。
  const group = q
    .filter(
      (it) =>
        it.tabId === head.tabId &&
        it.pageKey === head.pageKey &&
        it.tier === head.tier &&
        it.pipeline === head.pipeline,
    )
    .sort((a, b) => a.priority - b.priority);
  const batch: QueueItem[] = [];
  let tokens = 0;
  for (const it of group) {
    if (batch.length >= maxUnits) break;
    const t = itemTokens(it);
    // 第一筆永遠收:一筆就超過 token 上限的長段落也要能送出去,
    // 否則它會永遠堵在佇列頭
    if (batch.length > 0 && tokens + t > maxTokens) break;
    tokens += t;
    batch.push(it);
  }
  return batch;
}

export function remove(q: QueueItem[], batch: ReadonlyArray<QueueItem>): QueueItem[] {
  const ids = new Set(batch.map(itemKey));
  return q.filter((i) => !ids.has(itemKey(i)));
}

/**
 * 還沒湊滿一批而且最舊的也還沒等夠 → 回傳還要等幾 ms;0 = 直接送。
 * 重試的(attempts > 0)不等 —— 它們已經等過一輪了。
 */
export function aggregateWaitMs(batch: QueueItem[], batchUnits: number, now: number): number {
  if (batch.length === 0 || batch.length >= batchUnits) return 0;
  if (batch.some((b) => b.attempts > 0)) return 0;
  const oldest = Math.min(...batch.map((b) => b.at));
  return Math.max(0, AGGREGATE_MS - (now - oldest));
}

/** §7.3 指數退避。worst 是這一批裡最高的 attempts(1 起算)。 */
export function backoffMs(worst: number): number {
  return Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (Math.max(1, worst) - 1));
}
