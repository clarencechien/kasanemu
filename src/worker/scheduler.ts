import type { Tier } from '../shared/models';
import { getSettings, resolveTier } from '../shared/settings';
import type { ToContent } from '../shared/messages';
import type { Pipeline, Settings, UnitFailure, UnitRequest, UnitResult } from '../shared/types';
import { diag } from '../shared/diag';
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
  /** feature.md §2.2 花費按模式分開累計 */
  pipeline: Pipeline;
  /** feature.md §4.2 距視窗中心的距離,越小越先送 */
  priority: number;
  /** 進佇列的時間,用來湊 batch(見 AGGREGATE_MS) */
  at: number;
}

/**
 * 升級是零星觸發的(停留滿 1.5 秒的區塊一個一個到期),照單全收的話
 * 每個段落各發一次 API 請求 —— §5.4 給 free 檔的 6 塊/batch 從來沒湊滿過,
 * 而且單筆請求更容易讓小模型回出格式不對的東西(實測 got:0 的空陣列)。
 *
 * 所以還沒湊滿 batch 上限時,讓最舊的項目等一下,湊多一點再送。
 * 代價是第一批 L1 晚 600ms —— 反正 L0 已經在畫面上了。
 */
const AGGREGATE_MS = 600;

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
  chrome.tabs.sendMessage(tabId, msg).catch((e: unknown) => {
    /*
     * tab 已關或還沒注入是正常的,但**譯文送不到就是譯文不見了** ——
     * 佇列在 runBatch 結尾就清掉了,沒有人會再送一次。
     * 使用者那五塊「排進去卻沒變 L1」的嫌疑人就在這裡,
     * 而上一版這個 catch 是空的,log 裡一行都沒有。
     */
    if (msg.type === 'results' || msg.type === 'failures') {
      diag('warn', 'post-failed', {
        kind: msg.type,
        tabId,
        n: msg.type === 'results' ? msg.results.length : msg.failures.length,
        err: String((e as Error)?.message ?? e).slice(0, 80),
      });
    }
  });
}

export async function enqueue(
  tabId: number,
  pageKey: string,
  tier: Tier,
  pipeline: Pipeline,
  units: UnitRequest[],
  priorities: Record<string, number> = {},
): Promise<void> {
  const q = await loadQueue();
  const known = new Set(q.map((i) => `${i.tabId}:${i.pageKey}:${i.id}`));
  for (const u of units) {
    const k = `${tabId}:${pageKey}:${u.id}`;
    if (known.has(k)) continue;
    q.push({
      ...u,
      tabId,
      pageKey,
      tier,
      pipeline,
      attempts: 0,
      priority: priorities[u.id] ?? 0,
      at: Date.now(),
    });
  }
  await saveQueue(q);
  diag('info', 'enqueued', { asked: units.length, queue: q.length, tier, pipeline });
  await ensureAlarm(q.length > 0);
  void drain();
}

/**
 * feature.md §4.2:使用者捲動時重排佇列,距視窗中心越近越優先。
 * 已送出的請求不取消 —— 取消不會退錢。
 */
export async function reprioritize(
  tabId: number,
  pageKey: string,
  priorities: Record<string, number>,
): Promise<void> {
  const q = await loadQueue();
  let touched = 0;
  for (const item of q) {
    if (item.tabId !== tabId || item.pageKey !== pageKey) continue;
    const p = priorities[item.id];
    if (p === undefined) continue;
    item.priority = p;
    touched++;
  }
  if (touched > 0) await saveQueue(q);
}

/**
 * feature.md §4.6 / D23:快取命中時跳過 L0,直接以 L1 譯文渲染。
 * 這條路徑不碰保險絲、不碰 token bucket,也不排佇列 —— 純讀。
 */
