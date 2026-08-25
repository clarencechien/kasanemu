/*
 * 在真的瀏覽器裡驗選取規則。
 *
 * node 的測試(jsdom)沒有 layout:getBoundingClientRect 一律回 0,
 * 於是所有跟「這張圖多大」「這個元素自己佔不佔一行」有關的規則
 * 在測試裡根本不會被觸發。而那正是最容易出事的一類 ——
 * ClickHouse 那篇圖多的文章有一半不翻,就是這樣漏掉的。
 *
 *   node scripts/probe-detect.mjs
 *
 * playwright 不是 devDependency;沒裝就跳過,不擋 npm run check。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'detect.html');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(npm i -D playwright 之後再跑)');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const bundle = path.join(out, 'detect.js');
const geo = path.join(out, 'cover.js');
const build = (src, name, file) =>
  execFileSync(
    'npx',
    ['esbuild', path.join(here, '..', 'src', 'content', src),
     '--bundle', '--format=iife', `--global-name=${name}`, `--footer:js=globalThis.${name}=${name};`,
     `--outfile=${file}`],
    { stdio: 'inherit' },
  );
build('detect.ts', 'D', bundle);
// 幾何要用**production 的那一支** coverRect,不是在測試裡另外寫一份 ——
// 判斷邏輯有兩份就會分岔(§CH-2)
build('cover.ts', 'G', geo);

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
// MHTML / file:// 的 CSP 會擋掉 addScriptTag,init script 不受影響
await page.addInitScript({ content: readFileSync(bundle, 'utf8') });
await page.addInitScript({ content: readFileSync(geo, 'utf8') });
await page.goto('file://' + fixture);

const got = await page.evaluate(() => {
  const seen = new Set();
  const blocks = D.findCandidates(document.body, (el) => seen.has(el));
  for (const c of blocks) seen.add(c.el);
  // 內文層的單元常常建在祖先上(<p> 包連結、<td> 包連結),
  // 所以「已經處理過」要往上找,不能只比對元素本身
  const covered = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (seen.has(n)) return true;
    return false;
  };
  const labels = D.findLabels(document.body, 200, covered);
  // 掃描必須收斂:第二輪找不到東西,否則 scan 會永遠停在最短間隔
  const again = D.findCandidates(document.body, (el) => seen.has(el)).length;
  return {
    rescan: again,
    blocks: blocks.map((c) => ({
      src: c.src, tag: c.el.tagName, media: !!c.mediaSplit, pinned: c.pinned === true,
      ranged: !!c.range,
      inNav: !!c.el.closest('nav'), inMenu: !!c.el.closest('#menu'),
    })),
    // 疊層絕對不可以蓋到圖 —— 這是所有 mediaSplit / Range 規則的底線
    overImage: blocks.filter((c) => {
      // 用 production 的 coverRect:mediaSplit 的單元會在圖片邊界收住,
      // 拿元素的 border-box 去比一定會誤報
      const { rect } = G.coverRect({
        el: c.el, range: c.range, mediaSplit: c.mediaSplit,
        style: { border: [0, 0, 0, 0] },
      });
      if (rect.width < 1 || rect.height < 1) return false;
      const r = {
        top: rect.top - scrollY, bottom: rect.top + rect.height - scrollY,
        left: rect.left - scrollX, right: rect.left + rect.width - scrollX,
      };
      return [...document.querySelectorAll('img')].some((img) => {
        const m = img.getBoundingClientRect();
        if (m.width * m.height < 400) return false;
        return r.top < m.bottom - 2 && m.top < r.bottom - 2
          && r.left < m.right - 2 && m.left < r.right - 2;
      });
    }).map((c) => c.src.slice(0, 40)),
    labels: labels.map((c) => c.src),
  };
});
await browser.close();

const blockText = got.blocks.map((b) => b.src);
const problems = [];
const needBlock = (frag, why) => {
  if (!blockText.some((t) => t.includes(frag))) problems.push(`${why}:內文層少了「${frag}」`);
};
const noBlock = (frag, why) => {
  if (blockText.some((t) => t.includes(frag))) problems.push(`${why}:內文層不該有「${frag}」`);
};

// 目次:巢狀的每一層都要翻,長短混雜不影響
needBlock('Introduction', '文章目次');
needBlock('Summary', '目次子項');
needBlock('Storage size', '目次子項');
// 自己底下包著子清單的那一行,單元要落在 <a> 上
const nested = got.blocks.find((b) => b.src === 'Benchmark results');
if (!nested) problems.push('目次:「Benchmark results」整行消失');
else if (nested.tag !== 'A') problems.push(`目次:單元落在 ${nested.tag},應該是 A`);

// 圖片自己佔一行 → 翻,而且帶著 mediaSplit
const withImg = got.blocks.find((b) => b.src.startsWith('A common use case'));
if (!withImg) problems.push('圖片自己佔一行的段落沒被翻');
else if (!withImg.media) problems.push('圖片自己佔一行的段落沒帶 mediaSplit,疊層會蓋到圖');

// 行內圖片:圖不翻,圖旁的文字在媒體處切段照翻
needBlock('by a factor of five in the tests', '行內圖片旁的文字');
// 折行後聯集矩形蓋回圖的那一段,要放棄 —— 不蓋圖是底線
noBlock('definitely wraps onto the next line', '折行蓋圖的段');

// 每個連結都短、但項目本身是一整段 —— 整份仍然是內容清單
for (const frag of ['ClickHouse SQL query', 'Elasticsearch ESQL query']) {
  needBlock(frag, '長項目底下的短連結');
}

/*
 * aria-hidden 的逐字動畫標題:整句話要翻,而且是**一個**單元。
 * 使用者的話:「這看起來是有點搞笑」—— 整頁最大的那行字因為對
 * 螢幕閱讀器隱藏,所以對眼睛也不翻了。
 */
{
  const hero = got.blocks.filter((b) => b.src.includes('approach to teaching'));
  if (hero.length === 0) problems.push('aria-hidden 逐字標題:整行沒翻');
  else if (hero.length > 1) problems.push(`aria-hidden 逐字標題:切成了 ${hero.length} 塊,應該只有 1 塊`);
  else if (hero[0].tag !== 'H1') problems.push(`aria-hidden 逐字標題:單元落在 ${hero[0].tag},應該是 H1`);
}
// 反面:aria-hidden 而且 display:none 的提示框,照舊擋得住
noBlock('Download this file', 'aria-hidden 且看不見的提示框');
needBlock('Download the dataset', 'aria-hidden 提示框的外層段落');

