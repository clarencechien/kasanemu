/*
 * 在真的瀏覽器裡驗圖片加註的渲染(`docs/plan-images.md` §15)。
 *
 * jsdom 沒有 layout,而圖片加註**整個都是幾何**:object-fit 的換算、
 * 字級分流、錨點位置、疊層落在文件座標的哪裡。這些在 node 測試裡
 * 一律回 0,所以只能在瀏覽器裡量。
 *
 *   node scripts/probe-image.mjs
 *
 * 用的是 production 的 `imagegeo.ts` 與 `overlay.ts`(esbuild 打包),
 * 不在這裡另寫一份 —— §DF 學到的那件事。
 * playwright 沒裝就跳過,不擋 npm run check。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('略過:沒有 playwright');
  process.exit(0);
}

const out = mkdtempSync(path.join(tmpdir(), 'ksnm-'));
const entry = path.join(out, 'entry.ts');
writeFileSync(
  entry,
  `export * from '${path.join(root, 'src/content/imagegeo.ts')}';\n` +
    `export { hasNativeZoom, geometryOf, ImageAnnotator } from '${path.join(root, 'src/content/imageanno.ts')}';\n` +
    `export { sanitizeBlocks } from '${path.join(root, 'src/shared/imageblocks.ts')}';\n` +
    `export { OverlayLayer, HOST_ID } from '${path.join(root, 'src/content/overlay.ts')}';\n`,
);
const bundle = path.join(out, 'geo.js');
execFileSync(
  'npx',
  ['esbuild', entry, '--bundle', '--format=iife', '--global-name=IG',
   '--footer:js=globalThis.IG=IG;', `--outfile=${bundle}`],
  { stdio: 'inherit' },
);

/** 真實模型輸出當素材 —— 手寫的框驗不到「模型實際會給什麼」 */
const fixture = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/vision/lite-shot.json'), 'utf8'),
);
/*
 * 第二份素材是**圖表**,因為兩種素材驗的是不同的事:
 * 密集截圖(lite-shot,53 塊小字)驗「整張走錨點」,
 * 圖表(gemma-chart,7 塊大字)驗「放大之後整張翻成疊字」。
 * 只用截圖驗不到翻面 —— 它在任何尺寸下都該是錨點。
 */
const chart = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/vision/gemma-chart.json'), 'utf8'),
);

const page = `<!doctype html><meta charset=utf-8>
<style>
  body { margin: 0; font: 16px system-ui; }
  .pad { height: 400px; }
  figure { margin: 0 0 40px; }
  /* 三種 object-fit 各一個:換算錯了會在這裡現形 */
  #plain { width: 700px; height: 530px; }
  #cover { width: 400px; height: 400px; object-fit: cover; object-position: 50% 50%; }
  #contain { width: 500px; height: 500px; object-fit: contain; object-position: left top; }
</style>
<div class="pad">捲動占位:加註要在文件座標裡,跟著頁面捲</div>
<figure><img id="plain" src="IMG"></figure>
<figure><img id="cover" src="IMG"></figure>
<figure><img id="contain" src="IMG"></figure>

<!-- 站方自己的放大檢視:四種寫法,認得出來就不出我們的入口(§2.4) -->
<!-- ClickHouse 的實際寫法:透明按鈕蓋在圖上 -->
<figure style="position:relative;width:300px">
  <img id="zoom-btn" src="IMG" style="width:300px">
  <button style="position:absolute;inset:0;cursor:zoom-in;opacity:0"></button>
</figure>
<!-- WordPress / 相簿外掛:連到圖片檔 -->
<figure><a href="/photo-large.jpg"><img id="zoom-link" src="IMG" style="width:300px"></a></figure>
<!-- react-medium-image-zoom -->
<figure data-rmiz><img id="zoom-rmiz" src="IMG" style="width:300px"></figure>
<!-- 圖片自己是 zoom-in -->
<figure><img id="zoom-self" src="IMG" style="width:300px;cursor:zoom-in"></figure>
<!-- 反例:一般的內文圖,沒有站方入口 → 我們要出 -->
<figure><a href="/article/next"><img id="zoom-none" src="IMG" style="width:300px"></a></figure>
`;

const exe = process.env['PLAYWRIGHT_BROWSERS_PATH']
  ? path.join(process.env['PLAYWRIGHT_BROWSERS_PATH'], 'chromium')
  : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const p = await ctx.newPage();
