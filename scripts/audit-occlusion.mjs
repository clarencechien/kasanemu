/*
 * **為什麼疊層明明翻好了卻看不見。**
 *
 *   node scripts/audit-occlusion.mjs https://example.com/article
 *
 * 使用者回報「內文都沒翻 只翻了 title」,而診斷說 63 塊裡 60 塊拿到了
 * L1 譯文、零失敗 —— 兩件事同時為真的唯一解釋是**畫上去之後被藏起來**。
 * log 裡滿滿的 `clipped-overlays {"checked":19,"hidden":19}` 就是現場。
 *
 * 藏起來的那條規則是 `clippedAway()`(`src/content/index.ts`):
 * 往上走每一層祖先,只要有一層的 overflow 不是 visible,就檢查這個元素的
 * 矩形有沒有掉到那一層的矩形外面。掉出去 = 頁面自己也看不到 = 譯文不該畫。
 *
 * 規則本身是對的(§CE 那次的教訓:用 elementFromPoint 會被 stretched link
 * 誤判)。**這支要問的是:在真實的頁面上,是哪一層祖先、差多少。**
 * 沒有這個答案就只能猜,而猜出來的修法會再誤判別的站。
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { buildDetector, newPage, settle } from './lib/audit.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

const url = process.argv[2];
if (!url) {
  console.error('用法:node scripts/audit-occlusion.mjs <url>');
  process.exit(2);
}

const detectJs = buildDetector();
/*
 * **裁切規則用實作那一份**,不在這裡抄。
 * `clipReason()` 和執行時的 `clippedAway()` 是同一支,只是說得出是哪一層 ——
 * 抄一份的話這支稽核會慢慢變成在回答另一個問題(§22-bis)。
 */
const occOut = mkdtempSync(path.join(tmpdir(), 'ksnm-occ-'));
const occBundle = path.join(occOut, 'occ.js');
await esbuild.build({
  entryPoints: [path.resolve('src/content/occlusion.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'OCC',
  footer: { js: 'globalThis.OCC = OCC;' },
  outfile: occBundle,
  logLevel: 'error',
});
const browser = await chromium.launch({
  executablePath: process.env['PLAYWRIGHT_BROWSERS_PATH']
    ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
    : undefined,
});
const { ctx, page } = await newPage(browser, detectJs);
await settle(page, url);
await page.addScriptTag({ content: readFileSync(occBundle, 'utf8') });

const report = await page.evaluate(() => {
  /** 實作那一份說得出「是哪一層」的版本 —— 這裡只負責把它變成人看得懂的字 */
  const why = (el) => {
    const c = globalThis.OCC.clipReason(el);
    if (!c) return null;
    const p = c.by;
    const cs = getComputedStyle(p);
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const box = (x) => ({
      t: Math.round(x.top), b: Math.round(x.bottom),
      l: Math.round(x.left), rr: Math.round(x.right),
    });
    return {
      hit: c.kind,
      tag: p.tagName,
      cls: typeof p.className === 'string' ? p.className.slice(0, 60) : '',
      ov: `${cs.overflowX}/${cs.overflowY}`,
      r: box(r),
      pr: box(pr),
    };
  };

  const units = globalThis.D.findCandidates(document.body, () => false);
  const rows = [];
  for (const u of units) {
    const el = u.el ?? u;
    if (!(el instanceof Element)) continue;
    const w = why(el);
    rows.push({
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 46),
      tag: el.tagName,
      clipped: w !== null,
      why: w,
    });
  }
  return { total: units.length, rows, scrollY: window.scrollY, vh: window.innerHeight };
});

await ctx.close();
await browser.close();

const bad = report.rows.filter((r) => r.clipped);
console.log(`\n${report.total} 個單元,${bad.length} 個會被藏起來\n`);
const byCause = new Map();
for (const r of bad) {
  const key = `${r.why.hit} · <${r.why.tag ?? '?'} class="${r.why.cls ?? ''}"> overflow ${r.why.ov ?? ''}`;
  const g = byCause.get(key) ?? [];
  g.push(r);
  byCause.set(key, g);
}
for (const [key, g] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${g.length} 段 · ${key}`);
  for (const r of g.slice(0, 4)) {
    const w = r.why;
    console.log(`     <${r.tag}> ${r.text}`);
    if (w.r && w.pr) {
      console.log(
        `       元素 top ${w.r.t} bottom ${w.r.b} left ${w.r.l} right ${w.r.rr}` +
          `   祖先 top ${w.pr.t} bottom ${w.pr.b} left ${w.pr.l} right ${w.pr.rr}`,
      );
    }
  }
  console.log();
}
process.exit(bad.length > 0 ? 1 : 0);
