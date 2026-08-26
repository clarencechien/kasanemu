/*
 * 圖片加註的參數量測(`docs/plan-images.md` §13)。
 *
 *   gemini_key=... node scripts/measure-vision.mjs 圖片...
 *
 * 三件事,都是實作時**猜的**、要用數字定案的:
 *
 * 1. **縮圖敏感度**(§13-1):`MAX_EDGE` 現在是 1536,純屬保守猜測。
 *    縮到 1024 / 768 會少找到多少塊?省多少 token?
 * 2. **thinking 檔位**(§13-2):我們的 probe 用 `minimal` 在網頁渲染圖上
 *    沒事,但 sukemu 在**照片**上實測過降 thinking 會讓框橫向漂移
 *    (`adr/0001`)。兩種素材各跑一次 default / minimal 再定。
 * 3. **照片型素材**(§13-3):lite 在 sukemu 的照片上出局,在我們的
 *    渲染圖上卻最好。域不同,結論不能互相搬 —— 所以要在照片上自己量一次。
 *
 * 縮圖用的是 **production 的 `downscale()`**(在 Chromium 裡跑 OffscreenCanvas),
 * 不是另寫一份 —— 縮圖正是這次要判斷的東西,更不能換掉(§DB-2 / §DF)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env['gemini_key'] || process.env['GEMINI_API_KEY'];
if (!KEY) {
  console.log('略過:沒有 gemini_key / GEMINI_API_KEY');
  process.exit(0);
}
const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('用法:gemini_key=... node scripts/measure-vision.mjs 圖片.png ...');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(縮圖要 OffscreenCanvas)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));

/* ── production 的縮圖跑在瀏覽器裡 ─────────────────────────────── */
const shrinkEntry = path.join(out, 'shrink.ts');
writeFileSync(
  shrinkEntry,
  `export { downscale } from '${path.join(root, 'src/worker/imagefetch.ts')}';\n`,
);
const shrinkBundle = path.join(out, 'shrink.js');
execFileSync('npx', ['esbuild', shrinkEntry, '--bundle', '--format=iife', '--global-name=SH',
  '--footer:js=globalThis.SH=SH;', `--outfile=${shrinkBundle}`], { stdio: 'inherit' });

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
await page.addInitScript({ content: readFileSync(shrinkBundle, 'utf8') });
// 給它一個 http-ish 的 origin,OffscreenCanvas 才不會被 file:// 的限制絆到
await page.goto('data:text/html,<meta charset=utf-8>');

/** base64 進、base64 出:走 production 的 downscale */
async function shrink(b64, mime, edge) {
  return page.evaluate(
    async ({ b64, mime, edge }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      // downscale 的門檻是模組常數,量測要掃階梯 → 先自己縮到目標邊長再交給它
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const png = await cv.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await png.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { data: btoa(s), w, h, bytes: buf.length };
    },
    { b64, mime, edge },
  );
}

/* ── production 的視覺請求跑在 node 裡 ─────────────────────────── */
const vEntry = path.join(out, 'v.ts');
writeFileSync(vEntry, `export { callVision } from '${path.join(root, 'src/worker/vision.ts')}';\n`);
const vBundle = path.join(out, 'v.mjs');
execFileSync('npx', ['esbuild', vEntry, '--bundle', '--format=esm', '--platform=neutral',
  '--external:node:*', `--outfile=${vBundle}`], { stdio: 'inherit' });
globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };
const { callVision } = await import(vBundle);

const SPECS = {
  balanced: { tier: 'balanced', modelId: 'gemini-3.5-flash-lite', maxOutputTokens: 8192, glossaryPrompt: true },
  free: { tier: 'free', modelId: 'gemma-4-31b-it', maxOutputTokens: 4096, glossaryPrompt: true },
};

/*
 * 0 = 原尺寸不縮。**這一格是整個量測的基準** ——
 * 沒有它就只能比「縮多少」,答不出「該不該縮」。
 */
const EDGES = [0, 2048, 1536, 1024, 768];

