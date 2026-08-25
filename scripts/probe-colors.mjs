/*
 * 在真的瀏覽器裡驗顏色解析。
 *
 * node 的測試跑不到這一段:parseColor() 的慢路徑要 canvas,
 * resolveBackground() 要 getComputedStyle 與真正的 CSS 串接。
 * 而顏色選錯是**沉默的失敗** —— 疊層照畫,只是看不見,
 * 於是只能等使用者截圖。ClickHouse 那一輪就是這樣浪費掉的。
 *
 *   npx playwright@latest install-deps   # 多半不用
 *   node scripts/probe-colors.mjs
 *
 * playwright 不是 devDependency(它很大,而且只有這支用得到)。
 * 沒裝的話這支會說一聲就結束,不會擋住 npm run check。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'colors.html');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(npm i -D playwright 之後再跑)');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const bundle = path.join(out, 'styleprobe.js');
execFileSync(
  'npx',
  ['esbuild', path.join(here, '..', 'src', 'content', 'styleprobe.ts'),
   '--bundle', '--format=iife', '--global-name=KSNM', `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
await page.goto('file://' + fixture);
await page.addScriptTag({ content: readFileSync(bundle, 'utf8') });

const rows = await page.evaluate(() =>
  [...document.querySelectorAll('[id]')].map((el) => {
    const style = KSNM.probeStyle(el, 100);
    return {
      id: el.id,
      color: getComputedStyle(el).color,
      background: style.background,
      lightText: KSNM.lightText(getComputedStyle(el).color),
    };
  }),
);
const unparsed = await page.evaluate(() => KSNM.unparsedColors());
await browser.close();

console.table(rows);

/*
 * 期望值。每一條都對應一個實際發生過的災情:
 *  - lab() 解析失敗 → 深色頁面被判成淺色 → 白底配淺灰字(build 44)
 *  - 半透明白卡片被當成不透明 → 深色頁面上一塊純白(build 43)
 */
const problems = [];
if (unparsed.length > 0) problems.push(`解析不了的顏色:${unparsed.join(' · ')}`);
for (const r of rows) {
  if (!r.lightText) problems.push(`${r.id}:亮字被判成暗字(${r.color})`);
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(r.background ?? '');
  if (!m) {
    problems.push(`${r.id}:沒解出背景色(${r.background})`);
    continue;
  }
  const lum = (+m[1] * 0.299 + +m[2] * 0.587 + +m[3] * 0.114) / 255;
  if (lum > 0.5) problems.push(`${r.id}:深色頁面卻挑了淺底 ${r.background}`);
}
if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
