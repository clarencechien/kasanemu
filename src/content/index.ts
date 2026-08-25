import type { PageStats, ToContent, ToWorker } from '../shared/messages';
import type {
  DisplayMode,
  DomainState,
  Pipeline,
  Settings,
  UnitRequest,
  UnitResult,
  UnitTier,
} from '../shared/types';
import { setDebug, dbg } from '../shared/log';
import { diag, setDiagScope } from '../shared/diag';
import {
  INTERACTIVE_SELECTOR,
  explainCandidate,
  findCandidates,
  findLabels,
  hasContainerChild,
  isMeaningfulText,
  looksLikeTargetLang,
  normalizeText,
  ownText,
  setPageScript,
} from './detect';
import {
  assignScales,
  checkOverflow,
  computeMaxChars,
  coverRect,
  lockScales,
  maxCharsForUpgrade,
  measureTextHeight,
  measureUnit,
  unlockScales,
} from './geometry';
import { probePackagedFonts } from './fonts';
import { L0Engine, translatorSupported } from './l0';
import { pageSourceLang, sampleVisibleText, sniffScript, toTranslatorTarget } from './lang';
import {
  STALL_MS,
  dwellReady,
  hoverRetryReady,
  isFailedTier,
  priorityOf as priorityFor,
  swapAllowed,
  translationPhase,
} from './upgrade';
import { mask, protectedFragments } from './mask';
import { OverlayLayer, type ChipItem } from './overlay';
import { hintColor, parseColor, probeStyle, resetHintColor } from './styleprobe';
import { clearMeasureCache } from './measure';
import { activeText, hasText, type Unit } from './unit';
import { dedupeByText, labelBudget } from './annotate';

setDiagScope('content');

/** 掃到 0 個候選時的重掃間隔(ms) */
const EMPTY_SCAN_RETRIES = [300, 900, 2000, 4000];

/**
 * L0 的預翻範圍(視窗上下各幾 px)。
 *
 * §7.1 的 `rootMargin: 200px` 是**成本**規則:控制 TPM 與帳單。
 * 那是 L1 的顧慮 —— L0 在本機跑、零成本、不吃額度,卻一直跟著同一條規則,
 * 於是每捲一段就要重等一次翻譯。診斷 log 顯示 L0 一批 9 塊要 3.7 秒,
 * 首屏 4 秒幾乎全花在這裡。
 *
 * 分開之後:L0 提前翻視窗外 1500px 的內容(捲到之前就翻好了),
 * L1 仍然嚴守「可見 + 停留 1.5 秒」(D21,那條是拿來省錢的)。
 */
const L0_LOOKAHEAD_PX = 1500;

/**
 * 慢機器上的預翻範圍。
 *
 * 診斷 log(Chromebook,併發自動降到 2):`avgWaitMs` 爬到 18 秒、`queued: 30`。
 * 預翻 1500px 在這種機器上只是把佇列塞滿 —— 排進去的多半在使用者捲到之前
 * 就已經過期(SPA 換頁、重排)。看得見的區塊有優先度插隊所以不受害,
 * 但那些工作本身是浪費。
 */
const L0_LOOKAHEAD_SLOW_PX = 400;
/** 超過這個平均延遲就算慢機器(ms) */
const SLOW_MACHINE_MS = 2000;

function lookaheadPx(): number {
  const t = l0?.timing();
  if (!t || t.calls < 6) return L0_LOOKAHEAD_PX;
  return t.avgMs > SLOW_MACHINE_MS ? L0_LOOKAHEAD_SLOW_PX : L0_LOOKAHEAD_PX;
}

const host = location.hostname;

let settings: Settings;
let state: DomainState;
let layer: OverlayLayer | null = null;

/**
 * feature.md §6 最後一條:環境不支援 Translator API 時自動退回 single 並明確告知。
 * 存的偏好不動 —— 換到支援的機器上就會自己回到 progressive。
 */
let effective: Pipeline = 'single';
let l0: L0Engine | null = null;

/**
 * §3.4 節點 id 用 WeakMap 綁定,不得寫入 DOM 屬性 (D14)。
 *
 * 必須是 let:WeakMap 沒有 clear(),而 stop() 之後如果舊的對應還在,
 * 下一次 scan() 的 seen() 會對每個舊元素回 true,findCandidates 於是
 * 一個候選都不產生 —— 症狀是切換管線後狀態列說「沒找到可翻譯的區塊」。
 */
let unitByEl = new WeakMap<Element, Unit>();
const units = new Set<Unit>();
const unitById = new Map<string, Unit>();
let nextId = 1;

/** 已送去問過快取的單元,不重複問 (feature.md §4.6)。同樣不能 clear */
let probed = new WeakSet<Unit>();

let pageKey = makePageKey();
let hovered: Unit | null = null;
let altScan = false;

/* ---------------------------------------------------------------- 加翻層 */
/*
 * docs/plan-annotation.md。UI 標籤不覆蓋原文,改成 hover 時在旁邊出貼片。
 *
 * label 單元刻意**不放進 `units`**:那個集合被 flush / 幾何 / 提示線 /
 * 遮擋檢查等十幾條路徑吃著,每條都要加一個 kind 判斷,漏一條就是 bug。
 * 但**要放進 `unitById`** —— L1 的結果與快取靠 id 回來,那條路必須共用,
 * 否則等於把 §6.4 的 id 三層防線再實作一次。
 */
const ANNOTATION_CAP = 200;
/** 停留這麼久才開貼片:低於這個值,滑鼠橫掃導覽列會沿路閃出一排 */
const CHIP_OPEN_MS = 180;
/** 移開之後延遲關,避免在相鄰項目之間移動時閃爍 */
const CHIP_CLOSE_MS = 80;
/** 貼片開著這麼久 → 把整組排入 L1(注意力驅動的成本控制) */
const CHIP_L1_MS = 600;
/** 捲動後這段時間內不開貼片 */
const CHIP_SCROLL_QUIET_MS = 300;
/** 一起送 L1 的「同一組」:hover 一個導覽項目,順便把整條導覽列翻掉 */
const GROUP_SELECTOR =
  'nav,ul,ol,menu,[role="menu"],[role="menubar"],[role="tablist"],[role="toolbar"],header,footer';

let labels = new Set<Unit>();
let labelByEl = new WeakMap<Element, Unit>();
let chipUnit: Unit | null = null;
let chipOpenTimer = 0;
let chipCloseTimer = 0;
let chipL1Timer = 0;

let mo: MutationObserver | null = null;
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;

let flushTimer = 0;
let enqueueTimer = 0;
let dwellTimer = 0;
let reprioTimer = 0;
let motionTimer = 0;
let scrollRaf = 0;
let settleTimer = 0;
/** 只在數量變化時記錄,否則每次重排都記一筆會把 log 洗掉 */
let lastOverflowCount = -1;
let lastShiftBucket = '';
let lastTopBand = -1;
let lastBottomBand = -1;
let lastCovered = -1;
/** 掃到 0 個候選時的重試次數(頁面可能還在載入、入場動畫還沒跑完) */
let emptyScans = 0;
let running = false;
let pendingScan = false;

/** feature.md §2.2 首屏疊層出現時間 */
let startedAt = 0;
let firstPaintMs = -1;
/** feature.md §4.3 距上次捲動 < 400ms 的區塊延後替換 */
let lastScrollAt = 0;
/** feature.md §2.2「L0 讀完就沒再看 L1」的比例 */
let swapsTotal = 0;
let swapsOffscreen = 0;
/**
 * 手動翻譯已被觸發過(popup 按鈕或 Alt+Shift+R)。
 * autoTranslate 關掉時,這個旗標是唯一的放行條件。
 */
let manualArmed = false;
/** worker 回報的最後一則問題,顯示在狀態列上 —— 失敗不可以只留在 console */
let lastProblem = '';

function makePageKey(): string {
  return `${location.origin}${location.pathname}`;
}

function send(msg: ToWorker): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* service worker 正在回收,下一次動作會重試 */
  });
}

function ask<T>(msg: ToWorker): Promise<T | null> {
  return chrome.runtime.sendMessage(msg).catch(() => null) as Promise<T | null>;
}

const usesL0 = (p: Pipeline): boolean => p === 'progressive' || p === 'l0-only';
const usesL1 = (p: Pipeline): boolean => p === 'progressive' || p === 'single';

/* ------------------------------------------------------------------ 掃描 */

function scan(): void {
  if (!layer) return;
  const found = findCandidates(document.body, (el) => unitByEl.has(el));
  for (const c of found) {
    if (unitByEl.has(c.el)) continue;
    const style = probeStyle(c.el, settings.weightOffset);
    const unit: Unit = {
      id: `u${nextId++}`,
      el: c.el,
      kind: 'block',
      role: c.role,
      src: c.src,
      style,
      geometryRisk: c.geometryRisk,
      // §4.1 取不到不透明實色 → 降級為標註樣式,不要猜
      annotation: style.backgroundRisk,
      singleLine: false,
      sizeGroup: Math.round(style.fontSizePx),
      scale: 1,
      maxChars: 0,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      bleed: { x: 0, y: 0 },
      overflowsBox: false,
      firstRectTop: 0,
      lastRectBottom: 0,
      textHeight: 0,
      // §3.5 元素環繞浮動圖片 → bounding box 會蓋住圖片,跳過該單元
      tier: c.geometryRisk ? 'skipped' : 'pending',
      l1Queued: false,
      lockedFontSize: 0,
      inView: false,
      overflowing: false,
    };
    unitByEl.set(c.el, unit);
    units.add(unit);
    unitById.set(unit.id, unit);
    if (unit.tier !== 'skipped') {
      io?.observe(c.el);
      ro?.observe(c.el);
    }
  }
  scanLabels();
  dbg('scan', { found: found.length, total: units.size });
  diag(units.size === 0 ? 'warn' : 'info', 'scan', {
    found: found.length,
    total: units.size,
    pipeline: effective,
    attempt: emptyScans,
    // 一個都沒找到時,最想知道的是「頁面上到底有沒有東西」
    bodyChars: units.size === 0 ? (document.body.textContent ?? '').trim().length : undefined,
  });
  if (units.size === 0) {
    // 啟用的當下頁面可能還在載入,或入場動畫讓內容暫時是 opacity: 0。
    // 退避重掃幾次,不要一啟用就說「沒有可翻譯的區塊」然後不動了。
    if (emptyScans < EMPTY_SCAN_RETRIES.length) {
      const wait = EMPTY_SCAN_RETRIES[emptyScans]!;
      emptyScans++;
      window.setTimeout(() => scheduleFlush(true), wait);
    }
  } else {
    emptyScans = 0;
  }
}