/*
 * **指標選擇是這支腳本最重要的決定,而第一版選錯了。**
 *
 * 第一版用「對每個框找最近的框算 IoU」。結果同一張圖、同樣尺寸跑兩次:
 * 35 塊 vs 58 塊、IoU 0.48 —— 量到的是**模型的隨機性**,不是解析度。
 * 照那個數字下結論,「1536 夠用」或「縮圖有害」都能講得頭頭是道,
 * 而兩句都是噪音。
 *
 * 換成**文字召回率**:模型有沒有找到這串字。它對框的抖動、對「一塊還是
 * 兩塊」的切法都不敏感,而那正是我們不在乎的部分 —— 我們在乎的是
 * 「圖上的字有沒有被讀到」。
 *
 * 而且**每個配置都要有噪音底線**:同一個配置跑兩次,兩次的差距就是
 * 這個量測的解析度。比噪音小的差異不算差異。
 */
const norm = (t) => t.toLowerCase().replace(/[\s\p{P}]/gu, '');

/** b 這一組找到了 a 裡的幾成字串 */
function recall(ref, got) {
  if (ref.size === 0) return 1;
  const bag = got.map((x) => norm(x.text)).filter(Boolean);
  let hit = 0;
  for (const r of ref) {
    // 子字串比對:模型可能把兩行併成一塊,那也算找到
    if (bag.some((g) => g.includes(r) || r.includes(g))) hit++;
  }
  return hit / ref.size;
}

for (const file of files) {
  const raw = readFileSync(file);
  const b64 = raw.toString('base64');
  const mime = file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  console.log(`\n════ ${path.basename(file)}  (${raw.length} bytes)`);

  for (const tier of ['balanced', 'free']) {
    const spec = SPECS[tier];
    console.log(`  ── ${spec.modelId}`);
    const runs = [];
    for (const edge of EDGES) {
      // 原尺寸跑兩次:第二次就是這個量測的噪音底線
      const times = edge === 0 ? 2 : 1;
      for (let k = 0; k < times; k++) {
        const img = await shrink(b64, mime, edge || 99999);
        const t0 = Date.now();
        const res = await callVision(KEY, spec, { ...img, mime: 'image/png', hash: 'm' }, 'zh-TW', []);
        const ms = Date.now() - t0;
        if (!res.ok) {
          console.log(`     ${edge}px  ERR ${res.status} ${res.reason.slice(0, 90)}`);
          continue;
        }
        runs.push({ edge, k, img, ms, res });
      }
    }
    if (runs.length === 0) continue;
    /*
     * 參考字串 = **原尺寸兩次都找到的**那些。
     * 只出現一次的本來就在噪音裡,拿它當標準答案是自欺。
     */
    const base = runs.filter((r) => r.edge === 0);
    const ref = new Set();
    if (base.length === 2) {
      const b1 = base[1].res.blocks.map((x) => norm(x.text)).filter(Boolean);
      for (const t of base[0].res.blocks.map((x) => norm(x.text))) {
        if (t && b1.some((g) => g.includes(t) || t.includes(g))) ref.add(t);
      }
    } else {
      for (const t of base[0].res.blocks.map((x) => norm(x.text))) if (t) ref.add(t);
    }
    console.log(`     (參考字串 ${ref.size} 條 = 原尺寸兩次都讀到的)`);
    for (const r of runs) {
      const tag = r.edge === 0 ? `原尺寸#${r.k + 1}` : `${r.edge}px`;
      console.log(
        `     ${tag.padStart(9)}  ${String(r.img.w)}x${r.img.h}  ${String(Math.round(r.img.bytes / 1024)).padStart(4)}KB  ` +
        `${String(r.ms).padStart(6)}ms  ${String(r.res.blocks.length).padStart(2)} 塊  ` +
        `in:${String(r.res.usage.prompt).padStart(4)} out:${String(r.res.usage.output).padStart(4)}  ` +
        `召回:${(recall(ref, r.res.blocks) * 100).toFixed(0)}%`,
      );
    }
    for (const b of base[0].res.blocks.slice(0, 2)) {
      console.log(`         ${JSON.stringify(b.text.slice(0, 22))} → ${JSON.stringify(b.zh.slice(0, 22))}${b.v ? '  [直排]' : ''}`);
    }
  }
}

await browser.close();
