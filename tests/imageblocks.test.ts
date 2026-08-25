import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOX_SCALE,
  MIN_PATCH_FONT_PX,
  fontSizeFor,
  looksConcatenated,
  normalizeBoxes,
  patchable,
  sanitizeBlocks,
} from '../src/shared/imageblocks.ts';
import {
  drawnRect,
  mapBox,
  parsePosition,
  worthTranslating,
} from '../src/content/imagegeo.ts';

/* -------------------------------------------------------- 座標規格防呆 */

const box = (y0: number, x0: number, y1: number, x1: number) =>
  ({ box: [y0, x0, y1, x1] as [number, number, number, number] });

test('照規格的 0–1000 原樣通過,不誤判', () => {
  const { blocks, spec } = normalizeBoxes([box(100, 200, 160, 500)]);
  assert.equal(spec, null, '沒動過就不該報 spec');
  assert.deepEqual(blocks[0]!.box, [100, 200, 160, 500]);
});

test('模型掉回 0–100 百分比 → 換算回 0–1000', () => {
  // sukemu 要 0–100 結果拿到 0–1000;我們要 0–1000,反過來一樣要防
  const { blocks, spec } = normalizeBoxes([box(10, 20, 16, 50)]);
  assert.equal(spec, '0-100');
  assert.deepEqual(blocks[0]!.box, [100, 200, 160, 500]);
});

test('模型回 0–1 小數 → 換算回 0–1000', () => {
  const { blocks, spec } = normalizeBoxes([box(0.1, 0.2, 0.16, 0.5)]);
  assert.equal(spec, '0-1');
  assert.deepEqual(blocks[0]!.box, [100, 200, 160, 500]);
});

test('模型回像素 → 用圖片尺寸換算,兩軸分開算', () => {
  // 1580×530 的圖:x 走 1580,y 走 530 —— 用同一個比例會壓扁
  const { blocks, spec } = normalizeBoxes([box(53, 158, 106, 1264)], 1580, 530);
  assert.equal(spec, 'px');
  assert.deepEqual(blocks[0]!.box, [100, 100, 200, 800]);
});

test('像素模式在小圖上認不出來 —— 這是規格的死角,要寫下來不是假裝沒有', () => {
  /*
   * 530 高的圖,y 的像素值最大就是 530,和合規的 0–1000 座標無從分辨。
   * 選 0–1000 當契約就要接受這件事;會出事的大圖一定超過 1000。
   */
  const { spec } = normalizeBoxes([box(53, 158, 106, 790)], 1580, 530);
  assert.equal(spec, null, '認不出來就不要亂猜,原樣通過');
});

test('超界的值夾住而不是放大整張圖', () => {
  // 直接夾到上界會把框撐成滿版,整張圖蓋一片橘(sukemu 實測過的畫面)
  const { blocks } = normalizeBoxes([box(-40, 0, 1200, 1600)]);
  const [y0, x0, y1, x1] = blocks[0]!.box;
  assert.ok(y0 >= 0 && x0 >= 0, '負值要夾回 0');
  assert.ok(y1 <= BOX_SCALE && x1 <= BOX_SCALE, '超界要夾回上界');
});

test('兩角寫反的框排序回來,不丟掉', () => {
  const { blocks } = normalizeBoxes([box(500, 800, 100, 200)]);
  assert.deepEqual(blocks[0]!.box, [100, 200, 500, 800]);
});

/* ------------------------------------------------------------ 字級公式 */

test('字級不能只看框高 —— 多行合併的高瘦框不可以爆出巨字', () => {
  /*
   * gemma 把整張小卡合併成一塊:167×143 px、30 多個字。
   * 只看框高的話字級是 143×0.8 = 114px,一根巨柱壓在圖上(mockup 第一版)。
   */
  const merged = fontSizeFor(167, 143, 34);
  assert.ok(merged < 30, `合併框的字級沒有縮回去:${merged}`);

  // 反面:單行短句不受面積項影響,框高才是限制
  const line = fontSizeFor(187, 54, 8);
  assert.ok(line > 30, `單行短句被面積項誤殺:${line}`);
});

test('同一份資料兩個檢視尺寸 —— 縮圖落錨點,放大變疊字', () => {
  // 行內 340px 的截圖 vs 放大檢視 1200px,同一塊 tab 標籤
  const chars = 2;
  const small = fontSizeFor(340 * 0.03, 340 * 0.018, chars);
  const large = fontSizeFor(1200 * 0.03, 1200 * 0.018, chars);
  assert.ok(!patchable(small), '縮圖上該落錨點');
  assert.ok(patchable(large), '放大後該變疊字');
});

test('字級不超過上限 —— 加註不該比原圖的字還醒目', () => {
  assert.ok(fontSizeFor(900, 700, 1) <= 40);
});

test('直排看框寬,不看框高', () => {
  // 直排的一行字:框很高很窄,限制字級的是寬度
  const vertical = fontSizeFor(20, 300, 6, true);
  const horizontal = fontSizeFor(20, 300, 6, false);
  assert.ok(vertical < horizontal, '直排沒有改看框寬');
  assert.ok(vertical <= 20 * 0.8 + 0.01);
});

