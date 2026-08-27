/*
 * **加註語彙的量測**:一張圖該疊字還是標號,能不能用一個數字決定。
 *
 *   node --experimental-strip-types scripts/measure-vocab.mjs
 *   node --experimental-strip-types scripts/measure-vocab.mjs --width 800
 *
 * 使用者的話:「兩張很像的圖 一個是疊字 一個是標註 …
 * 先看能不能量測 再來看要翻多少 再來決定是要標註還是疊字 一次解決」。
 *
 * 現在的規則是**多數決**:七成以上的塊「字級放得下」就整張疊字
 * (`imagegeo.imageMode`)。它有兩個毛病:
 *
 * 1. **是個懸崖。** 69% 和 71% 的圖看起來一模一樣,語彙卻整個翻面。
 * 2. **量的是單塊放不放得下,不是整張看不看得下去。** 每一塊都「放得下」
 *    的圖照樣可以糊成一片 —— 只要那些塊彼此挨得夠近。
 *
 * 所以這裡多量兩個**整張圖**的數字,都從模型已經回來的東西算得出來
 * (不必再問一次模型,也不必先畫出來):
 *
 * - **遮蔽率** `ink`:所有毛玻璃的聯集面積 ÷ 圖的面積。加註蓋掉多少原圖。
 * - **擠壓率** `clash`:譯文貼片兩兩重疊的面積 ÷ 貼片總面積。
 *   貼片的寬度由字決定(這正是「不折字」的前提),所以它算得出來。
 *
 * 為什麼是這兩個而不是別的:mockup 那一輪量過「遮蔽面積」與「互動次數」,
 * 兩個單獨看都會騙人 —— 密集素材上強制疊字是「遮蔽 17.2% · 0 次互動」,
 * 兩欄都漂亮而畫面完全不能看。**分得出好壞的是標籤有沒有互相壓到**
 * (`TODO.md` 的比較台結論)。`clash` 就是那件事的數字化。
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
    kept.push({ r, label, fontPx, fits: IB.patchable(fontPx), plate: plateOf(r, label, fontPx) });
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

console.log('\n== 一張圖的三個數字(每個顯示寬度各一列)==\n');
console.log('| 素材 | 寬 | 塊 | 略過 | 放得下 | 現行 | 原文遮蔽 | 譯文佔版 | 擠壓 | 中位字級 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const rows = [];
for (const fx of fixtures) {
  for (const w of WIDTHS) {
    const m = measure(fx, w);
    rows.push({ id: fx.id, w, ...m });
    console.log(
      `| ${fx.id} | ${w} | ${m.n} | ${m.skipped} | ${(m.fitRatio * 100).toFixed(0)}% | ` +
        `${m.mode === 'veil' ? '疊字' : '錨點'} | ${(m.ink * 100).toFixed(1)}% | ` +
        `${(m.plateInk * 100).toFixed(1)}% | ` +
        `${(m.clash * 100).toFixed(1)}% | ${m.medFont.toFixed(1)}px |`,
    );
  }
}

/*
 * 同一張圖在相鄰兩個寬度之間**翻面**的地方,就是懸崖。
 * 懸崖本身不是壞事(總得有個界線),值得看的是**翻面的時候另外兩個
 * 數字動了多少** —— 動很少的話,那條界線畫錯了地方。
 */
console.log('\n== 語彙翻面的地方 ==\n');
for (const fx of fixtures) {
  const mine = rows.filter((r) => r.id === fx.id);
  for (let i = 1; i < mine.length; i++) {
    if (mine[i].mode === mine[i - 1].mode) continue;
    const a = mine[i - 1];
    const b = mine[i];
    console.log(
      `  ${fx.id}:${a.w}px ${a.mode === 'veil' ? '疊字' : '錨點'} → ${b.w}px ${b.mode === 'veil' ? '疊字' : '錨點'}` +
        `   放得下 ${(a.fitRatio * 100).toFixed(0)}%→${(b.fitRatio * 100).toFixed(0)}%` +
        `   擠壓 ${(a.clash * 100).toFixed(1)}%→${(b.clash * 100).toFixed(1)}%`,
    );
  }
}

/*
 * 同一張圖、同一個寬度,兩個模型的答案不一樣的地方。
 * 使用者看到的「兩張很像的圖一個疊字一個標註」有一半是這個:
 * L0 與 L1 對同一張圖回的塊數不同,而多數決對塊數很敏感。
 */
console.log('\n== 同一張圖、不同模型 ==\n');
const pairs = [['gemma-chart', 'lite-chart'], ['gemma-shot', 'lite-shot']];
for (const [a, b] of pairs) {
  for (const w of WIDTHS) {
    const ra = rows.find((r) => r.id === a && r.w === w);
    const rb = rows.find((r) => r.id === b && r.w === w);
    if (!ra || !rb || ra.mode === rb.mode) continue;
    console.log(
      `  ${w}px:${a} ${ra.mode === 'veil' ? '疊字' : '錨點'}(${ra.n} 塊 / 放得下 ${(ra.fitRatio * 100).toFixed(0)}%)` +
        ` vs ${b} ${rb.mode === 'veil' ? '疊字' : '錨點'}(${rb.n} 塊 / 放得下 ${(rb.fitRatio * 100).toFixed(0)}%)` +
        `   擠壓 ${(ra.clash * 100).toFixed(1)}% vs ${(rb.clash * 100).toFixed(1)}%`,
    );
  }
}

/*
 * 提案掃門檻。要看的是**它會不會把已經好好的圖弄壞** ——
 * chart 那兩張現在是疊字而且看起來沒問題,提案不該把它們變成錨點或砍掉東西。
 */
console.log('\n== 提案:加到佔版撞到預算為止(門檻掃描)==\n');
for (const budget of [0.08, 0.12, 0.16]) {
  console.log(`  預算 ${(budget * 100).toFixed(0)}%`);
  console.log('  | 素材 | 寬 | 現行 | 提案 | 翻幾塊 / 共 | 用掉的佔版 |');
  console.log('  |---|---|---|---|---|---|');
  for (const fx of fixtures) {
    for (const w of WIDTHS) {
      const m = measure(fx, w);
      const p = propose(m.kept, m.area, budget);
      const same = (m.mode === 'veil') === (p.mode === 'veil') ? '' : '  ←變';
      console.log(
        `  | ${fx.id} | ${w} | ${m.mode === 'veil' ? '疊字' : '錨點'} | ` +
          `${p.mode === 'veil' ? '疊字' : '錨點'}${same} | ${p.take.length} / ${m.n} | ` +
          `${(p.used * 100).toFixed(1)}% |`,
      );
    }
  }
  console.log('');
}
