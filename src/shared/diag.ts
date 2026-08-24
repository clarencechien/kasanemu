/**
 * 診斷 log。content script 與 service worker 各自寫進 chrome.storage.session
 * 的同一個環狀緩衝,popup 一鍵匯出成可以直接貼出來的 Markdown。
 *
 * 為什麼要有:這個擴充的失敗大多發生在「看不到的地方」——
 * echo 對不上、模型 ID 不存在、佇列卡住、掃描掃不到東西。
 * 沒有 log 的話,回報只能是「怪怪的」,而 devtools 的 console 分散在
 * 頁面與 service worker 兩處,還會被回收清掉。
 *
 * 一律不記原文與譯文全文,只記前 60 字 —— log 是要拿去貼給別人的。
 */
const KEY = 'diag';
const CAP = 300;

export type DiagScope = 'content' | 'worker' | 'popup';
export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  at: number;
  scope: DiagScope;
  level: DiagLevel;
  msg: string;
  data?: unknown;
}

let buffer: DiagEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let scope: DiagScope = 'content';

export function setDiagScope(s: DiagScope): void {
  scope = s;
}

/** 長字串一律截斷:log 是要貼出來的,不是原文備份 */
export function clip(v: unknown, max = 60): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => clip(x, max));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = clip(val, max);
    return out;
  }
  return v;
}

export function diag(level: DiagLevel, msg: string, data?: unknown): void {
  buffer.push({
    at: Date.now(),
    scope,
    level,
    msg,
    ...(data === undefined ? {} : { data: clip(data) }),
  });
  if (buffer.length > CAP) buffer = buffer.slice(-CAP);
  schedule();
}

function schedule(): void {
  if (flushTimer) return;
  // 批次寫入:每則都寫 storage 會在翻譯尖峰時變成 I/O 風暴
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 700);
}

export async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const mine = buffer;
  buffer = [];
  try {
    const got = await chrome.storage.session.get(KEY);
    const prev = (got[KEY] as DiagEvent[] | undefined) ?? [];
    const next = [...prev, ...mine].slice(-CAP);
    await chrome.storage.session.set({ [KEY]: next });
  } catch {
    /* session storage 滿了或 context 正在關閉:log 掉了就掉了,不能因此壞掉 */
  }
}

export async function readDiag(): Promise<DiagEvent[]> {
  try {
    const got = await chrome.storage.session.get(KEY);
    return ((got[KEY] as DiagEvent[] | undefined) ?? []).sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export async function clearDiag(): Promise<void> {
  buffer = [];
  await chrome.storage.session.remove(KEY).catch(() => undefined);
}
