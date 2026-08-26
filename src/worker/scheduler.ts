import type { Tier } from '../shared/models';
import { getSettings, resolveTier } from '../shared/settings';
import type { ToContent } from '../shared/messages';
import type { Pipeline, Settings, UnitFailure, UnitRequest, UnitResult } from '../shared/types';
import { diag } from '../shared/diag';
import {
  glossaryFingerprint,
  promptTerms,
  resolveGlossary,
  type Term,
} from '../shared/glossary';
import { dbg, warn } from '../shared/log';
import { callBatch } from './gemini';
import { parseBatch } from './protocol';
import {
  MAX_ATTEMPTS,
  aggregateWaitMs,
  appendNew,
  backoffMs,
  itemTokens,
  remove,
  takeBatch,
  type QueueItem,
} from './queuelogic';
import {
  IMAGE_MAX_ATTEMPTS,
  addJob,
  dropPageJobs,
  nextJobs,
  removeJobs,
  type ImageJob,
} from './imagequeue';
import { fetchImage } from './imagefetch';
import { callVision } from './vision';
import { estimateImageTokens, type ImageBlock } from '../shared/imageblocks';
import * as cache from './cache';
import { addPageTokens, checkAllowed, recordSpend } from './budget';
import { reserve, throttleDown, throttleOverride } from './tokenBucket';

const QUEUE_KEY = 'queue';

let draining = false;

