import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOX_SCALE,
  MIN_PATCH_FONT_PX,
  SINGLE_LINE_CHARS,
  worthAnnotating,
  fontSizeFor,
  looksConcatenated,
  looksVertical,
  normalizeBoxes,
  PLATE_BUDGET,
  TEXT_HEAVY_BLOCKS,
  platesOverlap,
  plateSize,
  sanitizeBlocks,
} from '../src/shared/imageblocks.ts';
import {
  drawnRect,
  mapBox,
  parsePosition,
  placeBlocks,
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

test('字級有地板 —— 框縮小的時候字不跟著縮,貼片因此長出框外', () => {
  /*
   * 這是預算規則會動的原因(§13-9):圖縮小的時候框跟著縮、字不跟著縮,
   * 所以同一塊在縮圖上佔掉的畫面比例**比放大檢視大**。
   * 貼片的尺寸要用**渲染時**的字級算,不是「塞得進框裡的」那個。
   */
  const chars = 2;
  const small = fontSizeFor(340 * 0.03, 340 * 0.018, chars);
  const large = fontSizeFor(1200 * 0.03, 1200 * 0.018, chars);
  assert.ok(small < MIN_PATCH_FONT_PX, '縮圖上塞不進去,會被地板頂起來');
  assert.ok(large > small);
  assert.equal(plateSize('小字', small).fs, MIN_PATCH_FONT_PX, '地板沒生效');
  assert.ok(plateSize('小字', large).fs > MIN_PATCH_FONT_PX);
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
/** 一份真實回應在某個顯示寬度下:畫幾塊、還剩幾塊、最大的字級 */
function split(name: string, displayW: number): { drawn: number; left: number; maxFs: number } {
  const fx = loadVision(name);
  const { blocks } = sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const H = (displayW * fx.nh) / fx.nw;
  const rect = drawnRect({ w: fx.nw, h: fx.nh }, { w: displayW, h: H }, 'contain', parsePosition('50% 50%'));
  const out = placeBlocks(blocks, rect, { w: displayW, h: H });
  let maxFs = 0;
  for (const b of blocks) {
    const [y0, x0, y1, x1] = b.box;
    maxFs = Math.max(
      maxFs,
      fontSizeFor(((x1 - x0) / 1000) * displayW, ((y1 - y0) / 1000) * H, [...(b.zh || b.text)].length, b.v),
    );
  }
  return { drawn: out.placed.length, left: out.left, maxFs };
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

test('真實輸出:密集截圖行內不畫,放大檢視才畫', () => {
  /*
   * 使用者的話:「前幾輪有些不需要翻的都扣掉了 還一堆量的話
   * 這張圖應該算是不要翻才是」。lite-shot 扣完還有 47 塊 —— 那是文件不是圖。
   */
  const small = split('lite-shot', 340);
  assert.equal(small.drawn, 0, '行內不該畫');
  assert.ok(small.left >= TEXT_HEAVY_BLOCKS, `扣完剩 ${small.left} 塊,沒有到「文件」的量`);

  // 放大檢視:同一份資料,不重問模型,預算換算出來放得下十幾塊
  const big = split('lite-shot', 1200);
  assert.ok(big.drawn > 5, `放大後要畫得出東西,實際只有 ${big.drawn} 塊`);
  assert.ok(big.left > 0, '密集素材放大之後也不該整張塞滿');
});

test('真實輸出:字大的圖表在行內就畫得完', () => {
  const chart = split('lite-chart', 1020);
  assert.ok(chart.drawn > 0, '圖表的標題該畫');
  assert.equal(chart.left, 0, '稀疏的圖表不該有塊放不下');
  assert.ok(chart.maxFs > 11, '字大的圖不該被當成密集素材');
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

/* ------------------------------------------------- 區塊 → 畫得出來的東西 */

test('placeBlocks:同一份資料兩個尺寸,語彙**不會**翻面 —— 只是放得下的變多', () => {
  /*
   * 舊規則(多數決)在這裡整張翻面:340px 全錨點、1200px 全疊字。
   * 使用者的回報是「兩張很像的圖 一個是疊字 一個是標註」——
   * 而錨點退場之後(§DW),尺寸只影響**放得下幾塊**,不影響語彙。
   */
  const fx = loadVision('gemma-chart');
  const { blocks } = sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const at = (W: number) => {
    const H = (W * fx.nh) / fx.nw;
    const drawn = drawnRect({ w: fx.nw, h: fx.nh }, { w: W, h: H }, 'contain', parsePosition('50% 50%'));
    return placeBlocks(blocks, drawn, { w: W, h: H });
  };
  const small = at(340);
  const big = at(1200);
  assert.equal(small.why, 'ok');
  assert.equal(big.why, 'ok');
  assert.ok(small.placed.length > 0, '縮圖上也該畫得出最大的那一塊');
  assert.ok(big.placed.length >= small.placed.length, '放大之後放得下的只會變多');
  assert.equal(small.placed.length + small.left, big.placed.length + big.left, '兩邊的候選總數要一樣');
});

test('placeBlocks:大的先進來 —— 框的大小就是版面標好的重要性', () => {
  /*
   * 預算裝不下全部的時候,要留下的是**大的那一塊**。
   * 字級是版面自己標好的重要性,而使用者說過「像這張圖 可能只有標題需要翻」。
   */
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 400, h: 400 }, 'contain', parsePosition('50% 50%'));
  const out = placeBlocks(
    [
      { box: [300, 0, 310, 60], text: 'tiny a', zh: '小甲', c: 1 },
      { box: [0, 0, 200, 500], text: 'big', zh: '大字', c: 1 },
      { box: [400, 0, 410, 60], text: 'tiny b', zh: '小乙', c: 1 },
    ],
    drawn,
    { w: 400, h: 400 },
  );
  assert.equal(out.placed[0]!.zh, '大字', '最大的那一塊沒有排在最前面');
  assert.equal(out.placed.length + out.left, 3, '塊數要守恆');
});

test('placeBlocks:預算是硬的 —— 貼片總面積不會超過 PLATE_BUDGET', () => {
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 600, h: 600 }, 'contain', parsePosition('50% 50%'));
  const many = Array.from({ length: 20 }, (_, i) => ({
    box: [i * 45, 0, i * 45 + 40, 900] as [number, number, number, number],
    text: `heading ${i}`,
    zh: `第 ${i} 個很長的標題文字`,
    c: 1,
  }));
  const out = placeBlocks(many, drawn, { w: 600, h: 600 });
  const used = out.placed.reduce((n, p) => {
    const pl = plateSize(p.zh, p.fontPx);
    return n + (pl.w * pl.h) / (600 * 600);
  }, 0);
  assert.ok(used <= PLATE_BUDGET + 1e-9, `超出預算:${(used * 100).toFixed(1)}%`);
  assert.ok(out.left > 0, '二十塊長標題不可能全部進得來');
});

test('placeBlocks:選上的貼片彼此不重疊 —— 面積便宜不代表畫得下', () => {
  /*
   * 比較稿一畫出來就看到:長標籤在字級地板上又寬又薄,面積很便宜,
   * 卻橫著壓過旁邊兩塊(§13-9-ter)。面積管總量,重疊管互壓,兩個都要。
   */
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 'contain', parsePosition('50% 50%'));
  const stacked = Array.from({ length: 6 }, (_, i) => ({
    box: [400 + i * 6, 100, 406 + i * 6, 900] as [number, number, number, number],
    text: `row ${i}`,
    zh: `這是一行相當長的說明文字第 ${i} 行`,
    c: 1,
  }));
  const out = placeBlocks(stacked, drawn, { w: 800, h: 800 });
  for (let i = 0; i < out.placed.length; i++) {
    for (let j = i + 1; j < out.placed.length; j++) {
      const a = out.placed[i]!;
      const b = out.placed[j]!;
      const pa = plateSize(a.zh, a.fontPx);
      const pb = plateSize(b.zh, b.fontPx);
      const box = (p: typeof a, s: typeof pa) => ({
        x: p.x + p.w / 2 - s.w / 2,
        y: p.y + p.h / 2 - s.h / 2,
        w: s.w,
        h: s.h,
      });
      assert.equal(platesOverlap(box(a, pa), box(b, pb)), false, '選上的兩片貼片壓在一起');
    }
  }
});

test('placeBlocks:扣完還一大堆 = 這是文件不是圖,行內不畫', () => {
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 600, h: 600 }, 'contain', parsePosition('50% 50%'));
  const doc = Array.from({ length: TEXT_HEAVY_BLOCKS + 3 }, (_, i) => ({
    box: [i * 20, 0, i * 20 + 15, 300] as [number, number, number, number],
    text: `line ${i}`,
    zh: `第 ${i} 行`,
    c: 1,
  }));
  const inline = placeBlocks(doc, drawn, { w: 600, h: 600 });
  assert.equal(inline.why, 'text-heavy');
  assert.equal(inline.placed.length, 0, '行內不該畫');
  assert.equal(inline.left, TEXT_HEAVY_BLOCKS + 3, '要說得出還有幾塊');

  // 放大檢視畫得下,而且是使用者自己點開的
  const wide = drawnRect({ w: 1000, h: 1000 }, { w: 1200, h: 1200 }, 'contain', parsePosition('50% 50%'));
  const zoom = placeBlocks(doc, wide, { w: 1200, h: 1200 });
  assert.equal(zoom.why, 'ok');
  assert.ok(zoom.placed.length > 0, '放大檢視也不畫的話,那些字就永遠讀不到了');
});


