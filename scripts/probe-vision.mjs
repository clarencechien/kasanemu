/*
 * 圖片翻譯可行性 probe(docs/plan-images.md §7):
 * 三檔現役模型 × 樣本圖,要求 {box_2d, text, zh} JSON,量延遲/token/區域數,
 * region 結果存檔給驗證台看(box 準不準要用眼睛,見 plan §7 的 artifact)。
 *
 *   gemini_key=... node scripts/probe-vision.mjs chart.png screenshot.png
 *
 * 和 production 同一組 generationConfig(schema 強制、thinkingLevel minimal)——
 * 量測工具走不同的路就是在量另一個系統(docs/lessons.md §1、§DB-2)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEY = process.env.gemini_key || process.env.GEMINI_API_KEY;
if (!KEY) { console.error('請設 gemini_key 或 GEMINI_API_KEY'); process.exit(1); }
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const SYS = `你是圖片文字翻譯器。找出圖中所有可讀的文字區塊,回傳 JSON 陣列。
每個元素:{"box_2d":[ymin,xmin,ymax,xmax],"text":"原文","zh":"臺灣繁體中文譯文"}
box_2d 用 0-1000 正規化座標。同一行/同一段合併成一個區塊。
專有名詞(產品名、公司名)不翻。只回傳 JSON。`;

const SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      box_2d: { type: 'array', items: { type: 'integer' } },
      text: { type: 'string' },
      zh: { type: 'string' },
    },
    required: ['box_2d', 'text', 'zh'],
  },
};

const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b-it'];

async function once(model, file) {
  const data = readFileSync(file).toString('base64');
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/png', data } },
      { text: '找出所有文字並翻譯。' },
    ] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
    systemInstruction: { parts: [{ text: SYS }] },
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  const j = await res.json();
  const um = j.usageMetadata ?? {};
  const cand = j.candidates?.[0] ?? {};
  const text = (cand.content?.parts ?? [])
    .filter((p) => p.thought !== true).map((p) => p.text ?? '').join('');
  let regions = null;
  try { regions = JSON.parse(text); } catch { }
  return {
    ms,
    prompt: um.promptTokenCount ?? 0,
    out: um.candidatesTokenCount ?? 0,
    thoughts: um.thoughtsTokenCount ?? 0,
    finish: cand.finishReason,
    regions,
  };
}

for (const file of process.argv.slice(2)) {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  for (const model of MODELS) {
    const r = await once(model, file).catch((e) => ({ error: String(e).slice(0, 200) }));
    const head = `${stem} ${model}`.padEnd(44);
    if (r.error) { console.log(head, 'ERR', r.error); continue; }
    const n = Array.isArray(r.regions) ? r.regions.length : -1;
    console.log(head,
      `${r.ms}ms in:${r.prompt} out:${r.out} th:${r.thoughts} finish:${r.finish} regions:${n}`);
    writeFileSync(`vision-${stem}-${model.replace(/[^a-z0-9]+/gi, '_')}.json`,
      JSON.stringify(r.regions ?? [], null, 1));
  }
}
