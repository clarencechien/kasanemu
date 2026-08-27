/*
 * 圖片加註的模型行為 probe(`docs/plan-images.md` §7、§13)。
 *
 *   gemini_key=... node scripts/probe-vision.mjs [圖片...]
 *   gemini_key=... node scripts/probe-vision.mjs --tier balanced 圖.png
 *
 * **用 production 的 `vision.ts` 打真的 API**,不在這裡另寫一份 prompt。
 *
 * 第一版就是自己寫一份 —— 結果 production 的 `box_2d` → `box` 轉換漏了,
 * probe 全綠、線上一塊都收不到,而且**完全無聲**:模型乖乖回了框、
 * usage 有幾百個 output token、區塊數 0、沒有任何一層報錯。
 * §DB-2 學到的是「量測要走 production 的路」;這次學到的是它的反面 ——
 * **production 的路也要真的走一次**。
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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const args = process.argv.slice(2);
let tiers = ['balanced', 'free'];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tier') tiers = [args[++i]];
  else files.push(args[i]);
}
if (files.length === 0) {
  console.log('用法:node scripts/probe-vision.mjs [--tier balanced] 圖片.png ...');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const entry = path.join(out, 'entry.ts');
writeFileSync(
  entry,
  `export { callVision, visionPrompt } from '${path.join(root, 'src/worker/vision.ts')}';\n` +
    `export { fontSizeFor, plateSize } from '${path.join(root, 'src/shared/imageblocks.ts')}';\n`,
);
const bundle = path.join(out, 'vision.mjs');
execFileSync(
  'npx',
  ['esbuild', entry, '--bundle', '--format=esm', '--platform=neutral', '--external:node:*',
   `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

// worker 模組在 node 裡跑,補一個最小的 chrome 殼(log 走 console 就夠了)
globalThis.chrome = { storage: { session: { get: async () => ({}), set: async () => {} } } };
const mod = await import(bundle);

/** 只填 callVision 真正讀到的欄位 */
const SPECS = {
  quality: { tier: 'quality', modelId: 'gemini-3.5-flash', maxOutputTokens: 8192, glossaryPrompt: true },
  balanced: { tier: 'balanced', modelId: 'gemini-3.5-flash-lite', maxOutputTokens: 8192, glossaryPrompt: true },
  free: { tier: 'free', modelId: 'gemma-4-31b-it', maxOutputTokens: 4096, glossaryPrompt: true },
};

console.log(`system prompt:${mod.visionPrompt('zh-TW').length} 字\n`);

let bad = 0;
for (const file of files) {
  const data = readFileSync(file).toString('base64');
  for (const tier of tiers) {
    const spec = SPECS[tier];
    if (!spec) { console.log(`未知檔位 ${tier}`); continue; }
    // 尺寸只有座標防呆的像素模式用得到;probe 不縮圖,原樣送
    const image = { data, mime: 'image/png', w: 0, h: 0, hash: 'probe' };
    const t0 = Date.now();
    const res = await mod.callVision(KEY, spec, image, 'zh-TW', []);
    const ms = Date.now() - t0;
    const name = `${path.basename(file)} ${tier}`.padEnd(38);
    if (!res.ok) {
      console.log(`${name} ERR ${res.status} ${res.reason.slice(0, 140)}`);
      bad++;
      continue;
    }
    const bogus = res.blocks.filter((b) => {
      const [y0, x0, y1, x1] = b.box;
      return !(y1 > y0 && x1 > x0 && x1 <= 1000 && y1 <= 1000);
    });
    const low = res.blocks.filter((b) => b.c < 0.9).length;
    console.log(
      `${name}${String(ms).padStart(6)}ms  ${String(res.blocks.length).padStart(2)} 塊  ` +
      `variant:${res.variant.padEnd(12)} 座標:${res.spec ?? '合規'}  壞框:${bogus.length}  低信心:${low}  ` +
      `in:${res.usage.prompt} out:${res.usage.output} th:${res.usage.thoughts}`,
    );
    /*
     * **零區塊是要報錯的**,不是「這張圖沒字」帶過去。
     * 那個無聲失敗就是這樣藏起來的:有 token、有回應、沒有東西。
     */
    if (res.blocks.length === 0) {
      console.error('  ↑ 零區塊 —— 如果這張圖上有字,就是解析斷了');
      bad++;
    }
    if (bogus.length > 0) {
      console.error(`  ↑ ${bogus.length} 個框不成矩形或超界`);
      bad++;
    }
    if (res.usage.thoughts > 0) console.error(`  ↑ thoughts 不是 0(${res.usage.thoughts})`);
    for (const b of res.blocks.slice(0, 3)) {
      console.log(`     ${JSON.stringify(b.box)} ${JSON.stringify(b.text.slice(0, 26))} → ${JSON.stringify(b.zh.slice(0, 26))} c=${b.c}`);
    }
  }
}
process.exit(bad > 0 ? 1 : 0);