test('疊字模式下塞不下的那幾塊把字級拉到下限,框不動', () => {
  /*
   * 譯文有自己的貼片(overlay 的 `.itx`),寬度由字決定、允許長出框外
   * (§3.2)。所以玻璃該蓋的只有原文那一塊 —— 撐大玻璃會蓋掉旁邊
   * 本來看得到的圖。
   */
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 600, h: 600 }, 'contain', parsePosition('50% 50%'));
  const blocks = [
    { box: [0, 0, 120, 600], text: 'a', zh: '標題一', c: 1 },
    { box: [200, 0, 320, 600], text: 'b', zh: '標題二', c: 1 },
    { box: [400, 0, 520, 600], text: 'c', zh: '標題三', c: 1 },
    { box: [600, 0, 720, 600], text: 'd', zh: '標題四', c: 1 },
    // 這一塊自己算是塞不下的
    { box: [900, 0, 906, 40], text: 'N/A', zh: '不適用', c: 1 },
  ];
  const placed = placeBlocks(blocks, drawn, { w: 600, h: 600 }).placed;
  const small = placed.find((p) => p.zh === '不適用')!;
  assert.equal(small.fontPx, MIN_PATCH_FONT_PX, '字級要拉到下限');
  assert.ok(small.h < 10, `框被撐大了:${small.h}`);
  assert.ok(small.w < 30, `框被撐寬了:${small.w}`);
});