/* ---------------------------------------------------------- 多語串接 */

test('譯文長度遠超原文 → 標低信心(多語並排的串接)', () => {
  // sukemu 實測:韓/英/日/中四行並排,lite 把四行全串進同一塊
  assert.ok(looksConcatenated('Seolleongtang', '雪濃湯 牛骨湯 雪濃湯 雪濃湯 9,000 韓元 招牌菜色 每日供應'));
  assert.ok(!looksConcatenated('Storage size', '儲存空間大小'), '正常譯文不可以被誤殺');
  // 英譯中會縮短,所以「譯文比原文長」本身就是訊號 —— 但縮寫展開要放過
  assert.ok(!looksConcatenated('NDA Review Standards Guide', 'NDA 審查標準指南'));
  assert.ok(
    !looksConcatenated('Contract redlining and negotiation', '合約修訂與協商'),
    '正常的長句譯文',
  );
});

test('極短原文不套串接規則 —— 縮寫本來就會展開', () => {
  // 'HR' → '人力資源' 是 2 字變 4 字,比例上超標但完全正確
  assert.ok(!looksConcatenated('HR', '人力資源'));
});

test('sanitizeBlocks:座標防呆 + 串接標記 + 欄位補齊一次做完', () => {
  const { blocks, spec } = sanitizeBlocks([
    { box: [10, 20, 16, 50], text: 'Storage size', zh: '儲存空間大小' },
    { box: [20, 20, 26, 50], text: 'Main menu', zh: '菜單 選單 目錄 一覽 清單 列表 項目' },
    // 壞掉的:不成矩形、缺座標、兩邊都空
    { box: [30, 20, 30, 20], text: 'x', zh: 'x' },
    { text: 'no box', zh: '沒有座標' },
    { box: [40, 20, 46, 50], text: '', zh: '' },
  ]);
  assert.equal(spec, '0-100');
  assert.equal(blocks.length, 2, '壞掉的三塊要濾掉');
  assert.deepEqual(blocks[0]!.box, [100, 200, 160, 500]);
  assert.equal(blocks[0]!.c, 1, '沒給 c 就當滿分');
  assert.ok(blocks[1]!.c <= 0.5, '串接的那塊要標低信心');
});

/* ------------------------------------------------------------ 幾何換算 */

test('contain:等比縮放置中,兩側留白', () => {
  // 1580×530 的圖放進 800×400 的盒子
  const r = drawnRect({ w: 1580, h: 530 }, { w: 800, h: 400 }, 'contain', parsePosition('50% 50%'));
  assert.equal(Math.round(r.w), 800);
  assert.equal(Math.round(r.h), 268);
  assert.equal(Math.round(r.x), 0);
  assert.ok(Math.round(r.y) > 60, '上下要留白');
});

test('cover:填滿盒子,超出的部分是負座標(被裁掉的那塊)', () => {
  const r = drawnRect({ w: 1580, h: 530 }, { w: 800, h: 400 }, 'cover', parsePosition('50% 50%'));
  assert.equal(Math.round(r.h), 400);
  assert.ok(r.w > 800, '寬度要溢出盒子');
  assert.ok(r.x < 0, '溢出的部分靠負座標表達,呼叫端才知道哪裡被裁掉');
});

test('cover 裁掉的框回 null,半可見的裁到看得見的那半', () => {
  const drawn = drawnRect({ w: 1000, h: 500 }, { w: 400, h: 400 }, 'cover', parsePosition('50% 50%'));
  const clip = { w: 400, h: 400 };
  // 圖最左邊的一塊:cover 之後在盒子外
  assert.equal(mapBox([100, 0, 200, 60], drawn, clip), null, '看不見的框不該畫');
  // 正中央的一塊:完整可見
  const mid = mapBox([400, 450, 600, 550], drawn, clip);
  assert.ok(mid && mid.w > 0 && mid.h > 0);
  assert.ok(mid!.x >= 0 && mid!.x + mid!.w <= 400);
});

test('object-position 左上:留白全部在右下', () => {
  const r = drawnRect({ w: 100, h: 100 }, { w: 400, h: 200 }, 'contain', parsePosition('left top'));
  assert.equal(Math.round(r.x), 0);
  assert.equal(Math.round(r.y), 0);
  const mid = drawnRect({ w: 100, h: 100 }, { w: 400, h: 200 }, 'contain', parsePosition('right bottom'));
  assert.equal(Math.round(mid.x), 200);
});

test('fill:兩軸各自拉伸,框跟著變形', () => {
  const r = drawnRect({ w: 100, h: 100 }, { w: 400, h: 200 }, 'fill', parsePosition('50% 50%'));
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 400, 200]);
});

