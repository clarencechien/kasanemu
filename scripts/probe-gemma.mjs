#!/usr/bin/env node
/**
 * 開放問題 3:「這是第一個要跑的實驗。」
 *
 * Gemma 4 31B 走 Gemini API 時的行為與 Gemini 系列不同,而 free 檔的價值
 * 完全押在它身上。如果 id 對位不穩,free 檔就沒有意義 —— 這件事只要半天,
 * 不該等到 DOM 那半寫完才發現。
 *
 * 這支腳本回答四個問題:
 *   1. thinkingLevel: "minimal" 會不會被接受?thoughts 真的歸零嗎?
 *   2. systemInstruction 支援嗎?
 *   3. JSON 輸出支援 schema 強制,還是只有 JSON mode?
 *   4. id 回聲對位的通過率(§6.4 第二層)有多高?
 *
 * 用法:
 *   GEMINI_API_KEY=... node scripts/probe-gemma.mjs
 *   GEMINI_API_KEY=... node scripts/probe-gemma.mjs --model=gemini-3.5-flash-lite --runs=3
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY ?? '';
const arg = (name, dflt) =>
  (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=')[1];

const MODEL = arg('model', 'gemma-4-31b-it');
const RUNS = Number(arg('runs', '2'));

if (!KEY) {
  console.error('需要 GEMINI_API_KEY。');
  process.exit(2);
}

/** 固定料:短句、長句、標題、表格儲存格各有,才照得出 id 對滑 */
const SAMPLE = [
  ['u1', 'Roughly 99 percent of the world data traffic travels through undersea cables.', 96, 'body'],
  ['u2', 'Getting Started', 12, 'heading'],
  ['u3', 'The compiler emits a warning when the lifetime cannot be inferred.', 64, 'body'],
  ['u4', 'Latency', 8, 'cell'],
  ['u5', 'Install the package with npm install --save-dev esbuild before running the build.', 72, 'body'],
  ['u6', 'Published on March 3, 2026 by the infrastructure team.', 40, 'meta'],
  ['u7', 'Why overlays instead of inline insertion?', 24, 'heading'],
  ['u8', 'Each request is billed by input and output tokens, and thoughts count as output.', 80, 'body'],
  ['u9', 'Throughput', 8, 'cell'],
  ['u10', 'Do not disable the fuse to make a failing page work.', 48, 'list'],
  ['u11', 'A closed shadow root isolates styles but hides the page computed values.', 72, 'body'],
  ['u12', 'Known failure modes', 16, 'heading'],
];

const SYSTEM = [
  '你是網頁翻譯引擎。輸入是一個 JSON array,每筆是一個獨立的網頁區塊。',
  '1. 只輸出 JSON array,不要 markdown 圍籬、不要說明文字。',
  '2. 每筆輸出 {"id","echo","t"}。id 必須與輸入完全相同。',
  '3. echo = 該筆輸入 src 的前 8 個字元,原樣照抄。',
  '4. t = 繁體中文譯文,長度控制在該筆 maxChars 個字以內。',
  '5. 輸入有幾筆就輸出幾筆,不得漏、不得多。',
].join('\n');

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'STRING' }, echo: { type: 'STRING' }, t: { type: 'STRING' } },
    required: ['id', 'echo', 't'],
  },
};

const payload = JSON.stringify(
  SAMPLE.map(([id, src, maxChars, role]) => ({ id, src, maxChars, role })),
);

const VARIANTS = [
  { name: 'schema + minimal + systemInstruction', schema: true, thinking: 'minimal', sys: true },
  { name: 'schema + 無 thinkingConfig', schema: true, thinking: null, sys: true },
  { name: 'jsonMode + minimal', schema: false, thinking: 'minimal', sys: true },
  { name: 'jsonMode + minimal,system 併進 user', schema: false, thinking: 'minimal', sys: false },
  { name: '對照組:預設 thinking(不要在正式路徑上用)', schema: false, thinking: null, sys: true },
];

function body(v) {
  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
  };
  if (v.schema) generationConfig.responseSchema = SCHEMA;
  if (v.thinking === 'minimal') generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  const out = {
    contents: [{ role: 'user', parts: [{ text: v.sys ? payload : `${SYSTEM}\n\n${payload}` }] }],
    generationConfig,
  };
  if (v.sys) out.systemInstruction = { parts: [{ text: SYSTEM }] };
  return out;
}

function echoOf(src) {
  return [...src].slice(0, 8).join('').replace(/\s+/g, ' ').trim();
}

function grade(text) {
  let arr;
  try {
    arr = JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch {
    return { json: false };
  }
  if (!Array.isArray(arr)) return { json: false };
  const want = new Map(SAMPLE.map(([id, src]) => [id, echoOf(src)]));
  let echoOk = 0;
  let echoBad = 0;
  let unknown = 0;
  const seen = new Set();
  for (const r of arr) {
    const id = r?.id;
    if (!want.has(id)) {
      unknown++;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (echoOf(String(r.echo ?? '')) === want.get(id)) echoOk++;
    else echoBad++;
  }
  return {
    json: true,
    got: arr.length,
    echoOk,
    echoBad,
    unknown,
    missing: SAMPLE.length - seen.size,
    sample: arr.slice(0, 2),
  };
}

async function once(v) {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body(v)),
  });
  if (!res.ok) {
    const msg = await res.text();
    return { status: res.status, error: msg.slice(0, 240) };
  }
  const json = await res.json();
  const um = json.usageMetadata ?? {};
  const cand = json.candidates?.[0] ?? {};
  const text = (cand.content?.parts ?? [])
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? '')
    .join('');
  return {
    status: 200,
    finish: cand.finishReason,
    prompt: um.promptTokenCount ?? 0,
    output: um.candidatesTokenCount ?? 0,
    thoughts: um.thoughtsTokenCount ?? 0,
    ...grade(text),
  };
}

async function main() {
  console.log(`模型 ${MODEL} · 每組 ${RUNS} 次 · 每次 ${SAMPLE.length} 筆\n`);
  for (const v of VARIANTS) {
    const rows = [];
    for (let i = 0; i < RUNS; i++) rows.push(await once(v));
    const bad = rows.find((r) => r.status !== 200);
    if (bad) {
      console.log(`✗ ${v.name}\n   HTTP ${bad.status}: ${bad.error}\n`);
      continue;
    }
    const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const jsonOk = rows.filter((r) => r.json).length;
    console.log(`✓ ${v.name}`);
    console.log(
      `   JSON 可解析 ${jsonOk}/${RUNS} · echo 通過 ${sum('echoOk')}/${SAMPLE.length * RUNS}` +
        ` · echo 對不上 ${sum('echoBad')} · 缺 ${sum('missing')} · 多 ${sum('unknown')}`,
    );
    console.log(
      `   token  prompt ${sum('prompt')} / output ${sum('output')} / thoughts ${sum('thoughts')}` +
        `${sum('thoughts') > 0 ? '  ← thinking 沒關掉' : ''}`,
    );
    if (rows[0]?.sample) console.log(`   ${JSON.stringify(rows[0].sample)}`);
    console.log();
  }
  console.log('判讀:echo 對不上 = §6.4 第二層攔下的 id 對滑。free 檔要能用,這一欄必須是 0。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
