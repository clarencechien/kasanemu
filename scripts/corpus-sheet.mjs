/*
 * **真實素材的加註總覽** —— 每一張圖照它在頁面上的實際大小畫一次。
 *
 *   node scripts/corpus-sheet.mjs corpus-result.json out.html
 *
 * `corpus-vision.mjs` 印的是數字,這一支畫的是**結果**。
 * 使用者要的是「看翻完會怎樣」,而 21 塊和 2 塊在表格裡長得一樣。
 *
 * 樣式與貼片排版來自打包後的 `overlay.ts`,顯示寬度用**線上量到的那個**
 * (`getBoundingClientRect().width`)—— 不是隨便挑一個尺寸,
 * 因為放幾塊正是尺寸的函數。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const [src, dest = 'corpus-sheet.html'] = process.argv.slice(2);
if (!src) {
  console.error('用法:node scripts/corpus-sheet.mjs corpus-result.json [out.html]');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(src, 'utf8'));

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-sheet-'));
const bundle = path.join(out, 'b.js');
writeFileSync(
  path.join(out, 'e.ts'),
  `export { LAYER_CSS, VEIL_PAD, paintPlates } from ${JSON.stringify(path.resolve('src/content/overlay.ts'))};\n`,
);
await esbuild.build({
  entryPoints: [path.join(out, 'e.ts')],
  bundle: true, format: 'iife', globalName: 'KS',
  footer: { js: 'globalThis.KS = KS;' },
  outfile: bundle, minify: true, logLevel: 'error',
});

const tpl = readFileSync(path.resolve('scripts/corpus-sheet.tpl.html'), 'utf8');
const html = tpl
  .replace('/*__BUNDLE__*/', () => JSON.stringify(readFileSync(bundle, 'utf8')))
  .replace('/*__ROWS__*/', () => JSON.stringify(rows));
writeFileSync(dest, html);
console.log(`${dest}  ${Math.round(html.length / 1024)}KB · ${rows.length} 張`);
