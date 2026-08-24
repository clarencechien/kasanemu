import { DEFAULT_SETTINGS, type DomainState, type Settings } from './types';
import { TIERS, type Tier, type TierSpec } from './models';

const SETTINGS_KEY = 'settings';
const DOMAIN_KEY_PREFIX = 'domain:';

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] ?? {}) } as Settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getDomainState(host: string, s?: Settings): Promise<DomainState> {
  const settings = s ?? (await getSettings());
  const key = DOMAIN_KEY_PREFIX + host;
  const got = await chrome.storage.local.get(key);
  const stored = (got[key] ?? {}) as Partial<DomainState>;
  return {
    // 預設不介入 (§2.1 關閉)
    enabled: stored.enabled ?? false,
    // 啟用後預設全開 (§2.1 / D03)
    mode: stored.mode ?? 'full',
    // 檔位以網域為單位記憶,與顯示狀態分開存 (§5.1)
    tier: stored.tier ?? settings.defaultTier,
    // feature.md §2.1 管線模式同樣以網域為單位記憶
    pipeline: stored.pipeline ?? settings.defaultPipeline,
  };
}

export async function setDomainState(host: string, patch: Partial<DomainState>): Promise<DomainState> {
  const next = { ...(await getDomainState(host)), ...patch };
  await chrome.storage.local.set({ [DOMAIN_KEY_PREFIX + host]: next });
  return next;
}

/** 合併 options 覆寫後的檔位規格 (§7.2 配額不寫死 / §8.2 價表可覆寫) */
export function resolveTier(tier: Tier, s: Settings): TierSpec {
  const base = TIERS[tier];
  const q = s.quota[tier] ?? {};
  const p = s.price[tier] ?? {};
  return {
    ...base,
    modelId: s.modelIds[tier] || base.modelId,
    rpm: q.rpm ?? base.rpm,
    tpm: q.tpm ?? base.tpm,
    rpd: q.rpd ?? base.rpd,
    inPrice: p.inPrice ?? base.inPrice,
    outPrice: p.outPrice ?? base.outPrice,
  };
}

export function todayKey(d = new Date()): string {
  // 本地日界線 (§8 第 4 層)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function monthKey(d = new Date()): string {
  return todayKey(d).slice(0, 7);
}
