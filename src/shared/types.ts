import type { Tier } from './models';

export type DisplayMode = 'full' | 'peek';
export type OverlayStyleName = 'inherit' | 'annotation';
export type CacheMode = 'session' | 'persistent' | 'off';

/** 一個翻譯單元送去 API 的樣子 (§6.1) */
export interface UnitRequest {
  id: string;
  src: string;
  maxChars: number;
  role: UnitRole;
}

export type UnitRole = 'heading' | 'body' | 'meta' | 'list' | 'cell';

/** API 回來、通過三層防線後的結果 (§6.3 / §6.4) */
export interface UnitResult {
  id: string;
  t: string;
}

export type UnitFailReason =
  | 'echo-mismatch'
  | 'missing-id'
  | 'duplicate-id'
  | 'unknown-id'
  | 'empty'
  | 'api-error'
  | 'budget-stop'
  | 'rate-limit'
  | 'truncated';

export interface UnitFailure {
  id: string;
  reason: UnitFailReason;
  detail?: string;
}

export interface DomainState {
  enabled: boolean;
  mode: DisplayMode;
  tier: Tier;
}

export interface QuotaOverride {
  rpm?: number;
  tpm?: number;
  rpd?: number;
}

export interface PriceOverride {
  inPrice?: number;
  outPrice?: number;
}

export interface Settings {
  apiKey: string;
  targetLang: string;
  defaultTier: Tier;
  /** §4.3 中文字重加權 */
  weightOffset: 0 | 100 | 200;
  /** §4.7 提示線 */
  hintLine: boolean;
  /** 強制全站使用標註樣式 (§4.6) */
  forceAnnotation: boolean;
  cacheMode: CacheMode;
  persistentCacheMB: number;
  /** §8 保險絲 */
  pageTokenCap: number;
  globalDailyTWD: number;
  usdToTwd: number;
  quota: Partial<Record<Tier, QuotaOverride>>;
  price: Partial<Record<Tier, PriceOverride>>;
  modelIds: Partial<Record<Tier, string>>;
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  targetLang: 'zh-TW',
  defaultTier: 'balanced',
  weightOffset: 100,
  hintLine: true,
  forceAnnotation: false,
  cacheMode: 'session',
  persistentCacheMB: 50,
  pageTokenCap: 120_000,
  globalDailyTWD: 60,
  usdToTwd: 32,
  quota: {},
  price: {},
  modelIds: {},
  debug: false,
};

/** 一天的花費帳 (§8.1) */
export interface SpendDay {
  /** YYYY-MM-DD,本地日界線 */
  day: string;
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  usd: number;
  calls: number;
}

export interface SpendLedger {
  days: Record<string, SpendDay>;
  /** 計數器自己壞掉時放行並警示 (§8.3) */
  degraded?: string;
}
