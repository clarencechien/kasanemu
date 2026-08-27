/*
 * **出貨中那條規則,在真實素材上放得下幾塊。**
 *
 *   npm run measure:vocab
 *   npm run measure:vocab -- --width 800
 *
 * 語彙的取捨已經定了(§DW):錨點退場,整張圖只有疊字,
 * 而放幾塊由一個數字決定 —— `PLATE_BUDGET`(譯文貼片可以佔掉畫面的多少),
 * 加上「不與已選的貼片重疊」。
 *
 * 這一支留著是為了**下次要動那兩個常數時有東西可以看**:
 * 換 `PLATE_BUDGET`、換 `TEXT_HEAVY_BLOCKS`,四份真實回應 × 五個寬度
 * 當場告訴你每張圖會變成什麼樣。
 *
 * 當初比較三個候選量尺的那一版留在 `docs/plan-images.md` §13-9:
 * 遮蔽率分不開、擠壓抓不到「壓不到但滿滿都是」,只有譯文佔版兩件事都抓得到。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const IG = await import(path.resolve('src/content/imagegeo.ts'));
const IB = await import(path.resolve('src/shared/imageblocks.ts'));

const args = process.argv.slice(2);
const num = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
/** 掃哪些顯示寬度 —— 行內縮圖、部落格正文、放大檢視 */
const WIDTHS = args.includes('--width') ? [num('width', 800)] : [340, 560, 800, 1040, 1400];

const DIR = 'tests/fixtures/vision';
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) }));

/** 兩個矩形重疊多少 */
const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * 譯文貼片**實際畫出來**會多大。
 *
 * 關鍵是字級要用**渲染時的**那個,不是「塞得進框裡的」那個:
 * 疊字模式對放不下的塊是 `max(fontPx, MIN_PATCH_FONT_PX)` —— 字級有地板,
 * 框沒有(`imagegeo.placeBlocks`)。所以小框的貼片會長出框外,
 * 而那正是「糊成一片」的來源。
 *
 * 第一版用了塞得進去的字級,量出來的 clash 在每個顯示寬度都一樣 ——
 * 因為貼片和框一起等比縮放,永遠不會多壓到誰。那個版本量的是
 * 「原文的框重不重疊」,不是「譯文擠不擠」。
 *
 * 中文字大致全形、拉丁字母大致半形 —— 這是估值不是量測,但要判斷的是
 * 擠不擠,排得出大小順序就夠。左右各留 PLATE_PAD_X 的白羽(§DT)。
 */
const PLATE_PAD_X = 0.62;
const plateOf = (r, label, fontPx) => {
  const fs = Math.max(fontPx, IB.MIN_PATCH_FONT_PX);
  const chars = [...label];
  const w =
    chars.reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 1 : 0.55), 0) * fs +
    fs * PLATE_PAD_X * 2;
  const h = fs * 1.24;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
};

function measure(fx, dispW) {
  const dispH = (dispW * fx.nh) / fx.nw;
  const drawn = IG.drawnRect(
    { w: fx.nw, h: fx.nh },
    { w: dispW, h: dispH },
    'contain',
    { x: { pct: 0.5 }, y: { pct: 0.5 } },
  );
  const clip = { w: dispW, h: dispH };
  const kept = [];
  for (const b of fx.blocks) {
    if (b.kind === 'code') continue;
    const r = IG.mapBox(b.box, drawn, clip);
    if (!r) continue;
    const label = b.zh || b.text;
    if (label.length === 0) continue;
    if (!IB.worthAnnotating(b.text, label)) continue;
    const chars = [...label].length;
    const fontPx = IB.fontSizeFor(r.w, r.h, chars, b.v === true);
    kept.push({ r, label, fontPx, plate: plateOf(r, label, fontPx) });
  }
  const area = dispW * dispH;
  /*
   * 遮蔽率用**加總**不用聯集:重疊的地方算兩次是刻意的 ——
   * 疊在一起的玻璃本來就比一片更糟。要的是「有多吵」不是「蓋了多少格」。
   */
  const ink = kept.reduce((n, k) => n + k.r.w * k.r.h, 0) / area;
  let clashArea = 0;
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) clashArea += overlap(kept[i].plate, kept[j].plate);
  }
  const plateArea = kept.reduce((n, k) => n + k.plate.w * k.plate.h, 0);
  /*
   * **譯文自己佔掉畫面多少**。
   *
   * 這是第三個候選:clash 只看貼片有沒有互相壓到,壓不到但滿滿都是
   * 也一樣不能看 —— mockup 那一輪的「遮蔽 17.2% · 0 次互動,而畫面完全
   * 不能看」講的就是這個。ink 量的是**原文的框**,這個量的是**譯文的貼片**,
   * 而貼片有 11px 的地板,所以小字多的圖會在這裡爆掉。
   */
  const fitRatio = kept.length === 0 ? 1 : kept.filter((k) => k.fits).length / kept.length;
  return {
    kept,
    area,
    n: kept.length,
    skipped: fx.blocks.length - kept.length,
    fitRatio,
    mode: IG.imageMode(kept.map((k) => k.fits)),
    ink,
    plateInk: plateArea / area,
    clash: plateArea === 0 ? 0 : clashArea / plateArea,
    minFont: kept.length ? Math.min(...kept.map((k) => k.fontPx)) : 0,
    medFont: kept.length
      ? [...kept].map((k) => k.fontPx).sort((a, b) => a - b)[Math.floor(kept.length / 2)]
      : 0,
  };
}

