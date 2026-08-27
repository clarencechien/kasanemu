/*
 * 玻璃的**目視稿與配方掃描**(`probe-veil.mjs` 的另一半)。
 *
 *   node scripts/render-veil.mjs out.png            # 出貨中的配方,三個情境
 *   node scripts/render-veil.mjs out.png --sweep    # 所有候選配方,同一個情境
 *
 * probe 量得出「原文退了沒、譯文讀不讀得到」,量不出兩件事:
 *
 * 1. **看起來像不像貼上去的** —— §DQ 的 inset 掃到 12 時數字最好看,
 *    而在真圖上它溢到隔壁的圖形。那一格是眼睛選的,眼睛要有東西可以看。
 * 2. **加註在原文之外溢出多少** —— 這是使用者這一輪的抱怨,而它從來沒被量過。
 *    我們一直在量「原文有沒有退場」,沒有量「退場用的那些東西有多明顯」。
 *    在有紋理的照片上模糊就夠了;在**一片平的深色卡片**上(ClickHouse
 *    那張黃底黑卡),模糊沒有東西可以糊,看得到的只剩那層灰和那團白。
 *
 * 所以這裡多量一個數:**外溢** = 原文框以外、加註仍然改變了的最亮那一點,
 * 對隔壁沒被碰到的背景還有幾比幾。1.0 = 完全看不出旁邊有東西。
 * 它和「原文殘留」互相拉扯(蓋得越乾淨、灑得越開),所以兩個要一起看,
 * 而且它**不是越低越好** —— §DR-2 就是刻意把它從 1.0 換到 2.6 買融入感的。
 *
 * 三個情境照著使用者實際回報的三張圖搭:亮底深卡、深底連續標籤
 * (標籤上下緊貼 —— 這是層級 bug 的現場)、淺底圖表。
 * 中間那個情境刻意讓玻璃互相重疊:**灰底不可以蓋到前一塊的白羽和字**(§DR-1)。
 *
 * 和 probe 一樣抄的是打包後的 LAYER_CSS,不在這裡另寫一份(§DF)。
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-render-'));
const bundle = path.join(out, 'css.js');
writeFileSync(
  path.join(out, 'e.ts'),
  `import { LAYER_CSS, VEIL_PAD } from ${JSON.stringify(path.resolve('src/content/overlay.ts'))};\n` +
    `(globalThis as any).KS = { LAYER_CSS, VEIL_PAD };\n`,
);
await esbuild.build({
  entryPoints: [path.join(out, 'e.ts')],
  bundle: true,
  outfile: bundle,
  format: 'iife',
  logLevel: 'error',
});

/** 直接從原始碼讀,不在這裡抄一份 —— 抄一份就會有一天對不上(§DF) */
const SHIP_PAD = Number(
  /export const VEIL_PAD = (\d+)/.exec(readFileSync('src/content/overlay.ts', 'utf8'))?.[1] ?? 18,
);

/*
 * 候選配方。`css` 覆蓋 `.iveil`,`pad` 換外擴距離 ——
 * 出貨中的那個 `css` 是空的,它就是 LAYER_CSS 本身,不在這裡抄一份。
 */
const feather = (pad) => `
  linear-gradient(to right, transparent 0, rgba(0,0,0,.20) ${pad * 0.42}px,
    rgba(0,0,0,.68) ${pad * 0.76}px, #000 ${pad}px, #000 calc(100% - ${pad}px),
    rgba(0,0,0,.68) calc(100% - ${pad * 0.76}px), rgba(0,0,0,.20) calc(100% - ${pad * 0.42}px),
    transparent 100%),
  linear-gradient(to bottom, transparent 0, rgba(0,0,0,.20) ${pad * 0.42}px,
    rgba(0,0,0,.68) ${pad * 0.76}px, #000 ${pad}px, #000 calc(100% - ${pad}px),
    rgba(0,0,0,.68) calc(100% - ${pad * 0.76}px), rgba(0,0,0,.20) calc(100% - ${pad * 0.42}px),
    transparent 100%)`;

