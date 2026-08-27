/*
 * 比較稿的資料 —— **幾何全部由 production 算好**,頁面只做選取。
 *
 *   node --experimental-strip-types scripts/mockup-data.mjs > out.json
 *
 * 為什麼要先算好:比較稿要問的是「**選哪幾塊**」,不是「框畫在哪裡」。
 * 框的位置、字級、值不值得翻,都由 `imagegeo` / `imageblocks` 決定,
 * 在頁面裡重寫一份就等於在比較另一套規則(§DF)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const IG = await import(path.resolve('src/content/imagegeo.ts'));
const IB = await import(path.resolve('src/shared/imageblocks.ts'));

const WIDTHS = [340, 480, 620, 800, 1040, 1400];
const DIR = 'tests/fixtures/vision';

/** 譯文貼片畫出來多大 —— 和 measure-vocab 同一支估法 */
const PLATE_PAD_X = 0.62;
const plateSize = (label, fontPx) => {
  const fs = Math.max(fontPx, IB.MIN_PATCH_FONT_PX);
  const w =
    [...label].reduce((n, c) => n + (/[　-鿿＀-￯]/u.test(c) ? 1 : 0.55), 0) * fs +
    fs * PLATE_PAD_X * 2;
  return { w, h: fs * 1.24, fs };
};

const out = {};
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
  const id = f.replace(/\.json$/, '');
  const fx = JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
  out[id] = { nw: fx.nw, nh: fx.nh, model: fx.model, widths: {} };
  for (const W of WIDTHS) {
    const H = Math.round((W * fx.nh) / fx.nw);
    const drawn = IG.drawnRect({ w: fx.nw, h: fx.nh }, { w: W, h: H }, 'contain',
      { x: { pct: 0.5 }, y: { pct: 0.5 } });
    const clip = { w: W, h: H };
    /** 原文:全部畫出來當底圖(fixture 沒有原圖) */
    const source = [];
    const blocks = [];
    for (const b of fx.blocks) {
      const r = IG.mapBox(b.box, drawn, clip);
      if (!r) continue;
      source.push({ x: r.x, y: r.y, w: r.w, h: r.h, text: b.text });
      if (b.kind === 'code') continue;
      const label = b.zh || b.text;
      if (!label || !IB.worthAnnotating(b.text, label)) continue;
      const fontPx = IB.fontSizeFor(r.w, r.h, [...label].length, b.v === true);
      const pl = plateSize(label, fontPx);
      blocks.push({
        x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
        w: Math.round(r.w * 10) / 10, h: Math.round(r.h * 10) / 10,
        label, text: b.text,
        font: Math.round(pl.fs * 10) / 10,
        pw: Math.round(pl.w * 10) / 10, ph: Math.round(pl.h * 10) / 10,
        fits: IB.patchable(fontPx),
      });
    }
    out[id].widths[W] = {
      W, H,
      mode: IG.imageMode(blocks.map((b) => b.fits)),
      fitRatio: blocks.length ? blocks.filter((b) => b.fits).length / blocks.length : 1,
      total: fx.blocks.length,
      source,
      blocks,
    };
  }
}
process.stdout.write(JSON.stringify(out));