function prune(): void {
  for (const u of [...units]) {
    if (u.el.isConnected) continue;
    // SPA 換路由:來源元素消失,疊層不得殘留 (§12.2)
    layer?.drop(u);
    io?.unobserve(u.el);
    ro?.unobserve(u.el);
    units.delete(u);
    unitById.delete(u.id);
  }
}

/* -------------------------------------------------------- 重排 / 重新錨定 */

/**
 * §3.4 重新錨定。debounce 120ms,在 requestAnimationFrame 內執行。
 * §10.1 所有 DOM 讀取集中在一個 batch,所有寫入集中在另一個 batch,不交錯。
 */
function scheduleFlush(alsoScan = false): void {
  if (alsoScan) pendingScan = true;
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    requestAnimationFrame(flush);
  }, 120);
}

/**
 * CSS transform 的入場動畫既不觸發 ResizeObserver 也不觸發 MutationObserver,
 * 所以疊層會停在動畫中途量到的位置 —— 症狀是卡片列表的譯文整排錯位到頁面頂端。
 *
 * 這裡在捲動停止、轉場結束之後對可見單元驗一次座標,對不上就重排。
 * 不在捲動**過程中**做,§10.2 的「捲動時額外開銷 0」還是成立。
 */
function auditPositions(): void {
  if (!layer || !running) return;
  applyChromeClip();
  checkOcclusion();
  // 用**疊層畫在哪**來決定要驗誰,而不是來源元素現在在哪:
  // 錯位的症狀正是「來源元素跑掉了,疊層還留在視口裡」,
  // 只驗 inView 的來源元素會漏掉那些。
  const near = window.innerHeight;
  const top = window.scrollY - near;
  const bottom = window.scrollY + near * 2;
  for (const u of units) {
    if (u.tier === 'skipped') continue;
    if (!u.box && !u.inView) continue;
    if (u.rect.top + u.rect.height < top || u.rect.top > bottom) continue;
    // 用同一個公式算「現在應該蓋哪裡」,否則取過 max 的高度會永遠對不上
    const { rect } = coverRect(u);
    const dx = Math.abs(rect.left - u.rect.left);
    const dy = Math.abs(rect.top - u.rect.top);
    const dw = Math.abs(rect.width - u.rect.width);
    const dh = Math.abs(rect.height - u.rect.height);
    if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
      diag('info', 'position-drift', { id: u.id, dx, dy, dw, dh });
      scheduleFlush();
      return;
    }
  }
}

/**
 * 圖片 / iframe / 影片載入完成會把後面的內容整個推走,而這件事
 * **沒有任何一個現有的 observer 看得到**:
 * ResizeObserver 看的是單元自己的尺寸(標題只是被推走,尺寸沒變),
 * MutationObserver 看的是 childList / characterData(載入不改 DOM 結構)。
 *
 * 症狀是卡片列表的標題疊層整排停在圖片還沒載入時的位置 ——
 * 也就是卡片頂端,差距剛好是一張圖的高度。
 *
 * load 事件不冒泡,所以要在 capture 階段攔。載入失敗(error)同樣會改變佈局。
 */
function onResourceLoad(e: Event): void {
  const t = e.target;
  if (
    t instanceof HTMLImageElement ||
    t instanceof HTMLIFrameElement ||
    t instanceof HTMLVideoElement ||
    t instanceof HTMLObjectElement
  ) {
    onMotionEnd();
  }
}

function onMotionEnd(): void {
  if (motionTimer) return;
  motionTimer = window.setTimeout(() => {
    motionTimer = 0;
    auditPositions();
  }, 120);
}

/** feature.md §4.4 規則 3:只有這些事件才解鎖字級重算 */
function relayout(): void {
  unlockScales(units);
  clearMeasureCache();
  // 幾何變了,還沒送出去的長度預算要跟著重算(已送出的不動,反正回不去了)
  for (const u of units) if (!u.l1Queued) u.maxChars = 0;
  scheduleFlush();
}

function flush(): void {
  if (!layer || !running) return;
  const doScan = pendingScan;
  pendingScan = false;
  prune();
  if (doScan) scan();

  // ---- 讀取階段:只讀,不寫
  for (const u of units) {
    if (u.tier === 'skipped') continue;
    measureUnit(u, settings.overlayBleedPx);
    if (u.maxChars === 0) u.maxChars = computeMaxChars(u);
  }
  const paintable = [...units].filter(hasText);
  assignScales(paintable);
  for (const u of paintable) u.textHeight = measureTextHeight(u);

  // ---- 寫入階段
  for (const u of units) {
    if (hasText(u)) layer.paint(u, settings);
    else layer.paintHint(u, settings);
  }
  const overflowing = [...units].filter((u) => u.overflowsBox).length;
  if (overflowing !== lastOverflowCount) {
    lastOverflowCount = overflowing;
    if (overflowing > 0) diag('info', 'content-overflows-box', { count: overflowing });
  }
  applyChromeClip();
  if (firstPaintMs < 0 && paintable.length > 0) {
    firstPaintMs = Math.round(performance.now() - startedAt);
    dbg('first paint', firstPaintMs, 'ms', effective);
  }
  updateHud();
  scheduleIntake();
}

/* ---------------------------------------------------------------- L0 即時層 */

/**
 * feature.md §4.6 / D23:先問快取。命中就直接以 L1 譯文渲染,跳過 L0,
 * 第二次讀同一頁不該先閃一次 L0。
 */
async function intake(): Promise<void> {
  if (!running) return;
  if (!settings.autoTranslate && !manualArmed) {
    updateHud();
    return;
  }

  if (effective === 'single') {
    // Phase 1 的路徑:要花錢,所以嚴守可見區
    const visible = [...units].filter(
      (u) => u.tier === 'pending' && u.inView && u.maxChars > 0 && !probed.has(u),
    );
    if (visible.length === 0) return;
    for (const u of visible) probed.add(u);
    queueUpgrade(visible);
    return;
  }

  // L0 免費且在本機,取材範圍可以遠大於可見區
  const ahead = lookaheadPx();
  const top = window.scrollY - ahead;
  const bottom = window.scrollY + window.innerHeight + ahead;
  const fresh = [...units].filter(
    (u) =>
      u.tier === 'pending' &&
      u.maxChars > 0 &&
      !probed.has(u) &&
      u.rect.top + u.rect.height >= top &&
      u.rect.top <= bottom,
  );
  if (fresh.length === 0) return;
  // 先翻使用者現在看得到的:預翻範圍拉大之後,順序比以前更重要
  fresh.sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const u of fresh) probed.add(u);

  /*
   * 快取查詢**不擋** L0。
   *
   * 之前這裡是 `await probeCache()` 再跑 L0,而那是一次到 service worker 的
   * 往返(SW 睡著時還要先喚醒)—— L0 還沒開始就先等了幾百毫秒,
   * 而 L0 存在的唯一理由就是快。
   *
   * 兩邊同時跑:快取先回來的話,runL0 裡面會跳過已經有 L1 譯文的區塊,
   * D23「快取命中不閃 L0」在多數情況下仍然成立(SW 熱的時候查詢很快)。
   */
  const probing = probeCache(fresh).then((hits) => {
    for (const u of fresh) {
      const hit = hits.get(u.id);
      if (hit === undefined) continue;
      u.l1Text = hit;
      u.tier = 'l1';
    }
    if (hits.size > 0) scheduleFlush();
    return hits.size;
  });

  const l0 = runL0(fresh);
  const [cacheHits] = await Promise.all([probing, l0]);
  diag('info', 'intake', { fresh: fresh.length, cacheHits, lookahead: ahead });
}

async function probeCache(list: Unit[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!usesL1(effective)) return out;
  const res = await ask<{ hits: UnitResult[] }>({
    type: 'cache-probe',
    tier: state.tier,
    units: list.map((u) => ({ id: u.id, src: u.src, maxChars: u.maxChars })),
  });
  for (const h of res?.hits ?? []) out.set(h.id, h.t);
  return out;
}

