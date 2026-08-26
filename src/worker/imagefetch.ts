/**
 * 圖片位元組的取得、縮圖與指紋 —— 全部在 service worker 裡做。
 *
 * **為什麼不能在 content script 做**(`docs/plan-images.md` §5、
 * `plan-annotation.md` §7.2):跨網域的 `<img>` 沒有 CORS 標頭時,
 * 畫進 canvas 會污染它,`toDataURL()` / `getImageData()` 直接丟 SecurityError。
 * 而部落格的圖幾乎都在 CDN 上 —— claude.com 那篇的圖全部跨域。
 *
 * 擴充功能有 `<all_urls>` host permission,由 worker `fetch()` 拿 bytes
 * 就完全繞開 canvas taint。代價是這裡要自己做所有的守門。
 */

// 副檔名:這個檔會被 node:test 直接載入(見 imagegeo.ts 的同一條註解)
import { dbg, warn } from '../shared/log.ts';

/**
 * 送給模型之前先縮圖。
 *
 * 1536 是**猜的**,而且我知道它是猜的 —— `docs/plan-images.md` §13-1
 * 列了縮圖敏感度量測(1536 / 1024 / 768 對區域數與 box 準度的影響)當
 * 實作後要補的功課。在那之前它至少是個保守的值:2042px 的截圖縮到 1536
 * 仍然看得到卡片上的小字。
 */
export const MAX_EDGE = 1536;

/** 超過這個大小的圖不抓。4MB 的 PNG 已經是海報級,不會是文章插圖 */
export const MAX_BYTES = 4 * 1024 * 1024;

/** 解碼後的上限。16MP ≈ 4000×4000,再大就是掃描檔 */
export const MAX_PIXELS = 16 * 1024 * 1024;

export interface ImageBytes {
  /** base64(不含 data: 前綴) */
  data: string;
  mime: string;
  /** **縮圖後**的尺寸 —— 座標防呆的像素模式要用這個,不是原始尺寸 */
  w: number;
  h: number;
  /** 原始 bytes 的 SHA-256,快取鍵用。縮圖前算,所以換 MAX_EDGE 不會讓快取全失效 */
  hash: string;
}

export type FetchOutcome =
  | { ok: true; image: ImageBytes }
  | { ok: false; reason: string; retriable: boolean };

/**
 * 只抓 http/https 與 data:。
 *
 * `blob:` 抓不到(那是別的 realm 的 URL,worker 解不開),
 * 其他 scheme(`chrome-extension:`、`file:`)一律拒絕 —— 讓一個
 * 「翻譯圖片」的功能變成任意檔案讀取,是這裡最容易犯的錯。
 */
export function allowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:';
  } catch {
    return false;
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  // 一次 apply 整個陣列會爆呼叫堆疊(幾 MB 的圖是幾百萬個參數),所以分塊
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * 縮圖。長邊超過 `MAX_EDGE` 才動,沒超過就原樣回傳 ——
 * **不重新編碼**是刻意的:重編一次 JPEG 會多一層失真,而模型要讀的是小字。
 */
async function downscale(
  blob: Blob,
  mime: string,
): Promise<{ blob: Blob; mime: string; w: number; h: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    warn(`圖片解碼失敗:${String(e).slice(0, 120)}`);
    return null;
  }
  const { width: w0, height: h0 } = bitmap;
  if (w0 * h0 > MAX_PIXELS) {
    bitmap.close();
    return null;
  }
  const edge = Math.max(w0, h0);
  if (edge <= MAX_EDGE) {
    bitmap.close();
    return { blob, mime, w: w0, h: h0 };
  }
  const scale = MAX_EDGE / edge;
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { blob, mime, w: w0, h: h0 };
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  /*
   * 一律轉 PNG。
   *
   * 縮完之後圖上都是**小字**,而 JPEG 對高對比細線的失真正好落在
   * 文字的筆畫上 —— 省下來的那點 token 換不到辨識率。
   */
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return { blob: out, mime: 'image/png', w, h };
}

/**
 * URL → 可以送進模型的 base64。
 *
 * 每個環節都可能失敗,而**失敗要說得出原因** —— chip 上顯示的字就是
 * 從這裡的 `reason` 來的,「辨識失敗」和「這張圖太大」對使用者是兩件事。
 */
export async function fetchImage(url: string): Promise<FetchOutcome> {
  if (!allowedUrl(url)) return { ok: false, reason: 'unsupported-scheme', retriable: false };

  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    return { ok: false, reason: `network:${String(e).slice(0, 80)}`, retriable: true };
  }
  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, retriable: res.status >= 500 };
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return { ok: false, reason: 'too-large', retriable: false };

  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf) return { ok: false, reason: 'read-failed', retriable: true };
  // content-length 可能沒有或說謊,所以拿到之後再量一次
  if (buf.byteLength > MAX_BYTES) return { ok: false, reason: 'too-large', retriable: false };
  if (buf.byteLength === 0) return { ok: false, reason: 'empty', retriable: false };

  const hash = await sha256(buf);
  const mime = (res.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim();
  const scaled = await downscale(new Blob([buf], { type: mime }), mime);
  if (!scaled) return { ok: false, reason: 'decode-failed', retriable: false };

  const bytes = new Uint8Array(await scaled.blob.arrayBuffer());
  dbg('image fetched', { bytes: buf.byteLength, sent: bytes.length, w: scaled.w, h: scaled.h });
  return {
    ok: true,
    image: { data: toBase64(bytes), mime: scaled.mime, w: scaled.w, h: scaled.h, hash },
  };
}