await p.addInitScript({ content: readFileSync(bundle, 'utf8') });

// 一張和 fixture 同尺寸的假圖(內容不重要,幾何才重要)
const png = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${fixture.nw}" height="${fixture.nh}"><rect width="100%" height="100%" fill="#ddd"/></svg>`,
).toString('base64')}`;
/*
 * 寫成檔案再 goto,不用 setContent —— `addInitScript` 掛在導覽上,
 * 而 setContent 不算一次導覽,注入的腳本不會生效(踩過一次)。
 */
const html = path.join(out, 'probe.html');
writeFileSync(html, page.replaceAll('IMG', png));
/*
 * overlay.ts 會叫 `chrome.runtime.getURL` 取打包的字型。
 * 頁面裡沒有擴充 API,補一個最小的殼 —— 字型載不到不影響幾何,
 * 而幾何正是這支 probe 要驗的東西。
 */
await p.addInitScript({
  content: `globalThis.chrome = { runtime: { getURL: (x) => 'about:blank#' + x } };`,
});
await p.goto('file://' + html);
await p.waitForLoadState('load');

const got = await p.evaluate((fx) => {
  const { blocks } = IG.sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const report = {};
  for (const id of ['plain', 'cover', 'contain']) {
    const img = document.getElementById(id);
    const cs = getComputedStyle(img);
    const r = img.getBoundingClientRect();
    const clip = { w: r.width, h: r.height };
    const drawn = IG.drawnRect(
      { w: img.naturalWidth, h: img.naturalHeight },
      clip,
      cs.objectFit || 'fill',
      IG.parsePosition(cs.objectPosition || '50% 50%'),
    );
    const placed = IG.placeBlocks(blocks, drawn, clip);
    report[id] = {
      display: `${Math.round(r.width)}x${Math.round(r.height)}`,
      fit: cs.objectFit,
      drawn: `${Math.round(drawn.w)}x${Math.round(drawn.h)} @${Math.round(drawn.x)},${Math.round(drawn.y)}`,
      total: placed.length,
      veil: placed.filter((b) => b.kind === 'veil').length,
      pin: placed.filter((b) => b.kind === 'pin').length,
      // 每一塊都要落在圖的範圍內 —— 超出去就是加註畫到圖外面
      outside: placed.filter(
        (b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > clip.w + 0.5 || b.y + b.h > clip.h + 0.5,
      ).length,
      maxFont: Math.round(Math.max(0, ...placed.map((b) => b.fontPx)) * 10) / 10,
      // 文件座標:加著捲動位移才對得上
      docTop: Math.round(r.top + window.scrollY),
    };
  }
  report._zoom = {};
  for (const id of ['zoom-btn', 'zoom-link', 'zoom-rmiz', 'zoom-self', 'zoom-none']) {
    report._zoom[id] = IG.hasNativeZoom(document.getElementById(id));
  }
  return report;
}, fixture);

const problems = [];
console.log(JSON.stringify(got, null, 1));

const zoom = got._zoom;
delete got._zoom;
console.log('站方 lightbox 偵測:', JSON.stringify(zoom));
for (const id of ['zoom-btn', 'zoom-link', 'zoom-rmiz', 'zoom-self']) {
  if (!zoom[id]) problems.push(`${id}:沒認出站方的放大檢視 → 會出兩顆意思一樣的按鈕`);
}
if (zoom['zoom-none']) problems.push('zoom-none:誤判成站方有 lightbox → 我們的入口不會出現');

for (const [id, r] of Object.entries(got)) {
  if (r.total === 0) problems.push(`${id}:一塊都沒放上去`);
  if (r.outside > 0) problems.push(`${id}:${r.outside} 塊畫到圖外面`);
  if (r.maxFont > 40) problems.push(`${id}:字級 ${r.maxFont} 超過上限`);
}
/*
 * **一張圖只能有一種語彙**(使用者原話:「一下有疊字 一下註解 不太統一」)。
 * 逐塊判斷每一塊單看都對,合起來卻是兩套視覺語言插在同一張圖上。
 */
for (const [id, r] of Object.entries(got)) {
  if (r.veil > 0 && r.pin > 0) {
    problems.push(`${id}:同一張圖上疊字 ${r.veil} 塊、錨點 ${r.pin} 塊 —— 兩種語彙混用`);
  }
}
// lite-shot 是密集截圖:53 塊小字,任何行內尺寸都該整張走錨點
if (got.plain.veil > 0) problems.push('plain:密集截圖被硬塞成疊字了');
// cover 會裁掉兩側,所以放上去的塊**必然比 contain 少**
if (got.cover.total >= got.contain.total) {
  problems.push(`cover 沒有裁掉任何東西(${got.cover.total} vs contain ${got.contain.total})`);
}

// 捲動之後文件座標不變 —— 疊層跟著瀏覽器捲,不是 JS 追
await p.evaluate(() => window.scrollTo(0, 300));
const after = await p.evaluate(() => {
  const r = document.getElementById('plain').getBoundingClientRect();
  return Math.round(r.top + window.scrollY);
});
if (after !== got.plain.docTop) {
  problems.push(`捲動後文件座標變了:${got.plain.docTop} → ${after}`);
}

/*
 * 渲染路徑:單元測試碰不到 OverlayLayer(closed shadow root + 真幾何)。
 * 這裡把它裝起來,畫一張圖與一次放大檢視,再從外面驗它畫了什麼。
 */
const render = await p.evaluate(([fx, cx]) => {
  /*
   * shadow root 是 closed 的,所以從外面看不進去 —— 但這裡要驗的正是
   * **裡面畫了什麼**(貼片有沒有字、清單有沒有列)。攔 attachShadow 拿到
   * 那個 root:動的是 probe 這一側,production 不必為了被驗而開後門。
   */
  const real = Element.prototype.attachShadow;
  let shadow = null;
  Element.prototype.attachShadow = function (init) {
    const r = real.call(this, { ...init, mode: 'open' });
    shadow = r;
    return r;
  };
  const { blocks } = IG.sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const chartBlocks = IG.sanitizeBlocks(cx.blocks, cx.nw, cx.nh).blocks;
  const layer = new IG.OverlayLayer();
  layer.setVeilStrength(0.3);

  const img = document.getElementById('plain');
  const g = IG.geometryOf(img);
  const placed = IG.placeBlocks(blocks, g.drawn, g.clip);
  layer.showImage(g.rect, placed);

  /*
   * 滑鼠穿透是硬規則,而它有**兩半**,兩半都要驗:
   * 加註畫上去之後仍然點得到底下的頁面;放大檢視開著時反而要擋住
   * (那是整層唯一的例外,理由見 overlay.ts 的 `.zoom`)。
   */
  const hitAt = () => {
    const r = img.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === img;
  };
  const throughWithAnno = hitAt();

  // 放大檢視:同一份區塊、換個尺寸重算 —— 整張要從錨點翻成疊字
  const holder = layer.showZoom(img.currentSrc, { w: fx.nw, h: fx.nh });
  const zr = holder.getBoundingClientRect();
  const zdrawn = IG.drawnRect({ w: fx.nw, h: fx.nh }, { w: zr.width, h: zr.height },
    'contain', { x: { pct: 0.5 }, y: { pct: 0.5 } });
  const zplaced = IG.placeBlocks(blocks, zdrawn, { w: zr.width, h: zr.height });
  layer.setZoomBlocks(zplaced);

  /*
   * 翻面用圖表那份量:密集截圖在放大檢視裡**仍然**該是錨點
   * (1040px 上 53 塊小字硬疊只會糊成一片,那正是 mockup 階段否決的樣子)。
   */
  const cSmall = IG.placeBlocks(
    chartBlocks,
    IG.drawnRect({ w: cx.nw, h: cx.nh }, { w: 340, h: (340 * cx.nh) / cx.nw },
      'contain', { x: { pct: 0.5 }, y: { pct: 0.5 } }),
    { w: 340, h: (340 * cx.nh) / cx.nw },
  );
  const cBig = IG.placeBlocks(
    chartBlocks,
    IG.drawnRect({ w: cx.nw, h: cx.nh }, { w: zr.width, h: (zr.width * cx.nh) / cx.nw },
      'contain', { x: { pct: 0.5 }, y: { pct: 0.5 } }),
    { w: zr.width, h: (zr.width * cx.nh) / cx.nw },
  );

  /*
   * 錨點貼片:規格 §2.3 的「hover pin 出貼片」。
   * 這一段以前根本不存在,而**沒有任何測試會發現** —— 圓點畫得好好的,
   * 只是點下去什麼都沒有。所以這裡直接問 DOM 有沒有那片貼片、上面有沒有字。
   */
  const firstPin = zplaced.find((b) => b.kind === 'pin') ?? placed.find((b) => b.kind === 'pin');
  layer.setActivePin(firstPin ? firstPin.n : 0, firstPin);
  const popEl = shadow?.querySelector('.ipop');
  const popText = popEl?.textContent ?? '';
  layer.setActivePin(0);
  const popGone = shadow?.querySelector('.ipop') === null;

  // 註解清單:錨點標位置,清單給字。少了它,放大檢視還是 53 個圓點
  const rows = shadow?.querySelectorAll('.zrow').length ?? 0;
  const hasList = shadow?.querySelector('.zoom')?.classList.contains('haslist') ?? false;

  Element.prototype.attachShadow = real;
  // 從 host 外面能看到的只有它存在;內部要靠 layer 自己回報
  return {
    popText,
    popHasZh: firstPin ? popText.includes(firstPin.zh) : false,
    popGone,
    rows,
    hasList,
    pinCount: zplaced.filter((b) => b.kind === 'pin').length,
    inlineVeil: placed.filter((b) => b.kind === 'veil').length,
    inlinePin: placed.filter((b) => b.kind === 'pin').length,
    zoomVeil: zplaced.filter((b) => b.kind === 'veil').length,
    zoomPin: zplaced.filter((b) => b.kind === 'pin').length,
    chartSmallVeil: cSmall.filter((b) => b.kind === 'veil').length,
    chartSmallPin: cSmall.filter((b) => b.kind === 'pin').length,
    chartBigVeil: cBig.filter((b) => b.kind === 'veil').length,
    chartBigPin: cBig.filter((b) => b.kind === 'pin').length,
    zoomSize: layer.zoomSize(),
    imageVisible: layer.imageVisible(),
    zoomVisible: layer.zoomVisible(),
    throughWithAnno,
    blockedWhileZoom: !hitAt(),
    throughAfterClose: (layer.hideZoom(), hitAt()),
  };
}, [fixture, chart]);
console.log('渲染:', JSON.stringify(render));

if (!render.imageVisible) problems.push('showImage 之後圖層沒顯示');
if (!render.zoomVisible) problems.push('showZoom 之後放大檢視沒顯示');
if (!render.throughWithAnno) problems.push('加註擋住了滑鼠 —— 圖上點不到底下的頁面');
if (!render.blockedWhileZoom) problems.push('放大檢視開著卻沒擋住點擊 —— 會點到底下的頁面');
if (!render.throughAfterClose) problems.push('關掉放大檢視之後滑鼠還是穿不過去');
// §2.3「hover pin 出貼片」—— 這一段以前沒實作,而圓點照樣畫得好好的
if (!render.popHasZh) {
  problems.push(`錨點沒有出貼片,或貼片上沒有譯文:「${render.popText}」`);
}
if (!render.popGone) problems.push('滑開之後貼片沒有收掉');
// 錨點標位置,清單給字 —— 少了清單,放大檢視還是一堆讀不到的圓點
if (!render.hasList) problems.push('錨點模式的放大檢視沒有掛註解清單');
if (render.rows !== render.pinCount) {
  problems.push(`清單列數對不上錨點數:${render.rows} vs ${render.pinCount}`);
}
if (render.zoomVeil > 0 && render.zoomPin > 0) {
  problems.push('放大檢視裡混用了兩種語彙');
}
// 圖表:縮圖上整張錨點,放大之後整張翻成疊字(§2.3 的分流,作用域是整張圖)
if (render.chartSmallVeil > 0) problems.push('圖表縮圖上就疊字了 —— 340px 上放不下');
if (render.chartBigPin > 0) {
  problems.push(`放大之後圖表沒有整張翻成疊字(還剩 ${render.chartBigPin} 個錨點)`);
}

/*
 * 同 src 認親(§2.4):站方 lightbox 開出來的是**新元素、同一個 src**。
 * 沒有這一條的話,使用者點開黑窗會看到一張沒有加註的圖。
 */
const adopt = await p.evaluate((fx) => {
  const { blocks } = IG.sanitizeBlocks(fx.blocks, fx.nw, fx.nh);
  const calls = { show: 0, cue: 0 };
  const anno = new IG.ImageAnnotator(
    {
      request() {},
      showImage() { calls.show++; },
      hideImage() {},
      setActivePin() {},
      cue() { calls.cue++; },
      openZoom() { return null; },
      setZoomBlocks() {},
      closeZoom() {},
    },
    () => true,
    () => false,
  );
  const first = document.getElementById('plain');
  const url = first.currentSrc || first.src;
  anno.onResult(url, 'h', 'l0', blocks);

  // 站方 lightbox:插一個新的 <img>,同一個 src
  const clone = document.createElement('img');
  clone.src = first.src;
  clone.style.cssText = 'width:900px;height:681px';
  document.body.appendChild(clone);
  const adopted = anno.adopt(clone);

  // 反例:沒翻過的別張圖不該被認親
  const other = document.createElement('img');
  other.src = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>');
  other.style.cssText = 'width:800px;height:600px';
  document.body.appendChild(other);
  const wrong = anno.adopt(other);

  return { adopted, wrong, show: calls.show };
}, fixture);
console.log('同 src 認親:', JSON.stringify(adopt));
if (!adopt.adopted) problems.push('同 src 的新元素沒有被認親 —— lightbox 開出來會沒有加註');
if (adopt.wrong) problems.push('沒翻過的圖被誤認了');
if (adopt.show === 0) problems.push('認親了卻沒有畫');

/*
 * **滑鼠真的走得到那片 chip 嗎。**
 *
 * 使用者回報「點這裡放大讀是點哪裡 那個 tip 不能點」。實測那片 chip
 * 點得下去、action 也會觸發 —— 它是在滑鼠碰到之前就被自己刪掉了:
 * closed shadow root 把事件目標重定向成 host,`imageUnder()` 找不到 img,
 * 於是 `move()` 判定「離開圖片」把 cue 收掉(§DK)。
 *
 * 所以這一條**走完整段路**:滑到圖上 → 滑到 chip 上 → chip 還在嗎 →
 * 按下去 → 放大檢視開了嗎。中間任何一步斷掉,使用者拿到的都是
 * 「那個 tip 不能點」。
 */
const journey = await p.evaluate(async () => {
  const real = Element.prototype.attachShadow;
  let shadow = null;
  Element.prototype.attachShadow = function (init) {
    const r = real.call(this, { ...init, mode: 'open' });
    shadow = r;
    return r;
  };
  const layer = new IG.OverlayLayer();
  const img = document.getElementById('zoom-none').querySelector('img') ?? document.getElementById('plain');
  const r = img.getBoundingClientRect();
  let opened = 0;
  layer.onChipAction(() => { opened++; });
  layer.showChips([{
    text: '⤢ 點這裡放大讀 · 15 條註解',
    anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
    tone: 'l0',
    style: { background: '#101519', color: '#e6edf3', line: '#345', bar: '#48cbbe', fontSizePx: 12 },
    action: 'zoom',
  }]);
  const chip = shadow.querySelector('.chip');
  const cr = chip.getBoundingClientRect();
  const cx = cr.left + cr.width / 2;
  const cy = cr.top + cr.height / 2;
  // 疊層是 pointer-events:none,只有可按的 chip 例外 —— 這一點打得到嗎
  const hitsChip = document.elementFromPoint(cx, cy)?.id === IG.HOST_ID;
  // 而滑鼠停在 chip 上時,事件目標長什麼樣(這正是 move() 拿到的東西)
  const targetAtChip = document.elementFromPoint(cx, cy);
  const looksLikeImage = targetAtChip?.closest?.('img') != null;
  chip.click();
  Element.prototype.attachShadow = real;
  return { hitsChip, looksLikeImage, opened, chipW: Math.round(cr.width) };
}, null);
console.log('chip 可達性:', JSON.stringify(journey));
if (!journey.hitsChip) problems.push('可按的 chip 打不到 —— pointer-events 沒開');
if (journey.looksLikeImage) problems.push('chip 上的事件目標被當成圖片了,判斷會失準');
if (journey.opened !== 1) problems.push('按下 chip 沒有觸發 action');

await browser.close();
if (problems.length > 0) {
  console.error('\n不合格:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\n全部合格。');
