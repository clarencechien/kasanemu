import type { TierSpec } from '../shared/models';
import { warn, dbg } from '../shared/log.ts';
import { RESPONSE_SCHEMA, systemPrompt, userPayload } from './protocol.ts';
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

export interface Variant {
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

/**
 * 一個請求的 body 怎麼組。文字批次與視覺請求的 body 形狀不同,
 * 但**降級階梯是同一套** —— gemma 走 Gemini API 時哪些欄位收不了,
 * 和送的是文字還是圖片無關。
 *
 * 抽出來是為了不要有第二份階梯:兩份就會分岔,而分岔的那天
 * 會是「圖片翻譯在 free 檔一直 400 而文字沒事」這種很難查的樣子。
 */
export type BodyBuilder = (v: Variant, spec: TierSpec) => unknown;

/**
 * 帶降級階梯的呼叫。`key` 是階梯記憶的鍵 —— 文字與視覺分開記,
 * 因為同一個模型在兩種請求上可能停在不同階。
 */
/**
 * 文字批次的上限時間 —— 純粹是保險絲:一批幾秒鐘就該回來。
 *
 * 圖片那一路的所有時限在 `shared/imagetiming.ts`,它們**彼此有順序**,
 * 所以放在同一個檔案裡。
 */
export const TEXT_TIMEOUT_MS = 60_000;

export async function callWithLadder(
  apiKey: string,
  spec: TierSpec,
  build: BodyBuilder,
  key = spec.modelId,
  timeoutMs = TEXT_TIMEOUT_MS,
): Promise<ApiOutcome> {
  let idx = variantByModel.get(key) ?? 0;
  let last: ApiErr = { ok: false, status: 0, message: 'no attempt', retriable: false };

  while (idx < LADDER.length) {
    const v = LADDER[idx]!;
    const res = await once(apiKey, spec, v, build, timeoutMs);
    if (res.ok) {
      variantByModel.set(key, idx);
      return res;
    }
    last = res;
    // 只有 400 才往下降級;429 / 5xx 交給上層退避
    if (res.status !== 400) return res;
    warn(`400 on variant ${v.name} (${key}): ${res.message} → 降級重試`);
    idx++;
  }
  return last;
}

export async function callBatch(
  apiKey: string,
  spec: TierSpec,
  units: UnitRequest[],
  targetLang: string,
  glossary: readonly Term[] = [],
): Promise<ApiOutcome> {
  return callWithLadder(apiKey, spec, (v) => buildBody(v, spec, units, targetLang, glossary));
}

/**
 * 從 API 的錯誤回應裡挖出**那句話**,不要整包 JSON。
 *
 * 原本是 `body.slice(0, 400)`,而回應長這樣:
 *
 *   {\n  "error": {\n    "code": 400,\n    "message": "Unsupported MIME type: …
 *
 * 診斷再截一次之後,使用者看到的是 `{"error":{"code":400,"message":"Unsupported …`
 * —— **真正有用的那半個字被 JSON 外殼吃掉了**。一個 400 正是最需要看清楚
 * 訊息的時候:它在說「你送的東西我不收」,而「哪裡不收」就在被截掉的地方
 * (`docs/deviations.md` §DO-2)。
 */
function apiMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } };
    const m = j.error?.message;
    if (typeof m === 'string' && m.length > 0) return m.slice(0, 400);
  } catch {
    // 不是 JSON(HTML 錯誤頁、代理的純文字)—— 原樣截
  }
  return body.slice(0, 400);
}

/** 只給測試 —— `apiMessage` 是內部細節,但它的行為是使用者看得到的那句話 */
export const apiMessageForTest = (body: string): string => apiMessage(body);

async function once(
  apiKey: string,
  spec: TierSpec,
  v: Variant,
  build: BodyBuilder,
  timeoutMs: number,
): Promise<ApiOutcome> {
  const url = `${BASE}/models/${encodeURIComponent(spec.modelId)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(build(v, spec)),
      // 沒有 timeout 的 fetch 是一個**永遠不會 settle 的 promise**(§DI)
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      /*
       * 逾時**不自動重試**:等了這麼久還沒回應,再等一輪同樣長的時間
       * 只會把使用者推過看門狗那條線。標成可重試是給**使用者**的
       * (chip 上點一下),不是給排程器的。
       */
      return { ok: false, status: 0, message: `timeout ${timeoutMs}ms`, retriable: false };
    }
    return { ok: false, status: 0, message: String(e), retriable: true };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      message: apiMessage(body),
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
