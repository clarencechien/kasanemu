import type { ToContent, ToWorker } from '../shared/messages';
import type { DisplayMode, DomainState, Settings, UnitRequest } from '../shared/types';
import { setDebug, dbg } from '../shared/log';
import { findCandidates } from './detect';
import { assignScales, computeMaxChars, measureUnit } from './geometry';
import { probePackagedFonts } from './fonts';
import { OverlayLayer } from './overlay';
import { probeStyle, resetHintColor } from './styleprobe';
import { clearMeasureCache } from './measure';
import type { Unit } from './unit';

const host = location.hostname;

let settings: Settings;
let state: DomainState;
let layer: OverlayLayer | null = null;

/** §3.4 節點 id 用 WeakMap 綁定,不得寫入 DOM 屬性 (D14) */
const unitByEl = new WeakMap<Element, Unit>();
const units = new Set<Unit>();
const unitById = new Map<string, Unit>();
let nextId = 1;

let pageKey = makePageKey();
let hovered: Unit | null = null;
let altScan = false;

let mo: MutationObserver | null = null;
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;

let flushTimer = 0;
let enqueueTimer = 0;
let running = false;

function makePageKey(): string {
  return `${location.origin}${location.pathname}`;
}

function send(msg: ToWorker): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* service worker 正在回收,下一次動作會重試 */
  });
}

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
      status: c.geometryRisk ? 'skipped' : 'new',
      inView: false,
      overflowing: false,
    };
    unitByEl.set(c.el, unit);
    units.add(unit);
    unitById.set(unit.id, unit);
    if (unit.status === 'new') {
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

let pendingScan = false;

function flush(): void {
  if (!layer || !running) return;
  const doScan = pendingScan;
  pendingScan = false;
  prune();
  if (doScan) scan();

  // ---- 讀取階段:只讀,不寫
  layer.refreshOrigin();
  for (const u of units) {
    if (u.status === 'skipped') continue;
    measureUnit(u);
    if (u.status === 'new') u.maxChars = computeMaxChars(u);
  }
  const translated = [...units].filter((u) => u.translation);
  assignScales(translated);

  // ---- 寫入階段
  for (const u of units) {
    if (u.translation) layer.paint(u, settings);
    else layer.paintHint(u, settings);
  }
  scheduleEnqueue();
}

/* -------------------------------------------------------------- 翻譯排程 */

/** §7.1 只翻可見區。捲到哪翻到哪——同時解決 TPM、成本、疊層互蓋 (D13) */
function scheduleEnqueue(): void {
  if (enqueueTimer) return;
  enqueueTimer = window.setTimeout(() => {
    enqueueTimer = 0;
    enqueueVisible();
  }, 150);
}

function enqueueVisible(): void {
  if (!running) return;
  const ready = [...units].filter((u) => u.status === 'new' && u.inView && u.maxChars > 0);
  if (ready.length === 0) return;
  // 依畫面順序送,捲到哪翻到哪
  ready.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const payload: UnitRequest[] = ready.map((u) => ({
    id: u.id,
    src: u.src,
    maxChars: u.maxChars,
    role: u.role,
  }));
  for (const u of ready) u.status = 'queued';
  send({ type: 'enqueue', pageKey, tier: state.tier, units: payload });
  dbg('enqueue', payload.length);
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
  hovered = found;
  layer.setHovered(found, units);
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

/** §6.4 第三層防線:隨機抽 5 筆並列原文/譯文 */
function toggleDebugPanel(): void {
  if (!layer) return;
  if (layer.hasSample()) {
    layer.hideSample();
    return;
  }
  const done = [...units].filter((u) => u.translation);
  const pick: Unit[] = [];
  const pool = [...done];
  while (pick.length < 5 && pool.length > 0) {
    pick.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  const failed = [...units].filter((u) => u.status === 'failed').length;
  const overflow = [...units].filter((u) => u.overflowing).length;
  layer.showSample(
    pick,
    `units ${units.size} / done ${done.length} / failed ${failed} / overflow ${overflow}`,
  );
}

/* ------------------------------------------------------------ 生命週期 */

async function start(): Promise<void> {
  if (running) return;
  running = true;
  await probePackagedFonts();
  resetHintColor();
  clearMeasureCache();
  layer = new OverlayLayer();
  layer.setMode(state.mode);

  io = new IntersectionObserver(
    (entries) => {
      let hit = false;
      for (const en of entries) {
        const u = unitByEl.get(en.target);
        if (!u) continue;
        if (en.isIntersecting) {
          u.inView = true;
          hit = true;
        }
      }
      if (hit) scheduleEnqueue();
    },
    // §7.1 可見區優先、漸進翻譯
    { rootMargin: '200px 0px' },
  );

  ro = new ResizeObserver(() => scheduleFlush());
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
    }
    scheduleFlush(true);
  });
  mo.observe(document.body, { childList: true, characterData: true, subtree: true });

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseleave', () => {
    hovered = null;
    layer?.setHovered(null, units);
  });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', () => scheduleFlush());
  // §3.4 字型載入會改變所有 rect,完成後強制重算一次
  document.fonts.ready.then(() => {
    clearMeasureCache();
    scheduleFlush();
  });

  pendingScan = true;
  requestAnimationFrame(flush);
}

