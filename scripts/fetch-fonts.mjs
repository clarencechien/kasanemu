#!/usr/bin/env node
/**
 * §4.2 字型打包。
 *
 * 下載 Noto Sans TC / Noto Serif TC 的 variable font,subset 後輸出成
 * assets/fonts/Ksnm{Sans,Serif}TC.woff2。必須打包進擴充,不得外連
 * Google Fonts:一來洩漏瀏覽紀錄給 Google,二來網站 CSP 會擋外部字型。
 *
 * 字集(開放問題 2 的實測起點):
 *   - Big5 第一階常用字 5401 個(用 Python codecs 就地產生,不依賴外部字表)
 *   - CJK 標點、全形符號、拉丁、數字
 *
 * 需要 Python 的 fonttools:  pip install fonttools brotli
 *
 * 實測(見 docs/fonts.md):5954 字的 variable subset,sans 1.6 MB / serif 2.2 MB。
 * PRD §4.2 的「單檔 < 300 KB」在 CJK variable font 上做不到,所以預設只打包
 * sans + Big5 前 3000 字(783 KB,仍在 §10.2 的 1.5 MB 預算內),serif 與
 * 更大的字集用旗標開。
 *
 * 用法:
 *   node scripts/fetch-fonts.mjs                 # sans / 3000 字 / 783 KB
 *   node scripts/fetch-fonts.mjs --level=full    # 5954 字
 *   node scripts/fetch-fonts.mjs --serif         # 加打包襯線體
 *   node scripts/fetch-fonts.mjs --keep-source   # 保留下載的原始 ttf
 */
import { mkdir, writeFile, stat, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const OUT_DIR = 'assets/fonts';
const TMP_DIR = 'assets/fonts/.src';

const FONTS = [
  {
    out: 'KsnmSansTC.woff2',
    src: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf',
    tmp: 'NotoSansTC.ttf',
  },
  {
    out: 'KsnmSerifTC.woff2',
    src: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf',
    tmp: 'NotoSerifTC.ttf',
  },
];

const level = (process.argv.find((a) => a.startsWith('--level=')) ?? '--level=core').split('=')[1];
const keepSource = process.argv.includes('--keep-source');
const withSerif = process.argv.includes('--serif');

/** Big5 第一階(0xA440–0xC67E)就是「常用字」,拿 codecs 直接展開,不必外部字表 */
async function charSet() {
  const py = `
import codecs
chars = []
for hi in range(0xA4, 0xC7):
    for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        b = bytes([hi, lo])
        try:
            c = b.decode('big5')
        except Exception:
            continue
        if len(c) == 1 and 0x4E00 <= ord(c) <= 0x9FFF:
            chars.append(c)
seen = set()
common = [c for c in chars if not (c in seen or seen.add(c))]
limit = ${level === 'core' ? 3000 : 'len(common)'}
common = common[:limit]
extra = []
extra += [chr(c) for c in range(0x20, 0x7F)]            # ASCII
extra += [chr(c) for c in range(0xA0, 0x100)]           # Latin-1 supplement
extra += [chr(c) for c in range(0x2010, 0x2060)]        # general punctuation
extra += [chr(c) for c in range(0x3000, 0x3040)]        # CJK punctuation
extra += [chr(c) for c in range(0x3100, 0x3130)]        # bopomofo (注音)
extra += [chr(c) for c in range(0xFE30, 0xFE50)]        # CJK compat forms
extra += [chr(c) for c in range(0xFF00, 0xFF70)]        # fullwidth forms
extra += list('①②③④⑤⑥⑦⑧⑨⑩←→↑↓⇒∼※§¶†‡•‰€£¥')
out = ''.join(common) + ''.join(extra)
print(len(common), len(out))
open('${TMP_DIR}/charset.txt', 'w', encoding='utf-8').write(out)
`;
  await run('python3', ['-c', py]);
  const text = await readFile(path.join(TMP_DIR, 'charset.txt'), 'utf8');
  return [...text].length;
}

async function download(url, dest) {
  if (existsSync(dest)) {
    console.log(`  已有原始檔,跳過下載:${dest}`);
    return;
  }
  console.log(`  下載 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 ${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function subset(font) {
  const src = path.join(TMP_DIR, font.tmp);
  const out = path.join(OUT_DIR, font.out);
  await run('python3', [
    '-m',
    'fontTools.subset',
    src,
    `--text-file=${path.join(TMP_DIR, 'charset.txt')}`,
    '--flavor=woff2',
    '--layout-features=kern,liga,vert,vrt2,palt,halt,ccmp',
    '--name-IDs=1,2,3,4,6',
    '--drop-tables+=DSIG',
    '--no-hinting',
    // variable font 的 fvar/gvar 要留著:400/500/600/700 四個字重靠它,
    // 四份靜態檔的體積會是 variable 版的數倍
    `--output-file=${out}`,
  ]);
  const { size } = await stat(out);
  return size;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
  const chars = await charSet();
  console.log(`字集:${chars} 個字元 (level=${level})`);

  let total = 0;
  const wanted = withSerif ? FONTS : FONTS.slice(0, 1);
  for (const font of wanted) {
    console.log(`\n${font.out}`);
    await download(font.src, path.join(TMP_DIR, font.tmp));
    const size = await subset(font);
    total += size;
    const kb = (size / 1024).toFixed(0);
    console.log(`  ${kb} KB${size > 300 * 1024 ? '  (超出 §4.2 的 300 KB 目標)' : ''}`);
  }
  const mb = total / 1024 / 1024;
  console.log(`\n合計 ${mb.toFixed(2)} MB`);
  if (!withSerif) console.log('襯線體未打包:襯線站台會落到系統的 Songti/PMingLiU。--serif 可加。');
  if (mb > 1.4) {
    console.log(
      '已吃掉 §10.2 的 1.5 MB 體積預算。\n' +
        '選項:(a) --level=core 縮到 3000 字  (b) 放寬體積預算(自用、不上架,體積成本其實只有磁碟)' +
        '  (c) 改成 unicode-range 分片按需載入。',
    );
  }
  if (!keepSource) await rm(TMP_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('字型打包失敗:', e.message);
  console.error('缺 fonttools 的話:pip install fonttools brotli');
  process.exit(1);
});
