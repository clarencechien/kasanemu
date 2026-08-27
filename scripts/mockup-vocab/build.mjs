/*
 * **疊字或錨點** —— 決定用的比較頁。
 *
 *   node --experimental-strip-types scripts/mockup-vocab/build.mjs [out.html]
 *
 * `measure-vocab.mjs` 量出「譯文佔版 + 不重疊」這組規則(§13-9),
 * `mockup-vocab.mjs` 出了兩張並排的 PNG。這一支出的是**可以動的那一份**:
 * 換素材、換顯示寬度、拉預算、開關重疊限制,當場看規則怎麼變。
 *
 * 三個東西一律**從實作來,不在頁面裡另寫一份**(§DF):
 *
 * - 幾何(框在哪裡、字級多大、值不值得翻)由 `imagegeo` / `imageblocks` 算,
 *   算好了才寫進頁面。頁面只負責「選哪幾塊」——那正是要比較的東西。
 * - 樣式是打包後的 `LAYER_CSS` 本人。
 * - 白貼片由 `paintPlates()` 畫,它是量出來的第三層(§DT)。
 *
 * 圖從原站抓、內嵌成 data URI:抓不到就中止 —— 拿假圖比較沒有意義
 * (和 `bench-vocab` 同一條規矩)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const IG = await import(path.join(root, 'src/content/imagegeo.ts'));
const IB = await import(path.join(root, 'src/shared/imageblocks.ts'));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

/** 兩端各一個:一張稀疏的深色圖表,一張密集的 UI 截圖 */
const SOURCES = {
  'lite-shot': {
    name: '密集的 UI 截圖',
    note: 'claude.com 的用例牆 · 2042px 原寬',
    url: 'https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/6a869c873ac9215b510583a4_5917bf5c.png',
  },
  'lite-chart': {
    name: '稀疏的深色圖表',
    note: 'ClickHouse 的 benchmark · 1580px 原寬',
    url: 'https://clickhouse.com/uploads/Elasticsearch_blog1_01_1d7bc921fc.png',
  },
};

const WIDTHS = [340, 480, 620, 800, 1040, 1400];
const PLATE_PAD_X = 0.62;

/** 譯文貼片畫出來多大。和 measure-vocab 同一支估法 */
function plateSize(label, fontPx) {
  const fs = Math.max(fontPx, IB.MIN_PATCH_FONT_PX);
  const w =
    [...label].reduce((n, c) => n + (/[　-鿿＀-￯]/u.test(c) ? 1 : 0.55), 0) * fs +
    fs * PLATE_PAD_X * 2;
  return { w, h: fs * 1.24, fs };
}

function geometry(fx) {
  const widths = {};
  for (const W of WIDTHS) {
    const H = Math.round((W * fx.nh) / fx.nw);
    const drawn = IG.drawnRect({ w: fx.nw, h: fx.nh }, { w: W, h: H }, 'contain',
      { x: { pct: 0.5 }, y: { pct: 0.5 } });
    const clip = { w: W, h: H };
    const blocks = [];
    for (const b of fx.blocks) {
      if (b.kind === 'code') continue;
      const r = IG.mapBox(b.box, drawn, clip);
      if (!r) continue;
      const label = b.zh || b.text;
      if (!label || !IB.worthAnnotating(b.text, label)) continue;
      const fontPx = IB.fontSizeFor(r.w, r.h, [...label].length, b.v === true);
      const pl = plateSize(label, fontPx);
      const rnd = (n) => Math.round(n * 10) / 10;
      blocks.push({
        x: rnd(r.x), y: rnd(r.y), w: rnd(r.w), h: rnd(r.h),
        label, text: b.text,
        font: rnd(pl.fs), pw: rnd(pl.w), ph: rnd(pl.h),
        fits: IB.patchable(fontPx),
      });
    }
    widths[W] = {
      W, H,
      mode: IG.imageMode(blocks.map((b) => b.fits)),
      fitPct: blocks.length ? Math.round((blocks.filter((b) => b.fits).length / blocks.length) * 100) : 100,
      total: fx.blocks.length,
      blocks,
    };
  }
  return widths;
}

/* ── 打包實作的樣式與貼片排版 ──────────────────────────────── */
const out = mkdtempSync(path.join(tmpdir(), 'ksnm-mk-'));
const bundle = path.join(out, 'b.js');
writeFileSync(
  path.join(out, 'e.ts'),
  `export { LAYER_CSS, VEIL_PAD, paintPlates } from ${JSON.stringify(path.join(root, 'src/content/overlay.ts'))};\n`,
);
await esbuild.build({
  entryPoints: [path.join(out, 'e.ts')],
  bundle: true, format: 'iife', globalName: 'KS',
  footer: { js: 'globalThis.KS = KS;' },
  outfile: bundle, minify: true, logLevel: 'error',
});

/* ── 抓圖 ──────────────────────────────────────────────────── */
const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();

async function embed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const src = `data:image/png;base64,${buf.toString('base64')}`;
  // 最寬只畫到 1400,原圖 2042 —— 縮一半省下三分之二的檔案大小
  return page.evaluate(async ([s, W]) => {
    const im = new Image();
    im.src = s;
    await im.decode();
    if (im.naturalWidth <= W) return s;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = Math.round((W * im.naturalHeight) / im.naturalWidth);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/webp', 0.88);
  }, [src, 1400]);
}

const data = {};
for (const [id, meta] of Object.entries(SOURCES)) {
  const fx = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/vision', `${id}.json`), 'utf8'));
  const img = await embed(meta.url);
  data[id] = { ...meta, nw: fx.nw, nh: fx.nh, img, widths: geometry(fx) };
  console.log(`  ${id}:${fx.blocks.length} 塊,圖 ${Math.round(img.length / 1024)}KB`);
}
await browser.close();

const tpl = readFileSync(path.join(here, 'page.tpl.html'), 'utf8');
const html = tpl
  .replace('/*__LAYER_CSS__*/', () => JSON.stringify(readFileSync(bundle, 'utf8')))
  .replace('/*__DATA__*/', () => JSON.stringify(data));
const dest = process.argv[2] ?? path.join(root, 'mockup-vocab.html');
writeFileSync(dest, html);
console.log(`\n${dest}  ${Math.round(html.length / 1024)}KB`);