function stop(): void {
  running = false;
  io?.disconnect();
  ro?.disconnect();
  mo?.disconnect();
  io = ro = mo = null;
  document.removeEventListener('mouseover', onMouseOver, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  for (const u of units) layer?.drop(u);
  units.clear();
  unitById.clear();
  layer?.destroy();
  layer = null;
  send({ type: 'drop-page', pageKey });
}

async function applyDomainState(next: DomainState): Promise<void> {
  const wasEnabled = state?.enabled;
  const prevTier = state?.tier;
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
  if (prevTier !== next.tier && running) {
    // 換檔位等於換模型,已翻的留著,未翻的用新檔位送
    scheduleEnqueue();
  }
}

/* ------------------------------------------------------------ 訊息接收 */

chrome.runtime.onMessage.addListener((raw: ToContent) => {
  if (!raw || typeof raw !== 'object') return;
  switch (raw.type) {
    case 'results': {
      if (raw.pageKey !== pageKey) return;
      for (const r of raw.results) {
        const u = unitById.get(r.id);
        if (!u) continue;
        u.translation = r.t;
        u.status = 'done';
      }
      scheduleFlush();
      break;
    }
    case 'failures': {
      if (raw.pageKey !== pageKey) return;
      for (const f of raw.failures) {
        const u = unitById.get(f.id);
        if (!u) continue;
        // §6.5 失敗必須可見:不顯示疊層,提示線改虛線
        u.status = 'failed';
        u.failReason = f.reason;
        layer?.drop(u);
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
  }
});

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
      settings = await chrome.runtime.sendMessage({ type: 'get-settings' } satisfies ToWorker);
      setDebug(settings.debug);
      // weightOffset / hintLine 之類的改動要整頁重算
      for (const u of units) u.style = probeStyle(u.el, settings.weightOffset);
      scheduleFlush();
    })();
  }
  const domainKey = `domain:${host}`;
  if (changes[domainKey]) {
    void applyDomainState(changes[domainKey].newValue as DomainState);
  }
});

async function boot(): Promise<void> {
  try {
    settings = (await chrome.runtime.sendMessage({ type: 'get-settings' } satisfies ToWorker)) as Settings;
    setDebug(settings.debug);
    state = (await chrome.runtime.sendMessage({
      type: 'get-domain-state',
      host,
    } satisfies ToWorker)) as DomainState;
  } catch {
    return; // worker 還沒起來,storage.onChanged 會再叫一次
  }
  if (state.enabled) await start();
}

void boot();