test('沒有 object-fit 的一般圖:框直接落在元素上', () => {
  // <img width=800 height=268> 顯示的就是等比縮放 —— contain 與它同結果
  const drawn = drawnRect({ w: 1580, h: 530 }, { w: 800, h: 268 }, 'contain', parsePosition('50% 50%'));
  const r = mapBox([100, 200, 200, 500], drawn, { w: 800, h: 268 });
  assert.ok(r);
  assert.equal(Math.round(r!.x), 160);
  assert.equal(Math.round(r!.w), 240);
});

test('顯示面積太小的圖不值得問模型', () => {
  assert.ok(!worthTranslating({ w: 120, h: 120 }), '卡片縮圖上的字讀不到,翻了白花錢');
  assert.ok(worthTranslating({ w: 340, h: 257 }), '繞圖的小圖仍然值得');
});

test('字級門檻是常數,錨死避免無聲漂移', () => {
  assert.equal(MIN_PATCH_FONT_PX, 11);
});

/* ------------------------------------------ 真實模型輸出(回歸用的地面實況) */

/*
 * `tests/fixtures/vision/*.json` 是 2026-08-25 那六次真實 API 回應
 * (`scripts/probe-vision.mjs`)。用它們驗的不是「模型會不會變」——
 * 那不歸我們管 —— 而是**這些公式對真實輸出的分流結果**。
 *
 * 手寫的案例驗的是邊界,這一組驗的是常態:規格 §7 的兩張圖、兩個檔位、
 * 兩個檢視尺寸,和 mockup 上目視確認過的畫面是同一份資料。
 */
function loadVision(name: string): {
  model: string;
  nw: number;
  nh: number;
  blocks: { box: [number, number, number, number]; text: string; zh: string }[];
} {
  const url = new URL(`./fixtures/vision/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** 一張圖在某個顯示寬度下的分流結果 */
function split(name: string, displayW: number): { veil: number; pin: number; maxFs: number } {
  const fx = loadVision(name);
  const { blocks } = sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const H = (displayW * fx.nh) / fx.nw;
  let veil = 0;
  let pin = 0;
  let maxFs = 0;
  for (const b of blocks) {
    const [y0, x0, y1, x1] = b.box;
    const fs = fontSizeFor(
      ((x1 - x0) / 1000) * displayW,
      ((y1 - y0) / 1000) * H,
      [...(b.zh || b.text)].length,
      b.v,
    );
    maxFs = Math.max(maxFs, fs);
    if (patchable(fs)) veil++;
    else pin++;
  }
  return { veil, pin, maxFs };
}

test('真實輸出:四份都通得過 sanitize,座標全部合規', () => {
  for (const name of ['gemma-chart', 'lite-chart', 'gemma-shot', 'lite-shot']) {
    const fx = loadVision(name);
    const { blocks, spec } = sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
    assert.equal(spec, null, `${name}:模型沒照 0–1000 規格(防呆有動作了)`);
    assert.equal(blocks.length, fx.blocks.length, `${name}:不該掉塊`);
    for (const b of blocks) {
      const [y0, x0, y1, x1] = b.box;
      assert.ok(y1 > y0 && x1 > x0, `${name}:框不成矩形`);
      assert.ok(x1 <= 1000 && y1 <= 1000, `${name}:框超出座標空間`);
    }
  }
});

test('真實輸出:繞圖的小圖全部落錨點,放大檢視才鋪開成疊字', () => {
  // 部落格情境:2042px 的截圖縮在 340px 的繞圖欄位裡
  const small = split('lite-shot', 340);
  assert.equal(small.veil, 0, `340px 下不該有疊字(最大字級 ${small.maxFs.toFixed(1)}px)`);
  assert.ok(small.maxFs < 11, '連最大的一塊都讀不動');

  // 放大檢視:同一份資料,不重問模型
  const big = split('lite-shot', 1200);
  assert.ok(big.veil > 10, `放大後要鋪開成疊字,實際只有 ${big.veil} 塊`);
  assert.ok(big.pin > 0, '最小的那些字放大了還是該留錨點');
});

test('真實輸出:字大的圖表在行內就疊得起來', () => {
  const chart = split('lite-chart', 1020);
  assert.ok(chart.veil > 0, '圖表的標題該疊字');
  assert.ok(chart.maxFs > 11, '字大的圖不該整張落錨點');
});

test('真實輸出:面積項吸收兩個檔位的框粒度差異', () => {
  /*
   * gemma 把整張小卡合併成一塊(35 塊),lite 拆到欄位層級(53 塊)。
   * 兩者的字級上限要落在同一個量級 —— 面積項就是為這件事加的。
   * 少了它,gemma 的合併框會爆出一根 100px 的巨柱(mockup 第一版)。
   */
  const g = split('gemma-shot', 1200);
  const l = split('lite-shot', 1200);
  assert.ok(g.maxFs <= 40 && l.maxFs <= 40, '都不該超過上限');
  assert.ok(Math.abs(g.maxFs - l.maxFs) < 15, `兩檔的字級量級差太多:${g.maxFs} vs ${l.maxFs}`);
});