const recipe = (pad, tint, blur, extra = '') => `
  --ksnm-pad: ${pad}px;
  backdrop-filter: blur(${blur}px) saturate(.55);
  -webkit-backdrop-filter: blur(${blur}px) saturate(.55);
  background: rgba(138,140,145, calc(var(--ksnm-veil, .30) * ${tint}));
  mask-image: ${feather(pad)};
  -webkit-mask-image: ${feather(pad)};
  mask-composite: intersect;
  -webkit-mask-composite: source-in;
  ${extra}`;

const VARIANTS = [
  { id: 'A 上一版(pad 18 · 膜 .78 · 糊 10 · 白羽 4)', pad: 18, css: recipe(18, 0.78, 10), plate: 'inset: -.16em -.3em; filter: blur(4px);' },
  { id: 'B 更大更淡(pad 26 · 膜 .58 · 糊 13)', pad: 26, css: recipe(26, 0.58, 13) },
  { id: 'C 只有霧沒有膜(pad 24 · 膜 0 · 糊 16)', pad: 24, css: recipe(24, 0, 16) },
  {
    id: 'D 雙層霧(外圈淡 · 內核濃)',
    pad: 28,
    css:
      recipe(28, 0.34, 12) +
      `
  }
  SCOPE .iveil::before {
    content: ''; position: absolute; inset: 14px; border-radius: 4px;
    background: rgba(138,140,145, calc(var(--ksnm-veil, .30) * .62));
    mask-image: ${feather(12)};
    -webkit-mask-image: ${feather(12)};
    mask-composite: intersect;
    -webkit-mask-composite: source-in;`,
  },
  /*
   * E / F 針對的是**密度的階梯**,不是膜本身。
   *
   * 量出來膜的外緣其實已經看不見了(1.02:1),使用者看到的那條帶子是
   * 「黑卡 → 灰環 → 白貼片 → 橘字」四階裡的中間兩階 —— 又是兩個物件
   * 排隊(lessons §26),只是這次排隊的是密度不是硬邊。
   * 把白貼片的羽毛放大到和霧接上,四階就變成一條連續的坡。
   */
  {
    id: 'E 白羽外擴(霧同 A,白貼片羽毛加大)',
    pad: 18,
    css: '',
    plate: 'inset: -.30em -.55em; filter: blur(9px);',
  },
  {
    id: 'F 出貨中 —— 一條連續的坡(霧更淡更大 + 白羽更大)',
    pad: 26,
    css: recipe(26, 0.5, 13),
    plate: 'inset: -.34em -.62em; filter: blur(11px);',
  },
];

