/*
 * 加註語彙比較台 —— 六種呈現、同一張圖、同一批譯文。
 *
 *   node scripts/bench-vocab/build.mjs        # 產生 bench.html
 *
 * 為什麼在 repo 裡:它和 `probe-veil.mjs` 是同一類東西 ——
 * **可重跑的證據**,不是一次性的截圖。決定要不要改語彙規則時
 * (`TODO.md`),拿它跑一次比看舊截圖可靠。
 *
 * 為什麼只收原始碼不收產物:產物是 120KB、裡面兩張 base64 圖。
 * 圖從原站抓(下面兩個 URL),抓不到就中止 —— 拿假圖比較沒有意義。
 *
 * 加註的樣式在 `page.tpl.html` 裡是**抄過來的**,不是 import
 * `overlay.ts`:比較台要畫的有四種是 production 沒有的東西(拉線、
 * 溢位徽章、行內清單)。抄過來的那幾條(`.veil` / `.itx` / `.ipin`)
 * 若和 production 分岔,`probe-veil.mjs` 那邊會先發現 —— 它量的是
 * production 的那一份。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

/** 素材:一張稀疏的深色圖表,一張密集的 UI 截圖 —— 兩端各一個 */
const SOURCES = {
  chart: {
    url: 'https://clickhouse.com/uploads/Elasticsearch_blog1_01_1d7bc921fc.png',
    fixture: 'lite-chart.json',
    mime: 'image/png',
  },
  shot: {
    url: 'https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/6a869c873ac9215b510583a4_5917bf5c.png',
    fixture: 'lite-shot.json',
    mime: 'image/png',
  },
};

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}

async function grab(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 密集那張是 2042px 寬,而比較台最多畫到 900 —— 縮一半省下 350KB */
async function shrink(page, buf, mime, maxW) {
  const src = `data:${mime};base64,${buf.toString('base64')}`;
  return page.evaluate(async ([s, W]) => {
    const im = new Image();
    im.src = s;
    await im.decode();
    if (im.naturalWidth <= W) return s;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = Math.round((W * im.naturalHeight) / im.naturalWidth);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/webp', 0.86);
  }, [src, maxW]);
}

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();

const data = {};
const uri = {};
for (const [key, s] of Object.entries(SOURCES)) {
  const fx = JSON.parse(
    readFileSync(path.join(root, 'tests/fixtures/vision', s.fixture), 'utf8'),
  );
  // 線上形狀是 box_2d,內部型別是 box —— 這條接縫斷過一次(§DF)
  data[key] = {
    nw: fx.nw,
    nh: fx.nh,
    blocks: fx.blocks.map((b) => ({ box: b.box_2d ?? b.box, text: b.text, zh: b.zh, c: b.c ?? 1 })),
  };
  uri[key] = await shrink(page, await grab(s.url), s.mime, 1200);
  console.log(`${key}: ${data[key].blocks.length} 塊 · ${Math.round(uri[key].length / 1024)}KB`);
}
await browser.close();

const out = readFileSync(path.join(here, 'page.tpl.html'), 'utf8')
  .replace('"data:image/png;base64,__IMG__"', JSON.stringify(uri.chart))
  .replace('"data:image/webp;base64,__SHOT__"', JSON.stringify(uri.shot))
  .replace('__DATA__', JSON.stringify(data));
const dest = path.join(here, 'bench.html');
writeFileSync(dest, out);
console.log(`→ ${path.relative(root, dest)}  ${Math.round(out.length / 1024)}KB`);