// 文章標題本身是連結 —— 標題標籤是內容,不是 UI 標籤
{
  const t = got.blocks.find((b) => b.src === 'Autonomy and Innovation');
  if (!t) problems.push('永久連結標題:整行沒翻(被判成 UI 標籤)');
  else if (t.tag !== 'H2') problems.push(`永久連結標題:單元落在 ${t.tag},應該是 H2`);
}
// 反面:自繪 UI 的 role="heading" 仍然是 UI 標籤
noBlock('Labels', '自繪 UI 的區塊標題');

// display:contents 的包裝沒有盒子,但子孫是活生生的內容
needBlock('Understanding the reduce method', 'display:contents 底下的標題');
needBlock('The reduce method executes', 'display:contents 底下的段落');

// 標題裡的 24×24 錨點圖示不算圖 —— 整行要翻
{
  const h = got.blocks.find((b) => b.src.includes('Start with the mockup'));
  if (!h) problems.push('標題帶錨點圖示:整行沒翻');
  else if (h.media) problems.push('標題帶錨點圖示:被誤判成圖文混排');
}

// <article> 裡的 header / footer 是文章的頭尾,不是站台外殼
needBlock('How to Back Up Your Digital Life', '文章 header 裡的標題');
needBlock('Backups are boring', '文章 header 裡的副標');
needBlock('Reporting contributed by', '文章 footer 裡的署名');

// 表單:控件不翻,說明文字降到貼片層(不是整段消失)
noBlock('We do newsletters', '表單內文不畫疊層');
noBlock('you@example.com', '表單控件');

// 沒有元素包著的鬆散文字要換錨點(Range),而且一段一個
for (const frag of ['ClickHouse requires 12 times', 'When the data set is pre-aggregated']) {
  needBlock(frag, '鬆散文字');
  const hit = got.blocks.find((b) => b.src.startsWith(frag));
  if (hit && !hit.ranged) problems.push(`鬆散文字「${frag}」沒用 Range 當錨點,會蓋到整個容器`);
}

// 圖片夾在中間:切成前後兩段
for (const frag of ['Runtimes of running the query', 'As discussed, ESQL currently']) {
  needBlock(frag, '圖片夾在段落中間');
}

// 掃描要收斂 —— 不收斂的話頁面會慢得像卡住
if (got.rescan > 0) {
  problems.push(`第二輪掃描還找到 ${got.rescan} 個候選 —— scan 會永遠停在最短間隔`);
}

// 底線:任何單元的矩形都不可以壓到圖片上
if (got.overImage.length > 0) {
  problems.push(`疊層蓋到圖片:${got.overImage.join(' / ')}`);
}

// 圖表儲存格:表頭與儲存格必須同一種行為
needBlock('Storage size', '圖表表頭');
const cell = got.blocks.find((b) => b.src === 'Link');
if (!cell) problems.push('圖表儲存格的連結沒翻 —— 同一張表兩種行為');
else if (!cell.media) problems.push('圖表儲存格沒帶 mediaSplit,疊層會蓋到圖');
// 同一段文字不能既是疊層又是貼片
if (got.labels.includes('Link')) problems.push('圖表儲存格被重複處理:疊層 + 貼片各一份');

// sticky 的 <nav> 目次:兩條舊規則(§3.5 與 EXCLUDE_TAGS)各擋了它一次
const pinned = got.blocks.filter((b) => b.inNav && !b.inMenu);
if (pinned.length === 0) problems.push('浮動目次完全沒有內文疊層');
else if (!pinned.every((b) => b.pinned)) {
  problems.push('浮動目次的單元沒標記 pinned,捲動時會脫位');
}

// 真的選單維持外殼待遇:不畫疊層,但滑上去看得到
if (got.blocks.some((b) => b.inMenu)) problems.push('選單不該有常駐疊層');
if (!got.labels.includes('Products')) problems.push('選單被踢出加翻層 → 什麼都沒有');

console.log(JSON.stringify(got, null, 1));
if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