const SCENES = {
  'yellow-cards': {
    w: 840,
    h: 250,
    bg: '#F5F16B',
    art: `${[0, 1, 2]
      .map(
        (i) =>
          `<div style="position:absolute;left:${40 + i * 260}px;top:26px;width:220px;height:190px;background:#22201d;border-radius:14px"></div>`,
      )
      .join('')}
      ${['5x', '90%', '4x']
        .map(
          (t, i) =>
            `<div style="position:absolute;left:${40 + i * 260}px;top:70px;width:220px;text-align:center;font:800 62px system-ui;color:#fff">${t}</div>`,
        )
        .join('')}
      ${['Faster aggregation', 'Better compression', 'Cost reduction']
        .map(
          (t, i) =>
            `<div style="position:absolute;left:${40 + i * 260}px;top:154px;width:220px;text-align:center;font:600 15px system-ui;color:#ddd">${t}</div>`,
        )
        .join('')}`,
    /* 量點:第一塊玻璃的外緣一圈,以及同一張卡片上沒被蓋到的地方 */
    /*
     * 掃描線要落在**沒有原文的那一條**:玻璃罩住的範圍比原文高,
     * 上下各多出 VEIL_PAD。掃在字上量到的是「原文殘留」——那是 probe-veil
     * 的工作,這裡要的是膜自己。
     */
    probe: { line: [44, 256, 140], clean: [150, 100] },
    blocks: [
      { x: 78, y: 152, w: 144, h: 22, zh: '更快的聚合速度' },
      { x: 338, y: 152, w: 144, h: 22, zh: '更好的壓縮率' },
      { x: 598, y: 152, w: 144, h: 22, zh: '成本降低' },
    ],
  },
  overlap: {
    w: 840,
    h: 190,
    bg: '#111',
    art: `<div style="position:absolute;left:60px;top:30px;font:700 22px system-ui;color:#fff">Storage size</div>
          <div style="position:absolute;left:60px;top:68px;font:600 17px system-ui;color:#bbb">Raw (non pre-aggregated) data</div>
          <div style="position:absolute;left:60px;top:106px;font:600 17px system-ui;color:#bbb">19 times smaller</div>`,
    probe: { line: [46, 224, 16], clean: [700, 150] },
    blocks: [
      { x: 60, y: 28, w: 150, h: 28, zh: '儲存空間大小' },
      { x: 60, y: 66, w: 250, h: 24, zh: '原始(未預先聚合)數據' },
      { x: 60, y: 104, w: 130, h: 24, zh: '小 19 倍' },
    ],
  },
  'light-chart': {
    w: 840,
    h: 170,
    bg: '#fafafa',
    art: `<div style="position:absolute;left:180px;top:30px;font:700 26px system-ui;color:#333">Measuring streaming accuracy</div>
          <div style="position:absolute;left:180px;top:72px;font:600 16px system-ui;color:#666">across languages</div>
          <div style="position:absolute;left:60px;top:124px;font:700 20px system-ui;color:#2b6be5">5.50%</div>`,
    probe: { line: [166, 596, 16], clean: [780, 140] },
    blocks: [
      { x: 180, y: 28, w: 380, h: 32, zh: '衡量跨語言的串流語音辨識準確度' },
      { x: 180, y: 70, w: 120, h: 22, zh: '越低越好' },
    ],
  },
};

const stage = (s, pad, tag) => `
<section>
  <h3>${tag}</h3>
  <div class="stage" data-probe="${s.probe.line.join(',')};${s.probe.clean.join(',')}"
       style="width:${s.w}px;height:${s.h}px;background:${s.bg}">
    ${s.art}
    <div class="imgwrap show" style="--ksnm-ix:0px;--ksnm-iy:0px;--ksnm-iw:${s.w}px;--ksnm-ih:${s.h}px">
      ${s.blocks
        .map(
          (b) =>
            `<span class="iveil" style="left:${b.x - pad}px;top:${b.y - pad}px;width:${b.w + pad * 2}px;height:${b.h + pad * 2}px"></span>`,
        )
        .join('')}
      ${s.blocks
        .map(
          (b) =>
            `<div class="iblk" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;font-size:${Math.min(b.h * 0.8, 22)}px;font-family:system-ui"><span class="itx">${b.zh}</span></div>`,
        )
        .join('')}
    </div>
  </div>
