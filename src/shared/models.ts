/**
 * 三檔模型 (PRD §5)。
 * 價格為官方牌價,USD per 1M token,保險絲寧可高估 (§8.2)。
 * thoughts 以輸出價計費,所以與 output 同價。
 */
export type Tier = 'quality' | 'balanced' | 'free';

export interface TierSpec {
  tier: Tier;
  label: string;
  modelId: string;
  /** USD per 1M input token */
  inPrice: number;
  /** USD per 1M output token (thoughts 同價) */
  outPrice: number;
  /** 每 batch 區塊數上限 (§5.4) */
  batchUnits: number;
  /** 每 batch 輸入 token 軟上限 (§5.4) */
  batchTokens: number;
  /** 預設節流值,實際配額依 quota tier 而異,options 可改 (§7.2) */
  rpm: number;
  tpm: number;
  rpd: number;
  maxOutputTokens: number;
  note: string;
}

export const TIERS: Record<Tier, TierSpec> = {
  quality: {
    tier: 'quality',
    label: 'quality',
    modelId: 'gemini-3.5-flash',
    inPrice: 1.5,
    outPrice: 9.0,
    batchUnits: 20,
    batchTokens: 6000,
    rpm: 30,
    tpm: 200_000,
    rpd: 5_000,
    maxOutputTokens: 8192,
    note: '要讀進去的長文、術語密集的技術文件',
  },
  balanced: {
    tier: 'balanced',
    label: 'balanced',
    modelId: 'gemini-3.5-flash-lite',
    inPrice: 0.3,
    outPrice: 2.5,
    batchUnits: 10,
    batchTokens: 3000,
    rpm: 60,
    tpm: 200_000,
    rpd: 10_000,
    maxOutputTokens: 8192,
    note: '日常瀏覽預設',
  },
  free: {
    tier: 'free',
    label: 'free',
    modelId: 'gemma-4-31b-it',
    inPrice: 0,
    outPrice: 0,
    batchUnits: 6,
    batchTokens: 2000,
    rpm: 15,
    tpm: 12_000,
    rpd: 1_000,
    maxOutputTokens: 4096,
    note: '零帳單模式;受免費層 TPM 夾擊',
  },
};

export const TIER_ORDER: Tier[] = ['quality', 'balanced', 'free'];

/**
 * 排除清單 (§5.5)。3.6 系列在同料 A/B 出現 batch 內 id 對滑,
 * 自動指標抓不到,在需要 id 對位的場景不採用。
 */
export const BLOCKED_MODEL_PREFIXES = ['gemini-3.6'];

export function isBlockedModel(modelId: string): boolean {
  return BLOCKED_MODEL_PREFIXES.some((p) => modelId.startsWith(p));
}
