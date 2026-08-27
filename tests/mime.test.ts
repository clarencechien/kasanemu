import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sniffMime } from '../src/worker/imagefetch.ts';

/**
 * 圖片格式以**檔頭**為準,不看 `Content-Type`。
 *
 * 使用者回報「圖形功能好像出錯了 不能用了」:blog.google 上每一張圖都
 * 回 `400 Unsupported MIME type`。原因不是格式不支援 —— WebP 模型收 ——
 * 而是 Google Cloud Storage 把每一張 WebP 都標成 `application/octet-stream`,
 * 而我們把那個字串原樣轉給了模型(`docs/deviations.md` §DO)。
 */

const bytes = (...b: number[]) => new Uint8Array([...b, ...Array(24).fill(0)]);
const ascii = (s: string, pad = 0) =>
  new Uint8Array([...Array(pad).fill(0), ...[...s].map((c) => c.charCodeAt(0)), ...Array(24).fill(0)]);

test('真實的檔頭:GCS 的 WebP 標成 application/octet-stream,而 bytes 說實話', () => {
  /*
   * 這份 fixture 是**從出事的那個站抓下來的**,不是我手寫的。
   * 手寫的檔頭只能驗「我以為的格式」,驗不到「伺服器實際會說什麼」。
   */
  const real = JSON.parse(
    readFileSync(new URL('./fixtures/mime/real-headers.json', import.meta.url), 'utf8'),
  ) as Record<string, { header: string; head: number[] }>;

  assert.equal(real['gcs-webp']!.header, 'application/octet-stream', 'fixture 過期了');
  assert.equal(sniffMime(new Uint8Array(real['gcs-webp']!.head)), 'image/webp');
  assert.equal(sniffMime(new Uint8Array(real['png']!.head)), 'image/png');
  assert.equal(sniffMime(new Uint8Array(real['jpeg']!.head)), 'image/jpeg');
});

test('認得出常見格式', () => {
  assert.equal(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47)), 'image/png');
  assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(ascii('GIF89a')), 'image/gif');
  assert.equal(sniffMime(bytes(0x42, 0x4d)), 'image/bmp');
});

test('WebP 要看到 RIFF 與 WEBP 兩段才算 —— RIFF 也可能是 wav', () => {
  const webp = new Uint8Array(24);
  webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  webp.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  assert.equal(sniffMime(webp), 'image/webp');

  const wav = new Uint8Array(24);
  wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  assert.equal(sniffMime(wav), null, 'wav 不是圖片');
});

test('AVIF 與 HEIC 共用 ftyp 外殼,靠 brand 分開', () => {
  /*
   * 這兩個要分得開,因為**模型收 HEIC 不收 AVIF**:
   * HEIC 直接送,AVIF 要重編。分不開就只能兩個都重編(浪費)
   * 或兩個都送(其中一個會 400)。
   */
  const ftyp = (brand: string) => {
    const b = new Uint8Array(24);
    b.set([...'ftyp'].map((c) => c.charCodeAt(0)), 4);
    b.set([...brand].map((c) => c.charCodeAt(0)), 8);
    return b;
  };
  assert.equal(sniffMime(ftyp('avif')), 'image/avif');
  assert.equal(sniffMime(ftyp('avis')), 'image/avif');
  assert.equal(sniffMime(ftyp('heic')), 'image/heic');
  assert.equal(sniffMime(ftyp('mif1')), 'image/heic');
});

test('認不出來就回 null —— 猜錯格式比不猜更糟', () => {
  assert.equal(sniffMime(bytes(0x00, 0x01, 0x02, 0x03)), null);
  assert.equal(sniffMime(new Uint8Array(0)), null);
  assert.equal(sniffMime(ascii('<svg xmlns=')), null, 'SVG 模型不收,要當成不支援');
});

test('太短的 buffer 不可以讀出界', () => {
  for (let n = 0; n < 12; n++) {
    assert.doesNotThrow(() => sniffMime(new Uint8Array(n)));
  }
});