</section>`;

const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith('--')) ?? path.join(out, 'shot.png');
const sweep = args.includes('--sweep');

/*
 * 掃描時每個配方要自己的樣式,而 <style> 是**整頁生效**的 ——
 * 一頁四個 <style> 的結果是四段長得一模一樣(最後一個贏)。
 * 所以每個配方包一層 .vN,選擇器也跟著加上前綴,四段才真的不同。
 */
const body = sweep
  ? VARIANTS.map((v, i) => {
      const scope = `.v${i}`;
      const css =
        (v.css ? `${scope} .iveil { ${v.css.replaceAll('SCOPE', scope)} }` : '') +
        (v.plate ? `${scope} .iblk .itx::before { ${v.plate} }` : '');
      return (
        (css ? `<style>${css}</style>` : '') +
        `<div class="${scope.slice(1)}">` +
        stage(SCENES['yellow-cards'], v.pad, v.id) +
        stage(SCENES['overlap'], v.pad, '') +
        `</div>`
      );
    }).join('')
  : Object.values(SCENES)
      .map((s, i) => stage(s, SHIP_PAD, Object.keys(SCENES)[i]))
      .join('');

const page = `<!doctype html><meta charset=utf-8>
<style>
 body{margin:0;background:#666;font:13px system-ui;color:#fff}
 section{padding:12px 20px 4px}
 h3{margin:0 0 6px;font-size:12px;opacity:.85;font-weight:700}
 h3:empty{display:none}
 .stage{position:relative;overflow:hidden;border-radius:6px}
</style>
${body}`;

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const f = path.join(out, 'r.html');
writeFileSync(f, page);
await p.goto('file://' + f);
await p.addScriptTag({ content: readFileSync(bundle, 'utf8') });
await p.evaluate(() => {
  const s = document.createElement('style');
  s.textContent = globalThis.KS.LAYER_CSS;
  /* LAYER_CSS 要排在配方覆蓋的前面,否則覆蓋不掉 */
  document.head.prepend(s);
});
await p.waitForTimeout(300);

const pad = await p.evaluate(() => globalThis.KS.VEIL_PAD);
if (pad !== SHIP_PAD) console.log(`注意:打包後的 VEIL_PAD 是 ${pad},從原始碼讀到的是 ${SHIP_PAD}`);

/*
 * **外溢**:原文框以外、加註仍然改變了的最亮那一點,對隔壁乾淨的背景。
 * 1.0 = 旁邊完全看不出有東西。越大越顯眼,但也越可能是「一條連續的坡」。
 */
const shots = [];
for (const st of await p.locator('.stage[data-probe]').all()) {
  shots.push({
    png: (await st.screenshot()).toString('base64'),
    probe: await st.getAttribute('data-probe'),
    tag: (await st.evaluate((e) => e.closest('section')?.querySelector('h3')?.textContent)) ?? '',
  });
}
const visib = await p.evaluate(async (items) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const res = [];
  for (const it of items) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + it.png;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.naturalWidth / it.cssW;
    const lumAt = (x, y) => {
      const d = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
      return 0.2126 * lin(d[0] / 255) + 0.7152 * lin(d[1] / 255) + 0.0722 * lin(d[2] / 255);
    };
    const [line, clean] = it.probe.split(';').map((s) => s.split(',').map(Number));
    const base = lumAt(clean[0], clean[1]);
    /*
     * 沿著標籤那一列掃過去,取**最刺眼的那一點**對乾淨背景的比值。
     * 跳過譯文自己的白貼片(它本來就該顯眼),只看膜。
     */
    const white = Math.max(base, 0.5);
    let worst = 1;
    for (let x = line[0]; x <= line[1]; x++) {
      const l = lumAt(x, line[2]);
      if (l > white) continue;
      const r = (Math.max(l, base) + 0.05) / (Math.min(l, base) + 0.05);
      if (r > worst) worst = r;
    }
    res.push({ tag: it.tag, v: worst });
  }
  return res;
}, shots.map((s) => ({ ...s, cssW: 840 })));

await p.screenshot({ path: dest, fullPage: true });
console.log(`${dest}${sweep ? '(掃描 —— 每個配方一段)' : ''}  VEIL_PAD = ${pad}`);
console.log('\n== 外溢(原文框以外 vs 乾淨的背景;1.0 = 旁邊看不出有東西)==\n');
const names = sweep ? ['亮底深卡', '深底連續標籤'] : Object.keys(SCENES);
visib.forEach((r, i) => {
  const where = sweep ? names[i % 2] : names[i];
  console.log(`  ${r.v.toFixed(2)}:1  ${where.padEnd(8)} ${r.tag}`);
});
await browser.close();