/** feature.md §3 L0:毫秒級、零成本。疊層立刻出現。 */
async function runL0(list: Unit[]): Promise<void> {
  if (list.length === 0) return;
  const engine = l0;
  if (!engine) {
    // 沒有 L0 可用:progressive 已經在 start() 退回 single,這裡只剩 l0-only
    for (const u of list) u.tier = 'failed';
    scheduleFlush();
    return;
  }
  const startedAt = performance.now();
  await Promise.all(
    list.map(async (u) => {
      // 快取比 L0 先回來 → 不必翻了(D23:不閃 L0)
      if (u.l1Text !== undefined) return;
      // §3.4 送出前把行內 code 與不翻清單換成佔位符
      const masked = mask(u.src, protectedFragments(u.el, settings.noTranslateTerms));
      // 距視窗中心越近越先翻 —— 捲到新一屏時會插隊到預翻的遠處區塊前面
      const raw = await engine.translate(masked.text, Math.round(priorityOf(u)));
      if (raw === null) {
        u.tier = effective === 'l0-only' ? 'failed' : 'l0-failed';
        u.failReason = 'l0';
        return;
      }
      const restored = masked.restore(raw);
      if (restored === null) {
        // 佔位符被翻掉或吃掉 —— 寧可算失敗,也不要交出少了程式碼的譯文
        u.tier = effective === 'l0-only' ? 'failed' : 'l0-failed';
        u.failReason = 'l0-placeholder';
        dbg('l0 placeholder lost', u.id);
        return;
      }
      u.l0Text = restored;
      u.tier = 'l0';
      // **逐塊上畫**。之前整批做完才 flush 一次 —— 一批 16 塊、每塊 850ms,
      // 於是 13.6 秒內畫面上什麼都沒有(log 的首屏 13970ms 就是這樣來的)。
      // scheduleFlush 自帶 120ms debounce,不會變成每塊一次重排。
      scheduleFlush();
    }),
  );
  scheduleFlush();
  const failedL0 = list.filter((u) => u.tier === 'l0-failed' || u.tier === 'failed').length;
  const ms = Math.round(performance.now() - startedAt);
  diag(failedL0 > 0 ? 'warn' : 'info', 'l0-done', {
    asked: list.length,
    failed: failedL0,
    // batchMs 是整批的牆鐘時間(含排隊);call 才是 translate() 本身的延遲。
    // 兩個分開才知道慢在 API 還是慢在我們自己的併發池。
    batchMs: ms,
    call: engine.timing(),
  });
  // §4.4 規則 1:這一輪 L0 收斂之後就把字級分組定案
  lockAfterL0();
}

/**
 * feature.md §4.4 規則 1:字級分組在 L0 全部完成時定案並鎖定。
 * 「全部完成」以目前可見區內沒有還在跑 L0 的區塊為準 ——
 * 整頁等到底會讓鎖定永遠不發生(捲動會一直帶來新區塊)。
 */
function lockAfterL0(): void {
  if (effective === 'single') return;
  const stillWorking = [...units].some(
    (u) => u.inView && u.tier === 'pending' && u.maxChars > 0,
  );
  if (stillWorking) return;
  requestAnimationFrame(() => {
    const n = lockScales([...units]);
    if (n > 0) dbg('locked font sizes', n);
  });
}

/* ---------------------------------------------------------------- L1 升級層 */

/** feature.md §4.2 距視窗中心越近越優先 */
function priorityOf(u: Unit): number {
  return priorityFor(u.rect.top, u.rect.height, window.scrollY, window.innerHeight);
}

function queueUpgrade(list: Unit[]): void {
  if (list.length === 0 || !usesL1(effective)) return;
  const payload: UnitRequest[] = [];
  const priorities: Record<string, number> = {};
  for (const u of list) {
    u.l1Queued = true;
    u.upgradeQueuedAt = Date.now();
    // §4.4 / D20:升級用的長度預算以鎖定字級的容量算,不是來源幾何
    const budget = u.lockedFontSize > 0 ? maxCharsForUpgrade(u) : u.maxChars;
    payload.push({ id: u.id, src: u.src, maxChars: budget, role: u.role });
    priorities[u.id] = Math.round(priorityOf(u));
  }
  send({
    type: 'enqueue',
    pageKey,
    tier: state.tier,
    pipeline: effective,
    units: payload,
    priorities,
  });
  dbg('queue L1', payload.length, effective);
  diag('info', 'queue-l1', { units: payload.length, tier: state.tier, pipeline: effective });
  updateHud();
}

/**
 * feature.md §4.2 / D21:可見且**停留超過 1.5 秒**才排入 L1。
 * 純粹滑過去的區塊留在 L0,不花錢 —— 這一條直接對治
 * 「有 L0 打底反而燒更多」。
 */
function dwellTick(): void {
  if (!running || effective !== 'progressive') return;
  const now = Date.now();
  const due = [...units].filter((u) => dwellReady(u, now, settings.upgradeDwellMs, effective));
  if (due.length > 0) {
    due.sort((a, b) => priorityOf(a) - priorityOf(b));
    queueUpgrade(due);
  }
}

/** feature.md §4.2 使用者捲動時重排佇列;已送出的請求不取消(取消不會退錢) */
function reprioritize(): void {
  if (effective !== 'progressive') return;
  const priorities: Record<string, number> = {};
  let n = 0;
  for (const u of units) {
    if (!u.l1Queued || u.l1Text !== undefined) continue;
    priorities[u.id] = Math.round(priorityOf(u));
    n++;
  }
  if (n > 0) send({ type: 'reprioritize', pageKey, priorities });
}

/* ------------------------------------------------------------------ 替換 */

/**
 * feature.md §4.3 不得替換使用者當前正在互動的區塊。
 * - hover 中(正在顯示原文)→ mouseleave 後再換
 * - 在可見區中央三分之一且距上次捲動 < 400ms → 延後 400ms 再試
 */
function canSwapNow(u: Unit): boolean {
  return swapAllowed({
    isHovered: hovered === u,
    sinceScrollMs: performance.now() - lastScrollAt,
    rectTop: u.rect.top,
    rectHeight: u.rect.height,
    scrollY: window.scrollY,
    viewportH: window.innerHeight,
  });
}

function isOnScreen(u: Unit): boolean {
  const top = u.rect.top - window.scrollY;
  return top + u.rect.height > 0 && top < window.innerHeight;
}

function trySwap(u: Unit): void {
  if (!layer || u.pendingSwap === undefined) return;
  if (!canSwapNow(u)) {
    window.setTimeout(() => trySwap(u), 420);
    return;
  }
  u.l1Text = u.pendingSwap;
  u.pendingSwap = undefined;
  u.tier = 'l1';
  u.overflowing = checkOverflow(u);
  swapsTotal++;
  if (!isOnScreen(u)) swapsOffscreen++;
  layer.swap(u, settings);
}

function applyResults(results: UnitResult[]): void {
  let needFlush = false;
  for (const r of results) {
    const u = unitById.get(r.id);
    if (!u) continue;
    if (u.kind === 'label') {
      // 記進 memo 並散給所有同文字的單元(rememberLabel 會避開開著的那一個)
      rememberLabel(u.src, { l1: r.t });
      if (chipUnit === u || altScan) renderChips();
      continue;
    }
    if (u.l0Text === undefined) {
      // single 模式,或 L0 失敗後才回來的 L1:沒有舊內容,直接畫
      u.l1Text = r.t;
      u.tier = 'l1';
      needFlush = true;
      continue;
    }
    if (u.l1Text === r.t) continue;
    u.pendingSwap = r.t;
    trySwap(u);
  }
  if (needFlush) scheduleFlush();
  // 有東西回來就代表管線是活的
  if (results.length > 0) lastProblem = '';
  updateHud();
}

/* ---------------------------------------------------------- 加翻層:實作 */

/** 從一個元素做出 label 單元。掃描與臨時加翻共用同一條路 */
function makeLabelUnit(el: Element, src: string, register = true): Unit {
  const style = probeStyle(el, settings.weightOffset);
  const unit: Unit = {
    id: `u${nextId++}`,
    el,
    kind: 'label',
    role: 'label',
    src,
    style,
    geometryRisk: false,
    annotation: false,
    singleLine: true,
    sizeGroup: 0,
    scale: 1,
    // 貼片沒有幾何上限,預算限的是簡潔,不是塞不塞得下
    maxChars: labelBudget(src),
    rect: { left: 0, top: 0, width: 0, height: 0 },
    bleed: { x: 0, y: 0 },
    overflowsBox: false,
    firstRectTop: 0,
    lastRectBottom: 0,
    textHeight: 0,
    tier: 'pending',
    l1Queued: false,
    lockedFontSize: 0,
    inView: false,
    overflowing: false,
  };
  if (register) labelByEl.set(el, unit);
  labels.add(unit);
  unitById.set(unit.id, unit);
  // 同一段文字別的地方已經翻過了 → 立刻就有,不必再送一次
  adoptMemo(unit);
  return unit;
}

/**
 * 建立 label 單元。可以重複呼叫,已建過的元素會跳過。
 *
 * 和 scan() 一樣是增量的 —— 頁面上的導覽列不會變,但無限捲動會帶來新的卡片,
 * 而卡片上的 CTA 也是 label。
 */
function scanLabels(): void {
  if (!settings.annotate) return;
  if (labels.size >= ANNOTATION_CAP) return;
  const found = findLabels(document.body, ANNOTATION_CAP, (el) => labelByEl.has(el));
  let added = 0;
  for (const c of found) {
    if (labels.size >= ANNOTATION_CAP) break;
    makeLabelUnit(c.el, c.src);
    added++;
  }
  if (added > 0) dbg('scan labels', { added, total: labels.size });
}

