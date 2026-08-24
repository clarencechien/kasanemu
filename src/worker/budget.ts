import type { TierSpec } from '../shared/models';
import { monthKey, todayKey } from '../shared/settings';
import type { Pipeline, PipelineSpend, Settings, SpendDay, SpendLedger } from '../shared/types';
import { warn } from '../shared/log';
import type { Usage } from './gemini';

/**
 * §8 成本保險絲(四層)。即使 free 檔零成本,quality / balanced 都會產生
 * 真實帳單,四層缺一不可。
 * 事故公式:無人看管 × 花錢 × 重試 × 失敗不可見。
 */
const LEDGER_KEY = 'ledger';

export function usdOf(spec: TierSpec, u: Usage): number {
  // thoughts 以輸出價計費
  return (u.prompt * spec.inPrice + (u.output + u.thoughts) * spec.outPrice) / 1_000_000;
}

export async function getLedger(): Promise<SpendLedger> {
  const got = await chrome.storage.local.get(LEDGER_KEY);
  return (got[LEDGER_KEY] as SpendLedger | undefined) ?? { days: {} };
}

async function putLedger(l: SpendLedger): Promise<void> {
  await chrome.storage.local.set({ [LEDGER_KEY]: l });
}

export async function recordSpend(
  spec: TierSpec,
  u: Usage,
  pipeline: Pipeline = 'single',
): Promise<void> {
  try {
    const l = await getLedger();
    const day = todayKey();
    const cur: SpendDay =
      l.days[day] ?? { day, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, usd: 0, calls: 0 };
    const usd = usdOf(spec, u);
    cur.promptTokens += u.prompt;
    cur.outputTokens += u.output;
    cur.thoughtsTokens += u.thoughts;
    cur.usd += usd;
    cur.calls += 1;
    // feature.md §2.2:兩週的 A/B 要有數字可比,所以按模式分開累計
    const byPipeline = cur.byPipeline ?? {};
    const slot: PipelineSpend =
      byPipeline[pipeline] ?? { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, usd: 0, calls: 0 };
    slot.promptTokens += u.prompt;
    slot.outputTokens += u.output;
    slot.thoughtsTokens += u.thoughts;
    slot.usd += usd;
    slot.calls += 1;
    byPipeline[pipeline] = slot;
    cur.byPipeline = byPipeline;
    l.days[day] = cur;
    // 只留 70 天,ledger 不該無限長大
    const keys = Object.keys(l.days).sort();
    while (keys.length > 70) {
      const k = keys.shift();
      if (k) delete l.days[k];
    }
    delete l.degraded;
    await putLedger(l);
  } catch (e) {
    // §8.3 預算計數器自身出錯時放行並警示,不鎖住整個擴充
    warn('ledger 寫入失敗,保險絲降級放行', e);
    await chrome.storage.local
      .set({ [LEDGER_KEY]: { days: {}, degraded: String(e) } satisfies SpendLedger })
      .catch(() => undefined);
  }
}

export interface Totals {
  todayUsd: number;
  monthUsd: number;
  today: SpendDay;
  monthTokens: { prompt: number; output: number; thoughts: number };
  /** feature.md §2.2 A/B 用:本月按模式分列 */
  monthByPipeline: Partial<Record<Pipeline, PipelineSpend>>;
  degraded?: string;
}

export async function totals(): Promise<Totals> {
  const l = await getLedger();
  const day = todayKey();
  const mk = monthKey();
  const today: SpendDay =
    l.days[day] ?? { day, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, usd: 0, calls: 0 };
  let monthUsd = 0;
  const monthTokens = { prompt: 0, output: 0, thoughts: 0 };
  const monthByPipeline: Partial<Record<Pipeline, PipelineSpend>> = {};
  for (const [k, d] of Object.entries(l.days)) {
    if (!k.startsWith(mk)) continue;
    monthUsd += d.usd;
    monthTokens.prompt += d.promptTokens;
    monthTokens.output += d.outputTokens;
    monthTokens.thoughts += d.thoughtsTokens;
    for (const [pipe, v] of Object.entries(d.byPipeline ?? {})) {
      const key = pipe as Pipeline;
      const slot =
        monthByPipeline[key] ?? { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, usd: 0, calls: 0 };
      slot.promptTokens += v.promptTokens;
      slot.outputTokens += v.outputTokens;
      slot.thoughtsTokens += v.thoughtsTokens;
      slot.usd += v.usd;
      slot.calls += v.calls;
      monthByPipeline[key] = slot;
    }
  }
  return {
    todayUsd: today.usd,
    monthUsd,
    today,
    monthTokens,
    monthByPipeline,
    ...(l.degraded ? { degraded: l.degraded } : {}),
  };
}

/* ------------------------------------------------ 第 3 層:每頁 token 上限 */

/**
 * 計數必須跨重排累計 —— 重新錨定觸發重算時計數歸零等於保險絲被繞過。
 * 所以 key 是 pageKey(origin + pathname),不是每次掃描的批次。
 */
function pageKeyOf(pageKey: string): string {
  return `pagetok:${pageKey}`;
}

export async function pageTokens(pageKey: string): Promise<number> {
  const k = pageKeyOf(pageKey);
  const got = await chrome.storage.session.get(k);
  return (got[k] as number | undefined) ?? 0;
}

export async function addPageTokens(pageKey: string, n: number): Promise<number> {
  const total = (await pageTokens(pageKey)) + n;
  await chrome.storage.session.set({ [pageKeyOf(pageKey)]: total });
  return total;
}

export async function dropPage(pageKey: string): Promise<void> {
  await chrome.storage.session.remove(pageKeyOf(pageKey));
}

/* ------------------------------------------------------------ 放行判定 */

export interface Verdict {
  allow: boolean;
  reason?: 'page-cap' | 'daily-cap' | 'no-key';
  text?: string;
}

export async function checkAllowed(
  settings: Settings,
  spec: TierSpec,
  pageKey: string,
  plannedTokens: number,
): Promise<Verdict> {
  if (!settings.apiKey) return { allow: false, reason: 'no-key', text: 'options 還沒填 API key' };
  try {
    const used = await pageTokens(pageKey);
    if (used + plannedTokens > settings.pageTokenCap) {
      return {
        allow: false,
        reason: 'page-cap',
        text: `本頁 token 上限 ${settings.pageTokenCap} 已用滿 (${used})`,
      };
    }
    const paid = spec.inPrice > 0 || spec.outPrice > 0;
    if (paid) {
      const t = await totals();
      const twd = t.todayUsd * settings.usdToTwd;
      if (twd >= settings.globalDailyTWD) {
        return {
          allow: false,
          reason: 'daily-cap',
          text: `今日預算 NT$${settings.globalDailyTWD} 已用完 (NT$${twd.toFixed(2)});free 檔仍可用`,
        };
      }
    }
    return { allow: true };
  } catch (e) {
    // §8.3 壞掉時放行並警示
    warn('保險絲判定失敗,放行並警示', e);
    return { allow: true, text: `保險絲判定失敗,已放行:${String(e)}` };
  }
}
