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
