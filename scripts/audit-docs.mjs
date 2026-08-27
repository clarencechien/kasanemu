/*
 * **文件和 repo 有沒有對齊。**
 *
 *   node scripts/audit-docs.mjs
 *
 * 這個專案的註解和文件互相指名道姓:程式裡寫節號、文件裡寫腳本名與檔案路徑。
 * 那些指名**沒有任何東西在維護** —— 改個檔名、刪一支腳本、
 * 章節重編號,指過去的那一端就變成謊話,而且看起來和真話一模一樣。
 *
 * 這支只問四件事,每一件都是「說有,那到底有沒有」:
 *
 * 1. 程式與腳本裡引的節號在 docs/deviations.md 找得到那一節嗎
 * 2. 文件裡寫的 npm 腳本名在 package.json 裡有嗎
 * 3. 文件與程式裡提到的檔案路徑真的存在嗎
 * 4. deviations 的節號有沒有跳號或重複
 *
 * 不查的:散文有沒有過時。那要人讀,而這支只查**機械上可驗證**的部分。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && /\.(ts|mjs|md|json|html)$/.test(f));

const read = (f) => readFileSync(f, 'utf8');
const problems = [];
const note = (f, msg) => problems.push(`${f}: ${msg}`);

/* ── 1. 節號 ────────────────────────────────────────────────── */

const devText = read('docs/deviations.md');
const devSections = new Set(
  [...devText.matchAll(/^## ([A-Z]{1,2})\.\s*/gm)].map((m) => m[1]),
);
/** deviations 的小節:「### DR-1.」 */
const devSubs = new Set(
  [...devText.matchAll(/^### ([A-Z]{1,2}-\d+)\.\s*/gm)].map((m) => m[1]),
);

for (const f of files) {
  if (f === 'docs/deviations.md') continue;
  for (const m of read(f).matchAll(/§([A-Z]{1,2})(-\d+)?\b/g)) {
    const [, letters, sub] = m;
    if (sub) {
      if (!devSubs.has(letters + sub) && !devSections.has(letters)) {
        note(f, `§${letters}${sub} 在 deviations 裡找不到`);
      }
    } else if (!devSections.has(letters)) {
      note(f, `§${letters} 在 deviations 裡找不到`);
    }
  }
}

/* ── 2. npm run ─────────────────────────────────────────────── */

const pkg = JSON.parse(read('package.json'));
const scripts = new Set(Object.keys(pkg.scripts ?? {}));
for (const f of files) {
  for (const m of read(f).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    if (!scripts.has(m[1])) note(f, `npm run ${m[1]} —— package.json 裡沒有這支`);
  }
}

/* ── 3. 提到的檔案在不在 ────────────────────────────────────── */

const known = new Set(files);
/*
 * **指向別的 repo 的路徑**。
 *
 * 這幾個不是筆誤,是前作(sukemu)與 PRD 前置的檔案 —— 文件裡明講了
 * 「不在這個 repo 裡」。放白名單而不是放寬規則:例外要看得見,
 * 而且下一個想加進來的人得先寫一行理由。
 */
const ELSEWHERE = new Map([
  ['docs/gemini-api-lessons.md', 'PRD 的前置文件,README §「跟規格的出入」明說不在這個 repo'],
  ['docs/handoff.md', 'sukemu 的檔案(plan-images.md 開頭那個連結指的那個 repo)'],
]);
const PATH_RE = /\b((?:src|scripts|tests|docs|adr)\/[A-Za-z0-9._/-]+\.(?:ts|mjs|md|html|json))/g;
for (const f of files) {
  for (const m of read(f).matchAll(PATH_RE)) {
    const p = m[1];
    if (known.has(p) || existsSync(p) || ELSEWHERE.has(p)) continue;
    note(f, `提到 ${p},但它不存在`);
  }
}

/* ── 4. README 說的測試數 ───────────────────────────────────── */

/*
 * 「N 個測試」是最會過期的那種數字:它每加一條就錯一次,
 * 而錯了完全看不出來。頂層 `test(` 的數量和 `node --test` 報的
 * 一致(兩邊都不算 subtest),所以數得出來就對得起來。
 */
const testCount = files
  .filter((f) => f.startsWith('tests/') && f.endsWith('.test.ts'))
  .reduce((n, f) => n + (read(f).match(/^test\(/gm)?.length ?? 0), 0);
for (const f of ['README.md']) {
  for (const m of read(f).matchAll(/(\d+) 個(?:測試|node:test)/g)) {
    if (Number(m[1]) !== testCount) {
      note(f, `說有 ${m[1]} 個測試,實際數到 ${testCount}`);
    }
  }
}

/* ── 4. deviations 自己的節號 ───────────────────────────────── */

const order = [...devText.matchAll(/^## ([A-Z]{1,2})\.\s*/gm)].map((m) => m[1]);
const seen = new Set();
for (const s of order) {
  if (seen.has(s)) note('docs/deviations.md', `§${s} 出現兩次`);
  seen.add(s);
}
/** A…Z、AA…AZ、BA… 的下一個 */
const next = (s) => {
  const n = s.split('').reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) + 1;
  let out = '';
  for (let v = n; v > 0; ) {
    const r = (v - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
};
for (let i = 1; i < order.length; i++) {
  if (order[i] !== next(order[i - 1])) {
    note('docs/deviations.md', `§${order[i - 1]} 之後直接跳到 §${order[i]}`);
  }
}

/* ── 出結果 ─────────────────────────────────────────────────── */

console.log(
  `掃 ${files.length} 個檔;deviations ${order.length} 節(${order[0]}–${order.at(-1)})、` +
    `${devSubs.size} 個小節;package.json ${scripts.size} 支腳本;${testCount} 個測試\n`,
);
if (problems.length === 0) {
  console.log('文件和 repo 對得起來。');
  process.exit(0);
}
for (const p of problems) console.log('  ' + p);
console.log(`\n${problems.length} 處對不上。`);
process.exit(1);
