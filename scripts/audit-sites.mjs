/*
 * 對一整批真實網站跑偵測稽核,把「沒人接手的文字」按原因彙總。
 *
 * 單頁版(audit-coverage.mjs)一次看一頁,適合追一個 bug;
 * 這一支回答另一個問題:**規則對整個常看的網路是不是都成立** ——
 * 收關文字階段之前,用台灣讀者常看的美日內容站 + CS 技術站掃一遍。
 *
 *   node scripts/audit-sites.mjs                 # 跑 scripts/sites.txt 全部
 *   node scripts/audit-sites.mjs qiita zenn      # 只跑網址含關鍵字的
 *
 * 網路:這個環境的 egress 會 reset Chromium 的 TLS(指紋問題),
 * 但 Node 的 fetch 走代理沒事 —— 所以所有請求都攔下來由 Node 抓再回填。
 * 副作用:頁面的每個資源都經過一手,慢,但這是稽核不是壓測。
 *
 * playwright 不是 devDependency,沒裝就跳過;單站失敗不擋整批。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const bundle = path.join(out, 'detect.js');
execFileSync(
  'npx',
  ['esbuild', path.join(here, '..', 'src', 'content', 'detect.ts'),
   '--bundle', '--format=iife', '--global-name=D', '--footer:js=globalThis.D=D;',
   `--outfile=${bundle}`],
  { stdio: 'inherit' },
);
const detectJs = readFileSync(bundle, 'utf8');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  executablePath: process.env['PLAYWRIGHT_BROWSERS_PATH']
    ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
    : undefined,
});

/** 每站一個乾淨的 context;所有請求由 Node fetch 代抓 */
async function newPage() {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const req = route.request();
    // 追蹤器與影音抓了也沒用,直接斷,省時間
    if (/\.(mp4|webm|m3u8)([?#]|$)|doubleclick|googletagmanager|google-analytics/.test(req.url())) {
      return route.abort();
    }
    try {
      const r = await fetch(req.url(), {
        method: req.method(),
        headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'ja,en;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      const body = Buffer.from(await r.arrayBuffer());
      const headers = {};
      r.headers.forEach((v, k) => {
        if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = v;
      });
      await route.fulfill({ status: r.status, headers, body });
    } catch {
      await route.abort();
    }
  });
  await page.addInitScript({ content: detectJs });
  return { ctx, page };
}

/** 和 audit-coverage.mjs 同一套判定,跑在頁面裡 */
function auditInPage() {
  const seen = new Set();
  const blocks = D.findCandidates(document.body, (el) => seen.has(el));
  for (const c of blocks) seen.add(c.el);
  const covered = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (seen.has(n)) return true;
    return false;
  };
  const labels = D.findLabels(document.body, 2000, covered);
  const labelEls = new Set(labels.map((c) => c.el));
  const handled = (node) => {
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      if (seen.has(n) || labelEls.has(n)) return true;
    }
    return false;
  };
  const visible = (node) => {
    const p = node.parentElement;
    if (!p) return false;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = p.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const missing = [];
  const seenText = new Set();
  let textNodes = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const p = node.parentElement;
    if (!p || SKIP_TAGS.has(p.tagName)) continue;
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 3) continue;
    if (!/\p{L}/u.test(text)) continue;
    if (/\p{Script=Han}/u.test(text) && !/[A-Za-z]{4}/.test(text) && !/[぀-ヿ]/.test(text)) continue;
    if (!visible(node)) continue;
    textNodes++;
    if (handled(node)) continue;
    let host = p;
    for (let n = p; n && n !== document.body; n = n.parentElement) {
      const d = getComputedStyle(n).display;
      if (d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table-cell') {
        host = n;
        break;
      }
    }
    const key = host.tagName + '|' + text.slice(0, 40);
    if (seenText.has(key)) continue;
    seenText.add(key);
    missing.push({
      text: text.slice(0, 56),
      host: host.tagName + (typeof host.className === 'string' && host.className.trim()
        ? '.' + host.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
      why: D.explainCandidate(host)[0] ?? '?',
    });
  }
  return { blocks: blocks.length, labels: labels.length, textNodes, missing };
}

const rows = [];
const reasonTotals = new Map();
for (const url of sites) {
  const short = url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 58);
  const { ctx, page } = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      for (let y = 0; y < Math.min(document.body.scrollHeight, 20_000); y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 25));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);
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