/**
 * 同一段文字的譯文共用一份。
 *
 * 上一版是在**偵測**層去重:同樣的文字只留第一個元素。那是錯的 ——
 * 卡片牆上十二張卡都寫「詳細を見る」,十二個都要能 hover;
 * 而「お問い合わせ」在導覽列與段落標題各出現一次,使用者指的是後者。
 * 症狀就是回報的「只會翻一個,不會延用在其他的」。
 *
 * 去重要做在**翻譯**層:每個元素都有自己的單元(所以都能 hover),
 * 但同一段文字只送一次 API,回來之後散給所有同文字的單元。
 */
const labelMemo = new Map<string, { l0?: string; l1?: string }>();
/** 已經送過 L1 的文字,不重複送 */
const labelQueuedText = new Set<string>();

function adoptMemo(u: Unit): void {
  const memo = labelMemo.get(u.src);
  if (!memo) return;
  if (memo.l0 !== undefined && u.l0Text === undefined) u.l0Text = memo.l0;
  if (memo.l1 !== undefined && u.l1Text === undefined) u.l1Text = memo.l1;
  if (u.l1Text !== undefined) u.tier = 'l1';
  else if (u.l0Text !== undefined) u.tier = 'l0';
}

function rememberLabel(src: string, patch: { l0?: string; l1?: string }): void {
  const memo = labelMemo.get(src) ?? {};
  labelMemo.set(src, { ...memo, ...patch });
  for (const u of labels) {
    if (u.src !== src) continue;
    // 貼片開著的那一個不在這裡換字(§4.3);由 flushLabelSwap 收尾
    if (patch.l1 !== undefined && chipUnit === u && layer?.chipsVisible()) {
      if (u.l1Text !== patch.l1) u.pendingSwap = patch.l1;
      continue;
    }
    adoptMemo(u);
  }
}

/**
 * 貼片的錨點。預設是來源元素的矩形,但選取範圍沒有「一個元素」——
 * 那時錨點要跟著 Range 走。
 */
const anchorOverride = new WeakMap<Unit, () => DOMRect | null>();

function anchorRectOf(u: Unit): DOMRect | null {
  const override = anchorOverride.get(u);
  if (override) return override();
  const r = u.el.getBoundingClientRect();
  return r.width <= 0 && r.height <= 0 ? null : r;
}

/**
 * 臨時加翻:指到任何**沒有被別的畫法接手**的文字,就當場翻它。
 *
 * 掃描出來的 label 只涵蓋互動元素,而使用者的心智模型是
 * 「我指到什麼就翻什麼」。回報的「有些 mouse over 後也不會翻」多半落在
 * 偵測規則的縫裡 —— 標題被十幾條規則的某一條擋掉、容器判定不算段落、
 * 或那一塊根本不在互動元素裡。與其一條條猜,不如讓 hover 本身變成兜底。
 *
 * 往上找**自己就有文字**的最近祖先。上限 240 字:再長就是段落,
 * 那是疊翻的守備範圍,塞進貼片只會變成一面牆。
 */
const ADHOC_MAX_CHARS = 240;
const ADHOC_HOPS = 6;
/**
 * 看過但不合格的元素。mouseover 在導覽列上會反覆打到同一批元素,
 * 沒有這個集合就會一直重跑 ownText 與樣式查詢。
 */
const adhocRejected = new WeakSet<Element>();

function adhocLabelAt(target: EventTarget | null): Unit | null {
  if (!settings.annotate) return null;
  if (!(target instanceof Element)) return null;
  let el: Element | null = target;
  for (let i = 0; el && i < ADHOC_HOPS && el !== document.body; i++, el = el.parentElement) {
    const known = labelByEl.get(el);
    if (known) return known;
    if (unitByEl.has(el)) return null; // 內文區塊有自己的畫法
    if (adhocRejected.has(el)) continue;
    if (labels.size >= ANNOTATION_CAP) return null;
    // 底下還有帶文字的結構性區塊 → 這是容器,翻它等於把一整段塞進貼片
    if (hasContainerChild(el)) {
      adhocRejected.add(el);
      continue;
    }
    const text = normalizeText(ownText(el));
    if (
      text.length === 0 ||
      text.length > ADHOC_MAX_CHARS ||
      !isMeaningfulText(text) ||
      looksLikeTargetLang(text) ||
      el.getClientRects().length === 0
    ) {
      adhocRejected.add(el);
      continue;
    }
    diag('info', 'adhoc-label', { chars: text.length, tag: el.tagName });
    return makeLabelUnit(el, text);
  }
  return null;
}

/* --------------------------------------------------------------- 選取加翻 */

/**
 * 選起來的文字也算「指到」。
 *
 * 這是兜底的兜底:hover 找的是元素,而使用者想知道的可能是一句話的一半、
 * 或跨越好幾個元素的一段。選取是最明確的「我要這一段」的表達,
 * 所以不必等停留 180ms,選完就出。
 */
const SELECTION_MIN_CHARS = 2;
const SELECTION_DEBOUNCE_MS = 250;

let selectionUnit: Unit | null = null;
let selectionTimer = 0;

function onSelectionChange(): void {
  if (!running || !settings.annotate) return;
  clearTimeout(selectionTimer);
  // 拖曳選取的過程中 selectionchange 會連續觸發,等手放開再說
  selectionTimer = window.setTimeout(applySelection, SELECTION_DEBOUNCE_MS);
}

function applySelection(): void {
  if (!running || !layer) return;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    if (selectionUnit && chipUnit === selectionUnit) closeChip(true);
    selectionUnit = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const text = normalizeText(sel.toString());
  if (text.length < SELECTION_MIN_CHARS || text.length > ADHOC_MAX_CHARS) return;
  if (!isMeaningfulText(text) || looksLikeTargetLang(text)) return;
  const host = range.commonAncestorContainer;
  const el = host instanceof Element ? host : host.parentElement;
  if (!el) return;

  if (selectionUnit?.src !== text) {
    // register: false —— 不佔用 labelByEl,那個是給元素用的
    selectionUnit = makeLabelUnit(el, text, false);
    anchorOverride.set(selectionUnit, () => {
      const s2 = document.getSelection();
      if (!s2 || s2.isCollapsed || s2.rangeCount === 0) return null;
      return s2.getRangeAt(0).getBoundingClientRect();
    });
    diag('info', 'selection-label', { chars: text.length });
  }
  openChip(selectionUnit, true);
}

/** 事件目標 → label 單元。hover 到的多半是連結裡的 span,要往上找互動元素 */
function labelAt(target: EventTarget | null): Unit | null {
  if (!(target instanceof Element)) return null;
  const act = target.closest(INTERACTIVE_SELECTOR);
  return act ? (labelByEl.get(act) ?? null) : null;
}

/**
 * 貼片的視覺取自來源元素,讓它看起來像頁面的一部分。
 * 取不到不透明背景時(§4.1 的 backgroundRisk)才自己挑一個 ——
 * 依文字顏色的亮度決定深底或淺底,免得深色頁面上冒出一塊白。
 */
