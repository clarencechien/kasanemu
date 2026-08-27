import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_CONCURRENCY,
  ORPHAN_MS,
  STALE_L0_MS,
  addJob,
  dropPageJobs,
  nextJobs,
  removeJobs,
  type ImageJob,
} from '../src/worker/imagequeue.ts';
import { allowedUrl } from '../src/worker/imagefetch.ts';
import {
  FETCH_TIMEOUT_MS,
  IMAGE_WATCHDOG_MS,
  ORPHAN_MS as TIMING_ORPHAN_MS,
  VISION_TIMEOUT_MS,
} from '../src/shared/imagetiming.ts';
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
  const { run } = nextJobs(q, new Set(), 1000);
  assert.equal(run[0]!.lane, 'l1', '第一個要是 l1');
});

test('l0 併發是 1 —— 免費檔和文字共用配額,掃過十張圖不能變十個請求', () => {
  const q = [job({ url: 'a' }), job({ url: 'b' }), job({ url: 'c' })];
  const { run } = nextJobs(q, new Set(), 1000);
  assert.equal(run.length, LANE_CONCURRENCY.l0);
  assert.equal(run.length, 1);

  // 已經有一個在跑 → 這一輪不再放行
  assert.deepEqual(nextJobs(q, new Set(['l0:a']), 1000).run, []);
});

test('掃過就走的 hover 會過期 —— 配額不花在使用者早就捲過去的圖', () => {
  const q = [job({ url: 'a', at: 0 })];
  const { run, drop } = nextJobs(q, new Set(), STALE_L0_MS + 1);
  assert.equal(drop.length, 1);
  assert.equal(run.length, 0, '過期的不該還被送出去');
});

test('l1 不會因為「掃過就走」過期 —— 那是使用者明確點的,慢也要做完', () => {
  const q = [job({ url: 'a', lane: 'l1', at: 0 })];
  const { run, drop } = nextJobs(q, new Set(), STALE_L0_MS * 10);
  assert.equal(drop.length, 0);
  assert.equal(run.length, 1);
});

test('l1 的孤兒仍然要收 —— 不然 worker 每次醒來都重跑一次,花的是配額', () => {
  /*
   * worker 被回收:runImage 停在半路,in-flight 集合跟著消失,佇列還活著。
   * l1 以前沒有任何過期線,那筆孤兒於是每次醒來都被重新派工 ——
   * 而 content 早在 180 秒的看門狗那裡放棄了。
   */
  const q = [job({ url: 'a', lane: 'l1', at: 0 })];
  const { drop } = nextJobs(q, new Set(), ORPHAN_MS + 1);
  assert.equal(drop.length, 1, 'l1 孤兒沒被收掉');
});

