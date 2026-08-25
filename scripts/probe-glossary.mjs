#!/usr/bin/env node
/**
 * 詞表實驗 + 26b/31b 對打(`docs/plan-glossary.md` §7)。
 *
 * 要回答三件事,而且要一起量 —— 分開量會得出「詞表遵循率不錯」但
 * 「id 紀律掉了」這種各自看都合格、合起來不能用的結論:
 *
 *   1. **詞表遵循率**:該用詞表說法的地方,有幾成真的用了?
 *   2. **副作用**:帶詞表之後 id 紀律的通過率有沒有下降?
 *      這一欄比第 1 欄重要 —— 寧可沒有詞表,也不能讓 echo 對位變差。
 *   3. **速度與品質**:26b(MoE,4B active)與 31b(dense)TPM 相同,
 *      但延遲與品質不會相同。
 *
 * 品質沒有自動化的判準,所以這裡量的是**可自動判定的品質訊號**
 * (漏譯、超出 maxChars、簡體字、原文照抄),真正的好壞最後印出
 * 兩個模型的譯文並排,用眼睛看。誠實一點:自動指標只能篩掉爛的,
 * 不能證明好的。
 *
 * 用法:
 *   GEMINI_API_KEY=... node scripts/probe-glossary.mjs
 *   GEMINI_API_KEY=... node scripts/probe-glossary.mjs --runs=3
 *   GEMINI_API_KEY=... node scripts/probe-glossary.mjs --models=gemma-4-31b-it,gemini-3.5-flash-lite
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env['GEMINI_API_KEY'] ?? '';
const arg = (name, dflt) =>
  (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).slice(
    name.length + 3,
  );

const MODELS = arg('models', 'gemma-4-26b-a4b-it,gemma-4-31b-it,gemini-3.5-flash-lite').split(',');
const RUNS = Number(arg('runs', '2'));

if (!KEY) {
  console.error('需要 GEMINI_API_KEY。');
  process.exit(2);
}

// Node 的 fetch 不吃 HTTPS_PROXY,這個環境的 egress 一定要走代理
try {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {
  /* 沒有 undici 就直連 */
}

/*
 * **用 production 的 `parseBatch` 評分,不要自己寫一份。**
 *
 * 第一版我自己寫了 echo 比對(嚴格相等),量出來 31b 只有 33% ——
 * 而同一批譯文用眼睛看是對的。原因是 production 的 `echoMatches`
 * 會先 `normalizeEcho`(NFKC、引號、破折號、空白、大小寫),那是 §M
 * 「echo 對不上的誤殺」花了一整輪才調出來的東西,而我在量測裡把它丟了。
 *
 * 這是 `docs/lessons.md` §1 在這一支腳本裡的**第二次**。
 * probe-detect.mjs 早就用 esbuild bundle production 的模組了(§CH-2),
 * 這裡照抄那個做法。
 */
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const nodePath = await import('node:path');
const outDir = mkdtempSync(nodePath.join(tmpdir(), 'ksnm-gl-'));
const protoFile = nodePath.join(outDir, 'protocol.mjs');
execFileSync(
  'npx',
  ['esbuild', 'src/worker/protocol.ts', '--bundle', '--format=esm', `--outfile=${protoFile}`],
  { stdio: 'inherit' },
);
const { parseBatch, echoOf: prodEchoOf } = await import(protoFile);

/**
 * 每一筆都**刻意含有一個詞表詞**,而且那個詞在一般翻譯下會被譯成別的說法 ——
 * 否則量不出「詞表有沒有生效」,只量到「模型剛好同意」。
 */
const SAMPLE = [
  ['u1', 'The attention mechanism scales quadratically with sequence length.', 40, 'body', 'attention mechanism'],
  ['u2', 'Embedding lookup dominates the memory budget on small devices.', 40, 'body', 'embedding'],
  ['u3', 'Rust ownership rules', 16, 'heading', 'ownership'],
  ['u4', 'We deploy the service mesh across three availability zones.', 36, 'body', 'service mesh'],
  ['u5', 'Garbage collection pauses were reduced by half in this release.', 40, 'body', 'garbage collection'],
  ['u6', 'Throughput', 8, 'cell', null],
  ['u7', 'The compiler emits a warning when the lifetime cannot be inferred.', 40, 'body', 'lifetime'],
  ['u8', 'Set up continuous integration before you write the first test.', 40, 'body', 'continuous integration'],
  ['u9', 'Known failure modes', 16, 'heading', null],
  ['u10', 'A closed shadow root isolates styles but hides computed values.', 40, 'body', 'shadow root'],
  ['u11', 'Rate limiting is enforced per project, not per API key.', 36, 'body', 'rate limiting'],
  ['u12', 'Published on March 3, 2026 by the infrastructure team.', 28, 'meta', null],
];

/** from → to。刻意選「模型自己會譯成別的說法」的詞,才量得出遵循率 */
const GLOSSARY = [
  ['attention mechanism', '注意力機制'],
  ['embedding', '嵌入向量'],
  ['ownership', '所有權模型'],
  ['service mesh', '服務網格'],
  ['garbage collection', '垃圾回收'],
  ['lifetime', '生命週期'],
  ['continuous integration', '持續整合'],
  ['shadow root', '影子根'],
  ['rate limiting', '速率限制'],
];
const WANT = new Map(GLOSSARY);