function chipStyleFor(u: Unit): ChipItem['style'] {
  const fg = u.style.color;
  let bg = u.style.background;
  if (bg === null) {
    const c = parseColor(fg);
    const lum = c ? (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255 : 0;
    bg = lum > 0.6 ? '#14181d' : '#f6f8fa';
  }
  const line = hintColor(fg);
  return {
    background: bg,
    color: fg,
    line,
    bar: line,
    // 永遠不比原文大;13px 是「讀得到但不搶戲」的上限
    fontSizePx: Math.min(13, Math.max(11, Math.round(u.style.fontSizePx))),
  };
}

function chipItemFor(u: Unit): ChipItem | null {
  const r = anchorRectOf(u);
  if (!r) return null;
  const failed = isFailedTier(u.tier) && u.l0Text === undefined;
  const text = failed ? u.src : (activeText(u) ?? '⋯');
  const tone: ChipItem['tone'] = failed
    ? 'warn'
    : u.tier === 'l1-failed'
      ? 'warn'
      : u.l1Text !== undefined
        ? 'l1'
        : 'l0';
  return {
    text,
    anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
    tone,
    style: chipStyleFor(u),
  };
}

/** 可見區內的 label,給 Alt 掃視用 */
function visibleLabels(): Unit[] {
  const out: Unit[] = [];
  for (const u of labels) {
    const r = anchorRectOf(u);
    if (!r || r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    if (r.right < 0 || r.left > window.innerWidth) continue;
    out.push(u);
  }
  return out;
}

/** 把目前該顯示的貼片畫出來(hover 一個,或 Alt 掃視一整批) */
function renderChips(): void {
  if (!layer || !settings.annotate) return;
  const list = altScan ? visibleLabels() : chipUnit ? [chipUnit] : [];
  if (list.length === 0) {
    layer.hideChips();
    return;
  }
  const items: ChipItem[] = [];
  for (const u of list) {
    const item = chipItemFor(u);
    if (item) items.push(item);
  }
  layer.showChips(items);
}

/**
 * feature.md §4.3 的規則在貼片上同樣成立:**開著的時候不換字**。
 * 貼片只有幾個字、讀完不到半秒,在使用者眼皮下換掉就是那條規則講的事。
 * 所以 L1 回來時掛在 pendingSwap,關掉才套用。
 */
function flushLabelSwap(u: Unit): void {
  if (u.pendingSwap === undefined) return;
  u.l1Text = u.pendingSwap;
  u.pendingSwap = undefined;
  u.tier = 'l1';
}

/** L0 翻一個標籤。和 runL0 同一套佔位符保護,但不碰幾何、不 flush */
async function translateLabel(u: Unit): Promise<void> {
  adoptMemo(u);
  if (u.tier !== 'pending') return;
  if (!usesL0(effective) || !l0) return;
  const masked = mask(u.src, protectedFragments(u.el, settings.noTranslateTerms));
  // 使用者正指著它 —— 優先度最高,插到所有預翻的區塊前面
  const raw = await l0.translate(masked.text, -1);
  if (u.tier !== 'pending') return; // 期間快取或 L1 已經回來了
  const restored = raw === null ? null : masked.restore(raw);
  if (restored === null) {
    u.tier = effective === 'l0-only' ? 'failed' : 'l0-failed';
    u.failReason = 'l0';
  } else {
    u.l0Text = restored;
    u.tier = 'l0';
    // 散給所有同文字的單元:卡片牆上的十二張卡一次到位
    rememberLabel(u.src, { l0: restored });
  }
  if (chipUnit === u || altScan) renderChips();
}

/**
 * 同一組:hover 一個導覽項目,把整條導覽列一起送 L1。
 *
 * 一次 batch 12 個短字串比 12 次單筆 batch 便宜得多,而且使用者滑到
 * 第二個項目時譯文已經在了。組 = 最近的 nav / ul / [role=menu] …,
 * 找不到就只送自己。
 */
function groupOf(u: Unit): Unit[] {
  const pool: Unit[] = [u];
  const box = u.el.closest(GROUP_SELECTOR);
  if (box) for (const peer of labels) if (peer !== u && box.contains(peer.el)) pool.push(peer);
  const out = dedupeByText(pool, labelQueuedText);
  for (const p of out) labelQueuedText.add(p.src);
  return out;
}

function armChipL1(u: Unit): void {
  clearTimeout(chipL1Timer);
  if (!usesL1(effective)) return;
  chipL1Timer = window.setTimeout(() => {
    if (chipUnit !== u || !running) return;
    const group = groupOf(u);
    if (group.length > 0) queueUpgrade(group);
  }, CHIP_L1_MS);
}

function openChip(u: Unit, immediate = false): void {
  if (!settings.annotate || !running) return;
  // 選取是明確的「我要這一段」,不受「只在 Alt 時顯示」與捲動靜默的限制
  if (!immediate) {
    if (settings.annotateAltOnly && !altScan) return;
    // 捲動中冒出貼片是噪音
    if (performance.now() - lastScrollAt < CHIP_SCROLL_QUIET_MS) return;
  }
  clearTimeout(chipCloseTimer);
  clearTimeout(chipOpenTimer);
  if (chipUnit === u && layer?.chipsVisible()) return;
  /*
   * 已經有貼片開著就**立刻**換,不重新等 180ms。
   * tooltip group 的標準行為:第一次要等,之後不用 ——
   * 使用者已經表達過「我在看這一排」了。
   */
  const wait = immediate || layer?.chipsVisible() ? 0 : CHIP_OPEN_MS;
  chipOpenTimer = window.setTimeout(() => {
    if (!running) return;
    const prev = chipUnit;
    if (prev && prev !== u) flushLabelSwap(prev);
    chipUnit = u;
    renderChips();
    void translateLabel(u);
    armChipL1(u);
  }, wait);
}

function closeChip(immediate = false): void {
  clearTimeout(chipOpenTimer);
  clearTimeout(chipL1Timer);
  clearTimeout(chipCloseTimer);
  const done = (): void => {
    const prev = chipUnit;
    chipUnit = null;
    if (prev) flushLabelSwap(prev);
    if (altScan) renderChips();
    else layer?.hideChips();
  };
  if (immediate) done();
  else chipCloseTimer = window.setTimeout(done, CHIP_CLOSE_MS);
}

/** 鍵盤使用者走 Tab 也要看得到 —— hover-only 的資訊等於不存在 */
function onFocusIn(e: Event): void {
  const u = labelAt(e.target);
  if (u) openChip(u);
  else if (chipUnit) closeChip();
}

/* ------------------------------------------------------------------ hover */

/**
 * 失敗的區塊 hover 一下就重新排隊。
 *
 * 紅線代表「這塊翻不出來」,而使用者發現它的時機幾乎一定是把滑鼠移過去
 * 看原文的那一刻 —— 那時候要求他再去按一次 popup 的「翻譯」(那會把
 * **整頁**的失敗區塊全部重來)實在太笨。停留一下就悄悄補翻這一塊。
 *
 * 每塊最多兩次,而且要停留 400ms:滑過去不算,免得滑鼠掃過一片紅線
 * 就送出一堆請求(L1 是要錢的)。
 */
const HOVER_RETRY_DWELL_MS = 400;
const HOVER_RETRY_MAX = 2;
const hoverRetries = new WeakMap<Unit, number>();
let hoverRetryTimer: number | undefined;

function armHoverRetry(u: Unit | null): void {
  if (hoverRetryTimer !== undefined) {
    clearTimeout(hoverRetryTimer);
    hoverRetryTimer = undefined;
  }
  if (!u || !running) return;
  const used = hoverRetries.get(u) ?? 0;
  if (!hoverRetryReady(u, used, HOVER_RETRY_MAX)) return;
  hoverRetryTimer = window.setTimeout(() => {
    hoverRetryTimer = undefined;
    // 停留期間可能已經移開,或被別的路徑補翻好了
    if (hovered !== u || !running || !isFailedTier(u.tier)) return;
    hoverRetries.set(u, used + 1);
    retryUnit(u);
  }, HOVER_RETRY_DWELL_MS);
}

function retryUnit(u: Unit): void {
  const from = u.tier;
  u.failReason = undefined;
  u.l1Queued = false;
  u.upgradeQueuedAt = undefined;
  probed.delete(u);
  if (u.l0Text !== undefined) {
    // L0 有譯文、掛掉的是 L1:直接重排 L1,不再等 §4.2 的停留時間 ——
    // 使用者的滑鼠**就停在上面**,停留條件早就滿足了。
    u.tier = 'l0';
    if (usesL1(effective)) queueUpgrade([u]);
  } else {
    // 連 L0 都沒有:退回 pending,讓 intake() 照正常流程重跑一次
    u.tier = 'pending';
    void intake();
  }
  lastProblem = '';
  diag('info', 'hover-retry', { id: u.id, from, attempt: (hoverRetries.get(u) ?? 0) });
  scheduleFlush();
}

/**
 * §2.2 疊層 pointer-events: none,所以 hover 只能由來源元素反向驅動。
 */
function onMouseOver(e: Event): void {
  if (!layer) return;
  let node: Node | null = e.target as Node | null;
  let found: Unit | null = null;
  while (node && node !== document.body) {
    if (node instanceof Element) {
      const u = unitByEl.get(node);
      if (u) {
        found = u;
        break;
      }
    }
    node = node.parentNode;
  }
  /*
   * 加翻層:內文區塊優先(它有自己的畫法),否則試 UI 標籤,
   * 再否則臨時加翻 —— 指到什麼就翻什麼,不讓偵測規則的縫變成「都不會翻」。
   */
  const label = found ? null : (labelAt(e.target) ?? adhocLabelAt(e.target));
  if (label) openChip(label);
  else if (chipUnit && chipUnit !== selectionUnit) closeChip();

  if (found === hovered) return;
  const left = hovered;
  hovered = found;
  layer.setHovered(found, units);
  // §4.3 hover 結束後才執行延後的替換
  if (left?.pendingSwap !== undefined) trySwap(left);
  armHoverRetry(found);
}

function onKeyDown(e: KeyboardEvent): void {
  // §2.1 按住 Alt → 所有疊層切換為標註樣式,用於快速掃視哪些區塊被翻了
  if (e.key === 'Alt' && !altScan) {
    altScan = true;
    layer?.setAltScan(true);
    // Alt 同時是加翻層的「全部顯示」:掃視的語彙沿用同一顆鍵
    renderChips();
  }
  if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault();
    toggleDebugPanel();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Alt' && altScan) {
    altScan = false;
    layer?.setAltScan(false);
    renderChips();
  }
}

function onBlur(): void {
  if (altScan) {
    altScan = false;
    layer?.setAltScan(false);
    renderChips();
  }
  closeChip(true);
}

/**
 * §6.4 第三層防線 + feature.md §5.3:原文 / L0 / L1 三欄並列。
 * 優先抽已升級的區塊 —— 那才看得出 L1 值不值得那些錢。
 */
function toggleDebugPanel(): void {
  if (!layer) return;
  if (layer.hasSample()) {
    layer.hideSample();
    return;
  }
  const all = [...units];
  const upgraded = all.filter((u) => u.l1Text !== undefined && u.l0Text !== undefined);
  const pool = upgraded.length >= 5 ? upgraded : [...upgraded, ...all.filter(hasText)];
  const pick: Unit[] = [];
  const seen = new Set<Unit>();
  while (pick.length < 5 && pool.length > 0) {
    const [u] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    pick.push(u);
  }
  const c = tierCounts();
  layer.showSample(
    pick,
    `${effective} · L0 ${c.l0} / L1 ${c.l1} / 失敗 ${c.failed + c['l1-failed']} / 溢出 ${
      all.filter((u) => u.overflowing).length
    } · 首屏 ${firstPaintMs}ms`,
  );
}

/* ---------------------------------------------------------------- 狀態列 */

/**
 * §5.2「模型 ID 必須驗證,不要等到執行時才 400」。
 * worker 啟動時已經比對過 /v1beta/models,這裡只是把結果講給使用者聽 ——
 * 不然 free 檔的 ID 打錯時,畫面上只會是「一直沒有東西回來」。
 */
async function checkModelId(): Promise<void> {
  if (!usesL1(effective)) return;
  try {
    const got = await chrome.storage.local.get('modelCheck');
    const check = got['modelCheck'] as
      | { problems: Array<{ tier: string; modelId: string; issue: string }> }
      | undefined;
    const bad = check?.problems.find((p) => p.tier === state.tier);
    if (!bad) return;
    lastProblem =
      bad.issue === 'blocked'
        ? `${bad.tier} 檔的 ${bad.modelId} 在排除清單上`
        : `${bad.tier} 檔的模型 ID 不存在:${bad.modelId}`;
  } catch {
    /* 沒驗過就算了,送出時的 notice 仍然會講 */
  }
}

/**
 * 使用者的原話:「翻譯中還是沒翻譯沒有明確的 status」。
 * 疊層在「還沒送出」「送出了在等」「已經死了」三種情況下長得一模一樣,
 * 所以狀態必須自己講出來。
 */
function updateHud(): void {
  if (!layer) return;
  if (!settings.hud) {
    layer.hideHud();
    return;
  }
  const c = tierCounts();
  const failed = c.failed + c['l1-failed'];
  let waiting = 0;
  let nearPending = 0;
  let farPending = 0;
  for (const u of units) {
    if (u.l1Queued && u.l1Text === undefined) waiting++;
    if (u.tier !== 'pending' && u.tier !== 'l0-failed') continue;
    if (u.maxChars <= 0) continue; // 塞不下的本來就不翻,不算「在等」
    /*
     * 「已經開口要了」也算在跑,即使它在畫面外:預翻範圍比視窗大,
     * 那些請求已經在 L0 的併發池裡。只看 inView 會在送出與回來之間
     * 閃一次「完成」。
     */
    const asked = u.tier === 'pending' && probed.has(u);
    if (u.inView || asked) nearPending++;
    else farPending++;
  }

  if (lastProblem) {
    layer.setHud(`疊 · ${lastProblem}`, 'warn');
    return;
  }
  if (units.size === 0) {
    const retrying = emptyScans > 0 && emptyScans <= EMPTY_SCAN_RETRIES.length;
    if (retrying) {
      layer.setHud('疊 · 掃描中…', 'busy');
      return;
    }
    // 沒有內文段落不代表沒東西可看:導覽列與按鈕仍然可以加翻
    const tail = labels.size > 0 ? `,${labels.size} 個標籤可加翻(滑上去看)` : '';
    layer.setHud(`疊 · 沒找到可翻譯的段落${tail}`, 'idle');
    return;
  }
  if (!settings.autoTranslate && !manualArmed) {
    layer.setHud(`疊 · 已啟用,${units.size} 塊待翻 —— 按 Alt+Shift+R 或 popup 開始`, 'idle');
    return;
  }
  const parts: string[] = [];
  if (c.l0 > 0) parts.push(`L0 ${c.l0}`);
  if (c.l1 > 0) parts.push(`L1 ${c.l1}`);
  if (failed > 0) parts.push(`失敗 ${failed}`);
  if (settings.annotate && labels.size > 0) parts.push(`標籤 ${labels.size}`);
  const heldBack = [...units].filter((u) => u.pendingSwap !== undefined).length;
  if (heldBack > 0) parts.push(`待換 ${heldBack}`);

  const phase = translationPhase({
    waiting,
    nearPending,
    farPending,
    l0Busy: l0?.busy() ?? false,
  });
  if (phase === 'busy') {
    const tail =
      waiting > 0
        ? `等 ${effective === 'single' ? 'L1' : '升級'} ${waiting}`
        : nearPending > 0
          ? `待翻 ${nearPending}`
          : '翻譯中…';
    layer.setHud(`疊 · ${[...parts, tail].join(' · ')}`, 'busy');
    return;
  }
  if (parts.length === 0) {
    layer.setHud('疊 · 沒有需要翻譯的內容', 'idle');
    return;
  }
  /*
   * 跑完了就說完了,然後讓它淡出 —— 常駐的狀態列是噪音。
   * 「這一屏完成」不是客套話:頁面下面還有沒輪到的區塊時說「完成」是騙人的,
   * 而使用者需要知道那是「捲下去會繼續」而不是「漏掉了」。
   */
  const done = phase === 'all-done' ? '完成' : '這一屏完成,捲動繼續翻';
  // 有紅的就順便講怎麼救 —— 使用者不會知道 hover 可以重試
  const tail = failed > 0 ? ' · 滑到紅線上重試' : ` · ${done}`;
  layer.setHud(`疊 · ${parts.join(' · ')}${tail}`, failed > 0 ? 'warn' : 'idle');
}

/* ------------------------------------------------------------------ 統計 */

function tierCounts(): Record<UnitTier, number> {
  const c: Record<UnitTier, number> = {
    pending: 0,
    l0: 0,
    l1: 0,
    'l0-failed': 0,
    'l1-failed': 0,
    failed: 0,
    skipped: 0,
  };
  for (const u of units) c[u.tier]++;
  return c;
}

/** feature.md §5.2 L1 = 0 且佇列非空持續超過 10 秒 → popup 明確警示 */
function stalledMs(): number {
  const c = tierCounts();
  if (c.l1 > 0) return 0;
  let oldest = 0;
  for (const u of units) {
    if (!u.l1Queued || u.l1Text !== undefined) continue;
    const age = Date.now() - (u.upgradeQueuedAt ?? Date.now());
    if (age > oldest) oldest = age;
  }
  return oldest;
}

function pageStats(): PageStats {
  const ms = stalledMs();
  return {
    pipeline: state?.pipeline ?? 'single',
    effective,
    counts: tierCounts(),
    total: units.size,
    firstPaintMs,
    stalled: usesL1(effective) && ms > STALL_MS,
    stalledMs: ms,
    l0: {
      supported: translatorSupported(),
      state: l0?.state ?? (translatorSupported() ? 'idle' : 'unsupported'),
      sourceLang: l0?.sourceLang ?? pageSourceLang(settings?.l0SourceLang ?? 'en'),
      progress: l0?.progress ?? 0,
      detail: l0?.detail ?? '',
    },
    swapsOffscreen,
    swapsTotal,
  };
}

/* ------------------------------------------------------------ 生命週期 */

function scheduleIntake(): void {
  if (enqueueTimer) return;
  enqueueTimer = window.setTimeout(() => {
    enqueueTimer = 0;
    void intake();
  }, 60);
}

async function start(): Promise<void> {
  if (running) return;
  running = true;
  startedAt = performance.now();
  firstPaintMs = -1;
  await probePackagedFonts();
  resetHintColor();
  clearMeasureCache();

  // 整頁的字集要在掃描之前定案:日文 / 韓文頁面的純漢字標題不能被當成
  // 「已經是中文」而跳過(見 detect.ts 的 setPageScript)
  const sample = sampleVisibleText();
  const script = sniffScript(sample);
  setPageScript(script);

  // feature.md §6:不支援就退回 single 並告知,不報錯
  effective = state.pipeline;
  diag('info', 'start', {
    script,
    pipeline: state.pipeline,
    tier: state.tier,
    mode: state.mode,
    translatorSupported: translatorSupported(),
    autoTranslate: settings.autoTranslate,
  });
  if (usesL0(effective)) {
    if (translatorSupported()) {
      l0 = new L0Engine(
        pageSourceLang(settings.l0SourceLang, sample),
        toTranslatorTarget(settings.targetLang),
      );
      // 語言包已在本機時這裡就會成功;需要下載時走 needs-gesture,由 popup 接手
      void l0.ensure();
    } else if (effective === 'progressive') {
      effective = 'single';
      diag('warn', 'l0-unsupported', '沒有 Translator API,progressive 退回 single');
      console.warn('[kasanemu] 這個環境沒有 Translator API,漸進式翻譯已退回 single 模式');
    } else {
      console.warn('[kasanemu] 這個環境沒有 Translator API,l0-only 模式無法翻譯');
    }
  }

  layer = new OverlayLayer();
  layer.setMode(state.mode);
  await checkModelId();

  io = new IntersectionObserver(
    (entries) => {
      let hit = false;
      for (const en of entries) {
        const u = unitByEl.get(en.target);
        if (!u) continue;
        u.inView = en.isIntersecting;
        if (en.isIntersecting) {
          // §4.2 第 2 條的計時起點
          if (u.inViewSince === undefined) u.inViewSince = Date.now();
          hit = true;
        } else {
          u.inViewSince = undefined;
        }
      }
      if (hit) scheduleIntake();
    },
    // §7.1 可見區優先、漸進翻譯
    { rootMargin: '200px 0px' },
  );

  ro = new ResizeObserver(() => relayout());
  ro.observe(document.documentElement);

  mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target instanceof Element && r.target.id === 'kasanemu-root') return;
    }
    // SPA 換路由後 pathname 會變,重新起一個 page key(§8 第 3 層的計數跟著換頁)
    const key = makePageKey();
    if (key !== pageKey) {
      send({ type: 'drop-page', pageKey });
      pageKey = key;
      unlockScales(units); // §4.4 規則 3
    }
    scheduleFlush(true);
  });
  mo.observe(document.body, { childList: true, characterData: true, subtree: true });

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseleave', onDocLeave);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', relayout);
  // capture:內層容器的捲動(水平卡片輪播、overflow 區塊)不冒泡到 window,
  // 但 capture 階段會經過 document —— 沒有這個,輪播一捲整排疊層就錯位
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('pagehide', onPageHide);
  // 入場動畫結束 → 位置定了,重新量一次
  document.addEventListener('transitionend', onMotionEnd, true);
  document.addEventListener('animationend', onMotionEnd, true);
  // lazy-load 的圖片載入會把後面的內容推走
  document.addEventListener('load', onResourceLoad, true);
  document.addEventListener('error', onResourceLoad, true);

  /*
   * 座標稽核**不停止**。原本只跑載入後 12 秒,但漏掉兩類晚到的位移:
   * CSS background-image 的 lazy load(沒有任何 DOM 事件可聽),
   * 以及捲到可見才觸發的入場動畫。成本很低:每輪只對疊層附近的單元
   * 各讀一次 rect(layout 是 clean 的,< 1ms),抓到第一個漂移就收手重排。
   * 分頁在背景時跳過。
   */
  settleTimer = window.setInterval(() => {
    if (document.hidden) return;
    auditPositions();
    void catchUpL0();
  }, 900);
  // §3.4 字型載入會改變所有 rect,完成後強制重算一次
  document.fonts.ready.then(relayout);

  dwellTimer = window.setInterval(dwellTick, 300);

  pendingScan = true;
  requestAnimationFrame(flush);
}