/**
 * **提案的規則**:一個數字,一個迴圈,三個決定。
 *
 * 那個數字是**譯文佔版**:所有譯文貼片的面積 ÷ 圖的面積。
 *
 * 為什麼是它而不是另外兩個(都量過了,見上面那張表):
 *
 * - `原文遮蔽`(玻璃蓋掉多少)在密集與稀疏素材上分不開:
 *   chart 3.1% / shot 13.7%,而且**不隨顯示尺寸變**——
 *   同一張圖縮到 340px 一樣是 13.7%,可是那時候已經完全不能看了。
 * - `擠壓`(貼片兩兩壓到)抓得到「疊在一起」,抓不到「壓不到但滿滿都是」。
 *   mockup 那一輪的「遮蔽 17.2% · 0 次互動,而畫面完全不能看」就是這種。
 * - `譯文佔版`兩件事都抓得到,而且**隨顯示尺寸單調變化** ——
 *   因為貼片的字級有 11px 的地板,圖縮小的時候框跟著縮、字不跟著縮。
 *   量出來 chart 家族 2–4%、screenshot 家族 10–80%,中間隔了一整個數量級。
 *
 * 迴圈:依框的面積由大到小加進來(字級就是版面自己標好的重要性),
 * 加到撞上預算為止 —— 這回答「翻多少」。連最大的那一塊自己都超過預算,
 * 表示這張圖在這個尺寸下**沒有任何譯文放得下** → 走錨點。
 */
function propose(kept, area, budget) {
  const order = [...kept].sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
  const take = [];
  let used = 0;
  for (const k of order) {
    const cost = (k.plate.w * k.plate.h) / area;
    // 跳過而不是中斷:放不下的是**這一塊**,後面比較小的還有機會
    if (used + cost > budget) continue;
    take.push(k);
    used += cost;
  }
  return { take, used, mode: take.length === 0 ? 'pin' : 'veil' };
}

console.log('\n== 出貨中的規則在真實素材上放得下幾塊 ==\n');
console.log(`預算 ${(IB.PLATE_BUDGET * 100).toFixed(1)}% · 密集門檻 ${IB.TEXT_HEAVY_BLOCKS} 塊\n`);
console.log('| 素材 | 寬 | 模型回 | 值得翻 | 畫幾塊 | 還剩 | 判定 |');
console.log('|---|---|---|---|---|---|---|');
for (const fx of fixtures) {
  for (const w of WIDTHS) {
    const H = Math.round((w * fx.nh) / fx.nw);
    const drawn = IG.drawnRect({ w: fx.nw, h: fx.nh }, { w, h: H }, 'contain',
      { x: { pct: 0.5 }, y: { pct: 0.5 } });
    const out = IG.placeBlocks(fx.blocks, drawn, { w, h: H });
    const why = { ok: '畫', 'text-heavy': '太密,行內不畫', nothing: '沒有需要翻的' }[out.why];
    console.log(
      `| ${fx.id} | ${w} | ${fx.blocks.length} | ${out.placed.length + out.left} | ` +
        `${out.placed.length} | ${out.left} | ${why} |`,
    );
  }
}
