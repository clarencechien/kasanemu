/*
 * 在真的瀏覽器裡驗選取規則。
 *
 * node 的測試(jsdom)沒有 layout:getBoundingClientRect 一律回 0,
 * 於是所有跟「這張圖多大」「這個元素自己佔不佔一行」有關的規則
 * 在測試裡根本不會被觸發。而那正是最容易出事的一類 ——
 * ClickHouse 那篇圖多的文章有一半不翻,就是這樣漏掉的。
 *
 *   node scripts/probe-detect.mjs
 *
 * playwright 不是 devDependency;沒裝就跳過,不擋 npm run check。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
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
const bundle = path.join(out, 'detect.js');
execFileSync(
  'npx',
  ['esbuild', path.join(here, '..', 'src', 'content', 'detect.ts'),
   '--bundle', '--format=iife', '--global-name=D', '--footer:js=globalThis.D=D;',
   `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
// MHTML / file:// 的 CSP 會擋掉 addScriptTag,init script 不受影響
await page.addInitScript({ content: readFileSync(bundle, 'utf8') });
await page.goto('file://' + fixture);

const got = await page.evaluate(() => {
  const seen = new Set();
  const blocks = D.findCandidates(document.body, (el) => seen.has(el));
  for (const c of blocks) seen.add(c.el);
  const labels = D.findLabels(document.body, 200, (el) => seen.has(el));
  return {
    blocks: blocks.map((c) => ({ src: c.src, tag: c.el.tagName, media: !!c.mediaSplit })),
    labels: labels.map((c) => c.src),
  };
});
await browser.close();

const blockText = got.blocks.map((b) => b.src);
const problems = [];
const needBlock = (frag, why) => {
  if (!blockText.some((t) => t.includes(frag))) problems.push(`${why}:內文層少了「${frag}」`);
};
const noBlock = (frag, why) => {
  if (blockText.some((t) => t.includes(frag))) problems.push(`${why}:內文層不該有「${frag}」`);
};

// 目次:巢狀的每一層都要翻,長短混雜不影響
needBlock('Introduction', '文章目次');
needBlock('Summary', '目次子項');
needBlock('Storage size', '目次子項');
// 自己底下包著子清單的那一行,單元要落在 <a> 上
const nested = got.blocks.find((b) => b.src === 'Benchmark results');
if (!nested) problems.push('目次:「Benchmark results」整行消失');
else if (nested.tag !== 'A') problems.push(`目次:單元落在 ${nested.tag},應該是 A`);

// 圖片自己佔一行 → 翻,而且帶著 mediaSplit
const withImg = got.blocks.find((b) => b.src.startsWith('A common use case'));
if (!withImg) problems.push('圖片自己佔一行的段落沒被翻');
else if (!withImg.media) problems.push('圖片自己佔一行的段落沒帶 mediaSplit,疊層會蓋到圖');

// 行內圖片 → 照舊整段跳過(疊層一定會蓋到圖)
noBlock('Latency dropped', '行內圖片');

// sticky 目次:內文層碰不得,但要留在加翻層(滑上去看得到)
if (!got.labels.includes('Introduction')) {
  problems.push('浮動目次:sticky 子樹不能有內文疊層,又被踢出加翻層 → 什麼都沒有');
}

console.log(JSON.stringify(got, null, 1));
if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
