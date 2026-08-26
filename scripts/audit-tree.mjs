/*
 * 爬一個站的**子路徑**,對每一頁跑偵測稽核。
 *
 *   node scripts/audit-tree.mjs https://thariqs.github.io/html-effectiveness/
 *   node scripts/audit-tree.mjs <url> --max 40 --miss 0.10
 *
 * 為什麼要有這一支:前兩個偵測 bug(§DM 的 header、§DN 的 footer)都是
 * **同一個站的不同頁**回報的,而且中間隔了一輪。一頁一頁看截圖的方式
 * 會一直這樣 —— 修完一個形狀,下一個形狀等使用者再踩一次才浮出來。
 *
 * `audit-sites.mjs` 掃的是「一批不同的站各一頁」,答的是廣度;
 * 這一支掃「同一個站的很多頁」,答的是**深度**:同一套版型的所有變化
 * (首頁 / 內容頁 / 索引頁 / 有 footer 的 / 有 header 的)一次看完。
 *
 * 只爬**同源、而且在起始路徑底下**的連結:`/html-effectiveness/` 底下的
 * `unknowns/index.html` 會爬,`/other-project/` 不會。這是刻意的 ——
 * 要驗的是「這一個站的這一套版型」,不是把整個網域抓下來。
 */
import path from 'node:path';
import { auditInPage, buildDetector, newPage, settle } from './lib/audit.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

const args = process.argv.slice(2);
const entry = args.find((a) => !a.startsWith('--'));
if (!entry) {
  console.error('用法:node scripts/audit-tree.mjs <url> [--max N] [--miss 0.15]');
  process.exit(2);
}
const numArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const MAX_PAGES = numArg('max', 25);
/** 單頁漏掉多少比例算不合格 —— 和 audit-sites 同一條線 */
const MISS_LIMIT = numArg('miss', 0.15);

const start = new URL(entry);
/** 起始路徑的目錄部分:`/a/b/page.html` → `/a/b/` */
const basePath = start.pathname.replace(/[^/]*$/, '');

function inScope(u) {
  try {
    const url = new URL(u, start);
    if (url.origin !== start.origin) return null;
    if (!url.pathname.startsWith(basePath)) return null;
    if (!/\.(html?|)$/.test(url.pathname)) return null;
    // 片段是同一頁,查詢字串通常是排序/追蹤 —— 都不算新頁面
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

const detectJs = buildDetector();
const browser = await chromium.launch({
  executablePath: process.env['PLAYWRIGHT_BROWSERS_PATH']
    ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
    : undefined,
});

const queue = [inScope(start.href) ?? start.href];
const done = new Set();
const rows = [];
const reasons = new Map();

console.log(`爬 ${start.origin}${basePath} 底下,最多 ${MAX_PAGES} 頁\n`);

while (queue.length > 0 && done.size < MAX_PAGES) {
  const url = queue.shift();
  if (done.has(url)) continue;
  done.add(url);
  const short = url.replace(start.origin + basePath, '') || '(起始頁)';
  const { ctx, page } = await newPage(browser, detectJs);
  try {
    await settle(page, url);
    const r = await page.evaluate(auditInPage);
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.href),
    );
    for (const l of links) {
      const n = inScope(l);
      if (n && !done.has(n) && !queue.includes(n)) queue.push(n);
    }
    const missRatio = r.textNodes > 0 ? r.missing.length / r.textNodes : 0;
    rows.push({ short, ...r, missRatio });
    for (const m of r.missing) {
      const g = reasons.get(m.why) ?? { n: 0, pages: new Set(), samples: [] };
      g.n++;
      g.pages.add(short);
      if (g.samples.length < 6) g.samples.push(`[${short}] <${m.host}> ${m.text}`);
      reasons.set(m.why, g);
    }
    console.log(
      `${String(r.blocks).padStart(4)} 單元 ${String(r.labels).padStart(4)} 貼片 ` +
        `${String(r.missing.length).padStart(4)} 漏 (${(missRatio * 100).toFixed(0)}%)  ${short}`,
    );
  } catch (e) {
    rows.push({ short, error: String(e).split('\n')[0].slice(0, 60) });
    console.log(`  失敗  ${short}  ${String(e).split('\n')[0].slice(0, 60)}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();

console.log('\n════ 漏掉的原因(整站合計)════\n');
for (const [why, g] of [...reasons].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`── ${g.n} 段 · 出現在 ${g.pages.size} 頁 · ${why}`);
  for (const s of g.samples) console.log(`     ${s}`);
  console.log();
}

const ok = rows.filter((r) => !r.error);
const bad = ok.filter((r) => r.missRatio > MISS_LIMIT);
console.log(
  `${ok.length}/${rows.length} 頁跑完` +
    (queue.length > 0 ? `(還有 ${queue.length} 頁沒爬,--max 可以放寬)` : '') +
    `;漏 >${(MISS_LIMIT * 100).toFixed(0)}% 的 ${bad.length} 頁${bad.length ? ':' + bad.map((b) => b.short).join('、') : ''}`,
);
/*
 * **同一個原因橫跨多頁 = 那是版型層的規則問題,不是那一頁的怪癖。**
 * 這正是這支工具存在的理由,所以把它單獨列出來。
 */
const systemic = [...reasons].filter(([, g]) => g.pages.size >= Math.max(2, ok.length * 0.5));
if (systemic.length > 0) {
  console.log('\n整站性的(出現在半數以上的頁面):');
  for (const [why, g] of systemic) console.log(`  · ${g.n} 段 / ${g.pages.size} 頁 — ${why}`);
}
process.exit(bad.length > 0 ? 1 : 0);