test('還在跑的工作不會被孤兒那條線誤殺,不分 lane', () => {
  const q = [job({ url: 'a', lane: 'l1', at: 0 }), job({ url: 'b', lane: 'l0', at: 0 })];
  const { drop } = nextJobs(q, new Set(['l1:a', 'l0:b']), ORPHAN_MS * 5);
  assert.equal(drop.length, 0, '執行中的工作被當成孤兒了');
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

/* ------------------------------------------------- 執行中的工作不可以被殺掉 */

test('跑了 17 秒的工作(gemma 的常態)不可以被當成過期丟掉', () => {
  /*
   * **使用者回報的「後面幾張都卡住了」就是這個。**
   *
   * 工作只有**完成才會從佇列移除**,所以執行中的工作一直在佇列裡。
   * 上一版的 nextJobs 只拿到「每條道在跑幾個」的計數,分不出哪一筆在跑,
   * 於是 `now - at > 10 秒` 這條把正在跑的工作判成過期 ——
   * 而 gemma 實測 17–70 秒,等於每一張免費檔的圖跑到一半都被自己殺掉,
   * log 上還留下一句騙人的 image-stale。
   */
  const q = [job({ url: 'a', at: 0 })];
  const { run, drop } = nextJobs(q, new Set(['l0:a']), 17_000);
  assert.equal(drop.length, 0, '執行中的工作被當成過期丟掉了');
  assert.equal(run.length, 0, '執行中的工作不該被重複派工');
});

test('沒在跑的才會過期 —— 同一批裡兩者要分得開', () => {
  const q = [job({ url: 'running', at: 0 }), job({ url: 'idle', at: 0 })];
  const { run, drop } = nextJobs(q, new Set(['l0:running']), 17_000);
  assert.deepEqual(drop.map((j) => j.url), ['idle']);
  assert.equal(run.length, 0, 'l0 併發是 1,而那一格被 running 佔著');
});

test('併發從 in-flight 集合算,不另外記數字', () => {
  // 兩份狀態就會分岔(lessons §1)—— 佇列與 in-flight 是同一件事的兩面
  const q = [job({ url: 'a', lane: 'l1' }), job({ url: 'b', lane: 'l1' }), job({ url: 'c', lane: 'l1' })];
  assert.equal(nextJobs(q, new Set(), 1000).run.length, 2, 'l1 併發 2');
  assert.equal(nextJobs(q, new Set(['l1:a']), 1000).run.length, 1);
  assert.equal(nextJobs(q, new Set(['l1:a', 'l1:b']), 1000).run.length, 0);
});

test('派出去過的工作在 worker 被回收後要**重派**,不是收掉', () => {
  /*
   * **使用者回報的「滑開再回來重試 都沒有成功過」就是這個。**
   *
   * log 上兩次都停在 ageMs: 61000 —— alarm(被 Chrome 夾到 60 秒)醒來時
   * 看到一筆跑了一分鐘的 gemma 工作,套上「掃過就走」那條 10 秒的規則
   * 把它殺了,然後叫使用者自己重試。但使用者根本沒有捲走,他在等。
   *
   * 分辨的線索是 startedAt:派出去過 = 有人在等它,沒派出去過才是「掃過就走」。
   */
  const q = [job({ url: 'a', at: 0, startedAt: 0 })];
  const { run, drop } = nextJobs(q, new Set(), 61_000);
  assert.equal(drop.length, 0, '派出去過的工作被當成掃過就走殺掉了');
  assert.equal(run.length, 1, '孤兒要重派');
});

test('沒派出去過的舊 l0 才是「掃過就走」,照樣收掉', () => {
  const q = [job({ url: 'a', at: 0 })];
  const { run, drop } = nextJobs(q, new Set(), STALE_L0_MS + 1);
  assert.equal(drop.length, 1);
  assert.equal(run.length, 0);
});

test('重派過頭的孤兒要收掉 —— 永遠回不來的工作不可以被叫醒無限次', () => {
  const q = [job({ url: 'a', at: 0, startedAt: 0, attempts: 2 })];
  const { run, drop } = nextJobs(q, new Set(), 61_000);
  assert.equal(drop.length, 1, '試過上限還是收掉');
  assert.equal(run.length, 0);
});

test('孤兒排在新來的前面 —— 使用者已經等過一輪了', () => {
  const q = [
    job({ url: 'fresh', at: 1000 }),
    job({ url: 'orphan', at: 0, startedAt: 0 }),
  ];
  const { run } = nextJobs(q, new Set(), 61_000);
  assert.equal(run[0]!.url, 'orphan');
});

test('沒派出去過而且超過孤兒上限的,不分 lane 一律收掉', () => {
  /*
   * MV3 的 worker 在請求途中被回收:runImage 停在半路,in-flight 集合
   * 隨著 worker 一起消失,但佇列在 storage.session 裡活著。
   * 新的 worker 醒來時那筆工作沒人在跑、而且很舊 —— 要收掉並**告訴 content**,
   * 否則圖角永遠停在「辨識中」。
   */
  const orphan = job({ url: 'orphan', at: 0 });
  const { drop } = nextJobs([orphan], new Set(), 7 * 60_000);
  assert.equal(drop.length, 1);
  assert.equal(drop[0]!.url, 'orphan');
});


/* ------------------------------------------- 逾時的層級關係(§DI) */

test('每一層都有上限時間 —— 沒有 timeout 的 fetch 是永遠不 settle 的 promise', () => {
  /*
   * 使用者回報「還是卡沒有回應」時,worker 的三個 fetch 一個 timeout 都沒有:
   * 抓圖、文字批次、視覺呼叫。一個不回應的請求扣住的不只是那張圖 ——
   * 派工那一輪 await 在它上面,整條圖片管線跟著停擺。
   */
  for (const [name, ms] of [
    ['抓圖', FETCH_TIMEOUT_MS],
    ['視覺', VISION_TIMEOUT_MS],
  ] as const) {
    assert.ok(ms > 0 && Number.isFinite(ms), `${name}沒有上限時間`);
  }
});

test('逾時的層級要由內而外遞增,最外層是 content 的看門狗', () => {
  /*
   * 這個順序**跨三個檔案**,而且錯了不會有任何症狀 —— 直到使用者先看到
   * 「沒有回應」、worker 的錯誤訊息才姍姍來遲,然後兩邊各說一套。
   *
   * 抓圖 < 視覺:抓 bytes 是本地頻寬的事,而且後面還排著模型那一段。
   * 視覺 < 看門狗:worker 一定要有機會先把真正的原因說出口。
   */
  assert.ok(FETCH_TIMEOUT_MS < VISION_TIMEOUT_MS, '抓圖的上限不該比模型還久');
  assert.ok(
    VISION_TIMEOUT_MS < IMAGE_WATCHDOG_MS,
    `模型逾時(${VISION_TIMEOUT_MS})要早於看門狗(${IMAGE_WATCHDOG_MS})`,
  );
  // 孤兒清掃 + alarm 最多 30 秒的延遲,也要趕在看門狗之前
  assert.ok(ORPHAN_MS + 30_000 < IMAGE_WATCHDOG_MS, '孤兒清掃趕不上看門狗');
  assert.equal(ORPHAN_MS, TIMING_ORPHAN_MS, '佇列用的和時限表上的不是同一個數字');
});

/* ------------------------------- API 的錯誤訊息要看得到重點(§DO-2) */

test('400 的錯誤訊息要挖出那句話,不是整包 JSON', async () => {
  /*
   * 使用者看到的是「圖形功能好像出錯了」,而 log 上是:
   *   {"error":{"code":400,"message":"Unsupported …(137)
   * 真正有用的那半句被 JSON 外殼吃掉了。一個 400 正是最需要看清楚訊息
   * 的時候 —— 它在說「你送的東西我不收」,而「哪裡不收」就在被截掉的地方。
   */
  const { apiMessageForTest } = await import('../src/worker/gemini.ts');
  const body = JSON.stringify({
    error: { code: 400, message: 'Unsupported MIME type: application/octet-stream', status: 'INVALID_ARGUMENT' },
  });
  assert.equal(apiMessageForTest(body), 'Unsupported MIME type: application/octet-stream');
});

test('不是 JSON 的錯誤(HTML 錯誤頁、代理的純文字)原樣截', async () => {
  const { apiMessageForTest } = await import('../src/worker/gemini.ts');
  assert.equal(apiMessageForTest('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>');
  assert.equal(apiMessageForTest(''), '');
});
