import type { Tier } from '../shared/models';
import { getSettings, resolveTier } from '../shared/settings';
import type { ToContent } from '../shared/messages';
import type { Settings, UnitFailure, UnitRequest, UnitResult } from '../shared/types';
import { dbg, warn } from '../shared/log';
import { callBatch } from './gemini';
import { estimateTokens, parseBatch } from './protocol';
import * as cache from './cache';
import { addPageTokens, checkAllowed, recordSpend } from './budget';
import { reserve, throttleDown, throttleOverride } from './tokenBucket';

interface QueueItem extends UnitRequest {
  tabId: number;
  pageKey: string;
  tier: Tier;
  attempts: number;
}

const QUEUE_KEY = 'queue';
const MAX_ATTEMPTS = 4; // §7.3 最多 4 次
const BACKOFF_BASE = 2_000;
const BACKOFF_CAP = 60_000;

let draining = false;

async function loadQueue(): Promise<QueueItem[]> {
  const got = await chrome.storage.session.get(QUEUE_KEY);
  return (got[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
}

async function saveQueue(q: QueueItem[]): Promise<void> {
  await chrome.storage.session.set({ [QUEUE_KEY]: q });
}

function post(tabId: number, msg: ToContent): void {
  if (msg.type === 'notice') {
    // §6.5 / §12.2 失敗與降級必須看得見。console 只有開著 devtools 才看得到,
    // 所以最後一則也落地給 popup 讀。
    void chrome.storage.session.set({
      lastNotice: { level: msg.level, text: msg.text, at: Date.now() },
    });
  }
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    /* tab 已關或還沒注入,忽略 */
  });
}

export async function enqueue(
  tabId: number,
  pageKey: string,
  tier: Tier,
  units: UnitRequest[],
): Promise<void> {
  const q = await loadQueue();
  const known = new Set(q.map((i) => `${i.tabId}:${i.pageKey}:${i.id}`));
  for (const u of units) {
    const k = `${tabId}:${pageKey}:${u.id}`;
    if (known.has(k)) continue;
    q.push({ ...u, tabId, pageKey, tier, attempts: 0 });
  }
  await saveQueue(q);
  await ensureAlarm(q.length > 0);
  void drain();
}

export async function dropPage(tabId: number, pageKey: string): Promise<void> {
  const q = await loadQueue();
  await saveQueue(q.filter((i) => !(i.tabId === tabId && i.pageKey === pageKey)));
}

export async function dropTab(tabId: number): Promise<void> {
  const q = await loadQueue();
  await saveQueue(q.filter((i) => i.tabId !== tabId));
}

async function ensureAlarm(needed: boolean): Promise<void> {
  // §7.4 service worker 會被回收,用 alarm 把排程叫回來
  if (needed) await chrome.alarms.create('drain', { delayInMinutes: 0.5 });
  else await chrome.alarms.clear('drain');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 從佇列裡切出一個 batch:同 tab / 同 page / 同檔位,受 §5.4 的兩個上限夾 */
function takeBatch(q: QueueItem[], maxUnits: number, maxTokens: number): QueueItem[] {
  const head = q[0];
  if (!head) return [];
  const batch: QueueItem[] = [];
  let tokens = 0;
  for (let i = 0; i < q.length && batch.length < maxUnits; i++) {
    const it = q[i]!;
    if (it.tabId !== head.tabId || it.pageKey !== head.pageKey || it.tier !== head.tier) continue;
    const t = estimateTokens(it.src) + 24;
    if (batch.length > 0 && tokens + t > maxTokens) break;
    tokens += t;
    batch.push(it);
  }
  return batch;
}

function remove(q: QueueItem[], batch: QueueItem[]): QueueItem[] {
  const ids = new Set(batch.map((b) => `${b.tabId}:${b.pageKey}:${b.id}`));
  return q.filter((i) => !ids.has(`${i.tabId}:${i.pageKey}:${i.id}`));
}

export async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const settings = await getSettings();
    for (let guard = 0; guard < 200; guard++) {
      let q = await loadQueue();
      if (q.length === 0) {
        await ensureAlarm(false);
        return;
      }
      const head = q[0]!;
      const throttle = await throttleOverride(head.tier);
      const spec = resolveTier(head.tier, settings);
      const live = throttle ? { ...spec, rpm: throttle.rpm, tpm: throttle.tpm } : spec;
      let batch = takeBatch(q, live.batchUnits, live.batchTokens);
      if (batch.length === 0) {
        q = remove(q, [head]);
        await saveQueue(q);
        continue;
      }

      // ---- §9 先吃快取,命中的不進 API
      const hits: UnitResult[] = [];
      const misses: QueueItem[] = [];
      for (const it of batch) {
        const k = await cache.keyFor(it.src, settings.targetLang, live.modelId, it.maxChars);
        const hit = await cache.get(settings.cacheMode, k);
        if (hit !== null) hits.push({ id: it.id, t: hit });
        else misses.push(it);
      }
      if (hits.length > 0) {
        post(head.tabId, { type: 'results', pageKey: head.pageKey, results: hits });
      }
      await saveQueue(remove(await loadQueue(), batch.filter((b) => !misses.includes(b))));
      batch = misses;
      if (batch.length === 0) continue;

      const planned = batch.reduce((a, b) => a + estimateTokens(b.src) + 24, 0);

      // ---- §8 保險絲
      const verdict = await checkAllowed(settings, live, head.pageKey, planned);
      if (!verdict.allow) {
        post(head.tabId, {
          type: 'notice',
          pageKey: head.pageKey,
          level: 'warn',
          text: verdict.text ?? '保險絲擋下請求',
        });
        await failBatch(batch, 'budget-stop');
        await saveQueue(remove(await loadQueue(), batch));
        continue;
      }
      if (verdict.text) {
        post(head.tabId, { type: 'notice', pageKey: head.pageKey, level: 'warn', text: verdict.text });
      }

      // ---- §7.2 token bucket
      const gate = await reserve(live, planned);
      if (!gate.ok) {
        if (gate.reason === 'rpd') {
          // §7.3 RPD 耗盡:提示切換檔位,不自動升檔花錢
          post(head.tabId, {
            type: 'notice',
            pageKey: head.pageKey,
            level: 'warn',
            text: `${live.modelId} 今日請求數已達設定上限,請在 popup 換檔位或調整 options 配額`,
          });
          await failBatch(batch, 'rate-limit');
          await saveQueue(remove(await loadQueue(), batch));
          continue;
        }
        dbg('bucket wait', gate);
        await sleep(Math.min(gate.waitMs, 15_000));
        continue;
      }

      await runBatch(batch, live, settings, head.tabId, head.pageKey);
    }
  } finally {
    draining = false;
    const q = await loadQueue();
    await ensureAlarm(q.length > 0);
    if (q.length > 0) dbg('queue still has', q.length);
  }
}

