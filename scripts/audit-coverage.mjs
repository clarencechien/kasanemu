/*
 * 一次問完:這一頁有哪些看得見的文字**沒有**被任何疊層或貼片接手,
 * 而且各是被哪一條規則擋掉的。
 *
 * 之前的節奏是「使用者截圖 → 修一個 → 再截圖」,一輪只解一個形狀,
 * 而同一頁上往往同時卡著五種不同的原因。這支腳本把整頁掃過一遍、
 * 依原因分組,一次看完再決定要修哪些。
 *
 *   node scripts/audit-coverage.mjs [檔案或網址]
 *
 * 預設跑 scripts/fixtures/ 裡的頁面;給網址就跑線上的那一頁。
 * playwright 不是 devDependency,沒裝就跳過。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? path.join(here, 'fixtures', 'detect.html');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright(npm i -D playwright 之後再跑)');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const bundle = path.join(out, 'detect.js');
execFileSync(
  'npx',
  ['esbuild', path.join(here, '..', 'src', 'content', 'detect.ts'),
   '--bundle', '--format=iife', '--global-name=D', '--footer:js=globalThis.D=D;',
   `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

const url = /^https?:/.test(target)
  ? target
  : 'file://' + (existsSync(target) ? path.resolve(target) : target);

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript({ content: readFileSync(bundle, 'utf8') });
await page.goto(url, { waitUntil: 'load' });
// 把整頁捲一遍:lazy load 的內容不出現就掃不到
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 30));
  }
  window.scrollTo(0, 0);
});

const report = await page.evaluate(() => {
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

  /** 這段文字看得見嗎 */
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
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const p = node.parentElement;
    if (!p || SKIP_TAGS.has(p.tagName)) continue;
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 3) continue;
    if (!/\p{L}/u.test(text)) continue;
    // 已經是中文的不算漏
    if (/\p{Script=Han}/u.test(text) && !/[A-Za-z]{4}/.test(text)) continue;
    if (!visible(node)) continue;
    if (handled(node)) continue;

    // 最近的 block 祖先才是「本來應該成為單元」的那個
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
      text: text.slice(0, 60),
      host: host.tagName + (typeof host.className === 'string' && host.className.trim()
        ? '.' + host.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
      why: D.explainCandidate(host)[0] ?? '?',
    });
  }
  return { blocks: blocks.length, labels: labels.length, missing };
});
await browser.close();

const groups = new Map();
for (const m of report.missing) {
  const g = groups.get(m.why) ?? [];
  g.push(m);
  groups.set(m.why, g);
}
console.log(`\n單元 ${report.blocks} · 貼片 ${report.labels} · 沒人接手的文字 ${report.missing.length} 段\n`);
for (const [why, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${items.length} 段 · ${why}`);
  for (const it of items.slice(0, 6)) {
    console.log(`     [${it.host}] ${it.text}`);
  }
  if (items.length > 6) console.log(`     …還有 ${items.length - 6} 段`);
  console.log();
}
