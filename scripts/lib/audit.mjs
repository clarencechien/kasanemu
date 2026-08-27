/*
 * 偵測稽核的共用零件。
 *
 * 兩支稽核共用:`audit-sites.mjs`(一批固定網址)與
 * `audit-tree.mjs`(爬一個站的子路徑)。
 *
 * **為什麼抽出來**:這兩支問的問題不同,但「怎麼開頁面」「怎麼判定
 * 哪些字沒人接手」必須是同一套。兩份判定就會分岔,而分岔的症狀是
 * 「A 說沒問題 B 說有問題」,然後沒有人知道該信哪個(`docs/lessons.md` §1)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** 打包 production 的 detect.ts —— 稽核驗的必須是要出貨的那一份 */
export function buildDetector() {
  const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
  const bundle = path.join(out, 'detect.js');
  execFileSync(
    'npx',
    ['esbuild', path.join(root, 'src', 'content', 'detect.ts'),
     '--bundle', '--format=iife', '--global-name=D', '--footer:js=globalThis.D=D;',
     `--outfile=${bundle}`],
    { stdio: 'inherit' },
  );
  return readFileSync(bundle, 'utf8');
}

/**
 * 每站一個乾淨的 context;**所有請求由 Node fetch 代抓**。
 *
 * 這個環境的 egress 會 reset Chromium 的 TLS(指紋問題),而 Node 的
 * fetch 走代理沒事。副作用是每個資源都經過一手,慢 —— 但這是稽核不是壓測。
 */
export async function newPage(browser, detectJs) {
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

/** 載入 + 捲一遍(lazy 內容要捲過才會出現) */
export async function settle(page, url) {
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
  /*
   * **SVG 裡的字有自己的管線**(`findSvgTexts`,圖片階段 1)。
   *
   * 少了這一行,整站稽核會把每一張流程圖的字都算成「漏掉」——
   * 爬 thariqs.github.io 時是 95 段假警報,分散在 5 頁,
   * 而且把那幾頁的漏字率推過門檻。稽核自己說謊比不稽核更糟:
   * 它會讓真的問題埋在假的裡面。
   */
  for (const c of D.findSvgTexts(document.body, 2000, covered)) labelEls.add(c.el);
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

export { auditInPage };