const SYSTEM_BASE = [
  '你是網頁翻譯引擎。輸入是一個 JSON array,每筆是一個獨立的網頁區塊。',
  '規則:',
  '1. 只輸出 JSON array,不要 markdown 圍籬、不要說明文字。',
  '2. 每筆輸出 {"id","echo","t"} 三個鍵。id 必須與輸入完全相同,不得重編、不得合併、不得改順序。',
  '3. echo = 該筆輸入 src 的前 8 個字元,原樣照抄,不翻譯、不修正。',
  '4. t = 譯文。譯文長度請控制在該筆的 maxChars 個字以內。',
  '5. role 表示排版角色:heading 用標題語域、cell 用表格語域、meta 用註記語域、body/list 用正文語域。',
  '6. 專有名詞、程式碼片段、URL、版本號原樣保留。',
  '7. 輸入有幾筆就輸出幾筆,不得漏、不得多。',
  '8. 目標語言:繁體中文(台灣用語)。',
].join('\n');

const GLOSSARY_BLOCK =
  '9. 詞表(遇到左邊的詞,譯文一律採用右邊的說法,不要自己另譯):\n' +
  GLOSSARY.map(([f, t]) => `   ${f} → ${t}`).join('\n');

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

const echoOf = prodEchoOf;

/**
 * 只在**簡體專用**的字上判定 —— 逐字挑,不要把整個詞塞進字元類。
 *
 * 第一版我寫的是「…确认执行验证…」,於是 `行` 這個兩岸共用字被一起收進來,
 * 「速率限制按專案執行」被判成簡體。**假警報比漏報更糟**:它會讓
 * 「31b 的繁體品質有問題」變成一個看起來有證據的錯誤結論。
 *
 * 收錄條件:簡化後與正體不同形,而且該字本身不是常用的正體字。
 */
const SIMPLIFIED =
  /[这么个们对时说过还没为该来发点动实现区块级别单节图记录调试样开关网络传输数库应边际层压缩权译语义确认执验证优处]/;

function grade(text, withGlossary) {
  const units = SAMPLE.map(([id, src, maxChars, role]) => ({ id, src, maxChars, role }));
  // production 的三層 id 紀律,一字不改
  const parsed = parseBatch(text, units, false);
  if (parsed.stats.got === 0 && parsed.results.length === 0) {
    // 真的回 0 筆(§AR 的空陣列),把原始回應留著給人看
    return { json: true, empty: true, raw: String(text).slice(0, 160), ...parsed.stats, texts: new Map() };
  }

  const cap = new Map(SAMPLE.map(([id, , maxChars]) => [id, maxChars]));
  const term = new Map(SAMPLE.map(([id, , , , t]) => [id, t]));

  let overCap = 0;
  let untranslated = 0;
  let simplified = 0;
  let leaked = 0;
  let termHit = 0;
  let termTotal = 0;
  const texts = new Map();

  for (const r of parsed.results) {
    const t = String(r.t ?? '');
    texts.set(r.id, t);
    if (t.length > cap.get(r.id)) overCap++;
    if (!/[一-鿿]/.test(t)) untranslated++;
    if (SIMPLIFIED.test(t)) simplified++;
    if (t.includes('→')) leaked++;
    const key = term.get(r.id);
    if (withGlossary && key) {
      termTotal++;
      const expect = WANT.get(key);
      if (expect && t.includes(expect)) termHit++;
    }
  }

  return {
    json: true,
    ...parsed.stats,
    // 失敗的細節照 production 的分類留下來
    failures: parsed.failures.map((f) => `${f.id} ${f.reason}`),
    overCap,
    untranslated,
    simplified,
    leaked,
    termHit,
    termTotal,
    texts,
  };
}

async function once(model, withGlossary) {
  const sys = withGlossary ? `${SYSTEM_BASE}\n${GLOSSARY_BLOCK}` : SYSTEM_BASE;
  /*
   * **和 production 的第一階(`full`)完全一樣。**
   *
   * 第一版這裡對 gemma 跳過了 `thinkingConfig` 與 `responseSchema`,
   * 理由是「Gemma 走 Gemini API 時支援情況不同」—— 那是 PRD 開放問題 3
   * 的**問句**,不是答案,而我把它當成了答案。結果:26b 把 4096 個
   * 輸出 token 全燒在 thinking 上、回傳 0 筆、花了 87 秒,
   * 看起來像「26b 不能用」。
   *
   * 實測:gemma-4-26b-a4b-it 與 gemma-4-31b-it **三個都吃**
   * (schema / systemInstruction / thinkingLevel:minimal)。
   * 加上 minimal 之後 thoughts 歸零,31b 從 13 秒掉到 3.4 秒。
   *
   * 這是 `docs/lessons.md` §1 的第七次:量測工具和 production 走不同的路,
   * 量出來的就是另一個系統的數字。
   */
  const body = {
    contents: [{ role: 'user', parts: [{ text: payload }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
    systemInstruction: { parts: [{ text: sys }] },
  };

  const t0 = Date.now();
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, status: res.status, error: (await res.text()).slice(0, 200) };

  const json = await res.json();
  const um = json.usageMetadata ?? {};
  const cand = json.candidates?.[0] ?? {};
  const text = (cand.content?.parts ?? [])
    .filter((p) => p.thought !== true)
    .map((p) => p.text ?? '')
    .join('');
  return {
    ms,
    status: 200,
    finish: cand.finishReason,
    prompt: um.promptTokenCount ?? 0,
    output: um.candidatesTokenCount ?? 0,
    thoughts: um.thoughtsTokenCount ?? 0,
    ...grade(text, withGlossary),
  };
}

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
};
const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

async function measure(model, withGlossary) {
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    rows.push(await once(model, withGlossary));
    // free 檔 15 RPM,兩個 gemma 共用同一個免費層配額 —— 別自己打自己
    await new Promise((r) => setTimeout(r, 4500));
  }
  return rows;
}