function onDocLeave(): void {
  const left = hovered;
  hovered = null;
  layer?.setHovered(null, units);
  if (left?.pendingSwap !== undefined) trySwap(left);
  armHoverRetry(null);
  closeChip();
}

/**
 * 捲動中的自我修正。用 rAF 節流,每次只讀兩個 rect:
 *  1. host 的原點(頁面若用 transform 平滑捲動,原點會跑掉)
 *  2. 一個可見單元當哨兵(內容自己在動的話,整批座標都要重算)
 * 兩個都對得上就什麼都不做。
 */
/**
 * 找出視窗上下緣被 position: fixed / sticky 的頁面元素佔掉多少。
 *
 * 為什麼需要:原文捲到固定頁首**底下**會被蓋住,而我們的疊層 z-index 是
 * 2147483000,畫在頁首**上面** —— 位置完全正確,卻浮在頁首上。
 * 使用者一路回報的「跑到 header」就是這個,不是幾何錯位
 * (診斷 log 裡 position-drift 是零筆,座標一直都對)。
 *
 * 疊層的 pointer-events: none 在這裡第二次派上用場:
 * elementFromPoint 打不到我們自己,回來的一定是頁面的東西。
 */
function chromeBand(y: number, top: boolean): number {
  const x = Math.round(window.innerWidth / 2);
  const hit = document.elementFromPoint(x, y);
  for (let el: Element | null = hit; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    // 透明的覆蓋層不會擋住文字,不要當成頁首
    if (Number(cs.opacity) === 0 || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const band = top ? r.bottom : window.innerHeight - r.top;
    return Math.max(0, Math.min(band, window.innerHeight / 2));
  }
  return 0;
}

/** 把被固定頁首 / 頁尾蓋住的那一段從疊層上裁掉,讓它跟原文一樣消失 */
function applyChromeClip(): void {
  if (!layer || !running) return;
  const h = window.innerHeight;
  const top = chromeBand(2, true);
  const bottom = chromeBand(h - 2, false);
  if (top !== lastTopBand || bottom !== lastBottomBand) {
    lastTopBand = top;
    lastBottomBand = bottom;
    diag('info', 'chrome-band', { top, bottom });
  }
  // 純算術,不讀 layout:u.rect 是快取值
  for (const u of units) {
    if (!u.box) continue;
    const vTop = u.rect.top - window.scrollY - u.bleed.y;
    const vBottom = vTop + u.rect.height + u.bleed.y * 2;
    if (vBottom < -50 || vTop > h + 50) {
      layer.setClip(u, 0, 0);
      continue;
    }
    layer.setClip(u, Math.max(0, top - vTop), Math.max(0, vBottom - (h - bottom)));
  }
}

/**
 * 元素是不是被某個祖先的 `overflow: hidden` 整個裁掉了。
 *
 * 這是「看不見的重複 DOM」的成因:輪播的另一份、隱藏的行動版選單。
 * 頁面把它裁掉了,而我們的疊層在最上層不受任何裁切,於是浮在無關的位置。
 *
 * build 15 用 `elementFromPoint` 做這件事,結果**把正確的疊層藏掉了** ——
 * 卡片常有一個絕對定位的 stretched link 蓋住整張卡,它既不是標題的祖先
 * 也不是子孫,命中測試就判成「被蓋住」。幾何判定沒有這個問題:
 * 只問「這個元素的矩形有沒有落在裁切框外面」,不管誰蓋在上面。
 *
 * 可捲動的容器**照樣算**:現在看不見就是看不見,使用者把它捲進來之後
 * 下一輪稽核會再把疊層放出來。
 */
function clippedAway(u: Unit): boolean {
  const r = u.el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return true;
  for (let p = u.el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    if (pr.width < 1 || pr.height < 1) return true;
    const outside =
      r.right <= pr.left + 1 || r.left >= pr.right - 1 || r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1;
    if (outside) return true;
  }
  return false;
}

function checkOcclusion(): void {
  if (!layer || !running || !settings.occlusionCheck) return;
  let hidden = 0;
  let checked = 0;
  for (const u of units) {
    if (!u.box) continue;
    const vTop = u.rect.top - window.scrollY;
    if (vTop + u.rect.height < -200 || vTop > window.innerHeight + 200) continue;
    if (checked++ > 80) break;
    const gone = clippedAway(u);
    layer.setCovered(u, gone);
    if (gone) hidden++;
  }
  if (hidden !== lastCovered) {
    lastCovered = hidden;
    diag('info', 'clipped-overlays', { hidden, checked });
  }
}

/** 疊層畫的位置與來源元素現在的位置差多少 */
function driftOf(u: Unit): { dx: number; dy: number } {
  const r = u.el.getBoundingClientRect();
  return { dx: r.left + window.scrollX - u.rect.left, dy: r.top + window.scrollY - u.rect.top };
}

/**
 * 捲動中的自我修正,每 frame 最多讀兩個 rect。
 *
 * 取頭尾兩個可見單元:
 *  - 兩者位移**一致** → 整片內容在動(transform 平滑捲動)。
 *    直接平移整個 layer 補回去,不重算任何盒子。
 *  - 位移**不一致** → 個別元素在動(lazy load、內容插入)。那要重排。
 *
 * 兩個哨兵是必要的:只看一個分不出這兩種情況,而它們的處置完全相反。
 */
function scrollSync(): void {
  scrollRaf = 0;
  if (!layer || !running) return;
  // 疊層本身由瀏覽器跟著頁面捲(document 座標),JS 不碰位置。
  // 這裡只處理「被固定頁首蓋住的那一段要跟著消失」。
  applyChromeClip();
  // 再看內容自己有沒有移動(sticky、lazy load、內容插入)
  const probe = [...units].find((u) => u.box && u.inView && u.tier !== 'skipped');
  if (!probe) return;
  const d = driftOf(probe);
  if (Math.abs(d.dx) > 2 || Math.abs(d.dy) > 2) {
    noteDrift(probe.id, d);
    scheduleFlush();
  }
}

/** 只在量級變化時記一筆,不然捲動時每 frame 一筆會把 log 洗掉 */
function noteDrift(id: string, d: { dx: number; dy: number }): void {
  const bucket = `${id}:${Math.round(d.dx / 20)},${Math.round(d.dy / 20)}`;
  if (bucket === lastShiftBucket) return;
  lastShiftBucket = bucket;
  diag('info', 'scroll-drift', { id, dx: Math.round(d.dx), dy: Math.round(d.dy) });
}

function onScroll(): void {
  lastScrollAt = performance.now();
  /*
   * 貼片是 position: fixed,不跟著頁面捲 —— 所以捲動時直接關掉。
   * 這是**刻意**不走疊翻那套 document 座標 + 捲動自我修正:
   * 貼片是暫態的,不需要跟著捲;不跟著捲就沒有 build 14 那種
   * 「JS 慢合成器一幀 → 疊層抖動」的問題。
   */
  if (chipUnit || layer?.chipsVisible()) closeChip(true);
  if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollSync);
  if (reprioTimer) return;
  reprioTimer = window.setTimeout(() => {
    reprioTimer = 0;
    reprioritize();
    auditPositions();
    // 視線帶讓出來了,把延後的替換補做掉 (§4.3)
    for (const u of units) if (u.pendingSwap !== undefined) trySwap(u);
  }, 300);
}

