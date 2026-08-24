import type { TierSpec } from '../shared/models';
import { todayKey } from '../shared/settings';
import { dbg } from '../shared/log';

/**
 * §7.2 token bucket。依檔位設定 RPM / TPM 上限。
 * 免費層的 TPM 是最緊的一維:長 context 的請求會先撞 TPM 而不是 RPD。
 * §7.4 MV3 的 service worker 會被回收,所以視窗狀態存 storage.session,
 * 不得只放在記憶體。
 */
interface Window {
  reqs: number[];
  toks: [number, number][];
}

const WINDOW_MS = 60_000;

function key(tier: string): string {
  return `bucket:${tier}`;
}

async function load(tier: string): Promise<Window> {
  const got = await chrome.storage.session.get(key(tier));
  const w = got[key(tier)] as Window | undefined;
  return { reqs: w?.reqs ?? [], toks: w?.toks ?? [] };
}

async function save(tier: string, w: Window): Promise<void> {
  await chrome.storage.session.set({ [key(tier)]: w });
}

function prune(w: Window, now: number): void {
  const cutoff = now - WINDOW_MS;
  w.reqs = w.reqs.filter((t) => t > cutoff);
  w.toks = w.toks.filter(([t]) => t > cutoff);
}

export interface Gate {
  ok: boolean;
  waitMs: number;
  reason?: 'rpm' | 'tpm' | 'rpd';
}

export async function reserve(spec: TierSpec, tokens: number): Promise<Gate> {
  const now = Date.now();
  const w = await load(spec.tier);
  prune(w, now);

  const rpdUsed = await rpdCount(spec.tier);
  if (rpdUsed >= spec.rpd) return { ok: false, waitMs: 0, reason: 'rpd' };

  if (w.reqs.length >= spec.rpm) {
    const oldest = Math.min(...w.reqs);
    return { ok: false, waitMs: Math.max(250, oldest + WINDOW_MS - now), reason: 'rpm' };
  }
  const used = w.toks.reduce((a, [, n]) => a + n, 0);
  if (used + tokens > spec.tpm) {
    const oldest = w.toks.length > 0 ? Math.min(...w.toks.map(([t]) => t)) : now;
    return { ok: false, waitMs: Math.max(250, oldest + WINDOW_MS - now), reason: 'tpm' };
  }
  w.reqs.push(now);
  w.toks.push([now, tokens]);
  await save(spec.tier, w);
  await bumpRpd(spec.tier);
  dbg('bucket reserve', { tier: spec.tier, tokens, reqs: w.reqs.length, used: used + tokens });
  return { ok: true, waitMs: 0 };
}

function rpdKey(tier: string): string {
  return `rpd:${tier}:${todayKey()}`;
}

async function rpdCount(tier: string): Promise<number> {
  const k = rpdKey(tier);
  const got = await chrome.storage.local.get(k);
  return (got[k] as number | undefined) ?? 0;
}

async function bumpRpd(tier: string): Promise<void> {
  const k = rpdKey(tier);
  await chrome.storage.local.set({ [k]: (await rpdCount(tier)) + 1 });
}

/** §7.2 429 時自動下調,實際配額不寫死 */
export async function throttleDown(tier: string, current: { rpm: number; tpm: number }): Promise<{ rpm: number; tpm: number }> {
  const next = {
    rpm: Math.max(2, Math.floor(current.rpm * 0.7)),
    tpm: Math.max(2_000, Math.floor(current.tpm * 0.7)),
  };
  await chrome.storage.session.set({ [`throttle:${tier}`]: next });
  return next;
}

export async function throttleOverride(tier: string): Promise<{ rpm: number; tpm: number } | null> {
  const k = `throttle:${tier}`;
  const got = await chrome.storage.session.get(k);
  return (got[k] as { rpm: number; tpm: number } | undefined) ?? null;
}
