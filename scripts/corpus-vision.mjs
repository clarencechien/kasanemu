/*
 * **把真的站上的圖丟給 gemma,看新規則翻出來會怎樣。**
 *
 *   gemini_key=... node --experimental-strip-types scripts/corpus-vision.mjs corpus.json
 *   ... --cache .viscache --out sheet.html
 *
 * 到 §DW 為止,語彙規則的所有數字都靠**四份** vision 回應撐著,
 * 而 `TEXT_HEAVY_BLOCKS = 24` 這種門檻靠四份是撐不住的。使用者的話是
 * 「拿真的圖表來…看翻完會怎樣 用 gemma4 就好」。
 *
 * 走的是 **production 的整條路**,不另寫一份:
 * `downscale()`(在 Chromium 裡跑 OffscreenCanvas)→ `callVision()`
 * (真的 prompt、真的階梯、真的 sanitize)→ `placeBlocks()`。
 * §DB-2 學到「量測要走 production 的路」,§7 學到「production 的路也要真的走一次」。
 *
 * **回應存檔**:同一張圖只問一次模型。改門檻、改預算、重畫比較稿都不必
 * 再打一次 API —— 免費檔也有配額,而且一次跑二十張要十分鐘。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const KEY = process.env['gemini_key'] || process.env['GEMINI_API_KEY'];
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const corpusFile = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!corpusFile) {
  console.error('用法:node scripts/corpus-vision.mjs corpus.json [--cache dir] [--out sheet.html]');
  process.exit(2);
}
const CACHE = arg('cache', '.viscache');
mkdirSync(CACHE, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('略過:沒有 playwright');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

const IG = await import(path.resolve('src/content/imagegeo.ts'));
const IB = await import(path.resolve('src/shared/imageblocks.ts'));

/* ── 打包 production 的 vision + downscale ─────────────────── */
const out = mkdtempSync(path.join(tmpdir(), 'ksnm-corpus-'));
const entry = path.join(out, 'e.ts');
writeFileSync(
  entry,
  `export { callVision } from '${path.resolve('src/worker/vision.ts')}';\n` +
    `export { downscale, sniffMime } from '${path.resolve('src/worker/imagefetch.ts')}';\n` +
    `export { sanitizeBlocks } from '${path.resolve('src/shared/imageblocks.ts')}';\n`,
);
const bundle = path.join(out, 'v.mjs');
execFileSync(
  'npx',
  ['esbuild', entry, '--bundle', '--format=esm', '--platform=neutral', '--external:node:*',
   `--outfile=${bundle}`],
  { stdio: 'inherit' },
);
globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };
const V = await import(bundle);

/* ── downscale 需要 OffscreenCanvas,所以在 Chromium 裡跑 ──── */
const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const shrinkPage = await browser.newPage();

/** production 的 MAX_EDGE 是 1536 —— 這裡照抄那個行為,不是另訂一個 */
const MAX_EDGE = 1536;
async function toModelBytes(buf, mime) {
  const src = `data:${mime};base64,${buf.toString('base64')}`;
  return shrinkPage.evaluate(
    async ([s, edge]) => {
      const im = new Image();
      im.src = s;
      await im.decode();
      const scale = Math.min(1, edge / Math.max(im.naturalWidth, im.naturalHeight));
      const w = Math.round(im.naturalWidth * scale);
      const h = Math.round(im.naturalHeight * scale);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(im, 0, 0, w, h);
      const url = cv.toDataURL('image/webp', 0.9);
      return { data: url.slice(url.indexOf(',') + 1), w, h };
    },
    [src, MAX_EDGE],
  );
}

const SPEC = {
  id: 'free',
  modelId: 'gemma-4-31b-it',
  maxOutputTokens: 8192,
  thinking: false,
  glossaryPrompt: false,
};

const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
const rows = [];
let asked = 0;

