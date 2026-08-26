/*
 * 對一整批真實網站跑偵測稽核,把「沒人接手的文字」按原因彙總。
 *
 * 單頁版(audit-coverage.mjs)一次看一頁,適合追一個 bug;
 * 爬站版(audit-tree.mjs)掃一個站的所有子路徑,適合「這一整個站都對嗎」;
 * 這一支回答第三個問題:**規則對整個常看的網路是不是都成立**。
 *
 *   node scripts/audit-sites.mjs                 # 跑 scripts/sites.txt 全部
 *   node scripts/audit-sites.mjs qiita zenn      # 只跑網址含關鍵字的
 *
 * 開頁面與判定的機制在 `lib/audit.mjs`,和 audit-tree 共用一份。
 *
 * playwright 不是 devDependency,沒裝就跳過;單站失敗不擋整批。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditInPage, buildDetector, newPage, settle } from './lib/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(npm i -D playwright 之後再跑)');
  process.exit(0);
}
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());

const filters = process.argv.slice(2);
const sites = readFileSync(path.join(here, 'sites.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .filter((u) => filters.length === 0 || filters.some((f) => u.includes(f)));

const detectJs = buildDetector();
const browser = await chromium.launch({
  executablePath: process.env['PLAYWRIGHT_BROWSERS_PATH']
    ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
    : undefined,
});

const rows = [];
const reasonTotals = new Map();
for (const url of sites) {
  const short = url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 58);
  const { ctx, page } = await newPage(browser, detectJs);
  try {
    await settle(page, url);
    const r = await page.evaluate(auditInPage);
    const missRatio = r.textNodes > 0 ? r.missing.length / (r.textNodes || 1) : 0;
    rows.push({ short, ...r, missRatio });
    for (const m of r.missing) {
      const g = reasonTotals.get(m.why) ?? { n: 0, samples: [] };
      g.n++;
      if (g.samples.length < 8) g.samples.push(`[${short.split('/')[0]}] <${m.host}> ${m.text}`);
      reasonTotals.set(m.why, g);
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

console.log('\n════ 漏掉的原因(全部站點合計)════\n');
for (const [why, g] of [...reasonTotals].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`── ${g.n} 段 · ${why}`);
  for (const s of g.samples) console.log(`     ${s}`);
  console.log();
}
const ok = rows.filter((r) => !r.error);
const bad = ok.filter((r) => r.missRatio > 0.15);
console.log(`${ok.length}/${rows.length} 站跑完;漏 >15% 的:${bad.map((b) => b.short.split('/')[0]).join('、') || '無'}`);