test('譯完等於沒譯就不要蓋上去', () => {
  /*
   * **使用者原話**:「數字 跟確定不翻的英文 可以直接不疊上去了 ——
   * 如果知道翻之前跟翻之後是一樣的,疊了沒意思」。
   *
   * blog.google 一張 bar chart 實測 18 個加註,只有標題、副標、
   * 「越低越好」三塊真的翻了;其餘 15 塊譯文和原文一模一樣 ——
   * 蓋住原圖,而且蓋得比原文糊。
   */
  assert.equal(worthAnnotating('469 GB', '469 GB'), false);
  assert.equal(worthAnnotating('Elasticsearch', 'Elasticsearch'), false);
  assert.equal(worthAnnotating('Deepgram Nova-3', 'Deepgram Nova-3'), false);
  // 大小寫與空白的差別不算「翻了」
  assert.equal(worthAnnotating('ClickHouse', 'clickhouse'), false);
  assert.equal(worthAnnotating('Storage  size', 'Storage size'), false);
  // 全形空白也要壓掉 —— 模型很愛加
  assert.equal(worthAnnotating('469 GB', '469\u3000GB'), false);
});

test('純數字與符號本來就不用翻 —— 模型硬要加東西也不算', () => {
  /*
   * 這一條擋的不是「譯完一樣」,是「模型自己加了原文沒有的東西」:
   * `2024` → `2024年` 是它在補上下文,而軸標籤上那個字是噪音。
   */
  assert.equal(worthAnnotating('15.77%', '15.77%'), false);
  assert.equal(worthAnnotating('2024', '2024年'), false);
  assert.equal(worthAnnotating('20%', '百分之二十'), false);
  assert.equal(worthAnnotating('→', '箭頭'), false);
  assert.equal(worthAnnotating('', ''), false);
});

