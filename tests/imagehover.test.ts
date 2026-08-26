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

const { ImageAnnotator, LEAVE_GRACE_MS } = await import('../src/content/imageanno.ts');
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
  closest(sel: string): FakeImg | null {
    return sel === 'img' ? this : null;
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 600, height: 400 } as unknown as DOMRect;
  }
}

function harness() {
  const cues: (string | null)[] = [];
  const host = {
    request: () => undefined,
    cue: (_el: unknown, text: string | null) => {
      cues.push(text);
    },
    showImage: () => undefined,
    hideImage: () => undefined,
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
  return { anno, cues, img, chip, elsewhere, done: () => anno.reset() };
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