for (const [i, im] of corpus.entries()) {
  const key = createHash('sha256').update(im.src).digest('hex').slice(0, 16);
  const cached = path.join(CACHE, `${key}.json`);
  let rec;
  if (existsSync(cached)) {
    rec = JSON.parse(readFileSync(cached, 'utf8'));
  } else {
    if (!KEY) {
      console.error(`  跳過(沒有 key 而且沒快取):${im.src.slice(0, 60)}`);
      continue;
    }
    try {
      const res = await fetch(im.src, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 看檔案本身,不看伺服器怎麼說(§DO)
      const mime = V.sniffMime(new Uint8Array(buf.subarray(0, 32))) ?? 'image/png';
      const shrunk = await toModelBytes(buf, mime);
      const t0 = Date.now();
      const r = await V.callVision(KEY, SPEC, { data: shrunk.data, mime: 'image/webp', w: shrunk.w, h: shrunk.h, hash: key }, 'zh-TW');
      asked++;
      rec = r.ok
        ? { ok: true, blocks: r.blocks, nw: shrunk.w, nh: shrunk.h, ms: Date.now() - t0, thumb: shrunk.data }
        : { ok: false, reason: r.reason, ms: Date.now() - t0 };
      writeFileSync(cached, JSON.stringify(rec));
    } catch (e) {
      rec = { ok: false, reason: String(e).split('\n')[0].slice(0, 80) };
      writeFileSync(cached, JSON.stringify(rec));
    }
    // 免費檔 15 RPM,而且和文字共用 —— 從容一點
    await new Promise((r) => setTimeout(r, 4500));
  }
  const label = `${im.site}/${path.basename(new URL(im.src).pathname).slice(0, 28)}`;
  if (!rec.ok) {
    console.log(`${String(i + 1).padStart(2)}. ✗ ${label} — ${rec.reason}`);
    rows.push({ im, rec, fail: true });
    continue;
  }
  const H = Math.round((im.dw * rec.nh) / rec.nw);
  const drawn = IG.drawnRect({ w: rec.nw, h: rec.nh }, { w: im.dw, h: H }, 'contain',
    { x: { pct: 0.5 }, y: { pct: 0.5 } });
  const placed = IG.placeBlocks(rec.blocks, drawn, { w: im.dw, h: H });
  const zw = 1200;
  const zh = Math.round((zw * rec.nh) / rec.nw);
  const zdrawn = IG.drawnRect({ w: rec.nw, h: rec.nh }, { w: zw, h: zh }, 'contain',
    { x: { pct: 0.5 }, y: { pct: 0.5 } });
  const zoom = IG.placeBlocks(rec.blocks, zdrawn, { w: zw, h: zh });
  const worth = placed.placed.length + placed.left;
  console.log(
    `${String(i + 1).padStart(2)}. ${label.padEnd(44)} ` +
      `${String(im.dw).padStart(4)}px  回 ${String(rec.blocks.length).padStart(2)} ` +
      `值得翻 ${String(worth).padStart(2)}  行內 ${String(placed.placed.length).padStart(2)}` +
      `(${{ ok: '畫', 'text-heavy': '太密', nothing: '無字' }[placed.why]})` +
      `  放大 ${String(zoom.placed.length).padStart(2)}`,
  );
  rows.push({ im, rec, placed, zoom, worth, H });
}
await browser.close();

/* ── 摘要 ──────────────────────────────────────────────────── */
const ok = rows.filter((r) => !r.fail);
const dense = ok.filter((r) => r.placed.why === 'text-heavy');
const empty = ok.filter((r) => r.placed.why === 'nothing');
const drawn = ok.filter((r) => r.placed.why === 'ok');
console.log(`\n${rows.length} 張:${drawn.length} 張畫、${dense.length} 張太密、${empty.length} 張沒字、${rows.length - ok.length} 張失敗`);
console.log(`這次真的問了模型 ${asked} 次(其餘來自 ${CACHE})`);
if (drawn.length > 0) {
  const n = drawn.map((r) => r.placed.placed.length).sort((a, b) => a - b);
  console.log(`有畫的那幾張:每張 ${n[0]}–${n.at(-1)} 塊,中位數 ${n[Math.floor(n.length / 2)]}`);
}
const worths = ok.map((r) => r.worth).sort((a, b) => a - b);
console.log(`「值得翻」的分布:${worths.join(' ')}`);

writeFileSync(arg('out', 'corpus-result.json'), JSON.stringify(
  rows.map((r) => ({
    site: r.im.site, src: r.im.src, page: r.im.page, where: r.im.where,
    dw: r.im.dw, dh: r.H, nw: r.rec.nw, nh: r.rec.nh,
    fail: r.fail ?? false, reason: r.rec.reason,
    ms: r.rec.ms,
    returned: r.rec.blocks?.length ?? 0,
    worth: r.worth ?? 0,
    why: r.placed?.why,
    inline: r.placed?.placed ?? [],
    left: r.placed?.left ?? 0,
    zoom: r.zoom?.placed.length ?? 0,
    thumb: r.rec.thumb ?? null,
  })),
));