test('數字加單位不用翻 —— 「5x」換到一個字,付出的是蓋掉整個數字', () => {
  /*
   * **使用者原話**:「像這個 5x 4x 其實也不用翻了」。
   *
   * `5x` → `5倍` 確實不同,所以「譯完等於沒譯」那條抓不到。但它換到的
   * 是一個字,而付出的是把整個數字蓋掉 —— 數字本來就是跨語言的。
   */
  assert.equal(worthAnnotating('5x', '5倍'), false);
  assert.equal(worthAnnotating('4x', '4倍'), false);
  assert.equal(worthAnnotating('25GB', '25 GB'), false);
  assert.equal(worthAnnotating('100ms', '100 毫秒'), false);
  assert.equal(worthAnnotating('5G', '5G 網路'), false);
});

test('界線畫在字母數 —— 有字的句子照翻', () => {
  /*
   * 這條規則最危險的失敗方向是吃掉正常的譯文,所以界線要看得見:
   * 字母 ≤ 2 而且有數字才算「數字加單位」。
   */
  assert.equal(worthAnnotating('5 tips', '五個訣竅'), true, '4 個字母,是句子');
  assert.equal(worthAnnotating('Top 10', '前 10 名'), true, '3 個字母');
  assert.equal(worthAnnotating('19 times smaller', '縮小 19 倍'), true);
  // 沒有數字的短字不套這條 —— 交給「譯完等於沒譯」判斷
  assert.equal(worthAnnotating('AI', '人工智慧'), true);
  assert.equal(worthAnnotating('OK', 'OK'), false, '這個是靠「譯完一樣」擋掉的');
});

test('真的翻了就要蓋 —— 這條規則不可以吃掉正常的譯文', () => {
  assert.equal(worthAnnotating('Storage size', '儲存空間大小'), true);
  assert.equal(worthAnnotating('Lower is better', '越低越好'), true);
  // 帶數字的句子照翻:有字母而且譯文不同
  assert.equal(worthAnnotating('19 times smaller', '縮小 19 倍'), true);
  assert.equal(worthAnnotating('FLEURS (top region)*', 'FLEURS(頂端區域)*'), true);
});

test('placeBlocks 會把不用翻的塊整個略過', () => {
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 'contain', parsePosition('50% 50%'));
  const placed = placeBlocks(
    [
      { box: [0, 0, 100, 400], text: 'Storage size', zh: '儲存空間大小', c: 1 },
      { box: [200, 0, 300, 400], text: '469 GB', zh: '469 GB', c: 1 },
      { box: [400, 0, 500, 400], text: 'Elasticsearch', zh: 'Elasticsearch', c: 1 },
      { box: [600, 0, 700, 400], text: '15.77%', zh: '15.77%', c: 1 },
    ],
    drawn,
    { w: 800, h: 800 },
  ).placed;
  assert.deepEqual(placed.map((p) => p.zh), ['儲存空間大小']);
});

test('不用翻的塊也不參與「整張圖用哪種語彙」的投票', () => {
  /*
   * 略過的塊沒有畫任何東西,讓它們影響形式的選擇沒有道理 ——
   * 而且它們通常很小(數值標籤),會把整張圖投向錨點。
   */
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 'contain', parsePosition('50% 50%'));
  const tiny = Array.from({ length: 6 }, (_, i) => ({
    box: [900 + i, 0, 903 + i, 20] as [number, number, number, number],
    text: `${i}%`,
    zh: `${i}%`,
    c: 1,
  }));
  const placed = placeBlocks(
    [
      { box: [0, 0, 120, 500], text: 'Storage size', zh: '儲存空間大小', c: 1 },
      { box: [200, 0, 320, 500], text: 'Lower is better', zh: '越低越好', c: 1 },
      ...tiny,
    ],
    drawn,
    { w: 800, h: 800 },
  ).placed;
  assert.equal(placed.length, 2, '略過的塊不該出現');
});

test('短標籤走單行 —— 「不適用」不可以被折成兩行', () => {
  /*
   * 使用者回報:「圖中間那個不適用 如果真的太小 應該加長 label 不要折字」。
   * 折行的判斷在 overlay(貼片才知道自己多寬),這裡釘住那條界線本身:
   * 標籤長度 ≤ SINGLE_LINE_CHARS 就是「標籤」,不是句子。
   */
  assert.ok([...'不適用'].length <= SINGLE_LINE_CHARS);
  assert.ok([...'Elasticsearch ESQL 查詢'].length > SINGLE_LINE_CHARS, '整句還是該折');
});

