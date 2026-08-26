/*
 * 在真的瀏覽器裡驗圖片加註的渲染(`docs/plan-images.md` §15)。
 *
 * jsdom 沒有 layout,而圖片加註**整個都是幾何**:object-fit 的換算、
 * 字級分流、錨點位置、疊層落在文件座標的哪裡。這些在 node 測試裡
 * 一律回 0,所以只能在瀏覽器裡量。
 *
 *   node scripts/probe-image.mjs
 *
 * 用的是 production 的 `imagegeo.ts` 與 `overlay.ts`(esbuild 打包),
 * 不在這裡另寫一份 —— §DF 學到的那件事。
 * playwright 沒裝就跳過,不擋 npm run check。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const entry = path.join(out, 'entry.ts');
writeFileSync(
  entry,
  `export * from '${path.join(root, 'src/content/imagegeo.ts')}';\n` +
    `export { sanitizeBlocks } from '${path.join(root, 'src/shared/imageblocks.ts')}';\n`,
);
const bundle = path.join(out, 'geo.js');
execFileSync(
  'npx',
  ['esbuild', entry, '--bundle', '--format=iife', '--global-name=IG',
   '--footer:js=globalThis.IG=IG;', `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

/** 真實模型輸出當素材 —— 手寫的框驗不到「模型實際會給什麼」 */
const fixture = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/vision/lite-shot.json'), 'utf8'),
);

const page = `<!doctype html><meta charset=utf-8>
<style>
  body { margin: 0; font: 16px system-ui; }
  .pad { height: 400px; }
  figure { margin: 0 0 40px; }
  /* 三種 object-fit 各一個:換算錯了會在這裡現形 */
  #plain { width: 700px; height: 530px; }
  #cover { width: 400px; height: 400px; object-fit: cover; object-position: 50% 50%; }
  #contain { width: 500px; height: 500px; object-fit: contain; object-position: left top; }
</style>
<div class="pad">捲動占位:加註要在文件座標裡,跟著頁面捲</div>
<figure><img id="plain" src="IMG"></figure>
<figure><img id="cover" src="IMG"></figure>
<figure><img id="contain" src="IMG"></figure>
`;

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const p = await ctx.newPage();
await p.addInitScript({ content: readFileSync(bundle, 'utf8') });

// 一張和 fixture 同尺寸的假圖(內容不重要,幾何才重要)
const png = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${fixture.nw}" height="${fixture.nh}"><rect width="100%" height="100%" fill="#ddd"/></svg>`,
).toString('base64')}`;
/*
 * 寫成檔案再 goto,不用 setContent —— `addInitScript` 掛在導覽上,
 * 而 setContent 不算一次導覽,注入的腳本不會生效(踩過一次)。
 */
const html = path.join(out, 'probe.html');
writeFileSync(html, page.replaceAll('IMG', png));
await p.goto('file://' + html);
await p.waitForLoadState('load');

const got = await p.evaluate((fx) => {
  const { blocks } = IG.sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const report = {};
  for (const id of ['plain', 'cover', 'contain']) {
    const img = document.getElementById(id);
    const cs = getComputedStyle(img);
    const r = img.getBoundingClientRect();
    const clip = { w: r.width, h: r.height };
    const drawn = IG.drawnRect(
      { w: img.naturalWidth, h: img.naturalHeight },
      clip,
      cs.objectFit || 'fill',
      IG.parsePosition(cs.objectPosition || '50% 50%'),
    );
    const placed = IG.placeBlocks(blocks, drawn, clip);
    report[id] = {
      display: `${Math.round(r.width)}x${Math.round(r.height)}`,
      fit: cs.objectFit,
      drawn: `${Math.round(drawn.w)}x${Math.round(drawn.h)} @${Math.round(drawn.x)},${Math.round(drawn.y)}`,
      total: placed.length,
      veil: placed.filter((b) => b.kind === 'veil').length,
      pin: placed.filter((b) => b.kind === 'pin').length,
      // 每一塊都要落在圖的範圍內 —— 超出去就是加註畫到圖外面
      outside: placed.filter(
        (b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > clip.w + 0.5 || b.y + b.h > clip.h + 0.5,
      ).length,
      maxFont: Math.round(Math.max(0, ...placed.map((b) => b.fontPx)) * 10) / 10,
      // 文件座標:加著捲動位移才對得上
      docTop: Math.round(r.top + window.scrollY),
    };
  }
  return report;
}, fixture);

const problems = [];
console.log(JSON.stringify(got, null, 1));

for (const [id, r] of Object.entries(got)) {
  if (r.total === 0) problems.push(`${id}:一塊都沒放上去`);
  if (r.outside > 0) problems.push(`${id}:${r.outside} 塊畫到圖外面`);
  if (r.maxFont > 40) problems.push(`${id}:字級 ${r.maxFont} 超過上限`);
}
// plain 是 700px 寬:大字疊得起來,小字要落錨點
if (got.plain.veil === 0) problems.push('plain:700px 寬還全是錨點,分流失效');
if (got.plain.pin === 0) problems.push('plain:一個錨點都沒有,小字被硬塞成疊字了');
// cover 會裁掉兩側,所以放上去的塊**必然比 contain 少**
if (got.cover.total >= got.contain.total) {
  problems.push(`cover 沒有裁掉任何東西(${got.cover.total} vs contain ${got.contain.total})`);
}

// 捲動之後文件座標不變 —— 疊層跟著瀏覽器捲,不是 JS 追
await p.evaluate(() => window.scrollTo(0, 300));
const after = await p.evaluate(() => {
  const r = document.getElementById('plain').getBoundingClientRect();
  return Math.round(r.top + window.scrollY);
});
if (after !== got.plain.docTop) {
  problems.push(`捲動後文件座標變了:${got.plain.docTop} → ${after}`);
}

await browser.close();
if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