export async function cacheProbe(
  tier: Tier,
  units: Array<{ id: string; src: string; maxChars: number }>,
): Promise<{ hits: UnitResult[] }> {
  const settings = await getSettings();
  const spec = resolveTier(tier, settings);
  const hits: UnitResult[] = [];
  for (const u of units) {
    const k = await cache.keyFor(u.src, settings.targetLang, spec.modelId, u.maxChars);
    const hit = await cache.get(settings.cacheMode, k);
    if (hit !== null) hits.push({ id: u.id, t: hit });
  }
  return { hits };
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

      // 還沒湊滿一批,而且最舊的也還沒等夠 → 先等,不要一個區塊發一次請求
      const oldest = Math.min(...batch.map((b) => b.at));
      const waited = Date.now() - oldest;
      if (batch.length < live.batchUnits && waited < AGGREGATE_MS && batch.every((b) => b.attempts === 0)) {
        await sleep(AGGREGATE_MS - waited);
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
        diag('warn', 'fuse-blocked', { reason: verdict.reason, text: verdict.text });
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
    // 佇列還有東西 = 東西還在 worker 這一側。內容腳本那邊看到的「卡住」
    // 到底是誰扣著,只有把兩邊的數字都寫進 log 才分得出來。
    if (q.length > 0) diag('info', 'queue-remains', { n: q.length });
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
    diag('error', 'api-failed', {
      status: res.status,
      message: res.message,
      model: spec.modelId,
      units: batch.length,
    });
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
  await recordSpend(spec, res.usage, batch[0]?.pipeline ?? 'single');
  await addPageTokens(pageKey, res.usage.prompt + res.usage.output + res.usage.thoughts);

  const parsed = parseBatch(res.text, units, res.truncated);
  dbg('parse', parsed.stats);
  diag(parsed.failures.length > 0 ? 'warn' : 'info', 'batch-parsed', {
    // 回 0 筆是小模型的格式問題,不看原始回應就只能猜
    ...(parsed.stats.got === 0 ? { rawHead: res.text.slice(0, 200) } : {}),
    model: spec.modelId,
    truncated: res.truncated,
    ...parsed.stats,
    // 誤殺與真對滑的差別全在這裡,所以失敗的細節要留下來
    failures: parsed.failures.slice(0, 6).map((f) => `${f.id} ${f.reason} ${f.detail ?? ''}`),
  });
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
  /*
   * 整批回 0 筆:重送一次同一批。
   *
   * 實測 gemma-4-31b-it 偶爾回 `[]`(rawHead 記到的是 "[]\n```" ——
   * 一個包在 markdown 圍籬裡的空陣列)。那不是缺句,是模型這一次沒產出,
   * 重送通常就有了。
   *
   * 這**不違反** §5.4「不要用縮小 chunk 再戰解決缺句」:
   * 那條講的是把 batch 切小去追缺句,病根在 id 紀律。這裡不切小、不改協定,
   * 只是同一批再送一次,屬於 §7.3 的重試範疇。上限一次,避免無人看管的重試迴圈。
   */
  if (parsed.stats.got === 0 && batch.every((b) => b.attempts === 0)) {
    diag('warn', 'empty-response-retry', { model: spec.modelId, units: batch.length });
    const q = await loadQueue();
    await saveQueue([...batch.map((b) => ({ ...b, attempts: 1 })), ...remove(q, batch)]);
    return;
  }

  if (parsed.failures.length > 0) {
    // §6.5 丟棄或失敗的區塊必須明確標示,不得沉默略過
    post(tabId, { type: 'failures', pageKey, failures: parsed.failures });
    const kinds = new Set(parsed.failures.map((f) => f.reason));
    if (parsed.stats.swapped) {
      // 這是 §5.5 等級的事:這個模型在這個 batch 大小下會對錯句
      post(tabId, {
        type: 'notice',
        pageKey,
        level: 'error',
        text:
          `偵測到 batch 內 id 對滑,${parsed.failures.length} 筆整批丟棄。` +
          `${spec.modelId} 在 ${batch.length} 筆的 batch 下把譯文對錯了句 —— ` +
          `換檔位,或把該檔的 batch 調小`,
      });
    } else {
      const first = parsed.failures.find((f) => f.detail)?.detail;
      post(tabId, {
        type: 'notice',
        pageKey,
        level: 'warn',
        text:
          `${parsed.failures.length} 個區塊未通過 id 紀律檢查 (${[...kinds].join(', ')})` +
          (first ? ` — ${first}` : ''),
      });
    }
  }
  await saveQueue(remove(await loadQueue(), batch));
}
