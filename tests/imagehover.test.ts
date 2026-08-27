import { test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * `imageUnder` 用 `instanceof` 把非元素擋掉,而 node 裡沒有 DOM。
 * 補一個最小的殼,替身繼承它就成立 —— **不裝 jsdom**:這裡要驗的是
 * hover/leave 的**判斷**,一個 layout 都不需要,而 layout 那半在
 * `scripts/probe-image.mjs` 裡用真的瀏覽器驗。
 *
 * 殼要在載入受測模組**之前**放好,所以用動態 import。
 */
class FakeElement {}
class FakeImageElement extends FakeElement {}
const g = globalThis as unknown as Record<string, unknown>;
g['Element'] = FakeElement;
g['HTMLImageElement'] = FakeImageElement;
g['window'] = globalThis;
/*
 * `imageUnder` 在 target 不是圖片時會退而問 `elementsFromPoint` ——
 * 站方壓在圖上的透明按鈕會吃掉 target(ClickHouse 就是這樣)。
 * 這裡的替身回空陣列 = 「那個座標下面沒有圖」,正是這幾條要驗的情境。
 */
g['document'] = { elementsFromPoint: () => [] };
// `geometryOf` 要問 object-fit 與捲動位置 —— 給最單純的那組值
g['getComputedStyle'] = () => ({ objectFit: 'fill', objectPosition: '50% 50%' });
g['scrollX'] = 0;
g['scrollY'] = 0;

const { ImageAnnotator, LEAVE_GRACE_MS, IMAGE_HOVER_MS } = await import('../src/content/imageanno.ts');
type Host = ConstructorParameters<typeof ImageAnnotator>[0];

/**
 * hover 的生命週期。
 *
 * 這個檔案存在的理由是一個使用者回報:「點這裡放大讀是點哪裡 那個 tip 不能點」。
 * 那片 chip 其實**點得下去**(probe 實測 action 會觸發)—— 它是在滑鼠碰到
 * 之前就被自己刪掉的。整條路上每一段都對:chip 畫出來了、pointer-events
 * 開了、onclick 綁了、action 送得出去。錯的是**滑鼠走過去的那半秒**,
 * 而那半秒沒有任何一層在看(`docs/deviations.md` §DK)。
 *
 * 所以這裡不驗任何一段,驗的是**一段路**。
 */

const HOST_ID = 'kasanemu-root';

class FakeDiv extends FakeElement {
  id = '';
  closest(): null {
    return null;
  }
}

class FakeImg extends FakeImageElement {
  currentSrc = 'https://example.com/a.png';
  src = 'https://example.com/a.png';
  naturalWidth = 1200;
  naturalHeight = 800;
  closest(sel: string): FakeImg | null {
    return sel === 'img' ? this : null;
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 600, height: 400 } as unknown as DOMRect;
  }
}

function harness() {
  const cues: (string | null)[] = [];
  const shown: number[] = [];
  const hidden: number[] = [];
  /** 每次 cue 帶不帶 action —— 「點一下重試」那句話算不算數就看它 */
  const actions: (string | undefined)[] = [];
  /** 送出去的請求:重試有沒有真的再送一次、送去哪一條道、有沒有帶 brief */
  const sent: { url: string; lane: string; brief?: boolean }[] = [];
  const host = {
    request: (url: string, lane: string, brief?: boolean) => {
      sent.push({ url, lane, brief });
    },
    cue: (_el: unknown, text: string | null, _tone: string, action?: string) => {
      cues.push(text);
      actions.push(action);
    },
    showImage: () => {
      shown.push(1);
    },
    hideImage: () => {
      hidden.push(1);
    },
    setActivePin: () => undefined,
    ownsTarget: (t: unknown) => t instanceof FakeDiv && t.id === HOST_ID,
    openZoom: () => ({ w: 800, h: 600 }),
    setZoomBlocks: () => undefined,
    closeZoom: () => undefined,
  } as unknown as Host;
  const anno = new ImageAnnotator(host, () => true, () => false);
  const img = new FakeImg() as unknown as HTMLImageElement;
  const chip = new FakeDiv();
  chip.id = HOST_ID;
  const elsewhere = new FakeDiv();
  /*
   * **一定要 reset**:hover 會排一個 500ms 的計時器,而它跑完會再排一個
   * 180 秒的看門狗 —— 沒收掉的話 node 會抱著那個計時器不結束。
   */
  return { anno, cues, actions, sent, shown, hidden, img, chip, elsewhere, done: () => anno.reset() };
}

