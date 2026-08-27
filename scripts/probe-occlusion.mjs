/*
 * **疊層該不該藏起來**(`src/content/occlusion.ts`)。
 *
 *   npm run probe:occlusion
 *
 * 這條規則有兩個相反的失敗方向,而且**只有真的瀏覽器分得出來**:
 *
 * - 藏太多:§DV。`body { overflow-x: hidden }` 是到處都在用的擋橫向捲軸
 *   寫法,而它的 overflow 被傳播到視窗、自己一格都不裁 ——
 *   讀計算值會以為它裁,於是首屏以下整篇的譯文都被藏起來。
 * - 藏太少:真的內層捲動容器裡、捲出去的內容,頁面沒有畫它,
 *   我們的疊層卻不受任何裁切,會浮在無關的位置。
 *
 * 「門面帶」(視窗上下被 fixed / sticky 佔掉的那一段)也是同一件事的一半:
 * 裁太多和被祖先裁掉的下場一模一樣。而它有自己的兩個方向 ——
 * 黏著的**側欄**不可以算(§DY),橫跨畫面的**頁尾列**一定要算。
 *
 * 所以 fixture 兩種都裝著,而且**兩個方向都斷言** ——
 * 只驗一邊的話,「修好藏太多」會直接變成「什麼都不藏」。
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-occ-'));
const bundle = path.join(out, 'occ.js');
await esbuild.build({
  entryPoints: [path.resolve('src/content/occlusion.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'OCC',
  footer: { js: 'globalThis.OCC = OCC;' },
  outfile: bundle,
  logLevel: 'error',
});

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await ctx.newPage();
const file = path.join(out, 'f.html');
writeFileSync(file, readFileSync('tests/fixtures/occlusion.html', 'utf8'));
await page.goto('file://' + file);
await page.addScriptTag({ content: readFileSync(bundle, 'utf8') });
await page.waitForTimeout(120);

const got = await page.evaluate(() => {
  const ask = (id) => globalThis.OCC.clippedAway(document.getElementById(id));
  /*
   * clipsContent 是「祖先會不會裁」唯一的一份定義(§DZ)——
   * clippedAway 和 index.ts 的 clippers() 都吃它。body 把 overflow 傳播給
   * 視窗,必須判「不裁」;真的內層捲動容器必須判「裁」。
   */
  const clips = {
    body: globalThis.OCC.clipsContent(document.body),
    inner: globalThis.OCC.clipsContent(document.getElementById('inner')),
  };
  const band = () => {
    const d = globalThis.OCC.chromeBandDetail(window.innerHeight - 2, false);
    return { band: Math.round(d.band), by: d.by ? d.by.id || d.by.tagName : null };
  };
  // 先把全寬的那條藏起來,單獨問黏著側欄算不算門面
  const bar = document.getElementById('chrome-bar');
  bar.style.display = 'none';
  const railOnly = band();
  bar.style.display = '';
  const withBar = band();
  const before = {
    above: ask('above'),
    below: ask('below'),
    below2: ask('below2'),
    'scrolled-in': ask('scrolled-in'),
    'scrolled-out': ask('scrolled-out'),
  };
  // 捲下去之後,首屏以上的那一段換它離開視窗 —— 一樣不該被藏
  window.scrollTo(0, 1400);
  return {
    before,
    afterScroll: { above: ask('above'), below: ask('below') },
    railOnly,
    withBar,
    clips,
  };
});
await browser.close();

console.log('裁切與門面帶:', JSON.stringify(got));

const problems = [];
const mustShow = (where, id, v) => {
  if (v) problems.push(`${where} ${id}:被藏起來了 —— 頁面明明看得到(§DV)`);
};
mustShow('捲動前', 'above', got.before.above);
mustShow('捲動前', 'below', got.before.below);
mustShow('捲動前', 'below2', got.before.below2);
mustShow('捲動前', 'scrolled-in', got.before['scrolled-in']);
mustShow('捲動後', 'above', got.afterScroll.above);
mustShow('捲動後', 'below', got.afterScroll.below);
if (!got.before['scrolled-out']) {
  problems.push('scrolled-out:沒被藏 —— 內層捲動容器裁掉的東西,疊層會浮在無關的位置');
}
if (got.clips.body) {
  problems.push('clipsContent 說 body 會裁 —— 捲過第一屏之後整頁的譯文會被裁光(§DZ)');
}
if (!got.clips.inner) {
  problems.push('clipsContent 說內層捲動容器不裁 —— 捲出去的內容疊層會浮在外面');
}
/*
 * 門面帶的兩個方向(§DY)。
 * 只驗一邊的話,「別把側欄當門面」會直接變成「什麼門面都不認」。
 */
if (got.railOnly.band > 0) {
  problems.push(
    `黏著側欄被當成門面了(裁掉 ${got.railOnly.band}px)—— 半個視窗的譯文會不見`,
  );
}
if (got.withBar.band <= 0) {
  problems.push('橫跨畫面的頁尾列沒被認出來 —— 譯文會浮在它上面');
}

if (problems.length === 0) {
  console.log('\n全部合格。');
  process.exit(0);
}
console.log('\n不合格:');
for (const p of problems) console.log('  ' + p);
process.exit(1);
