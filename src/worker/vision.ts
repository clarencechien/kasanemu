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
import { callWithLadder, type ApiOutcome, type Variant } from './gemini';
import { VISION_TIMEOUT_MS } from '../shared/imagetiming.ts';
import { repairJsonArray } from './protocol';
import type { ImageBytes } from './imagefetch';
import { dbg, warn } from '../shared/log';

/**
 * 座標**順著模型的訓練慣例要 0–1000**,不要求 0–100。
 *
 * sukemu 要 0–100,lite 檔照樣回 0–1000(`adr/0001` 破法 1)——
 * 與其和訓練慣例對抗再靠防呆救回來,不如一開始就要它習慣的那個。
 * 防呆(`normalizeBoxes`)照樣裝著:順著要也不代表它一定照給。
 */
const VISION_PROMPT = [
  '你是圖片文字翻譯器。找出圖中所有可讀的文字區塊,回傳 JSON 陣列。',
  '每個元素:',
  '  box_2d:[ymin, xmin, ymax, xmax],0–1000 正規化座標',
  '  text:圖上的原文',
  '  zh:譯文',
  '  c:這一塊的定位信心 0–1',
  '  v:直排(由上往下寫)才給 true,否則省略',
  '  kind:等寬字體 / 程式碼片段給 "code",否則省略',
  '規則:',
  '1. 同一行、同一段的字合併成一個區塊;分屬不同版面位置的不要合併。',
  '2. 專有名詞(產品名、公司名、人名)保持原樣不翻。',
  '3. kind 是 "code" 的區塊,zh 直接填原文 —— 程式碼不翻。',
  '4. 看不清楚的區塊照樣回報,把 c 調低,不要略過。',
  '5. 圖上沒有任何文字時回傳空陣列。',
  '只回傳 JSON,不要說明。',
].join('\n');

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

export function visionPrompt(targetLang: string, glossary: readonly Term[] = []): string {
  const langName = targetLang === 'zh-TW' ? '繁體中文(台灣用語)' : targetLang;
  const base = `${VISION_PROMPT}\n目標語言:${langName}。`;
  if (glossary.length === 0) return base;
  /*
   * 圖片上**只有路徑 B**(`docs/plan-images.md` §8)。
   *
   * 文字管線的佔位符前提是「我們能在送出前改寫來源」—— 圖片做不到,
   * 模型看到的是像素。所以詞表在這裡是請求,不是保證,手冊寫明了這件事。
   */
  const lines = glossary.map((t) => `  ${t.from} → ${t.to ?? t.from}`).join('\n');
  /*
   * **詞表要明講它蓋過規則 2。**
   *
   * 量測(§13-5)顯示:加了詞表之後 `Storage size → 儲存容量` 與
   * `smaller → 更精簡` 兩檔都照做,但 `Elasticsearch → 彈性搜尋`
   * 兩檔都不照 —— 因為規則 2 寫著「專有名詞保持原樣不翻」,
   * 而模型認為那條比詞表大。
   *
   * 它沒有做錯,是**我們的 prompt 自相矛盾**。使用者把產品名寫進詞表
   * 並給了譯法,那就是明確的「我要翻它」;規則 2 是預設值,不是禁令。
   */
  return (
    `${base}\n詞表(圖上遇到左邊的詞,譯文一律採用右邊的說法。` +
    `**這條優先於上面的規則 2** —— 詞表裡的專有名詞要照詞表翻):\n${lines}`
  );
}

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
): Promise<VisionOk | VisionErr> {
  const sys = visionPrompt(targetLang, glossary);
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
