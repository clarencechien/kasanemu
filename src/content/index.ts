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
import { explainCandidate, findCandidates } from './detect';
import {
  assignScales,
  checkOverflow,
  computeMaxChars,
  coverRect,
  lockScales,
  maxCharsForUpgrade,
  measureUnit,
  unlockScales,
} from './geometry';
import { probePackagedFonts } from './fonts';
import { L0Engine, translatorSupported } from './l0';
import { pageSourceLang, toTranslatorTarget } from './lang';
import { STALL_MS, dwellReady, priorityOf as priorityFor, swapAllowed } from './upgrade';
import { mask, protectedFragments } from './mask';
import { OverlayLayer } from './overlay';
import { probeStyle, resetHintColor } from './styleprobe';
import { clearMeasureCache } from './measure';
import { activeText, hasText, type Unit } from './unit';

setDiagScope('content');

/** 掃到 0 個候選時的重掃間隔(ms) */
const EMPTY_SCAN_RETRIES = [300, 900, 2000, 4000];

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
  // 沒開自動翻譯就等使用者明確按下去
  if (!settings.autoTranslate && !manualArmed) {
    updateHud();
    return;
  }
  const fresh = [...units].filter(
    (u) => u.tier === 'pending' && u.inView && u.maxChars > 0 && !probed.has(u),
  );
  if (fresh.length === 0) return;
  for (const u of fresh) probed.add(u);

  if (effective === 'single') {
    // Phase 1 的路徑:直接送 L1,沒有 L0 打底
    queueUpgrade(fresh);
    return;
  }

  const hits = await probeCache(fresh);
  const misses = fresh.filter((u) => !hits.has(u.id));
  for (const u of fresh) {
    const hit = hits.get(u.id);
    if (hit === undefined) continue;
    u.l1Text = hit;
    u.tier = 'l1';
  }
  if (hits.size > 0) scheduleFlush();
  diag('info', 'intake', { fresh: fresh.length, cacheHits: hits.size, toL0: misses.length });
  await runL0(misses);
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
  await Promise.all(
    list.map(async (u) => {
      // §3.4 送出前把行內 code 與不翻清單換成佔位符
      const masked = mask(u.src, protectedFragments(u.el, settings.noTranslateTerms));
      const raw = await engine.translate(masked.text);
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
    }),
  );
  scheduleFlush();
  const failedL0 = list.filter((u) => u.tier === 'l0-failed' || u.tier === 'failed').length;
  diag(failedL0 > 0 ? 'warn' : 'info', 'l0-done', {
    asked: list.length,
    failed: failedL0,
    state: engine.state,
    detail: engine.detail,
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

/* ------------------------------------------------------------------ hover */

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
  if (found === hovered) return;
  const left = hovered;
  hovered = found;
  layer.setHovered(found, units);
  // §4.3 hover 結束後才執行延後的替換
  if (left?.pendingSwap !== undefined) trySwap(left);
}

function onKeyDown(e: KeyboardEvent): void {
  // §2.1 按住 Alt → 所有疊層切換為標註樣式,用於快速掃視哪些區塊被翻了
  if (e.key === 'Alt' && !altScan) {
    altScan = true;
    layer?.setAltScan(true);
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
  }
}

function onBlur(): void {
  if (altScan) {
    altScan = false;
    layer?.setAltScan(false);
  }
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
  const waiting = [...units].filter((u) => u.l1Queued && u.l1Text === undefined).length;
  const pending = c.pending + c['l0-failed'];

  if (lastProblem) {
    layer.setHud(`疊 · ${lastProblem}`, 'warn');
    return;
  }
  if (units.size === 0) {
    const retrying = emptyScans > 0 && emptyScans <= EMPTY_SCAN_RETRIES.length;
    layer.setHud(retrying ? '疊 · 掃描中…' : '疊 · 沒找到可翻譯的區塊', retrying ? 'busy' : 'idle');
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
  const heldBack = [...units].filter((u) => u.pendingSwap !== undefined).length;
  if (heldBack > 0) parts.push(`待換 ${heldBack}`);
  const busy = waiting > 0 || pending > 0;
  if (busy) {
    const tail = waiting > 0 ? `等 ${effective === 'single' ? 'L1' : '升級'} ${waiting}` : `待翻 ${pending}`;
    layer.setHud(`疊 · ${[...parts, tail].join(' · ')}`, 'busy');
    return;
  }
  if (parts.length === 0) {
    layer.setHud('疊 · 沒有需要翻譯的內容', 'idle');
    return;
  }
  layer.setHud(`疊 · ${parts.join(' · ')} · 完成`, failed > 0 ? 'warn' : 'idle');
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

  // feature.md §6:不支援就退回 single 並告知,不報錯
  effective = state.pipeline;
  diag('info', 'start', {
    pipeline: state.pipeline,
    tier: state.tier,
    mode: state.mode,
    translatorSupported: translatorSupported(),
    autoTranslate: settings.autoTranslate,
  });
  if (usesL0(effective)) {
    if (translatorSupported()) {
      l0 = new L0Engine(
        pageSourceLang(settings.l0SourceLang),
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
        if (u.l0Text === undefined) layer?.drop(u);
      }
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
