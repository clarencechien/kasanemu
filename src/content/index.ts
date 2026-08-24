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
import { findCandidates } from './detect';
import {
  assignScales,
  checkOverflow,
  computeMaxChars,
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

/** §3.4 節點 id 用 WeakMap 綁定,不得寫入 DOM 屬性 (D14) */
const unitByEl = new WeakMap<Element, Unit>();
const units = new Set<Unit>();
const unitById = new Map<string, Unit>();
let nextId = 1;

/** 已送去問過快取的單元,不重複問 (feature.md §4.6) */
const probed = new WeakSet<Unit>();

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
      firstRectTop: 0,
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
  layer.refreshOrigin();
  for (const u of units) {
    if (u.tier === 'skipped') continue;
    measureUnit(u);
    if (u.maxChars === 0) u.maxChars = computeMaxChars(u);
  }
  const paintable = [...units].filter(hasText);
  assignScales(paintable);

  // ---- 寫入階段
  for (const u of units) {
    if (hasText(u)) layer.paint(u, settings);
    else layer.paintHint(u, settings);
  }
  if (firstPaintMs < 0 && paintable.length > 0) {
    firstPaintMs = Math.round(performance.now() - startedAt);
    dbg('first paint', firstPaintMs, 'ms', effective);
  }
  scheduleIntake();
}

/* ---------------------------------------------------------------- L0 即時層 */

/**
 * feature.md §4.6 / D23:先問快取。命中就直接以 L1 譯文渲染,跳過 L0,
 * 第二次讀同一頁不該先閃一次 L0。
 */
async function intake(): Promise<void> {
  if (!running) return;
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
      console.warn('[kasanemu] 這個環境沒有 Translator API,漸進式翻譯已退回 single 模式');
    } else {
      console.warn('[kasanemu] 這個環境沒有 Translator API,l0-only 模式無法翻譯');
    }
  }

  layer = new OverlayLayer();
  layer.setMode(state.mode);

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
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pagehide', onPageHide);
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

function onScroll(): void {
  lastScrollAt = performance.now();
  if (reprioTimer) return;
  reprioTimer = window.setTimeout(() => {
    reprioTimer = 0;
    reprioritize();
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
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('pagehide', onPageHide);
  for (const u of units) layer?.drop(u);
  units.clear();
  unitById.clear();
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
      break;
    }
    case 'notice': {
      console.warn(`[kasanemu] ${raw.level}: ${raw.text}`);
      break;
    }
    case 'domain-state': {
      if (raw.host === host) void applyDomainState(raw.state);
      break;
    }
    case 'command': {
      if (!state) return; // boot 還沒完成
      if (raw.command === 'toggle-enabled') {
        void toggleEnabled();
      } else {
        void toggleMode();
      }
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
  },
});
