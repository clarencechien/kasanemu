#!/usr/bin/env node
/**
 * 把 dist/ 打包成 kasanemu-<version>.zip。
 *
 * 自己寫 zip 而不是 shell 出去呼 `zip`:CI、macOS、Windows 上都不用假設
 * 有那支 CLI,而且 Node 內建的 zlib 就夠了。
 *
 * 用法:npm run zip
 */
import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const SRC = 'dist';
const OUT_DIR = 'release';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 時間戳。固定值 → 同樣的輸入產生同樣的 zip(可比對 checksum) */
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

async function walk(dir, base = '') {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push({ full, rel });
  }
  return out;
}

function localHeader(entry) {
  const name = Buffer.from(entry.rel, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 名稱
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.deflated.length, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.rel, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.deflated.length, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attrs(<< 是有號運算,要轉回無號)
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

async function main() {
  try {
    await stat(SRC);
  } catch {
    console.error('沒有 dist/,先跑 npm run build。');
    process.exit(1);
  }
  // 版本以 dist/manifest.json 為準 —— build 時蓋上了 build number,
  // package.json 只有基準版號
  const manifest = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8'));

  const files = await walk(SRC);
  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const f of files) {
    const raw = await readFile(f.full);
    const entry = {
      rel: f.rel,
      size: raw.length,
      crc: crc32(raw),
      // woff2 已經是 brotli,再 deflate 一次只是浪費 CPU,但 zip 沒有 store-only
      // 的必要;等級壓到 1 就好
      deflated: deflateRawSync(raw, { level: f.rel.endsWith('.woff2') ? 1 : 9 }),
      offset,
    };
    const local = localHeader(entry);
    chunks.push(local, entry.deflated);
    offset += local.length + entry.deflated.length;
    entries.push(entry);
  }

  const central = entries.map(centralHeader);
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  await mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `kasanemu-${manifest.version}.zip`);
  const buf = Buffer.concat([...chunks, ...central, end]);
  await writeFile(out, buf);
  console.log(`${out}  ${(buf.length / 1024).toFixed(0)} KB  ${entries.length} 個檔`);
  if (manifest.version_name) console.log(manifest.version_name);
  console.log('載入方式:解壓後 chrome://extensions → 載入未封裝項目 → 選解壓出來的目錄');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
