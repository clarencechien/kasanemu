/*
 * 快照的行為驗收:譯文就位、滑過去與按住 Alt 看得到原文、頁面自己的
 * 腳本不見了、相對路徑還找得到。
 *
 * 這一段沒辦法在 node 裡驗:display:contents 的元素**不產生盒子**,
 * 所以「看不看得到」只能問畫面上的文字,而那需要真的排版。
 * (第一版的檢查就是拿 getClientRects() 去量,兩邊都回 0,看起來像壞了。)
 *
 *   node scripts/probe-snapshot.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'detect.html');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(npm i -D playwright 之後再跑)');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const build = (src, name) => {
  const file = path.join(out, `${name}.js`);
  execFileSync(
    'npx',
    ['esbuild', path.join(here, '..', 'src', 'content', src),
     '--bundle', '--format=iife', `--global-name=${name}`,
     `--footer:js=globalThis.${name}=${name};`, `--outfile=${file}`],
    { stdio: 'inherit' },
  );
  return file;
};
const detect = build('detect.ts', 'D');
const snap = build('snapshot.ts', 'SNAP');

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript({ content: readFileSync(detect, 'utf8') });
await page.addInitScript({ content: readFileSync(snap, 'utf8') });
await page.goto('file://' + fixture);

const built = await page.evaluate(() => {
  const seen = new Set();
  const blocks = D.findCandidates(document.body, (el) => seen.has(el));
  const units = blocks.map((c, i) => ({
    el: c.el, range: c.range, tier: 'l1', l1Text: '\u3010\u8b6f' + i + '\u3011',
  }));
  const r = SNAP.buildSnapshot({
    units, hostId: 'kasanemu-root', url: 'https://example.com/article', version: 'probe',
  });
  return { html: r.html, applied: r.applied, total: units.length };
});
const file = path.join(out, 'snapshot.html');
writeFileSync(file, built.html);

const viewer = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await viewer.goto('file://' + file);
const state = await viewer.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ksnm')];
  const probe = boxes.find((b) => (b.querySelector('.ksnm-src')?.textContent ?? '').length > 30);
  probe && (probe.id = 'probe-target');
  const text = () => document.body.innerText;
  const original = probe?.querySelector('.ksnm-src')?.textContent?.trim().slice(0, 24) ?? '';
  const before = text();
  document.documentElement.classList.add('ksnm-peek');
  const during = text();
  document.documentElement.classList.remove('ksnm-peek');
  const rect = probe?.querySelector('.ksnm-tx')?.getBoundingClientRect();
  return {
    wrappers: boxes.length,
    pageScripts: [...document.querySelectorAll('script')].filter((s) => !s.textContent.includes('ksnm-peek')).length,
    base: document.querySelector('base')?.getAttribute('href') ?? null,
    host: document.getElementById('kasanemu-root') !== null,
    showsTx: before.includes('\u3010\u8b6f'),
    hidesSrc: original.length > 0 && !before.includes(original),
    peekShowsSrc: original.length > 0 && during.includes(original),
    peekHidesTx: !during.includes('\u3010\u8b6f'),
    point: rect ? { x: Math.round(rect.left + 4), y: Math.round(rect.top + 4) } : null,
    original,
  };
});

let hover = { showsSrc: false, hidesTx: false };
if (state.point) {
  await viewer.mouse.move(state.point.x, state.point.y);
  await viewer.waitForTimeout(80);
  hover = await viewer.evaluate((orig) => {
    const t = document.getElementById('probe-target')?.innerText ?? '';
    return { showsSrc: t.includes(orig), hidesTx: !t.includes('\u3010\u8b6f') };
  }, state.original);
}
await browser.close();

console.log(JSON.stringify({ ...built, html: undefined, ...state, hover }, null, 1));

const problems = [];
if (built.applied !== built.total) problems.push(`只套用 ${built.applied}/${built.total} 段`);
if (state.wrappers !== built.applied) problems.push('包裝數量對不上');
if (state.pageScripts > 0) problems.push('頁面自己的 script 沒被拿掉 —— 打開時會把譯文洗掉');
if (!state.base) problems.push('沒有 <base>:相對路徑的 CSS 與圖片會全部失效');
if (state.host) problems.push('疊層宿主被複製進快照了');
if (!state.showsTx) problems.push('平常看不到譯文');
if (!state.hidesSrc) problems.push('平常原文沒有讓開 —— 會變成兩份都在');
if (!state.peekShowsSrc) problems.push('按住 Alt 看不到原文');
if (!state.peekHidesTx) problems.push('按住 Alt 譯文沒有讓開');
if (!hover.showsSrc) problems.push('滑過去看不到原文');
if (!hover.hidesTx) problems.push('滑過去譯文沒有讓開');

if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