async function loadQueue(): Promise<QueueItem[]> {
  const got = await chrome.storage.session.get(QUEUE_KEY);
  return (got[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
}

async function saveQueue(q: QueueItem[]): Promise<void> {
  await chrome.storage.session.set({ [QUEUE_KEY]: q });
}

/**
 * **佇列的每一次寫入都走這裡,一次一個。**
 *
 * enqueue(訊息)、reprioritize(捲動)、dropPage(換頁)、drain(排程)
 * 各自「load → 改 → save」,而它們之間全是 await 邊界 —— 交錯的結果是
 * 後寫的把先寫的蓋掉:drain 把做完的 batch 移出佇列存檔,捲動觸發的
 * reprioritize 拿著**舊版佇列**改完優先序存回去,做完的項目就這樣復活、
 * 再跑一遍(快取擋住了帳單,擋不住多跑的迴圈)。§CR 的 diag 互蓋
 * 是同一個病:read-modify-write 沒有序列化。
 *
 * fn 收到剛讀出來的佇列,回傳新佇列;整段串在同一條 promise chain 上。
 * 決策本身(切批、去重、退避)在 queuelogic.ts,純函式、有測試。
 */
let qchain: Promise<unknown> = Promise.resolve();

function mutateQueue(fn: (q: QueueItem[]) => QueueItem[]): Promise<QueueItem[]> {
  const p = qchain.then(async () => {
    const next = fn(await loadQueue());
    await saveQueue(next);
    return next;
  });
  qchain = p.catch(() => undefined);
  return p;
}

/**
 * 這一頁生效的詞表。**worker 這一側自己解析**,不從內容腳本帶過來 ——
 * 判斷只有一份(`docs/lessons.md` §1),而 pageKey 裡就有 host。
 */
function glossaryFor(pageKey: string, settings: Settings): Term[] {
  try {
    return resolveGlossary(new URL(pageKey).hostname, settings);
  } catch {
    return resolveGlossary('', settings); // pageKey 壞掉時只用全域詞表
  }
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
  const q = await mutateQueue((prev) =>
    appendNew(
      prev,
      units.map((u) => ({
        ...u,
        tabId,
        pageKey,
        tier,
        pipeline,
        priority: priorities[u.id] ?? 0,
      })),
      Date.now(),
    ).next,
  );
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
  await mutateQueue((q) =>
    q.map((item) => {
      if (item.tabId !== tabId || item.pageKey !== pageKey) return item;
      const p = priorities[item.id];
      return p === undefined ? item : { ...item, priority: p };
    }),
  );
}

/**
 * feature.md §4.6 / D23:快取命中時跳過 L0,直接以 L1 譯文渲染。
 * 這條路徑不碰保險絲、不碰 token bucket,也不排佇列 —— 純讀。
 */
export async function cacheProbe(
  tier: Tier,
  units: Array<{ id: string; src: string; maxChars: number }>,
  pageKey = '',
): Promise<{ hits: UnitResult[] }> {
  const settings = await getSettings();
  const spec = resolveTier(tier, settings);
  const gloss = glossaryFor(pageKey, settings);
  const hits: UnitResult[] = [];
  for (const u of units) {
    const k = await cache.keyFor(
      u.src,
      settings.targetLang,
      spec.modelId,
      u.maxChars,
      glossaryFingerprint(u.src, gloss),
    );
    const hit = await cache.get(settings.cacheMode, k);
    if (hit !== null) hits.push({ id: u.id, t: hit });
  }
  return { hits };
}

/**
 * 佇列現在有什麼。**這是「到底是誰扣著」唯一能對起來的數字。**
 *
 * 內容腳本說「這五塊在佇列裡」,worker 說「佇列是空的」——
 * 兩句話擺在一起才看得出訊息掉在中間;分開看,兩邊都像正常的。
 * 協定裡本來就有 `page-status` 這條訊息,只是從來沒有人實作它。
 */
export async function queueStatus(
  pageKey?: string,
  ids?: string[],
): Promise<{
  total: number;
  page: number;
  oldestMs: number;
  draining: boolean;
  /** 問到的 id 裡,還在佇列裡的那幾筆 */
  has: string[];
}> {
  const q = await loadQueue();
  const mine = pageKey === undefined ? q : q.filter((i) => i.pageKey === pageKey);
  const now = Date.now();
  const held = new Set(mine.map((i) => i.id));
  return {
    total: q.length,
    page: mine.length,
    oldestMs: mine.length > 0 ? now - Math.min(...mine.map((i) => i.at)) : 0,
    draining,
    has: (ids ?? []).filter((id) => held.has(id)),
  };
}

export async function dropPage(tabId: number, pageKey: string): Promise<void> {
  await mutateQueue((q) => q.filter((i) => !(i.tabId === tabId && i.pageKey === pageKey)));
}

export async function dropTab(tabId: number): Promise<void> {
  await mutateQueue((q) => q.filter((i) => i.tabId !== tabId));
}

async function ensureAlarm(needed: boolean): Promise<void> {
  // §7.4 service worker 會被回收,用 alarm 把排程叫回來
  if (needed) await chrome.alarms.create('drain', { delayInMinutes: 0.5 });
  else await chrome.alarms.clear('drain');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}



export async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const settings = await getSettings();
    for (let guard = 0; guard < 200; guard++) {
      const q = await loadQueue();
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
        await mutateQueue((cur) => remove(cur, [head]));
        continue;
      }

      // 還沒湊滿一批,而且最舊的也還沒等夠 → 先等,不要一個區塊發一次請求
      const wait = aggregateWaitMs(batch, live.batchUnits, Date.now());
      if (wait > 0) {
        await sleep(wait);
        continue;
      }

      // ---- §9 先吃快取,命中的不進 API
      const hits: UnitResult[] = [];
      const misses: QueueItem[] = [];
      const gloss = glossaryFor(head.pageKey, settings);
      for (const it of batch) {
        const k = await cache.keyFor(
          it.src,
          settings.targetLang,
          live.modelId,
          it.maxChars,
          glossaryFingerprint(it.src, gloss),
        );
        const hit = await cache.get(settings.cacheMode, k);
        if (hit !== null) hits.push({ id: it.id, t: hit });
        else misses.push(it);
      }
      if (hits.length > 0) {
        post(head.tabId, { type: 'results', pageKey: head.pageKey, results: hits });
      }
      const done = batch.filter((b) => !misses.includes(b));
      if (done.length > 0) await mutateQueue((cur) => remove(cur, done));
      batch = misses;
      if (batch.length === 0) continue;

      const planned = batch.reduce((a, b) => a + itemTokens(b), 0);

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
        await mutateQueue((cur) => remove(cur, batch));
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
          await mutateQueue((cur) => remove(cur, batch));
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
  const gloss = glossaryFor(pageKey, settings);
  /*
   * 路徑 B:把詞表也寫進 prompt(`docs/plan-glossary.md` §4.2)。
   *
   * 只在這個檔位**實測過**遵循率的時候做(`spec.glossaryPrompt`),
   * 使用者可以用 `glossaryPrompt: 'on' | 'off'` 覆蓋。
   * 關掉不代表詞表失效 —— 佔位符那條路一直都在。
   */
  const usePrompt =
    settings.glossaryPrompt === 'on' ||
    (settings.glossaryPrompt !== 'off' && spec.glossaryPrompt);
  const inPrompt = usePrompt
    ? promptTerms(units.map((u) => u.src), gloss)
    : { terms: [], dropped: 0 };
  if (inPrompt.dropped > 0) {
    diag('warn', 'glossary-truncated', { used: inPrompt.terms.length, dropped: inPrompt.dropped });
  }

  const res = await callBatch(
    settings.apiKey,
    spec,
    units,
    settings.targetLang,
    inPrompt.terms,
  );

  if (!res.ok) {
    if (res.retriable) {
      // §7.3 指數退避,base 2s,上限 60s,最多 4 次
      const next = batch.map((b) => ({ ...b, attempts: b.attempts + 1 }));
      const worst = Math.max(...next.map((n) => n.attempts));
      if (worst > MAX_ATTEMPTS) {
        warn('連續失敗達上限,永久標記失敗', { status: res.status, ids: batch.map((b) => b.id) });
        await failBatch(batch, res.status === 429 ? 'rate-limit' : 'api-error');
        await mutateQueue((cur) => remove(cur, batch));
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
      await mutateQueue((cur) => [...next, ...remove(cur, batch)]);
      await sleep(backoffMs(worst));
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
    await mutateQueue((cur) => remove(cur, batch));
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
      const k = await cache.keyFor(
        src.src,
        settings.targetLang,
        spec.modelId,
        src.maxChars,
        glossaryFingerprint(src.src, gloss),
      );
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
    await mutateQueue((cur) => [...batch.map((b) => ({ ...b, attempts: 1 })), ...remove(cur, batch)]);
    return;
  }

  /*
   * **缺句補一次。**
   *
   * 使用者的原話:「清了 cache 再翻一次,還是有 L0,只是換不同點了」。
   * 上一份 log 裡就一則 `5 個區塊未通過 id 紀律檢查 (missing-id)` ——
   * 那五塊當場變成 `l1-failed`,而它們的唯一出路是使用者自己滑上去重試。
   * 於是每一頁都會剩下幾塊沒升級,而且每次剩的都不一樣。
   *
   * 這**不是** §5.4 說的「縮小 chunk 再戰追缺句」:沒有切小、沒有改協定,
   * 缺的那幾筆原封不動丟回同一個佇列,由排程器和別的區塊重新湊批 ——
   * 和上面那個「整批回 0 筆就重送」同一個道理,屬於 §7.3 的重試範疇。
   * `attempts` 卡住上限:只補一次,不做無人看管的重試迴圈。
   *
   * 對滑(`echo-swap`)不在此列 —— 那是整批不可信,重送也還是不可信。
   */
  const retryIds = new Set(
    parsed.failures.filter((f) => f.reason === 'missing-id').map((f) => f.id),
  );
  const retryItems = parsed.stats.swapped
    ? []
    : batch.filter((b) => retryIds.has(b.id) && b.attempts === 0);
  const retrySet = new Set(retryItems.map((b) => b.id));
  const hardFailures = parsed.failures.filter((f) => !retrySet.has(f.id));
  if (retryItems.length > 0) {
    diag('warn', 'missing-id-retry', { units: retryItems.length, model: spec.modelId });
  }

  if (hardFailures.length > 0) {
    // §6.5 丟棄或失敗的區塊必須明確標示,不得沉默略過
    post(tabId, { type: 'failures', pageKey, failures: hardFailures });
    const kinds = new Set(hardFailures.map((f) => f.reason));
    if (parsed.stats.swapped) {
      // 這是 §5.5 等級的事:這個模型在這個 batch 大小下會對錯句
      post(tabId, {
        type: 'notice',
        pageKey,
        level: 'error',
        text:
          `偵測到 batch 內 id 對滑,${hardFailures.length} 筆整批丟棄。` +
          `${spec.modelId} 在 ${batch.length} 筆的 batch 下把譯文對錯了句 —— ` +
          `換檔位,或把該檔的 batch 調小`,
      });
    } else {
      const first = hardFailures.find((f) => f.detail)?.detail;
      post(tabId, {
        type: 'notice',
        pageKey,
        level: 'warn',
        text:
          `${hardFailures.length} 個區塊未通過 id 紀律檢查 (${[...kinds].join(', ')})` +
          (first ? ` — ${first}` : ''),
      });
    }
  }
  await mutateQueue((cur) => {
    const left = remove(cur, batch);
    return retryItems.length > 0
      ? [...retryItems.map((b) => ({ ...b, attempts: 1 })), ...left]
      : left;
  });
}

/* ══════════════════════════════════════════════════ 圖片加註(plan-images §5) */

const IMAGE_QUEUE_KEY = 'imageQueue';
const running: Record<'l0' | 'l1', number> = { l0: 0, l1: 0 };
let imageDraining = false;

/*
 * 和文字佇列同一套寫入紀律(`docs/lessons.md` §5):所有「讀 → 改 → 寫」
 * 走單一 promise chain。少了它,hover 連續觸發與 drain 完成兩條路會交錯,
 * 做完的工作復活再跑一遍 —— 文字佇列踩過這個坑(§CY)。
 */
let ichain: Promise<unknown> = Promise.resolve();

function mutateImageQueue(fn: (q: ImageJob[]) => ImageJob[]): Promise<ImageJob[]> {
  const next = ichain.then(async () => {
    const got = await chrome.storage.session.get(IMAGE_QUEUE_KEY);
    const cur = (got[IMAGE_QUEUE_KEY] as ImageJob[] | undefined) ?? [];
    const out = fn(cur);
    await chrome.storage.session.set({ [IMAGE_QUEUE_KEY]: out });
    return out;
  });
  ichain = next.catch(() => undefined);
  return next;
}

/** 圖片用哪個模型:l0 一律 free 檔(零成本),l1 走使用者選的檔位 */
function imageTierFor(lane: 'l0' | 'l1', tier: Tier): Tier {
  return lane === 'l0' ? 'free' : tier;
}

export async function translateImage(
  tabId: number,
  pageKey: string,
  url: string,
  lane: 'l0' | 'l1',
  tier: Tier,
): Promise<void> {
  await mutateImageQueue((q) =>
    addJob(q, { url, pageKey, tabId, lane, tier, at: Date.now(), attempts: 0 }),
  );
  void drainImages();
}

export async function dropPageImages(tabId: number, pageKey: string): Promise<void> {
  await mutateImageQueue((q) => dropPageJobs(q, tabId, pageKey));
  imagesByPage.delete(pageKey);
}

export async function drainImages(): Promise<void> {
  if (imageDraining) return;
  imageDraining = true;
  try {
    for (;;) {
      const q = await mutateImageQueue((cur) => cur);
      const { run, drop } = nextJobs(q, running, Date.now());
      if (drop.length > 0) {
        // 掃過就走的 hover:配額不該花在使用者早就捲過去的圖上
        diag('info', 'image-stale', { n: drop.length });
        await mutateImageQueue((cur) => removeJobs(cur, drop));
      }
      if (run.length === 0) return;
      await Promise.all(run.map((job) => runImage(job)));
    }
  } finally {
    imageDraining = false;
  }
}

/**
 * 一張圖跑完整條路:配額 → 快取 → 抓 bytes → 模型 → 回傳。
 *
 * 快取查兩次是刻意的:**抓 bytes 之前先用 URL 查一次**(命中就完全
 * 不用連線),抓完之後再用 bytes hash 查一次(同一張圖在不同 CDN 參數
 * 下的第二次命中)。第二次命中省的是模型錢,第一次省的是頻寬與延遲。
 */
async function runImage(job: ImageJob): Promise<void> {
  running[job.lane]++;
  try {
    const settings = await getSettings();
    const spec = resolveTier(imageTierFor(job.lane, job.tier), settings);
    const done = async (): Promise<void> => {
      await mutateImageQueue((cur) => removeJobs(cur, [job]));
    };

    /*
     * 每頁圖片張數的閘門(§9)。
     *
     * 放在**快取查詢之前**是刻意的:快取命中不算一張新的圖,
     * 否則同一頁滑上滑下幾次就會把額度用完,而那幾次一毛錢都沒花。
     * ——所以這裡只擋「真的要送出去」的,見下面 `countImage()` 的位置。
     */
    // URL 快取:命中就不用連線(同一頁重複進出、放大檢視再看一次)
    const urlKey = await cache.keyFor(`img:url:${job.url}`, settings.targetLang, spec.modelId, 0);
    const cachedByUrl = await cache.get(settings.cacheMode, urlKey);
    if (cachedByUrl !== null) {
      const parsed = readCachedBlocks(cachedByUrl);
      if (parsed) {
        post(job.tabId, {
          type: 'image-result',
          pageKey: job.pageKey,
          url: job.url,
          hash: parsed.hash,
          lane: job.lane,
          blocks: parsed.blocks,
        });
        await done();
        return;
      }
    }

    const fetched = await fetchImage(job.url);
    if (!fetched.ok) {
      await imageFailed(job, fetched.reason, fetched.retriable);
      return;
    }
    const image = fetched.image;

    // bytes 快取:同一張圖不同 URL 參數只付一次錢
    const hashKey = await cache.keyFor(`img:${image.hash}`, settings.targetLang, spec.modelId, 0);
    const cachedByHash = await cache.get(settings.cacheMode, hashKey);
    if (cachedByHash !== null) {
      const parsed = readCachedBlocks(cachedByHash);
      if (parsed) {
        await cache.put(settings.cacheMode, urlKey, cachedByHash);
        post(job.tabId, {
          type: 'image-result',
          pageKey: job.pageKey,
          url: job.url,
          hash: image.hash,
          lane: job.lane,
          blocks: parsed.blocks,
        });
        await done();
        return;
      }
    }

    /*
     * 保險絲在**抓完 bytes 之後、送出之前**。
     *
     * 順序是有意義的:估算輸入 token 要知道圖片實際多大,而抓 bytes
     * 不花模型的錢。反過來先擋的話,估值只能用猜的。
     */
    const planned = estimateImageTokens(image.w, image.h);
    const verdict = await checkAllowed(settings, spec, job.pageKey, planned);
    if (!verdict.allow) {
      await imageFailed(job, verdict.reason ?? 'blocked', false, verdict.text);
      return;
    }
    // 快取沒中、保險絲放行 → 這才是真的要送一張新的圖出去
    const nth = await countImage(job.pageKey, image.hash);
    if (nth > settings.imagePageCap) {
      await imageFailed(
        job,
        'page-image-cap',
        false,
        `本頁圖片上限 ${settings.imagePageCap} 張已用滿`,
      );
      return;
    }
    const gate = await reserve(spec, planned);
    if (!gate.ok) {
      // 節流:放回佇列等下一輪,不算失敗
      await sleep(gate.waitMs);
      return;
    }

    const gloss = glossaryFor(job.pageKey, settings);
    const usePrompt =
      settings.glossaryPrompt === 'on' ||
      (settings.glossaryPrompt !== 'off' && spec.glossaryPrompt);
    const res = await callVision(
      settings.apiKey,
      spec,
      image,
      settings.targetLang,
      usePrompt ? gloss.filter((t) => t.to !== undefined).slice(0, 30) : [],
    );

    if (!res.ok) {
      await imageFailed(job, res.reason, res.retriable);
      return;
    }
    await recordSpend(spec, res.usage, 'progressive');
    await addPageTokens(job.pageKey, res.usage.prompt + res.usage.output + res.usage.thoughts);
    if (res.spec) {
      diag('warn', 'image-coord-spec', { spec: res.spec, model: spec.modelId });
    }

    const payload = JSON.stringify({ hash: image.hash, blocks: res.blocks });
    await cache.put(settings.cacheMode, hashKey, payload);
    await cache.put(settings.cacheMode, urlKey, payload);
    diag('info', 'image-done', {
      lane: job.lane,
      blocks: res.blocks.length,
      model: spec.modelId,
    });
    post(job.tabId, {
      type: 'image-result',
      pageKey: job.pageKey,
      url: job.url,
      hash: image.hash,
      lane: job.lane,
      blocks: res.blocks,
    });
    await done();
  } catch (e) {
    await imageFailed(job, `internal:${String(e).slice(0, 80)}`, false);
  } finally {
    running[job.lane]--;
  }
}

/**
 * 這一頁送出過的圖(以 bytes hash 去重)。回傳這是第幾張。
 *
 * **用 hash 不用 URL**:同一張圖在不同 CDN 參數下不算兩張,
 * 而 L0 之後再 L1 的同一張圖也只算一張 —— 額度限的是「幾張圖」,
 * 不是「幾次請求」。
 */
const imagesByPage = new Map<string, Set<string>>();

async function countImage(pageKey: string, hash: string): Promise<number> {
  let seen = imagesByPage.get(pageKey);
  if (!seen) {
    seen = new Set();
    imagesByPage.set(pageKey, seen);
  }
  seen.add(hash);
  return seen.size;
}

function readCachedBlocks(raw: string): { hash: string; blocks: ImageBlock[] } | null {
  try {
    const v = JSON.parse(raw) as { hash?: string; blocks?: ImageBlock[] };
    if (!Array.isArray(v.blocks)) return null;
    return { hash: String(v.hash ?? ''), blocks: v.blocks };
  } catch {
    return null;
  }
}

async function imageFailed(
  job: ImageJob,
  reason: string,
  retriable: boolean,
  text?: string,
): Promise<void> {
  const attempts = job.attempts + 1;
  if (retriable && attempts <= IMAGE_MAX_ATTEMPTS) {
    await mutateImageQueue((cur) => [
      ...removeJobs(cur, [job]),
      { ...job, attempts, at: Date.now() },
    ]);
    await sleep(backoffMs(attempts));
    return;
  }
  diag('warn', 'image-failed', { reason, lane: job.lane, attempts });
  await mutateImageQueue((cur) => removeJobs(cur, [job]));
  post(job.tabId, {
    type: 'image-error',
    pageKey: job.pageKey,
    url: job.url,
    reason: text ?? reason,
    retriable,
  });
}
