/*
 * veil 的**可讀性量測**(`docs/plan-images.md` §13-7)。
 *
 * 這支存在的理由是一次實際的失誤:原本的配方 `brightness(1.16)` 是抄來的,
 * 而我用推論(「把底色推向白,原文自然退後」)取代了量測。brightness 是
 * 乘法 —— 深底白字上黑的乘完還是黑、白的還是白,對比一點都沒掉。使用者在
 * ClickHouse 的深色 bar chart 上看到的就是這個:原文和譯文兩層字互相打架
 * (`docs/deviations.md` §DH)。
 *
 * 所以這裡不看截圖、不憑感覺,量兩個數字:
 *
 * 1. **原文殘留** —— veil 蓋上去後,底下那段字對它的底還剩幾比幾。
 *    越低越好(目標 < 4:1):原文要退到背景,不是消失。
 * 2. **譯文對比** —— 加註的墨色對上 veil 收出來的那片底還有幾比幾。
 *    越高越好(目標 ≥ 4.5:1),而且**四種底色都要高** ——
 *    這才是「不必知道底下是什麼顏色」的意思。
 *
 * 量的是打包後 `overlay.ts` 裡那份 CSS,不在這裡另抄一份(§DF)。
 * 螢幕擷圖直接送回頁面裡用 canvas 解 —— 不必多一個 PNG 解碼相依。
 *
 *   node scripts/probe-veil.mjs
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

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-veil-'));
const entry = path.join(out, 'entry.ts');
writeFileSync(entry, `export { LAYER_CSS } from '${path.join(root, 'src/content/overlay.ts')}';\n`);
const bundle = path.join(out, 'css.js');
execFileSync(
  'npx',
  ['esbuild', entry, '--bundle', '--format=iife', '--global-name=KS',
   '--footer:js=globalThis.KS=KS;', `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

/*
 * 素材刻意取四個方向的底色,因為失效的正是「只在一端有效」。
 * 深底白字就是使用者回報的那張 bar chart。
 */
const CASES = [
  { name: '深底白字(bar chart)', bg: '#12181d', fg: '#ffffff' },
  { name: '淺底黑字(白底圖表)', bg: '#ffffff', fg: '#111111' },
  { name: '中灰底深字(照片)', bg: '#7a8288', fg: '#20262b' },
  { name: '彩底白字(品牌色塊)', bg: '#1a4fd6', fg: '#ffffff' },
];

const W = 480;
const H = 120;

const stage = (bg, fg, mode) => `
<div class="stage" style="background:${bg}">
  <div class="orig" style="color:${fg}">Elasticsearch ESQL</div>
  ${mode === 'bare' ? '' : `<div class="wrap"><div class="iblk" style="left:0;top:0;width:${W}px;height:${H}px">
    <span class="veil"></span>${mode === 'ink' ? `<span class="itx" style="font-size:34px">彈性搜尋 ESQL</span>` : ''}
  </div></div>`}
</div>`;

const page = `<!doctype html><meta charset=utf-8>
<style>
  body { margin:0; background:#888; }
  .stage { position:relative; width:${W}px; height:${H}px; overflow:hidden; }
  .orig { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          font:700 34px system-ui; letter-spacing:.5px; }
  .wrap { position:absolute; inset:0; }
</style>
<div id="all">${CASES.map((c) =>
  ['bare', 'veil', 'ink'].map((m) => stage(c.bg, c.fg, m)).join(''),
).join('')}</div>`;

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({
  viewport: { width: W + 20, height: H * CASES.length * 3 + 20 },
  deviceScaleFactor: 1,
});
const p = await ctx.newPage();
const html = path.join(out, 'veil.html');
writeFileSync(html, page);
await p.goto('file://' + html);
await p.addScriptTag({ content: readFileSync(bundle, 'utf8') });
await p.evaluate(() => {
  const s = document.createElement('style');
  s.textContent = globalThis.KS.LAYER_CSS;
  document.head.append(s);
});
await p.waitForTimeout(200);

const stages = await p.locator('.stage').all();
const shots = [];
for (const s of stages) shots.push((await s.screenshot()).toString('base64'));

/*
 * 解碼回像素:把擷圖當成 data: 圖片丟回頁面畫進 canvas。
 * data: 來源不會污染 canvas,所以 getImageData 讀得到。
 */
const stats = await p.evaluate(async (b64s) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const out = [];
  for (const b64 of b64s) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    // 只取中間帶(字所在的那一條),避開上下空白拉低變異
    const y0 = Math.floor(cv.height * 0.32);
    const y1 = Math.ceil(cv.height * 0.68);
    const d = g.getImageData(0, y0, cv.width, y1 - y0).data;
    const l = [];
    for (let i = 0; i < d.length; i += 4) {
      l.push(0.2126 * lin(d[i] / 255) + 0.7152 * lin(d[i + 1] / 255) + 0.0722 * lin(d[i + 2] / 255));
    }
    l.sort((a, b) => a - b);
    const at = (q) => l[Math.min(l.length - 1, Math.floor(l.length * q))];
    out.push({ p02: at(0.02), p04: at(0.04), p50: at(0.5), p96: at(0.96) });
  }
  return out;
}, shots);

const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

console.log('\n== veil 量測(數字越接近目標越好)==\n');
console.log('| 素材 | 原文對比(裸) | 原文殘留(veil 後) | 譯文對比 |');
console.log('|---|---|---|---|');
let worstResidual = 0;
let worstInk = Infinity;
for (let i = 0; i < CASES.length; i++) {
  const bare = stats[i * 3];
  const veil = stats[i * 3 + 1];
  const ink = stats[i * 3 + 2];
  const residual = ratio(veil.p04, veil.p96);
  // 譯文的墨(最暗那一撮)對上 veil 收出來的那片底(中位數)
  const inkC = ratio(ink.p02, veil.p50);
  worstResidual = Math.max(worstResidual, residual);
  worstInk = Math.min(worstInk, inkC);
  console.log(
    `| ${CASES[i].name} | ${ratio(bare.p04, bare.p96).toFixed(1)}:1 | ` +
      `${residual.toFixed(1)}:1 | ${inkC.toFixed(1)}:1 |`,
  );
}
console.log(`\n最差:原文殘留 ${worstResidual.toFixed(1)}:1(要 < 4)· 譯文 ${worstInk.toFixed(1)}:1(要 ≥ 4.5)`);
await browser.close();
if (worstResidual >= 4 || worstInk < 4.5) {
  console.error('\n不合格 —— veil 在某種底色上失效了,這正是抄配方會踩的那個坑');
  process.exit(1);
}
