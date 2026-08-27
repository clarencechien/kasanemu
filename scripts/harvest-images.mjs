/*
 * **從真的站上撈圖**,給語彙規則做素材。
 *
 *   node --experimental-strip-types scripts/harvest-images.mjs > corpus.json
 *   node --experimental-strip-types scripts/harvest-images.mjs --per 6 --pages 4
 *
 * 到目前為止所有的量測都靠**四份** vision 回應(兩張圖 × 兩個模型)。
 * `TEXT_HEAVY_BLOCKS = 24` 這種門檻靠四份素材是撐不住的(§13-10 自己寫著
 * 「第一版不是定論」),而使用者要的正是「拿真的圖表來看翻完會怎樣」。
 *
 * 撈的條件和**線上完全一樣**:`worthTranslating()` 看的是**顯示尺寸**
 * 不是原始尺寸(2042px 的圖縮在 120px 的縮圖格裡不值得翻),
 * 而 mime 走 `API_MIMES` 白名單(§DO 那次的教訓:看檔案本身,不看伺服器怎麼說)。
 *
 * 只抓圖的**位址與尺寸**,不下載 bytes —— 下載是下一支的事,
 * 而且那一支會快取,免得改個門檻就重打一次 API。
 */
import path from 'node:path';
import { newPage, settle } from './lib/audit.mjs';

const IG = await import(path.resolve('src/content/imagegeo.ts'));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('略過:沒有 playwright');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

const args = process.argv.slice(2);
const numArg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
/** 每個站最多留幾張 */
const PER_SITE = numArg('per', 8);
/** 每個站爬幾頁(起始頁 + 幾篇文章) */
const PAGES = numArg('pages', 4);

const only = args.indexOf('--site') >= 0 ? args[args.indexOf('--site') + 1] : null;

const SITES = [
  { id: 'clickhouse', url: 'https://clickhouse.com/blog' },
  { id: 'newstack', url: 'https://thenewstack.io/' },
  { id: 'claude-blog', url: 'https://claude.com/blog/' },
  { id: 'claude-academy', url: 'https://academy.claude.com/' },
];

/**
 * 在頁面裡跑:哪些 `<img>` 是**內文裡的圖**。
 *
 * 第一版只用「顯示尺寸夠大」,撈回來的 25 張裡有 20 張是**卡片縮圖**
 * (活動海報、文章封面、課程封面)—— 尺寸過關,但它們不是我們要看的東西。
 * 要看的是內文裡的圖表與截圖:那才會回一堆塊,才分得出規則的好壞。
 *
 * 三個排除條件,都是「這張圖是版面零件」的訊號:
 *
 * - **包在連結裡** —— 縮圖幾乎都是 `<a>` 的內容,點下去去別的地方。
 * - **在外殼裡** —— nav / aside / footer / header。
 * - **卡片容器** —— class 帶 card / thumb / teaser / promo / avatar / logo。
 *
 * 再加一個正向條件:**還沒載完的不算**(`naturalWidth === 0`)——
 * 那種撈回來也抓不到 bytes。
 */
const collectInPage = () => {
  const SHELL = 'nav, aside, footer, header, [role="navigation"]';
  const CARD = /card|thumb|teaser|promo|avatar|logo|icon|badge|sidebar|widget/i;
  const out = [];
  const all = [];
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) continue;
    if (!img.complete || img.naturalWidth === 0) continue;
    all.push({
      src,
      dw: Math.round(r.width),
      dh: Math.round(r.height),
      nw: img.naturalWidth,
      nh: img.naturalHeight,
      alt: (img.alt || '').slice(0, 60),
    });
    if (img.closest('a')) continue;
    if (img.closest(SHELL)) continue;
    let card = false;
    for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
      const cls = typeof p.className === 'string' ? p.className : '';
      if (CARD.test(cls)) { card = true; break; }
    }
    if (card) continue;
    out.push(all[all.length - 1]);
  }
  return [out, all];
};

/**
 * 這個連結像不像**一篇文章**。
 *
 * 首頁的連結大半是導覽與分類頁,而圖表住在文章裡。判準是路徑深度與
 * 常見的文章路徑形狀 —— 不精準,但足以讓爬蟲往內文走而不是在外殼繞。
 */
const looksLikeArticle = (href, origin) => {
  if (!href.startsWith(origin)) return false;
  const p = new URL(href).pathname.replace(/\/$/, '');
  if (p === '' || p === '/blog' || p === '/docs') return false;
  const segs = p.split('/').filter(Boolean);
  return segs.length >= 2 || (segs.length === 1 && segs[0].length > 18);
};

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

const corpus = [];
for (const site of SITES.filter((x) => !only || x.id === only)) {
  const origin = new URL(site.url).origin;
  const queue = [site.url];
  const seen = new Set();
  const found = new Map();
  const loose = new Map();
  const { ctx, page } = await newPage(browser, '');
  while (queue.length > 0 && seen.size < PAGES && found.size < PER_SITE * 3) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await settle(page, url);
      const [body, all] = await page.evaluate(collectInPage);
      /*
       * 內文的圖優先;**一張都沒有的站退回全部**。
       *
       * academy.claude.com 的圖全部包在課程卡片裡,嚴格條件下是零 ——
       * 而那本身就是答案(那個站沒有內文圖表)。但零張就看不到它翻起來
       * 長什麼樣,所以退一步,並且記下是哪一種來源。
       */
      for (const im of body) {
        if (found.has(im.src)) continue;
        // 線上的門檻:看顯示尺寸,不是原始尺寸
        if (!IG.worthTranslating({ w: im.dw, h: im.dh })) continue;
        found.set(im.src, { ...im, page: url, where: 'body' });
      }
      if (found.size === 0) {
        for (const im of all) {
          if (found.has(im.src)) continue;
          if (!IG.worthTranslating({ w: im.dw, h: im.dh })) continue;
          loose.set(im.src, { ...im, page: url, where: 'card' });
        }
      }
      if (seen.size < PAGES) {
        const links = await page.evaluate(
          () => [...document.querySelectorAll('a[href]')].map((a) => a.href),
        );
        for (const l of links) {
          if (!/[#?]/.test(l) && looksLikeArticle(l, origin) && !seen.has(l) && !queue.includes(l)) {
            queue.push(l);
          }
        }
      }
    } catch (e) {
      console.error(`  ${url} 失敗:${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
  await ctx.close();
  /*
   * 挑**顯示面積最大的**幾張,而且同一個 pathname 只留一張 ——
   * 一篇文章裡的十張連續截圖看起來都一樣,對規則沒有新資訊。
   */
  const pool = found.size > 0 ? found : loose;
  const bySrc = [...pool.values()].sort((a, b) => b.dw * b.dh - a.dw * a.dh);
  const perPage = new Map();
  const picked = [];
  for (const im of bySrc) {
    const n = perPage.get(im.page) ?? 0;
    if (n >= 2) continue;
    perPage.set(im.page, n + 1);
    picked.push(im);
    if (picked.length >= PER_SITE) break;
  }
  for (const im of picked) corpus.push({ site: site.id, ...im });
  console.error(
    `${site.id}:${seen.size} 頁 · 內文 ${found.size} 張 · 退而求其次 ${loose.size} 張 · 留 ${picked.length} 張`,
  );
}
await browser.close();
process.stdout.write(JSON.stringify(corpus, null, 1));
