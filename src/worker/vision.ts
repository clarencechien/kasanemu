/**
 * 視覺請求:一張圖 → 一組帶座標的譯文區塊。
 *
 * 規格 `docs/plan-images.md` §5;prompt 與 schema 的形狀來自 §7 的實測
 * (`scripts/probe-vision.mjs`,三個模型 × 兩張真實圖全部會畫框而且準)。
 *
 * 和文字批次的差別只有兩處:body 裡多一個 `inlineData`,以及回應走
 * `sanitizeBlocks()` 而不是 id/echo 對位。**降級階梯是共用的**
 * (`callWithLadder`)—— gemma 收不了哪些欄位,和送的是文字還是圖片無關。
 */

import type { TierSpec } from '../shared/models';
import type { Term } from '../shared/glossary';
import type { ImageBlock } from '../shared/imageblocks';
import { fromWire, sanitizeBlocks } from '../shared/imageblocks';
import { visionPrompt } from './visionprompt.ts';
export { visionPrompt, BRIEF_BLOCKS } from './visionprompt.ts';
import { callWithLadder, type ApiOutcome, type Variant } from './gemini';
import { VISION_TIMEOUT_MS } from '../shared/imagetiming.ts';
import { repairJsonArray } from './protocol';
import type { ImageBytes } from './imagefetch';
import { dbg, warn } from '../shared/log';

/** 回應 schema。gemma 不一定吃,吃不下的話 callWithLadder 會降級 */
export const VISION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
      text: { type: 'STRING' },
      zh: { type: 'STRING' },
      c: { type: 'NUMBER' },
      v: { type: 'BOOLEAN' },
      kind: { type: 'STRING' },
    },
    required: ['box_2d', 'text', 'zh'],
  },
} as const;

function buildVisionBody(
  v: Variant,
  spec: TierSpec,
  image: ImageBytes,
  sys: string,
): unknown {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: spec.maxOutputTokens,
  };
  if (v.jsonMime) generationConfig['responseMimeType'] = 'application/json';
  if (v.schema) generationConfig['responseSchema'] = VISION_SCHEMA;
  if (v.thinking) generationConfig['thinkingConfig'] = { thinkingLevel: 'minimal' };

  const parts: Record<string, unknown>[] = [
    { inlineData: { mimeType: image.mime, data: image.data } },
    { text: v.systemInstruction ? '找出所有文字並翻譯。' : `${sys}\n\n找出所有文字並翻譯。` },
  ];
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  if (v.systemInstruction) body['systemInstruction'] = { parts: [{ text: sys }] };
  return body;
}

export interface VisionOk {
  ok: true;
  blocks: ImageBlock[];
  usage: { prompt: number; output: number; thoughts: number };
  variant: string;
  /** 模型沒照座標規格時是換算方式,照規格是 null */
  spec: string | null;
}

export interface VisionErr {
  ok: false;
  reason: string;
  status: number;
  retriable: boolean;
}

export async function callVision(
  apiKey: string,
  spec: TierSpec,
  image: ImageBytes,
  targetLang: string,
  glossary: readonly Term[] = [],
  brief = false,
): Promise<VisionOk | VisionErr> {
  const sys = visionPrompt(targetLang, glossary, brief);
  // 階梯記憶用另一個鍵:同一個模型在文字與視覺上可能停在不同階
  const res: ApiOutcome = await callWithLadder(
    apiKey,
    spec,
    (v, s) => buildVisionBody(v, s, image, sys),
    `${spec.modelId}:vision`,
    VISION_TIMEOUT_MS,
  );
  if (!res.ok) {
    return { ok: false, reason: res.message.slice(0, 200), status: res.status, retriable: res.retriable };
  }

  /*
   * 截斷的回應照樣救。
   *
   * 圖上區塊多的時候(截圖級 53 塊)輸出會逼近上限,而**救回來的
   * 前 40 塊遠比整批丟掉有用** —— 這是文字管線 §6.6 學到的同一件事,
   * 所以直接用同一支修復函式。
   */
  const arr = repairJsonArray(res.text);
  if (!arr) {
    warn(`視覺回應不是 JSON(${spec.modelId}, variant ${res.variant})`);
    return { ok: false, reason: 'bad-json', status: 200, retriable: true };
  }
  const { blocks, spec: coordSpec } = sanitizeBlocks(fromWire(arr), image.w, image.h);
  if (coordSpec) {
    // 換模型時這行 log 就是證據(`docs/plan-images.md` §4)
    warn(`視覺座標不是 0–1000,已按 ${coordSpec} 規格換算(${spec.modelId})`);
  }
  dbg('vision ok', {
    model: spec.modelId,
    variant: res.variant,
    blocks: blocks.length,
    truncated: res.truncated,
    usage: res.usage,
  });
  return { ok: true, blocks, usage: res.usage, variant: res.variant, spec: coordSpec };
}