function report(model, tag, rows) {
  const bad = rows.find((r) => r.status !== 200);
  if (bad) {
    console.log(`  ${tag.padEnd(6)} ✗ HTTP ${bad.status}: ${bad.error}`);
    return null;
  }
  const n = SAMPLE.length * rows.length;
  const latency = med(rows.map((r) => r.ms));
  const out = sum(rows, 'output');
  const totalMs = rows.reduce((a, r) => a + r.ms, 0);
  console.log(
    `  ${tag.padEnd(6)} 延遲中位 ${String(latency).padStart(6)}ms · ` +
      `輸出 ${Math.round(out / rows.length)} tok/次 · ${Math.round(out / (totalMs / 1000))} tok/s`,
  );
  console.log(
    `         id 紀律(production parseBatch):採用 ${pct(sum(rows, 'kept'), n)} · ` +
      `echo 對不上 ${sum(rows, 'echoMismatch')} · 重複 ${sum(rows, 'dupe')} · ` +
      `缺 ${sum(rows, 'missing')} · 多 ${sum(rows, 'unknown')}`,
  );
  const fails = rows.flatMap((r) => r.failures ?? []).slice(0, 4);
  if (fails.length > 0) console.log(`         失敗細節:${fails.join(' / ')}`);
  const empty = rows.filter((r) => r.empty);
  if (empty.length > 0) console.log(`         **回 0 筆 ${empty.length}/${rows.length} 次** 原始回應:${empty[0].raw}`);
  console.log(
    `         品質訊號:超出 maxChars ${sum(rows, 'overCap')} · 沒翻 ${sum(rows, 'untranslated')} · ` +
      `簡體 ${sum(rows, 'simplified')} · 詞表洩漏 ${sum(rows, 'leaked')} · thoughts ${sum(rows, 'thoughts')}`,
  );
  const tt = sum(rows, 'termTotal');
  if (tt > 0) {
    console.log(`         **詞表遵循 ${pct(sum(rows, 'termHit'), tt)}** (${sum(rows, 'termHit')}/${tt})`);
  }
  return {
    latency,
    kept: sum(rows, 'kept') / n,
    termHit: tt > 0 ? sum(rows, 'termHit') / tt : null,
    texts: rows.find((r) => r.texts && r.texts.size > 0)?.texts,
  };
}

async function main() {
  console.log(
    `詞表實驗 + 速度品質對打 · 每組 ${RUNS} 次 × ${SAMPLE.length} 筆 · 詞表 ${GLOSSARY.length} 條\n`,
  );
  const results = new Map();
  for (const model of MODELS) {
    console.log(`── ${model}`);
    const off = await measure(model, false);
    const a = report(model, '無詞表', off);
    const on = await measure(model, true);
    const b = report(model, '有詞表', on);
    if (a && b) {
      const delta = Math.round((b.kept - a.kept) * 100);
      console.log(
        `         → 帶詞表之後 id 紀律 ${delta >= 0 ? '+' : ''}${delta} 個百分點` +
          `${delta < 0 ? '  ← 副作用,這比遵循率重要' : ''}`,
      );
      results.set(model, { off: a, on: b });
    }
    console.log();
  }

  // 自動指標只能篩掉爛的,不能證明好的 —— 譯文並排,用眼睛看
  console.log('════ 譯文並排(眼睛看的那一半)════\n');
  for (const [id, src] of SAMPLE.map(([id, src]) => [id, src])) {
    console.log(`${id}  ${src}`);
    for (const [model, r] of results) {
      const t = r.on.texts?.get(id) ?? '(無)';
      console.log(`   ${model.padEnd(24)} ${t}`);
    }
    console.log();
  }

  console.log('════ 判讀 ════');
  console.log('通過條件(docs/plan-glossary.md §7):詞表遵循 ≥ 80%,');
  console.log('而且 id 紀律**與不帶詞表時相同**。沒過就把該檔的 glossaryPrompt 留 false ——');
  console.log('使用者仍然有佔位符那條路,只是名詞片語要自己登記完整。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
