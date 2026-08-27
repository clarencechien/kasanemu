/*
 * **加註語彙的比較稿**:同一張密集截圖,兩種做法並排。
 *
 *   npm run mockup:vocab out.png
 *
 * `measure-vocab.mjs` 量出「譯文佔版」是唯一同時抓得到「疊在一起」和
 * 「壓不到但滿滿都是」的量尺(`docs/plan-images.md` §13-9),而它推出來的
 * 規則會讓**錨點幾乎消失** —— 總有夠小的塊塞得進預算。
 *
 * 那一步是產品取捨不是量測結果:與其在縮圖上畫 47 個圓點,
 * 不如疊最重要的幾塊、其餘留給放大檢視。取捨要**看得到**才決定得了。
 *
 * 所以這裡不出數字,出畫面:左邊現行(全錨點),右邊提案(預算內的疊字)。
 * 兩邊用**同一份真實的 vision 回應**、同一套 LAYER_CSS、同一支 paintPlates。
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

const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith('--')) ?? 'mockup-vocab.png';
const numArg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
/** 畫多寬(單邊)。部落格正文大約 560–800 */
const W = numArg('width', 620);
/** 譯文佔版的預算 */
const BUDGET = numArg('budget', 0.12);
const FIXTURE = args.includes('--fixture')
  ? args[args.indexOf('--fixture') + 1]
  : 'lite-shot';

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-mock-'));
const bundle = path.join(out, 'b.js');
writeFileSync(
  path.join(out, 'e.ts'),
  `export { LAYER_CSS, VEIL_PAD, paintPlates } from ${JSON.stringify(path.resolve('src/content/overlay.ts'))};\n` +
    `export * as IG from ${JSON.stringify(path.resolve('src/content/imagegeo.ts'))};\n` +
    `export * as IB from ${JSON.stringify(path.resolve('src/shared/imageblocks.ts'))};\n`,
);
await esbuild.build({
  entryPoints: [path.join(out, 'e.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'KS',
  footer: { js: 'globalThis.KS = KS;' },
  outfile: bundle,
  logLevel: 'error',
});

const fx = JSON.parse(readFileSync(`tests/fixtures/vision/${FIXTURE}.json`, 'utf8'));
const H = Math.round((W * fx.nh) / fx.nw);

/*
 * 沒有原圖(fixture 只有座標與譯文),所以底下畫的是**原文本身** ——
 * 位置一樣、字級照框反推。要比的是加註的密度,不是圖好不好看。
 */
const page = `<!doctype html><meta charset=utf-8>
<style>
  body { margin: 0; background: #5f6368; font: 13px system-ui; color: #fff; }
  .row { display: flex; gap: 18px; padding: 16px 18px 22px; }
  .col { width: ${W}px; }
  h3 { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .3px; }
  .sub { opacity: .75; font-weight: 400; }
  .stage { position: relative; width: ${W}px; height: ${H}px;
           background: #fbfbfc; overflow: hidden; border-radius: 6px; }
  .src { position: absolute; color: #2b2f33; white-space: nowrap;
         font-family: system-ui; line-height: 1; }
  .imgwrap { position: absolute; inset: 0; }
</style>
<div class="row">
  <div class="col"><h3>現行 · 全錨點 <span class="sub">(多數決:放得下的不到七成)</span></h3>
    <div class="stage" id="a"></div></div>
  <div class="col"><h3>提案 · 預算內的疊字 <span class="sub">(譯文佔版 ≤ ${(BUDGET * 100).toFixed(0)}%)</span></h3>
    <div class="stage" id="b"></div></div>
</div>`;

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({
  viewport: { width: W * 2 + 60, height: H + 80 },
  deviceScaleFactor: 2,
});
const p = await ctx.newPage();
const f = path.join(out, 'm.html');
writeFileSync(f, page);
await p.goto('file://' + f);
await p.addScriptTag({ content: readFileSync(bundle, 'utf8') });

const stats = await p.evaluate(
  ({ fx, W, H, BUDGET }) => {
    const { IG, IB, LAYER_CSS, VEIL_PAD, paintPlates } = globalThis.KS;
    const st = document.createElement('style');
    st.textContent = LAYER_CSS;
    document.head.prepend(st);

    const drawn = IG.drawnRect({ w: fx.nw, h: fx.nh }, { w: W, h: H }, 'contain',
      { x: { pct: 0.5 }, y: { pct: 0.5 } });
    const clip = { w: W, h: H };

    /** 底圖:把原文畫回它自己的位置 */
    const paintSource = (stage) => {
      for (const b of fx.blocks) {
        const r = IG.mapBox(b.box, drawn, clip);
        if (!r) continue;
        const el = document.createElement('div');
        el.className = 'src';
        el.textContent = b.text;
        el.style.left = `${r.x}px`;
        el.style.top = `${r.y + r.h / 2 - Math.min(r.h, 13) / 2}px`;
        el.style.fontSize = `${Math.max(5, Math.min(r.h * 0.82, 13))}px`;
        stage.append(el);
      }
    };

    /** placeBlocks 前半段:留下值得加註的,連同幾何 */
    const candidates = () => {
      const kept = [];
      for (const b of fx.blocks) {
        if (b.kind === 'code') continue;
        const r = IG.mapBox(b.box, drawn, clip);
        if (!r) continue;
        const label = b.zh || b.text;
        if (!label || !IB.worthAnnotating(b.text, label)) continue;
        const fontPx = IB.fontSizeFor(r.w, r.h, [...label].length, b.v === true);
        kept.push({ r, label, fontPx, b });
      }
      return kept;
    };

    const wrapFor = (stage) => {
      const w = document.createElement('div');
      w.className = 'imgwrap show';
      stage.append(w);
      return w;
    };

    const A = document.getElementById('a');
    const B = document.getElementById('b');
    paintSource(A);
    paintSource(B);
    const kept = candidates();

    /* ── 左:現行的錨點 ───────────────────────────────── */
    const wa = wrapFor(A);
    kept.forEach((k, i) => {
      const pin = document.createElement('div');
      pin.className = 'ipin';
      pin.textContent = String(i + 1);
      pin.style.left = `${k.r.x + k.r.w / 2}px`;
      pin.style.top = `${k.r.y + k.r.h / 2}px`;
      wa.append(pin);
    });

    /* ── 右:預算內、而且互不重疊的疊字(大的先進來) ─── */
    /*
     * **兩個條件,不是一個。**
     *
     * 第一版只看面積預算,而長標籤在 11px 的地板上是「又寬又薄」——
     * 面積很便宜,畫出來卻橫著壓過旁邊兩塊。比較稿一畫出來就看得到
     * (三張卡的標題連成一條紅色的句子)。
     *
     * 面積管的是「總量會不會太吵」,重疊管的是「會不會互相壓到」——
     * 這正是 §13-9 量到的那兩件事,而它們是互補的不是二選一。
     */
    const area = W * H;
    const plateOf = (k) => {
      const fs = Math.max(k.fontPx, IB.MIN_PATCH_FONT_PX);
      const chars = [...k.label];
      const pw =
        chars.reduce((n, c) => n + (/[　-鿿＀-￯]/u.test(c) ? 1 : 0.55), 0) * fs +
        fs * 0.62 * 2;
      const ph = fs * 1.24;
      return { x: k.r.x + k.r.w / 2 - pw / 2, y: k.r.y + k.r.h / 2 - ph / 2, w: pw, h: ph };
    };
    const hits = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const order = [...kept].sort((x, y) => y.r.w * y.r.h - x.r.w * x.r.h);
    const take = [];
    const plates = [];
    let used = 0;
    for (const k of order) {
      const pl = plateOf(k);
      const cost = (pl.w * pl.h) / area;
      if (used + cost > BUDGET) continue;
      if (plates.some((q) => hits(q, pl))) continue;
      take.push(k);
      plates.push(pl);
      used += cost;
    }
    const wb = wrapFor(B);
    for (const k of take) {
      const v = document.createElement('span');
      v.className = 'iveil';
      v.style.left = `${k.r.x - VEIL_PAD}px`;
      v.style.top = `${k.r.y - VEIL_PAD}px`;
      v.style.width = `${k.r.w + VEIL_PAD * 2}px`;
      v.style.height = `${k.r.h + VEIL_PAD * 2}px`;
      wb.append(v);
    }
    for (const k of take) {
      const box = document.createElement('div');
      box.className = 'iblk';
      box.style.left = `${k.r.x}px`;
      box.style.top = `${k.r.y}px`;
      box.style.width = `${k.r.w}px`;
      box.style.height = `${k.r.h}px`;
      box.style.fontSize = `${Math.max(k.fontPx, IB.MIN_PATCH_FONT_PX)}px`;
      box.style.fontFamily = 'system-ui';
      const tx = document.createElement('span');
      tx.className = 'itx';
      tx.textContent = k.label;
      box.append(tx);
      wb.append(box);
    }
    paintPlates(wb);
    return { pins: kept.length, veils: take.length, used, total: fx.blocks.length };
  },
  { fx, W, H, BUDGET },
);

await p.waitForTimeout(250);
await p.screenshot({ path: dest, fullPage: true });
await browser.close();
console.log(
  `${dest}  ${FIXTURE} @${W}px:模型回 ${stats.total} 塊,值得翻 ${stats.pins} 塊 →` +
    ` 左邊 ${stats.pins} 個錨點 / 右邊 ${stats.veils} 塊疊字(佔版 ${(stats.used * 100).toFixed(1)}%)`,
);