test('code 樣式的字不加註 —— 程式碼原樣留著才有用', () => {
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 'contain', parsePosition('50% 50%'));
  const placed = placeBlocks(
    [
      { box: [0, 0, 100, 400], text: 'npm install', zh: 'npm install', c: 1, kind: 'code' },
      { box: [200, 0, 300, 400], text: 'Install it', zh: '安裝它', c: 1 },
    ],
    drawn,
    { w: 800, h: 800 },
  ).placed;
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.zh, '安裝它');
});

test('低信心標記傳到畫面上 —— 使用者要知道哪一塊該自己看原圖', () => {
  const drawn = drawnRect({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 'contain', parsePosition('50% 50%'));
  const placed = placeBlocks(
    [{ box: [0, 0, 100, 400], text: 'x', zh: '疑問', c: 0.4 }],
    drawn,
    { w: 800, h: 800 },
  ).placed;
  assert.equal(placed[0]!.low, true);
});

test('被 cover 裁掉的區塊不畫 —— 使用者看不到的地方不該冒出加註', () => {
  const drawn = drawnRect({ w: 1000, h: 500 }, { w: 400, h: 400 }, 'cover', parsePosition('50% 50%'));
  const placed = placeBlocks(
    [
      { box: [400, 0, 500, 40], text: 'cut', zh: '被裁掉', c: 1 },
      { box: [400, 450, 500, 550], text: 'mid', zh: '中間', c: 1 },
    ],
    drawn,
    { w: 400, h: 400 },
  ).placed;
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.zh, '中間');
});


/* --------------------------------------------------------------- 直排偵測 */

test('直排的框又高又窄且是 CJK → 標低信心(兩檔模型都讀壞)', () => {
  /*
   * 實測(§13-4):「秋の特別展示」被讀成「秋祭」、
   * 「開催期間 十月一日から」被讀成「興展兼囊」——
   * 模型把直排當橫排讀,字跨欄串起來。而且**沒有一塊回 v: true**。
   *
   * 但它有給別的訊號:c 掉到 0.5–0.9,加上框的形狀(實測 204×15)。
   * 兩個合起來就能標出來 —— 不靜默做錯。
   */
  const { blocks } = sanitizeBlocks([
    { box: [94, 381, 298, 396], text: '開催ただし(税場盟', zh: '舉辦，但是', c: 0.9 },
  ]);
  assert.equal(blocks[0]!.v, true, '沒認出直排');
  assert.ok(blocks[0]!.c <= 0.5, '直排要標低信心');
});

test('又高又窄但不是 CJK → 不算直排(側邊欄標籤那種)', () => {
  const { blocks } = sanitizeBlocks([
    { box: [100, 10, 400, 40], text: 'SIDEBAR', zh: '側邊欄', c: 1 },
  ]);
  assert.notEqual(blocks[0]!.v, true);
  assert.equal(blocks[0]!.c, 1);
});

test('正常的橫排 CJK 不會被誤判成直排', () => {
  const { blocks } = sanitizeBlocks([
    { box: [100, 100, 130, 500], text: '台風18号 鹿児島', zh: '颱風18號 鹿兒島', c: 1 },
  ]);
  assert.notEqual(blocks[0]!.v, true);
  assert.equal(blocks[0]!.c, 1);
});

/* ── 只翻大字的問法(§DS-2) ─────────────────────────────────── */

test('brief 的 prompt 要說得出上限與挑法 —— 逾時的唯一出路', async () => {
  /*
   * 逾時是輸出太長造成的(實測 ~2.3 秒一塊,100 秒 = 43 塊),
   * 所以重試必須**問得比較少**才回得來。挑「最大的」不是「前 N 個」:
   * 字級就是版面自己標好的重要性。
   */
  const { visionPrompt, BRIEF_BLOCKS } = await import('../src/worker/visionprompt.ts');
  const full = visionPrompt('zh-TW');
  const brief = visionPrompt('zh-TW', [], true);
  assert.equal(full.includes(String(BRIEF_BLOCKS)), false, '完整版不該有上限');
  assert.ok(brief.includes(String(BRIEF_BLOCKS)), 'brief 沒說上限是多少');
  assert.ok(/字級/.test(brief), 'brief 沒說用什麼挑');
  assert.ok(brief.length > full.length);
});