function onPageHide(): void {
  // §3.2 規則 5:頁面卸載時 destroy()
  l0?.destroy();
}

function stop(): void {
  running = false;
  io?.disconnect();
  ro?.disconnect();
  mo?.disconnect();
  io = ro = mo = null;
  clearInterval(dwellTimer);
  dwellTimer = 0;
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mouseleave', onDocLeave);
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('selectionchange', onSelectionChange);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', relayout);
  document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  window.removeEventListener('pagehide', onPageHide);
  document.removeEventListener('transitionend', onMotionEnd, true);
  document.removeEventListener('animationend', onMotionEnd, true);
  document.removeEventListener('load', onResourceLoad, true);
  document.removeEventListener('error', onResourceLoad, true);
  clearInterval(settleTimer);
  settleTimer = 0;
  clearTimeout(motionTimer);
  motionTimer = 0;
  clearTimeout(hoverRetryTimer);
  hoverRetryTimer = undefined;
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  emptyScans = 0;
  for (const u of units) layer?.drop(u);
  layer?.hideHud();
  manualArmed = false;
  lastProblem = '';
  units.clear();
  unitById.clear();
  // 重建而不是清空:WeakMap / WeakSet 沒有 clear(),
  // 留著會讓下一次 scan() 認為整頁都已經建過單元
  unitByEl = new WeakMap<Element, Unit>();
  probed = new WeakSet<Unit>();
  setPageScript(null);
  clearTimeout(selectionTimer);
  selectionTimer = 0;
  selectionUnit = null;
  closeChip(true);
  labels.clear();
  labelMemo.clear();
  labelQueuedText.clear();
  labelByEl = new WeakMap<Element, Unit>();
  // nextId 刻意不重置:worker 佇列裡可能還有已送出的舊 id,
  // 重新從 u1 開始會讓那些結果套到完全不同的區塊上 —— 自己製造 id 對滑。
  // §6.1 說 id 是「本頁單調遞增的穩定 id」,跨 stop/start 也維持單調。
  l0?.destroy();
  l0 = null;
  layer?.destroy();
  layer = null;
  send({ type: 'drop-page', pageKey });
}