const removed = (cues: readonly (string | null)[], from: number) =>
  cues.slice(from).some((c) => c === null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */

test('停在我們自己的 chip 上,cue 不可以被收掉 —— 否則永遠按不到', async () => {
  /*
   * closed shadow root 把事件目標重定向成 host,所以「滑鼠在 chip 上」
   * 從外面看不到任何 <img>。上一版就在這裡呼叫 leave(),
   * 於是那片「⤢ 點這裡放大讀」在滑鼠碰到它的前一刻消失。
   *
   * **一定要等過寬限期再驗。** 我第一版寫成同步檢查,結果把
   * ownsTarget 那條整個拿掉測試照樣綠 —— 因為寬限期把症狀蓋住了 220 毫秒。
   * 使用者在 chip 上讀完那行字要花的時間遠不只 220 毫秒,
   * 所以要驗的是「停著不動也不會消失」,不是「不會馬上消失」。
   */
  const h = harness();
  h.anno.move(h.img, 10, 10);
  const n = h.cues.length;
  h.anno.move(h.chip, 10, 420); // 滑到圖外面的 chip 上
  await sleep(LEAVE_GRACE_MS + 120);
  assert.equal(removed(h.cues, n), false, '停在 chip 上,它還是被自己刪掉了');
  h.done();
});

test('停在 chip 上時 current 要留著 —— 按下去才有東西可以放大', async () => {
  /*
   * 同一個 bug 的第二半:就算滑鼠快到能在 chip 消失前按下去,`leave()`
   * 也已經把 current 清成 null,`openZoom()` 直接回 false。
   * 只修一半的話,使用者按下去仍然什麼都不會發生。
   */
  const h = harness();
  h.anno.move(h.img, 10, 10);
  h.anno.move(h.chip, 10, 420);
  await sleep(LEAVE_GRACE_MS + 120);
  assert.equal(h.anno.currentImage(), h.img, '停在 chip 上就把 current 清掉了');
  h.done();
});

test('滑到頁面別處是真的離開,但要留一段寬限給滑鼠走路', async () => {
  const h = harness();
  h.anno.move(h.img, 10, 10);
  const n = h.cues.length;
  h.anno.move(h.elsewhere, 900, 900);
  assert.equal(removed(h.cues, n), false, '立刻收了 —— 圖與 chip 之間那一兩個像素會殺掉 chip');
  await sleep(LEAVE_GRACE_MS + 80);
  assert.equal(removed(h.cues, n), true, '寬限過了還是不收,對稱律就壞了(移開要還原圖)');
  h.done();
});

test('寬限期內滑回圖上,收起來要取消掉', async () => {
  const h = harness();
  h.anno.move(h.img, 10, 10);
  const n = h.cues.length;
  h.anno.move(h.elsewhere, 900, 900);
  h.anno.move(h.img, 20, 20); // 半路折返
  await sleep(LEAVE_GRACE_MS + 80);
  assert.equal(removed(h.cues, n), false, '折返之後還是收掉了 —— 排好的計時器沒有取消');
  h.done();
});

test('寬限期比一幀長很多 —— mousemove 節流到每幀一次,太短等於沒有', () => {
  assert.ok(LEAVE_GRACE_MS >= 120, `寬限太短:${LEAVE_GRACE_MS}ms`);
});

/* ------------------------------------------- 站方壓在圖上的透明按鈕 */

test('站方蓋在圖上的透明按鈕不可以擋掉 hover', async () => {
  /*
   * ClickHouse 那篇每張圖上都壓著一顆
   * `<button style="position:absolute;inset:0;cursor:zoom-in;opacity:0">`,
   * 所以 `target.closest('img')` 永遠是 null。使用者原話:
   * 「沒點之前 mouse over 不會翻,要點起來再 mouse over 有翻了」——
   * 站方的 lightbox 打開之後 <img> 才直接吃得到滑鼠。
   *
   * 諷刺的是 `hasNativeZoom()` **早就認得**那顆按鈕(靠它判斷站方有自己的
   * 放大檢視),卻沒想到它會擋住 hover。
   */
  const { imageUnder } = await import('../src/content/imageanno.ts');
  const img = new FakeImg();
  const cover = new FakeDiv(); // 站方那顆透明按鈕
  g['document'] = { elementsFromPoint: () => [cover, img] };
  try {
    assert.equal(imageUnder(cover), null, '按鈕本身當然不是圖片');
    assert.equal(
      imageUnder(cover, 100, 100),
      img as unknown as HTMLImageElement,
      '有座標就該找得到底下那張圖',
    );
  } finally {
    g['document'] = { elementsFromPoint: () => [] };
// `geometryOf` 要問 object-fit 與捲動位置 —— 給最單純的那組值
g['getComputedStyle'] = () => ({ objectFit: 'fill', objectPosition: '50% 50%' });
g['scrollX'] = 0;
g['scrollY'] = 0;
  }
});

test('掃描深度有上限 —— 不能把被不透明東西蓋住的圖也算進來', async () => {
  const { imageUnder, OVERLAY_SCAN_DEPTH } = await import('../src/content/imageanno.ts');
  const img = new FakeImg();
  const stack = Array.from({ length: OVERLAY_SCAN_DEPTH }, () => new FakeDiv());
  g['document'] = { elementsFromPoint: () => [...stack, img] };
  try {
    assert.equal(imageUnder(stack[0]!, 100, 100), null, '埋太深的圖不該被撈出來');
  } finally {
    g['document'] = { elementsFromPoint: () => [] };
// `geometryOf` 要問 object-fit 與捲動位置 —— 給最單純的那組值
g['getComputedStyle'] = () => ({ objectFit: 'fill', objectPosition: '50% 50%' });
g['scrollX'] = 0;
g['scrollY'] = 0;
  }
});

/* --------------------------------------------------- 按住 Alt 之後 */

test('repaint 把加註畫回來 —— Alt 放開之後圖片加註要回來', () => {
  /*
   * **使用者原話:「alt 按下後 layer 不見就再也不會回來了」。**
   *
   * Alt 按下去做了兩件事:收文字疊層、`hideImage()` 收圖片加註。
   * 放開時上一版只做了第一件的反面。而且回不來 —— `move()` 看到滑鼠還在
   * 同一張圖上就不會重畫,所以那張圖要等你滑走再滑回來才有加註。
   */
  const h = harness();
  h.anno.move(h.img, 10, 10);
  // 譯文回來了,加註畫上去
  h.anno.onResult('https://example.com/a.png', 'hash', 'l0', [
    { box: [100, 100, 200, 500], text: 'Storage size', zh: '儲存大小', c: 1 },
  ]);
  const before = h.shown.length;
  assert.ok(before > 0, '結果回來時本來就該畫一次');

  // 按住 Alt:index.ts 會呼叫 hideImage()
  h.hidden.length = 0;
  h.anno.repaint();
  assert.ok(h.shown.length > before, 'repaint 沒有把加註畫回來 —— Alt 放開之後就永遠不見了');
  h.done();
});

test('沒有譯文的圖,repaint 不該亂畫', () => {
  const h = harness();
  h.anno.move(h.img, 10, 10);
  const before = h.shown.length;
  h.anno.repaint();
  assert.equal(h.shown.length, before);
  h.done();
});

/* ── 失敗之後回得去嗎(§DS) ─────────────────────────────────── */

/** 滑上去、等過 hover 門檻、讓它真的送出一次 */
async function armed(h: ReturnType<typeof harness>): Promise<void> {
  h.anno.move(h.img, 10, 10);
  await sleep(IMAGE_HOVER_MS + 40);
}

test('說「點一下重試」的 chip 就要真的能點 —— 文案不可以自己說了算', async () => {
  /*
   * 使用者的原話:「所以是要點哪裡? 怎麼點都沒有反應」。
   *
   * 上一版每一句失敗文案都寫著「再點一次重試」,而 cue **一個 action
   * 都沒帶** —— chip 拿不到 act 類別、onclick 是 null、pointer-events
   * 沒開。整條路上沒有任何一層在說謊,是文案和行為住在不同的地方,
   * 於是它們各自漂走了(§DS-1)。
   */
  const h = harness();
  await armed(h);
  h.anno.onError('https://example.com/a.png', 'timeout 100000ms');
  assert.equal(h.actions.at(-1), 'retry', '文案叫人點,chip 卻不能點');
  h.done();
});

test('點不得的失敗不給 action —— 額度用完了點一百次也一樣', async () => {
  const h = harness();
  await armed(h);
  h.anno.onError('https://example.com/a.png', 'daily-cap');
  assert.equal(h.actions.at(-1), undefined, '不可重試的失敗給了一個假的入口');
  assert.match(String(h.cues.at(-1)), /預算/, '而且文案也不該叫人點');
  h.done();
});

test('重試要真的再送一次 —— 以前從任何入口都回不去', async () => {
  /*
   * 以前 `arm()` 看到 failed 只會把同一句話再印一次,而 failed 只有
   * onResult 會清。點也沒用、滑開再滑回來也沒用 —— **失敗是終點站**。
   */
  const h = harness();
  await armed(h);
  const n = h.sent.length;
  h.anno.onError('https://example.com/a.png', 'timeout 100000ms');
  assert.equal(h.anno.retry(), true);
  assert.equal(h.sent.length, n + 1, '點了重試卻沒有送出任何請求');
  h.done();
});

test('逾時的重試只問大字 —— 同一份請求再送一次只會再逾時一次', async () => {
  /*
   * 使用者已經替我們驗過了:逾時之後 Alt+click 升級,**照樣逾時**。
   * 逾時不是隨機的,是輸出太長(實測 ~2.3 秒一塊,100 秒 = 43 塊),
   * 所以重試要問得比較少才回得來(§DS-2)。
   */
  const h = harness();
  await armed(h);
  h.anno.onError('https://example.com/a.png', 'timeout 100000ms');
  h.anno.retry();
  assert.equal(h.sent.at(-1)?.brief, true, '逾時的重試又送了一份完整的請求');
  h.done();
});

test('抓不到圖那種重試不必縮水 —— 只有逾時是輸出太長', async () => {
  const h = harness();
  await armed(h);
  h.anno.onError('https://example.com/a.png', 'fetch-timeout');
  h.anno.retry();
  assert.notEqual(h.sent.at(-1)?.brief, true);
  h.done();
});

test('升級過的圖重試要留在 l1 —— 不可以偷偷退回免費檔', async () => {
  /*
   * 使用者花了錢點升級,失敗之後重試回免費檔的話,他拿到的是**比較差的
   * 東西而且不會知道**。
   */
  const h = harness();
  await armed(h);
  h.anno.upgrade(h.img);
  h.anno.onError('https://example.com/a.png', 'timeout 100000ms');
  h.anno.retry();
  assert.equal(h.sent.at(-1)?.lane, 'l1');
  h.done();
});

test('同一張圖還在飛的時候,重試不重複送', async () => {
  const h = harness();
  await armed(h);
  h.anno.onError('https://example.com/a.png', 'timeout 100000ms');
  assert.equal(h.anno.retry(), true);
  const n = h.sent.length;
  assert.equal(h.anno.retry(), false, '第二次點下去又送了一份');
  assert.equal(h.sent.length, n);
  h.done();
});

test('免費檔還在跑的時候按升級,不可以被吞掉', async () => {
  /*
   * `upgrade()` 以前只問「這張圖有沒有請求在飛」,有就回 true 走人 ——
   * 於是使用者在「辨識中…」的時候 Alt+click,那一下**連結也不會走、
   * 請求也不會送**,兩頭落空。worker 那邊本來就允許 l1 蓋過 l0。
   */
  const h = harness();
  await armed(h);
  const n = h.sent.length;
  assert.equal(h.anno.upgrade(h.img), true);
  assert.equal(h.sent.length, n + 1, '升級被吞掉了');
  assert.equal(h.sent.at(-1)?.lane, 'l1');
  h.done();
});

test('已經在升級了就不重複送 —— 連按兩下只算一次', async () => {
  const h = harness();
  await armed(h);
  h.anno.upgrade(h.img);
  const n = h.sent.length;
  assert.equal(h.anno.upgrade(h.img), true);
  assert.equal(h.sent.length, n);
  h.done();
});
