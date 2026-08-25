import type { TierSpec } from '../shared/models';
import { warn, dbg } from '../shared/log';
import { RESPONSE_SCHEMA, systemPrompt, userPayload } from './protocol';
import type { UnitRequest } from '../shared/types';
import type { Term } from '../shared/glossary';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface Usage {
  prompt: number;
  output: number;
  /** §8.1 thoughts 單獨列出,它是最容易失控的一項 */
  thoughts: number;
}

export interface ApiOk {
  ok: true;
  text: string;
  truncated: boolean;
  usage: Usage;
  /** 實際生效的降級組合,寫進 log 方便追 */
  variant: string;
}

export interface ApiErr {
  ok: false;
  status: number;
  message: string;
  retriable: boolean;
}

export type ApiOutcome = ApiOk | ApiErr;

/**
 * §5.3 thinking 全部關閉。
 * thinkingLevel: "minimal" 是唯一在 3.5 / 3.6 系列都實測歸零的寫法。
 * 不要用 thinkingBudget: 128 —— budget 是預算不是硬上限,實測仍會燒
 * 12–18.5 倍 thoughts token。thinkingBudget: 0 在 3.5 可、3.6 拒收 400。
 * thinkingLevel 與 thinkingBudget 同時給 → 400。
 */
const THINKING = { thinkingLevel: 'minimal' } as const;

interface Variant {
  name: string;
  thinking: boolean;
  schema: boolean;
  jsonMime: boolean;
  systemInstruction: boolean;
}

/**
 * 降級階梯。每一階只在收到 400 時往下走一步,並記錄實際生效的組合。
 * 第 2 階就是 §5.3 要求的「一律備 400 fallback:拿掉整個 thinkingConfig 重試」。
 * 第 3、4 階是給 Gemma 的:走 Gemini API 時 schema 強制與 systemInstruction
 * 的支援情況與 Gemini 系列不同(開放問題 3)。
 */
const LADDER: Variant[] = [
  { name: 'full', thinking: true, schema: true, jsonMime: true, systemInstruction: true },
  { name: 'no-thinking', thinking: false, schema: true, jsonMime: true, systemInstruction: true },
  { name: 'no-schema', thinking: false, schema: false, jsonMime: true, systemInstruction: true },
  { name: 'no-json-mime', thinking: false, schema: false, jsonMime: false, systemInstruction: true },
  { name: 'inline-system', thinking: false, schema: false, jsonMime: false, systemInstruction: false },
];

function buildBody(
  v: Variant,
  spec: TierSpec,
  units: UnitRequest[],
  targetLang: string,
  glossary: readonly Term[],
): unknown {
  const sys = systemPrompt(targetLang, glossary);
  const payload = userPayload(units);
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: spec.maxOutputTokens,
  };
  if (v.jsonMime) generationConfig['responseMimeType'] = 'application/json';
  if (v.schema) generationConfig['responseSchema'] = RESPONSE_SCHEMA;
  if (v.thinking) generationConfig['thinkingConfig'] = THINKING;
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: v.systemInstruction ? payload : `${sys}\n\n${payload}` }],
      },
    ],
    generationConfig,
  };
  if (v.systemInstruction) body['systemInstruction'] = { parts: [{ text: sys }] };
  return body;
}

function readUsage(json: Record<string, unknown>): Usage {
  const um = (json['usageMetadata'] ?? {}) as Record<string, number>;
  return {
    prompt: um['promptTokenCount'] ?? 0,
    output: um['candidatesTokenCount'] ?? 0,
    thoughts: um['thoughtsTokenCount'] ?? 0,
  };
}

function readText(json: Record<string, unknown>): { text: string; truncated: boolean } {
  const cands = (json['candidates'] ?? []) as Array<Record<string, unknown>>;
  const first = cands[0];
  if (!first) return { text: '', truncated: false };
  const content = (first['content'] ?? {}) as Record<string, unknown>;
  const parts = (content['parts'] ?? []) as Array<Record<string, unknown>>;
  const text = parts
    .filter((p) => p['thought'] !== true)
    .map((p) => (typeof p['text'] === 'string' ? p['text'] : ''))
    .join('');
  return { text, truncated: first['finishReason'] === 'MAX_TOKENS' };
}

/** 記住每個模型走到哪一階,下次直接從那階開始,不要每個 batch 都重踩 400 */
const variantByModel = new Map<string, number>();

export async function callBatch(
  apiKey: string,
  spec: TierSpec,
  units: UnitRequest[],
  targetLang: string,
  glossary: readonly Term[] = [],
): Promise<ApiOutcome> {
  let idx = variantByModel.get(spec.modelId) ?? 0;
  let last: ApiErr = { ok: false, status: 0, message: 'no attempt', retriable: false };

  while (idx < LADDER.length) {
    const v = LADDER[idx]!;
    const res = await once(apiKey, spec, units, targetLang, v, glossary);
    if (res.ok) {
      variantByModel.set(spec.modelId, idx);
      return res;
    }
    last = res;
    // 只有 400 才往下降級;429 / 5xx 交給上層退避
    if (res.status !== 400) return res;
    warn(`400 on variant ${v.name} (${spec.modelId}): ${res.message} → 降級重試`);
    idx++;
  }
  return last;
}

async function once(
  apiKey: string,
  spec: TierSpec,
  units: UnitRequest[],
  targetLang: string,
  v: Variant,
  glossary: readonly Term[],
): Promise<ApiOutcome> {
  const url = `${BASE}/models/${encodeURIComponent(spec.modelId)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(buildBody(v, spec, units, targetLang, glossary)),
    });
  } catch (e) {
    return { ok: false, status: 0, message: String(e), retriable: true };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      message: body.slice(0, 400),
      retriable: res.status === 429 || res.status >= 500,
    };
  }
  const json = (await res.json()) as Record<string, unknown>;
  const usage = readUsage(json);
  const { text, truncated } = readText(json);
  if (usage.thoughts > 0) {
    // 關不掉就是有人改壞了設定,要看得見
    warn(`thoughts token 不是 0 (${usage.thoughts}, ${spec.modelId}, variant ${v.name})`);
  }
  dbg('batch ok', { model: spec.modelId, variant: v.name, usage, truncated });
  return { ok: true, text, truncated, usage, variant: v.name };
}

/** §5.2 模型 ID 必須驗證:啟動時取回可用清單,不要等到執行時才 400 */
export async function listModels(apiKey: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? [])
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  } catch {
    return null;
  }
}