async function failBatch(batch: QueueItem[], reason: UnitFailure['reason']): Promise<void> {
  const byTab = new Map<string, { tabId: number; pageKey: string; failures: UnitFailure[] }>();
  for (const it of batch) {
    const k = `${it.tabId}:${it.pageKey}`;
    const g = byTab.get(k) ?? { tabId: it.tabId, pageKey: it.pageKey, failures: [] };
    g.failures.push({ id: it.id, reason });
    byTab.set(k, g);
  }
  for (const g of byTab.values()) {
    post(g.tabId, { type: 'failures', pageKey: g.pageKey, failures: g.failures });
  }
}

async function runBatch(
  batch: QueueItem[],
  spec: ReturnType<typeof resolveTier>,
  settings: Settings,
  tabId: number,
  pageKey: string,
): Promise<void> {
  const units: UnitRequest[] = batch.map((b) => ({
    id: b.id,
    src: b.src,
    maxChars: b.maxChars,
    role: b.role,
  }));
  const res = await callBatch(settings.apiKey, spec, units, settings.targetLang);

  if (!res.ok) {
    if (res.retriable) {
      // §7.3 指數退避,base 2s,上限 60s,最多 4 次
      const next = batch.map((b) => ({ ...b, attempts: b.attempts + 1 }));
      const worst = Math.max(...next.map((n) => n.attempts));
      if (worst > MAX_ATTEMPTS) {
        warn('連續失敗達上限,永久標記失敗', { status: res.status, ids: batch.map((b) => b.id) });
        await failBatch(batch, res.status === 429 ? 'rate-limit' : 'api-error');
        await saveQueue(remove(await loadQueue(), batch));
        return;
      }
      if (res.status === 429) {
        const lowered = await throttleDown(spec.tier, { rpm: spec.rpm, tpm: spec.tpm });
        post(tabId, {
          type: 'notice',
          pageKey,
          level: 'warn',
          text: `429:已把 ${spec.tier} 的節流下調到 ${lowered.rpm} RPM / ${lowered.tpm} TPM,第 ${worst} 次重試`,
        });
      }
      const q = await loadQueue();
      const kept = remove(q, batch);
      await saveQueue([...next, ...kept]);
      await sleep(Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** (worst - 1)));
      return;
    }
    // 不可重試(例如 400 走完降級階梯、401 key 錯)
    post(tabId, {
      type: 'notice',
      pageKey,
      level: 'error',
      text: `API ${res.status}: ${res.message.slice(0, 160)}`,
    });
    await failBatch(batch, 'api-error');
    await saveQueue(remove(await loadQueue(), batch));
    return;
  }

  // ---- 記帳。§8 第 3 層計數跨重排累計
  await recordSpend(spec, res.usage);
  await addPageTokens(pageKey, res.usage.prompt + res.usage.output + res.usage.thoughts);

  const parsed = parseBatch(res.text, units, res.truncated);
  dbg('parse', parsed.stats);
  if (parsed.results.length > 0) {
    post(tabId, { type: 'results', pageKey, results: parsed.results });
    for (const r of parsed.results) {
      const src = batch.find((b) => b.id === r.id);
      if (!src) continue;
      const k = await cache.keyFor(src.src, settings.targetLang, spec.modelId, src.maxChars);
      await cache.put(settings.cacheMode, k, r.t);
    }
    if (settings.cacheMode === 'persistent') await cache.evictIfNeeded(settings.persistentCacheMB);
  }
  if (parsed.failures.length > 0) {
    // §6.5 丟棄或失敗的區塊必須明確標示,不得沉默略過
    post(tabId, { type: 'failures', pageKey, failures: parsed.failures });
    const kinds = new Set(parsed.failures.map((f) => f.reason));
    post(tabId, {
      type: 'notice',
      pageKey,
      level: 'warn',
      text: `${parsed.failures.length} 個區塊未通過 id 紀律檢查 (${[...kinds].join(', ')})`,
    });
  }
  await saveQueue(remove(await loadQueue(), batch));
}
