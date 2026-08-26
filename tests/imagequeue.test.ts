import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_CONCURRENCY,
  STALE_L0_MS,
  addJob,
  dropPageJobs,
  nextJobs,
  removeJobs,
  type ImageJob,
} from '../src/worker/imagequeue.ts';
import { allowedUrl } from '../src/worker/imagefetch.ts';
import {
  estimateImageTokens,
  fromWire,
  sanitizeBlocks,
} from '../src/shared/imageblocks.ts';

const job = (over: Partial<ImageJob> = {}): ImageJob => ({
  url: 'https://example.com/a.png',
  pageKey: 'https://example.com/post',
  tabId: 1,
  lane: 'l0',
  tier: 'free',
  at: 1000,
  attempts: 0,
  ...over,
});

test('同一張圖同一條道不重複排隊 —— hover 抖動不該排出十筆', () => {
  let q = addJob([], job());
  q = addJob(q, job());
  q = addJob(q, job());
  assert.equal(q.length, 1);
});

test('l1 蓋掉同一張圖待處理的 l0 —— 點了升級,免費那筆就沒意義了', () => {
  let q = addJob([], job({ lane: 'l0' }));
  q = addJob(q, job({ lane: 'l1', tier: 'balanced' }));
  assert.equal(q.length, 1);
  assert.equal(q[0]!.lane, 'l1');
});

test('不同圖各自排隊,l1 不會誤殺別張圖的 l0', () => {
  let q = addJob([], job({ url: 'https://example.com/a.png', lane: 'l0' }));
  q = addJob(q, job({ url: 'https://example.com/b.png', lane: 'l1' }));
  assert.equal(q.length, 2);
});

test('l1 先跑 —— 人親手點的動作不排在自動來的後面', () => {
  /*
   * `docs/lessons.md` §7:成本閘門只約束自動行為。
   * hover 排進來的十張圖不可以讓使用者剛點的那張等十分鐘。
   */
  const q = [
    job({ url: 'a', lane: 'l0' }),
    job({ url: 'b', lane: 'l0' }),
    job({ url: 'c', lane: 'l1' }),
  ];
  const { run } = nextJobs(q, { l0: 0, l1: 0 }, 1000);
  assert.equal(run[0]!.lane, 'l1', '第一個要是 l1');
});

test('l0 併發是 1 —— 免費檔和文字共用配額,掃過十張圖不能變十個請求', () => {
  const q = [job({ url: 'a' }), job({ url: 'b' }), job({ url: 'c' })];
  const { run } = nextJobs(q, { l0: 0, l1: 0 }, 1000);
  assert.equal(run.length, LANE_CONCURRENCY.l0);
  assert.equal(run.length, 1);

  // 已經有一個在跑 → 這一輪不再放行
  assert.deepEqual(nextJobs(q, { l0: 1, l1: 0 }, 1000).run, []);
});

test('掃過就走的 hover 會過期 —— 配額不花在使用者早就捲過去的圖', () => {
  const q = [job({ url: 'a', at: 0 })];
  const { run, drop } = nextJobs(q, { l0: 0, l1: 0 }, STALE_L0_MS + 1);
  assert.equal(drop.length, 1);
  assert.equal(run.length, 0, '過期的不該還被送出去');
});

test('l1 不會過期 —— 那是使用者明確點的,慢也要做完', () => {
  const q = [job({ url: 'a', lane: 'l1', at: 0 })];
  const { run, drop } = nextJobs(q, { l0: 0, l1: 0 }, STALE_L0_MS * 10);
  assert.equal(drop.length, 0);
  assert.equal(run.length, 1);
});

test('移除只拿掉指定的那幾筆', () => {
  const a = job({ url: 'a' });
  const b = job({ url: 'b' });
  assert.deepEqual(removeJobs([a, b], [a]).map((j) => j.url), ['b']);
});

test('換頁把那一頁的圖片工作清掉,別的分頁不受影響', () => {
  const mine = job({ pageKey: 'p1', tabId: 1 });
  const other = job({ pageKey: 'p2', tabId: 1 });
  const otherTab = job({ pageKey: 'p1', tabId: 2 });
  const left = dropPageJobs([mine, other, otherTab], 1, 'p1');
  assert.equal(left.length, 2);
  assert.ok(!left.includes(mine));
});

/* ------------------------------------------------------------ 取圖的守門 */

test('只放行 http / https / data:,其他 scheme 一律擋掉', () => {
  /*
   * 這條是安全邊界,不是相容性:讓「翻譯圖片」變成任意檔案讀取,
   * 是這裡最容易犯的錯。
   */
  assert.ok(allowedUrl('https://cdn.example.com/a.png'));
  assert.ok(allowedUrl('http://example.com/a.png'));
  assert.ok(allowedUrl('data:image/png;base64,iVBOR'));
  assert.ok(!allowedUrl('file:///etc/passwd'));
  assert.ok(!allowedUrl('chrome-extension://abc/manifest.json'));
  assert.ok(!allowedUrl('blob:https://example.com/uuid'), 'blob 是別的 realm 的 URL,worker 解不開');
  assert.ok(!allowedUrl('javascript:alert(1)'));
  assert.ok(!allowedUrl('not a url'));
});

test('token 估算貼著實測值,而且寧可高估', () => {
  /*
   * 實測(§7):1580×530 → prompt 1192;2042×1546 → 1211。
   * 估太低會讓保險絲失效,所以只要求「同一個量級且不低於實測」。
   */
  const chart = estimateImageTokens(1580, 530);
  const shot = estimateImageTokens(1536, 1163); // 2042×1546 縮到長邊 1536 之後
  assert.ok(chart >= 1192, `圖表估太低:${chart}`);
  assert.ok(shot >= 1211, `截圖估太低:${shot}`);
  assert.ok(chart < 1192 * 3 && shot < 1211 * 3, '高估也要有節制,否則保險絲永遠說沒預算');
});

/* ------------------------------------------- 線上形狀 → 內部形狀的接縫 */

test('模型回的是 box_2d,內部型別是 box —— 這個接縫斷掉是無聲的', () => {
  /*
   * 實際發生過:三個模型都乖乖回了框、usage 有 515 個 output token、
   * sanitizeBlocks 一塊都收不到、沒有任何一層報錯。
   *
   * 單元測試抓不到,因為它餵的是內部形狀。所以這一條**刻意餵線上的形狀**
   * —— 直接貼 API 回來的樣子,一個欄位都不改。
   */
  const wire = [
    { box_2d: [101, 442, 152, 556], text: 'Storage size', zh: '儲存大小', c: 0.99 },
    { box_2d: [284, 415, 325, 477], text: '469 GB', zh: '469 GB', c: 1 },
  ];
  const { blocks } = sanitizeBlocks(fromWire(wire));
  assert.equal(blocks.length, 2, 'box_2d 沒被認出來 —— 接縫斷了');
  assert.deepEqual(blocks[0]!.box, [101, 442, 152, 556]);
  assert.equal(blocks[0]!.c, 0.99, 'c 也要接過來');
});

test('內部形狀直接進來也要能用(快取讀回、測試餵值)', () => {
  const { blocks } = sanitizeBlocks(fromWire([{ box: [10, 20, 30, 40], text: 'a', zh: 'b' }]));
  assert.equal(blocks.length, 1);
});

test('壞掉的元素不會讓整批爆掉', () => {
  const { blocks } = sanitizeBlocks(fromWire([null, 'nope', 42, { box_2d: [1, 2, 3, 4], text: 'x', zh: 'y' }]));
  assert.equal(blocks.length, 1);
});