async function applyDomainState(next: DomainState): Promise<void> {
  const wasEnabled = state?.enabled;
  const prevTier = state?.tier;
  const prevPipeline = state?.pipeline;
  state = next;
  if (next.enabled && !wasEnabled) {
    await start();
    return;
  }
  if (!next.enabled && wasEnabled) {
    stop();
    return;
  }
  layer?.setMode(next.mode);
  if (running && next.pipeline !== prevPipeline) {
    // 換管線等於換整條路徑,重來一次比修補狀態機乾淨
    stop();
    await start();
    return;
  }
  if (prevTier !== next.tier && running) {
    // 換檔位等於換模型,已翻的留著,未翻的用新檔位送
    scheduleIntake();
  }
}

/* ------------------------------------------------------------ 訊息接收 */

chrome.runtime.onMessage.addListener((raw: ToContent, _sender, reply) => {
  if (!raw || typeof raw !== 'object') return;
  switch (raw.type) {
    case 'results': {
      if (raw.pageKey !== pageKey) return;
      applyResults(raw.results);
      break;
    }
    case 'failures': {
      if (raw.pageKey !== pageKey) return;
      for (const f of raw.failures) {
        const u = unitById.get(f.id);
        if (!u) continue;
        // feature.md §5.1:有 L0 可讀就停在 L0 並標記(l1-failed),
        // 沒有的話才是真的 failed。兩者的提示線都是警示色 —— 不可以看起來正常。
        u.tier = u.l0Text !== undefined ? 'l1-failed' : 'failed';
        u.failReason = f.reason;
        if (u.kind === 'label') {
          // 失敗的文字要能再送一次,否則 hover 重試對加翻層無效
          labelQueuedText.delete(u.src);
          renderChips();
          continue;
        }
        if (u.l0Text === undefined) layer?.drop(u);
      }
      renderChips();
      scheduleFlush();
      updateHud();
      break;
    }
    case 'notice': {
      console.warn(`[kasanemu] ${raw.level}: ${raw.text}`);
      diag(raw.level, 'notice', raw.text);
      if (raw.level !== 'info') {
        lastProblem = raw.text;
        updateHud();
      }
      break;
    }
    case 'domain-state': {
      if (raw.host === host) void applyDomainState(raw.state);
      break;
    }
    case 'command': {
      if (!state) return; // boot 還沒完成
      if (raw.command === 'toggle-enabled') void toggleEnabled();
      else if (raw.command === 'translate-page') void translatePage();
      else void toggleMode();
      break;
    }
    case 'get-page-stats': {
      reply(pageStats());
      return true;
    }
    case 'l0-ready': {
      // popup 在 user gesture 裡把語言包下載完了,重試卡住的區塊
      void retryL0();
      break;
    }
  }
  return undefined;
});

/**
 * 手動觸發翻譯,同時是失敗區塊的重試入口。
 * 沒啟用的話先啟用 —— 使用者按下去的意思就是「現在翻」。
 */
async function translatePage(): Promise<void> {
  manualArmed = true;
  lastProblem = '';
  if (!state.enabled) {
    const next = await chrome.runtime.sendMessage({
      type: 'set-domain-state',
      host,
      patch: { enabled: true },
    } satisfies ToWorker);
    await applyDomainState(next as DomainState);
    return; // start() 會自己掃描與翻譯
  }
  if (!running) return;
  // 失敗的重來一次:清掉已問過快取的記號,並把狀態退回 pending
  for (const u of units) {
    if (u.tier === 'failed' || u.tier === 'l1-failed' || u.tier === 'l0-failed') {
      u.tier = u.l0Text !== undefined ? 'l0' : 'pending';
      u.l1Queued = false;
      u.failReason = undefined;
      probed.delete(u);
    }
  }
  updateHud();
  scheduleFlush(true);
  void intake();
}

/**
 * 語言包在頁面載入後才就緒的情況:一開始的區塊全部 l0-failed(needs-gesture),
 * 只能空等 L1 —— 診斷 log 裡首屏 6129ms 就是這樣來的。
 * L0 一旦變成 ready,把卡住的補翻。
 */
async function catchUpL0(): Promise<void> {
  if (!running || !usesL0(effective) || l0?.state !== 'ready') return;
  const stuck = [...units].filter(
    (u) => u.tier === 'l0-failed' && u.l1Text === undefined && u.maxChars > 0,
  );
  if (stuck.length === 0) return;
  await runL0(stuck);
}

/** popup 下載完語言包後,把停在 pending / l0-failed 的區塊補翻 */
async function retryL0(): Promise<void> {
  if (!running || !usesL0(effective)) return;
  if (!l0 || l0.state === 'needs-gesture' || l0.state === 'idle') {
    l0 =
      l0 ??
      new L0Engine(pageSourceLang(settings.l0SourceLang), toTranslatorTarget(settings.targetLang));
    if (!(await l0.ensure())) return;
  }
  const stuck = [...units].filter(
    (u) => (u.tier === 'pending' || u.tier === 'l0-failed') && u.maxChars > 0 && u.inView,
  );
  await runL0(stuck);
}

async function toggleEnabled(): Promise<void> {
  const next = await chrome.runtime.sendMessage({
    type: 'set-domain-state',
    host,
    patch: { enabled: !state.enabled },
  } satisfies ToWorker);
  await applyDomainState(next as DomainState);
}

async function toggleMode(): Promise<void> {
  const mode: DisplayMode = state.mode === 'full' ? 'peek' : 'full';
  const next = await chrome.runtime.sendMessage({
    type: 'set-domain-state',
    host,
    patch: { mode },
  } satisfies ToWorker);
  await applyDomainState(next as DomainState);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['settings']) {
    void (async () => {
      const next = await ask<Settings>({ type: 'get-settings' });
      if (!next) return;
      settings = next;
      setDebug(settings.debug);
      // weightOffset / hintLine 之類的改動要整頁重算
      for (const u of units) u.style = probeStyle(u.el, settings.weightOffset);
      relayout();
    })();
  }
  const domainKey = `domain:${host}`;
  if (changes[domainKey]) {
    void applyDomainState(changes[domainKey].newValue as DomainState);
  }
});

async function boot(): Promise<void> {
  const s = await ask<Settings>({ type: 'get-settings' });
  const d = await ask<DomainState>({ type: 'get-domain-state', host });
  if (!s || !d) return; // worker 還沒起來,storage.onChanged 會再叫一次
  settings = s;
  state = d;
  setDebug(settings.debug);
  if (state.enabled) await start();
}

void boot();

// 疊層外的除錯入口(content script 的 isolated world),debug mode 才有意義
Object.assign(globalThis as Record<string, unknown>, {
  __ksnm: {
    stats: pageStats,
    units: () => [...units].map((u) => ({ id: u.id, tier: u.tier, src: u.src, l0: u.l0Text, l1: u.l1Text })),
    text: (id: string) => activeText(unitById.get(id) ?? ({} as Unit)),
    /** 為什麼這個元素沒被翻:__ksnm.explain(document.querySelector('h1')) */
    explain: (el: Element | string) =>
      explainCandidate(typeof el === 'string' ? document.querySelector(el)! : el),
    /**
     * 查某個座標上畫的是哪個疊層:__ksnm.at(x, y)(viewport 座標)。
     * 把滑鼠停在錯位的譯文上,按 F12 執行這行,就知道:
     *  - painted:疊層畫在哪(document 座標)
     *  - live:來源元素現在在哪
     * 兩者差很多 → 位置漂移沒被偵測到;
     * 兩者一致 → 疊層位置其實是對的,問題在那個元素根本不該被翻
     *            (隱藏的重複 DOM、被裁切的內容)。
     */
    at: (x: number, y: number) => {
      const dx = x + window.scrollX;
      const dy = y + window.scrollY;
      return [...units]
        .filter(
          (u) =>
            u.box &&
            dx >= u.rect.left &&
            dx <= u.rect.left + u.rect.width &&
            dy >= u.rect.top &&
            dy <= u.rect.top + u.rect.height,
        )
        .map((u) => {
          const r = u.el.getBoundingClientRect();
          return {
            id: u.id,
            tier: u.tier,
            src: u.src.slice(0, 60),
            text: activeText(u)?.slice(0, 60),
            painted: { x: Math.round(u.rect.left), y: Math.round(u.rect.top) },
            live: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY) },
            visible: r.width > 0 && r.height > 0,
            el: u.el,
          };
        });
    },
    /** 把疊層盒子的邊界畫出來:__ksnm.outline() */
    outline: (on = true) => layer?.setOutline(on),
    rescan: () => {
      emptyScans = 0;
      scheduleFlush(true);
    },
  },
});
