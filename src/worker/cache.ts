import { cacheKey } from '../shared/hash';
import type { CacheMode } from '../shared/types';
import { dbg, warn } from '../shared/log';

/**
 * §9 三段式快取。
 * key = sha256(src | targetLang | modelId | maxCharsBucket)
 * 導覽列、頁尾、重複標題在同站內命中率高。
 */
const mem = new Map<string, string>();
const MEM_CAP = 4000;

const DB_NAME = 'kasanemu';
const STORE = 'tx';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'k' });
        store.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function keyFor(src: string, lang: string, modelId: string, maxChars: number): Promise<string> {
  return cacheKey(src, lang, modelId, maxChars);
}

export async function get(mode: CacheMode, k: string): Promise<string | null> {
  if (mode === 'off') return null;
  const hit = mem.get(k);
  if (hit !== undefined) return hit;
  const sk = `tx:${k}`;
  const fromSession = await chrome.storage.session.get(sk);
  const sv = fromSession[sk] as string | undefined;
  if (sv !== undefined) {
    mem.set(k, sv);
    return sv;
  }
  if (mode !== 'persistent') return null;
  try {
    const rec = await tx<{ k: string; t: string; at: number } | undefined>('readonly', (s) => s.get(k));
    if (!rec) return null;
    mem.set(k, rec.t);
    return rec.t;
  } catch (e) {
    warn('IndexedDB 讀取失敗', e);
    return null;
  }
}

export async function put(mode: CacheMode, k: string, t: string): Promise<void> {
  if (mode === 'off') return;
  if (mem.size >= MEM_CAP) mem.clear();
  mem.set(k, t);
  await chrome.storage.session.set({ [`tx:${k}`]: t }).catch(() => undefined);
  if (mode !== 'persistent') return;
  try {
    await tx('readwrite', (s) => s.put({ k, t, at: Date.now(), size: t.length * 2 + 96 }));
  } catch (e) {
    warn('IndexedDB 寫入失敗', e);
  }
}

/** persistent 模式設 LRU 上限(預設 50 MB) */
export async function evictIfNeeded(capMB: number): Promise<void> {
  try {
    const all = await tx<Array<{ k: string; at: number; size: number }>>('readonly', (s) => s.getAll());
    const total = all.reduce((a, r) => a + (r.size ?? 0), 0);
    const cap = capMB * 1024 * 1024;
    if (total <= cap) return;
    all.sort((a, b) => a.at - b.at);
    let freed = 0;
    for (const r of all) {
      if (total - freed <= cap * 0.9) break;
      await tx('readwrite', (s) => s.delete(r.k));
      mem.delete(r.k);
      freed += r.size ?? 0;
    }
    dbg('cache evict', { total, cap, freed });
  } catch (e) {
    warn('LRU 清理失敗', e);
  }
}

export async function clearAll(): Promise<void> {
  mem.clear();
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('tx:'));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
  try {
    await tx('readwrite', (s) => s.clear());
  } catch (e) {
    warn('IndexedDB 清空失敗', e);
  }
}

/** 匯出檔的格式。版本號是為了以後改格式時能認出舊檔。 */
export interface CacheDump {
  v: 1;
  at: number;
  count: number;
  /** [key, 譯文, 最後使用時間] —— 陣列比物件省一半體積 */
  records: Array<[string, string, number]>;
}

/**
 * 把快取整包倒出來。
 *
 * 使用者的原話:「這樣就可以不用在移掉 ext 或昇版時 一切都重來」——
 * 封測期間每換一版就重新載入擴充功能,`chrome.storage.session` 會清空,
 * 而重灌更是連 IndexedDB 都沒了。譯文是花錢換來的,不該綁在安裝上。
 *
 * 兩個來源都倒:persistent 模式的資料在 IndexedDB,session 模式的在
 * storage.session。以 IndexedDB 的時間戳優先(它才有真正的 LRU 資訊)。
 */
export async function exportAll(): Promise<CacheDump> {
  const map = new Map<string, [string, number]>();
  try {
    const all = await tx<Array<{ k: string; t: string; at: number }>>('readonly', (s) => s.getAll());
    for (const r of all) map.set(r.k, [r.t, r.at ?? 0]);
  } catch (e) {
    warn('IndexedDB 匯出失敗', e);
  }
  const session = await chrome.storage.session.get(null).catch(() => ({}));
  for (const [sk, v] of Object.entries(session)) {
    if (!sk.startsWith('tx:') || typeof v !== 'string') continue;
    const k = sk.slice(3);
    if (!map.has(k)) map.set(k, [v, 0]);
  }
  const records: Array<[string, string, number]> = [];
  for (const [k, [t, at]] of map) records.push([k, t, at]);
  return { v: 1, at: Date.now(), count: records.length, records };
}

/**
 * 匯入。**只補不覆蓋** —— 同一把 key 的譯文是同一段原文、同一個模型、
 * 同一個長度分桶算出來的,現有的那份沒有比較差,而覆蓋會把
 * 「剛剛才翻好、還熱著的」換成檔案裡的舊資料。
 *
 * 一律同時寫進記憶體、session 與 IndexedDB:匯入的人多半正要換模式,
 * 寫兩邊比猜他等一下想用哪一種可靠。
 */
export async function importAll(dump: unknown): Promise<{ added: number; skipped: number }> {
  const d = dump as Partial<CacheDump> | null;
  if (!d || d.v !== 1 || !Array.isArray(d.records)) throw new Error('不是 Kasanemu 的快取檔');
  let added = 0;
  let skipped = 0;
  const batch: Record<string, string> = {};
  for (const rec of d.records) {
    if (!Array.isArray(rec) || typeof rec[0] !== 'string' || typeof rec[1] !== 'string') {
      skipped++;
      continue;
    }
    const [k, t, at] = rec;
    if (await get('persistent', k)) {
      skipped++;
      continue;
    }
    mem.set(k, t);
    batch[`tx:${k}`] = t;
    try {
      await tx('readwrite', (s) =>
        s.put({ k, t, at: typeof at === 'number' && at > 0 ? at : Date.now(), size: t.length * 2 + 96 }),
      );
    } catch (e) {
      warn('IndexedDB 匯入失敗', e);
    }
    added++;
  }
  await chrome.storage.session.set(batch).catch(() => undefined);
  return { added, skipped };
}
