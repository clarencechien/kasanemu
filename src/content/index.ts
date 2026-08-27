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
  MAX_UNIT_CHARS,
  inExcluded,
  oversizedUnits,
  INTERACTIVE_SELECTOR,
  explainCandidate,
  findCandidates,
  findLabels,
  findSvgTexts,
  hasContainerChild,
  hiddenByDisclosure,
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
import { clipInsets, scrolls, type Box } from './cover';
import { chromeBand, clippedAway, clipsContent } from './occlusion';
import { hidePinnedWhileScrolling, motionGuard } from './motion';
import { deviceProfile, type DeviceProfile } from './device';
import { probePackagedFonts } from './fonts';
import { L0Engine, translatorSupported } from './l0';
import { pageSourceLang, sampleVisibleText, sniffScript, toTranslatorTarget } from './lang';
import {
  STALL_MS,
  dwellReady,
  hoverRetryReady,
  isFailedTier,
  priorityOf as priorityFor,
  stuckPlan,
  swapAllowed,
  translationPhase,
} from './upgrade';
import { mask, protectedFragments } from './mask';
import { matchedGlossaries, resolveGlossary, type Term } from '../shared/glossary';
import { TIERS } from '../shared/models';
import { HOST_ID, OverlayLayer, type ChipItem } from './overlay';
import {
  hintColor,
  parseColor,
  probeStyle,
  resetColorCache,
  resetHintColor,
  unparsedColors,
} from './styleprobe';
import { clearMeasureCache } from './measure';
import { activeText, hasText, type Unit } from './unit';
import { dedupeByText, labelBudget } from './annotate';
import { ImageAnnotator, imageUnder } from './imageanno';
import { keyDownAct, keyUpAct } from './keys';
import { buildSnapshot } from './snapshot';

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
/**
 * L0 佇列深度上限。超過就**不再往前預翻**,只收現在看得到的。
 *
 * 診斷 log(ClickHouse 那篇 268 個區塊的長文,Chromebook):開場沒多久
 * 佇列就有 179 個在排,每個呼叫 2.4 秒、併發 2 —— 那是五分鐘的存貨。
 * 預翻的用意是「使用者捲到的時候已經翻好了」,可是排在 179 個後面的東西
 * 不管使用者捲不捲都不會準時到,只是把 CPU 佔住、讓真正在看的那一屏也慢。
 *
 * 存貨超過這個數就停止進料;下一輪 scan 會再來看。
 * 30 個 × 2.4 秒 ÷ 併發 2 ≈ 36 秒,對慢機器來說已經是預翻的上限了。
 */
const L0_QUEUE_CAP = 30;
/**
 * 同一個區塊最多讓 L0 試幾次。
 *
 * catchUpL0 每 900ms 重試一次 l0-failed,原本沒有上限。多數失敗是暫時的
 * (語言包還沒好),但**佔位符被翻掉**那種不是:masked.restore() 對同一段
 * 文字永遠回 null,而且 L0 的譯文有快取 —— 重試連 API 都不用打就直接失敗。
 * log 裡整段 `l0-done {"asked":6,"batchMs":0,...,"failed":6}` 每 900ms 一筆、
 * calls 完全不動,就是這個永動機。試三次還不行就交給 L1,別再空轉。
 */
const L0_MAX_TRIES = 3;
/** 佇列滿到一個都放不下時,隔多久再來看一次 */
const INTAKE_RETRY_MS = 600;

function lookaheadPx(): number {
  const t = l0?.timing();
  if (!t || t.calls < 6) return L0_LOOKAHEAD_PX;
  return t.avgMs > SLOW_MACHINE_MS ? L0_LOOKAHEAD_SLOW_PX : L0_LOOKAHEAD_PX;
}

const host = location.hostname;

let settings: Settings;
/**
 * 這個網域實際生效的詞表(`docs/plan-glossary.md` §3)。
 * 設定一改就重算 —— 不要每個區塊各算一次,那是每頁幾百次的重複工作。
 */
let glossary: Term[] = [];
let state: DomainState;
let layer: OverlayLayer | null = null;

/**
 * 圖片加註(`docs/plan-images.md`)。
 *
 * 生命週期在 `imageanno.ts`,這裡只接線:送訊息、畫上去、chip 文案。
 * `index.ts` 已經三千行,再塞一套狀態機只會讓兩件事互相絆住。
 */
const imageAnno = new ImageAnnotator(
  {
    request(url, lane, brief) {
      send({ type: 'translate-image', pageKey, url, lane, tier: state.tier, brief });
    },
    showImage(rect, placed) {
      layer?.showImage(rect, placed);
    },
    hideImage() {
      layer?.hideImage();
    },
    /*
     * closed shadow root 把事件目標重定向成 host,所以「滑鼠在我們的 chip 上」
     * 從外面看就是「目標 === 那個 host」。整層只有 chip 與放大檢視吃滑鼠事件,
     * 所以這個判斷不會誤收別的東西(§DK)。
     */
    ownsTarget(t) {
      return t instanceof Element && t.id === HOST_ID;
    },
    cue(el, text, tone, action) {
      imageCue = text === null ? null : { el, text, tone, action };
      renderChips();
    },
    openZoom(src, natural, reserve) {
      const holder = layer?.showZoom(src, natural, reserve);
      if (!holder) return null;
      const r = holder.getBoundingClientRect();
      return { w: r.width, h: r.height };
    },
    setZoomBlocks(placed) {
      layer?.setZoomBlocks(placed);
    },
    closeZoom() {
      layer?.hideZoom();
    },
  },
  () => settings.imageMode !== 'off' && running,
  () => settings.imageAlwaysOn,
  () => settings.imageMaxPlates,
);

/** 圖片 chip 的內容。和 UI 標籤貼片共用同一條渲染路 */
let imageCue: {
  el: Element;
  text: string;
  tone: 'idle' | 'busy' | 'warn';
  action?: string;
} | null = null;

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
/**
 * 元素 → 它產生的單元。**一對多**:鬆散文字與被圖片切開的段落會讓同一個
 * 元素產生好幾段(見 detect.ts 的 inlineRuns),所以這裡是陣列。
 * `has()` 的語意仍然是「這個元素掃過了」—— 一個元素的所有段落在同一次
 * findCandidates 裡一起產生,不會只做一半。
 */
let unitByEl = new WeakMap<Element, Unit[]>();
const units = new Set<Unit>();
const unitById = new Map<string, Unit>();
let nextId = 1;

/** 已送去問過快取的單元,不重複問 (feature.md §4.6)。同樣不能 clear */
let probed = new WeakSet<Unit>();

let pageKey = makePageKey();
let hovered: Unit | null = null;
let altScan = false;
/** 按住 Alt:整層暫時收起(譯文留著,放開立刻回來) */
let hiddenAll = false;

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
/** 捲動停止後把 pinned 疊層放回來的計時器 */
let pinnedTimer = 0;
/** 目前有幾個 pinned 單元(0 就完全不必理會捲動) */
let pinnedCount = 0;
let motionTimer = 0;
let scrollRaf = 0;
let settleTimer = 0;
/** 應用程式外殼的快速座標檢查(document 本身不捲時才開) */
let driftTimer = 0;
/** 只在數量變化時記錄,否則每次重排都記一筆會把 log 洗掉 */
/**
 * 兩次掃描之間至少隔這麼久(ms),而且**掃不到東西就往上退**。
 *
 * 診斷 log 顯示 Gmail 上 `scan {"found":0}` 每 500ms 一次、持續整段時間 ——
 * 單元數從頭到尾都是 59,一次新的都沒有。應用程式的 DOM 為了自己的理由
 * 一直在動,而每一次都被我們翻譯成一次全樹 walk + getComputedStyle。
 *
 * 掃描是為了「發現新內容」。連續掃不到就代表這一頁的內容已經穩定了,
 * 退到 3 秒一次;一旦真的掃到新東西就立刻回到 400ms(無限捲動的頁面
 * 要能馬上跟上)。
 */
const MIN_SCAN_GAP_MS = 400;
const MAX_SCAN_GAP_MS = 3000;
let scanGapMs = MIN_SCAN_GAP_MS;
let lastScanAt = -1e9;
let rescanTimer = 0;
let lastOverflowCount = -1;
/** 來源元素現在沒被畫出來的疊層數(收折的 <details> 等) */
let lastHiddenCount = -1;
/** 被容器裁到的疊層數 */
let lastClippedCount = -1;
let lastNoClipper = -1;
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
/** 機器畫像,start() 時量一次(微基準要跑幾毫秒,不要每次都跑) */
let device: DeviceProfile | null = null;
/** feature.md §4.3 距上次捲動 < 400ms 的區塊延後替換 */
/** 這一頁有幾塊是從快取直接拿到的(沒有再花一次 API) */
let cacheHitsTotal = 0;
let lastScrollAt = 0;
/** document 自己不捲(Gmail / Slack 這種應用程式外殼)—— start() 時量一次 */
let appShellPage = false;
/** 這一頁收到過內層容器的捲動事件 */
let sawInnerScroll = false;
/** feature.md §2.2「L0 讀完就沒再看 L1」的比例 */
let swapsTotal = 0;
let swapsOffscreen = 0;
/**
 * 手動翻譯已被觸發過(popup 按鈕或 Alt+R)。
 * autoTranslate 關掉時,這個旗標是唯一的放行條件。
 */
let manualArmed = false;
/** worker 回報的最後一則問題,顯示在狀態列上 —— 失敗不可以只留在 console */
let lastProblem = '';

function makePageKey(): string {
  return `${location.origin}${location.pathname}`;
}

/**
 * 換頁的偵測用 href,不是 page key。
 *
 * page key 只到 pathname —— 那是給 §8 的成本計數用的,粒度刻意粗。
 * 但「使用者跳到另一個頁面了」這件事要更敏感:`?page=2` 的分頁、
 * hash 路由的 SPA 都是新內容,不該沿用上一頁按下的「翻譯這一頁」。
 */
let lastHref = location.href;

/**
 * 換頁了。
 *
 * 回報:「在啟用的情況下,在同一頁點超連結跳轉後會開始自動翻譯新的內容」。
 * SPA 換路由時 content script 不會重載,於是上一頁按下的 manualArmed
 * 一路帶到新頁面 —— 使用者按的是「翻**這一頁**」,不是「從今以後每一頁」。
 *
 * 整頁重新載入沒有這個問題(content script 是新的),所以這裡只處理
 * 同一份 document 內的換頁。
 */
function onRouteChange(): void {
  const href = location.href;
  if (href === lastHref) return;
  lastHref = href;
  const key = makePageKey();
  if (key !== pageKey) {
    send({ type: 'drop-page', pageKey });
    imageAnno.reset();
    pageKey = key;
    unlockScales(units); // §4.4 規則 3
  }
  // 新頁面要重新表達意圖;開了自動翻譯的人不受影響(intake 自己會判斷)
  manualArmed = false;
  lastProblem = '';
  emptyScans = 0;
  firstPaintMs = -1;
  scanGapMs = MIN_SCAN_GAP_MS;
  // 上一頁的貼片與標籤單元不屬於這一頁
  closeChip(true);
  selectionUnit = null;
  for (const u of labels) unitById.delete(u.id);
  labels.clear();
  labelByEl = new WeakMap<Element, Unit>();
  labelMemo.clear();
  labelQueuedText.clear();
  diag('info', 'route-change', { pageKey, autoTranslate: settings.autoTranslate });
  updateHud();
}

/**
 * 送給 worker 的訊息。**會重試。**
 *
 * 原本這裡是 `.catch(() => {})`,註解寫「service worker 正在回收,
 * 下一次動作會重試」—— 那句話對 `enqueue` 是假的:**沒有下一次動作**。
 * `queueUpgrade` 送出的當下就把區塊標成 `l1Queued = true`,
 * 訊息掉了就沒有人會再送一次,那一塊從此停在 L0。
 *
 * 而 MV3 的 service worker 閒置 30 秒就會被回收,回收與喚醒之間
 * `chrome.runtime.sendMessage` 會直接 reject(「Could not establish
 * connection」)—— 這不是罕見狀況,是**每一頁安靜幾十秒之後的常態**。
 *
 * 重試是安全的:`enqueue` 在 worker 端以 id 去重、`reprioritize`
 * 與 `drop-page` 本來就是冪等的。三次都失敗才記一筆 error,
 * 因為那時候看門狗會接手,但總要有人說出「訊息根本沒送出去」。
 */
function send(msg: ToWorker, left = 3): void {
  chrome.runtime.sendMessage(msg).catch((e: unknown) => {
    if (left > 1) {
      window.setTimeout(() => send(msg, left - 1), (4 - left) * 300);
      return;
    }
    diag('error', 'send-failed', {
      kind: msg.type,
      err: String((e as Error)?.message ?? e),
    });
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
  // 同一批裡同一個元素可以出現好幾次(一段一個),所以只擋「上一輪就有的」
  const before = new Set(found.filter((c) => unitByEl.has(c.el)).map((c) => c.el));
  for (const c of found) {
    if (before.has(c.el)) continue;
    const style = probeStyle(c.el, settings.weightOffset);
    const unit: Unit = {
      id: `u${nextId++}`,
      el: c.el,
      kind: 'block',
      role: c.role,
      src: c.src,
      style,
      geometryRisk: c.geometryRisk,
      ...(c.mediaSplit ? { mediaSplit: c.mediaSplit } : {}),
      ...(c.pinned ? { pinned: true } : {}),
      ...(c.range ? { range: c.range } : {}),
      /*
       * §4.1 原本是「取不到不透明實色 → 降級為標註樣式」。
       * 改成只有使用者明確要求時才用標註樣式 —— 背景取不到的情況現在由
       * backgroundForText() 依文字亮度挑一個對比色處理,那比固定淺色底
       * 準得多(深色橫幅上一塊淺藍配橘字實在太醜)。
       */
      annotation: settings.forceAnnotation,
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
    const list = unitByEl.get(c.el);
    if (list) list.push(unit);
    else unitByEl.set(c.el, [unit]);
    units.add(unit);
    unitById.set(unit.id, unit);
    if (unit.tier !== 'skipped') {
      io?.observe(c.el);
      ro?.observe(c.el);
    }
  }
  scanLabels();
  // 掃到新東西就回到最快的節奏,連續掃不到就退 —— 見 scanGapMs 的說明
  scanGapMs = found.length > 0 ? MIN_SCAN_GAP_MS : Math.min(scanGapMs * 2, MAX_SCAN_GAP_MS);
  dbg('scan', { found: found.length, total: units.size });
  diag(units.size === 0 ? 'warn' : 'info', 'scan', {
    gapMs: scanGapMs,
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

/**
 * 這個元素**現在**有沒有被畫出來。
 *
 * `checkVisibility()` 一次回答 display:none、visibility:hidden、
 * 以及 content-visibility 被跳過的內容(收折的 <details>、
 * Gmail 對離開畫面的區塊做的 `content-visibility: auto`)。
 * 逐條用 computed style 判斷會漏掉最後那一種 —— 它不改 display,也不改 visibility。
 */
function isRendered(el: Element): boolean {
  // 收折的 <details>:量測全部說謊,先問 DOM(見 detect.ts 的 hiddenByDisclosure)
  if (hiddenByDisclosure(el)) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check !== 'function') return true;
  return check.call(el, { contentVisibilityAuto: true, visibilityProperty: true });
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
function auditPositions(full = true): void {
  if (!layer || !running) return;
  // 還在動就別量了:量到的一定是漂移,而處置已經做了(藏起來 + 等靜下來)
  if (!settled()) return;
  applyChromeClip();
  if (full) checkOcclusion();
  // 用**疊層畫在哪**來決定要驗誰,而不是來源元素現在在哪:
  // 錯位的症狀正是「來源元素跑掉了,疊層還留在視口裡」,
  // 只驗 inView 的來源元素會漏掉那些。
  const near = window.innerHeight;
  const top = window.scrollY - near;
  const bottom = window.scrollY + near * 2;
  for (const u of units) {
    if (u.tier === 'skipped') continue;
    // 釘住的單元隨捲動移動是**正常的**,不是壞掉的證據(見 scrollSync)
    if (u.pinned === true) continue;
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
      // 一個錯得離譜就代表這一批都不能信(多半是共同的祖先動了)
      /*
       * 座標錯得離譜 → 這一批都不能信。**但「先藏起來」只有在會反覆發生的
       * 頁面上才划算**:長文上這通常是一張圖載完把後面推走,量一次就對了,
       * 藏 200ms 只換來一次閃爍。flushNow() 當幀就重畫到正確位置。
       */
      if (Math.max(dx, dy) > GROSS_DRIFT_PX && guarding()) {
        markAllStale();
        noteMotion();
      }
      flushNow();
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
/**
 * 收合元件切換 → 版面整片位移,而且可能有新內容第一次被算進版面。
 * 所以是 relayout(重新量)+ 重掃,不是只有 flush。
 */
function onDisclosureToggle(): void {
  if (!running) return;
  diag('info', 'disclosure-toggle', {});
  relayout();
  scheduleFlush(true);
}

function relayout(): void {
  unlockScales(units);
  for (const u of units) clippersOf.delete(u);
  clearMeasureCache();
  // 幾何變了,還沒送出去的長度預算要跟著重算(已送出的不動,反正回不去了)
  for (const u of units) if (!u.l1Queued) u.maxChars = 0;
  scheduleFlush();
}

function flush(): void {
  if (!layer || !running) return;
  /*
   * 掃描節流。
   *
   * Gmail 的診斷 log 顯示 `scan {"found":0}` **每秒跑兩次** ——
   * 應用程式的 DOM 一直在動,每一次變動都觸發一次全樹 walk + getComputedStyle。
   * 那是純浪費,而且會排擠真正要做的重新量測。
   *
   * 掃描是為了「發現新內容」,那件事不需要 60fps。重新量測(flush 的其餘部分)
   * 才需要即時,所以只節流掃描,不節流 flush。
   * 空掃重試(emptyScans)期間不節流 —— 那時候正在等內容出現。
   */
  const now = performance.now();
  const doScan = pendingScan && (emptyScans > 0 || now - lastScanAt >= scanGapMs);
  if (doScan) {
    lastScanAt = now;
    pendingScan = false;
  } else if (pendingScan && rescanTimer === 0) {
    // 被節流掉的掃描要補回來,不然安靜的頁面會永遠等不到下一次 flush
    rescanTimer = window.setTimeout(() => {
      rescanTimer = 0;
      scheduleFlush();
    }, scanGapMs);
  }
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
    /*
     * 來源元素現在沒有繪製面積(display:none、收折的 <details>、
     * 隱藏的分頁)→ 疊層必須跟著消失。
     *
     * 這一條**不受 occlusionCheck 開關控制**,也不受可見區與 80 筆上限限制:
     * 那個檢查是啟發式的「有沒有被祖先裁掉」,這一條是「原文根本不存在於版面上」。
     * 沒有這條的話,收折起來的問答會把譯文留在原地,疊到別人身上。
     */
    layer.setCovered(u, !isRendered(u.el) || u.rect.width < 1 || u.rect.height < 1);
    // 還在動就一直藏著(座標每個 frame 都在變);靜下來才放出來
    /*
     * 釘住的來源(sticky / fixed)在捲動期間 document 座標一直在動,
     * 而疊層在 document 座標 —— 每一幀追著跑會比合成器慢一格而抖動
     * (build 14 的教訓),所以走和內層捲動同一條路:先藏起來,
     * 停下來再一次量、一次顯示。只藏這幾個,一般段落照常留在畫面上。
     */
    layer.setStale(
      u,
      (guarding() && !settled()) ||
        (u.pinned === true && !scrollIdle() && hidePinnedWhileScrolling(settings.stability)),
    );
  }
  pinnedCount = [...units].filter((u) => u.pinned === true).length;
  const hidden = [...units].filter((u) => u.box && !isRendered(u.el)).length;
  if (hidden !== lastHiddenCount) {
    lastHiddenCount = hidden;
    diag('info', 'unrendered-sources', { count: hidden });
  }
  const overflowing = [...units].filter((u) => u.overflowsBox).length;
  if (overflowing !== lastOverflowCount) {
    lastOverflowCount = overflowing;
    if (overflowing > 0) diag('info', 'content-overflows-box', { count: overflowing });
  }
  applyChromeClip();
  checkOrigin();
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
let lastCappedAt = -1e9;

/** 佇列滿的診斷每秒最多一筆 —— 它每 600ms 會來一次,照實記會把 log 洗掉 */
function noteCapped(want: number, room: number, queued: number, visible: number): void {
  const now = performance.now();
  if (now - lastCappedAt < 1000) return;
  lastCappedAt = now;
  diag('info', 'intake-capped', { want, room, queued, visible });
}

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
  let fresh = [...units].filter(
    (u) =>
      u.tier === 'pending' &&
      u.maxChars > 0 &&
      !probed.has(u) &&
      // 收折起來的內容不必翻 —— 展開時 scan 會再帶進來(而且是免費的 DOM 檢查)
      !hiddenByDisclosure(u.el) &&
      u.rect.top + u.rect.height >= top &&
      u.rect.top <= bottom,
  );
  if (fresh.length === 0) return;
  // 先翻使用者現在看得到的:預翻範圍拉大之後,順序比以前更重要
  fresh.sort((a, b) => priorityOf(a) - priorityOf(b));
  /*
   * 佇列已經很滿就只補到上限為止。**沒被取走的不標記 probed**,
   * 下一輪 scan 會重新考慮它們 —— 那時使用者可能已經捲到附近,
   * 優先度也就跟著對了。
   */
  /*
   * 佇列太深就停止**預翻**,但看得見的一律照收。
   *
   * 上限管的是存貨,不是需求:使用者現在看得到的東西沒有「等下一輪」這個選項,
   * 而排在幾十個離螢幕很遠的區塊後面等於沒翻。
   */
  const queued = l0?.queueDepth() ?? 0;
  const room = Math.max(0, L0_QUEUE_CAP - queued);
  if (room < fresh.length) {
    const viewTop = window.scrollY;
    const viewBottom = viewTop + window.innerHeight;
    const visible = fresh.filter(
      (u) => u.rect.top + u.rect.height >= viewTop && u.rect.top <= viewBottom,
    );
    const rest = fresh.filter((u) => !visible.includes(u));
    noteCapped(fresh.length, room, queued, visible.length);
    fresh = [...visible, ...rest.slice(0, room)];
    /*
     * 一個都放不下。這裡**必須自己排下一次** —— 平常是
     * runL0 → scheduleFlush → flush → scheduleIntake 這條迴圈在推,
     * 沒送出任何東西就沒有 flush,進料會停在這裡不再醒來。
     */
    if (fresh.length === 0) {
      if (!enqueueTimer) {
        enqueueTimer = window.setTimeout(() => {
          enqueueTimer = 0;
          void intake();
        }, INTAKE_RETRY_MS);
      }
      return;
    }
  }
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

  const l0Run = runL0(fresh);
  const [cacheHits] = await Promise.all([probing, l0Run]);
  cacheHitsTotal += cacheHits;
  diag('info', 'intake', { fresh: fresh.length, cacheHits, lookahead: ahead });
}

async function probeCache(list: Unit[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!usesL1(effective)) return out;
  const res = await ask<{ hits: UnitResult[] }>({
    type: 'cache-probe',
    tier: state.tier,
    units: list.map((u) => ({ id: u.id, src: u.src, maxChars: u.maxChars })),
    pageKey,
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
      u.l0Tries = (u.l0Tries ?? 0) + 1;
      // §3.4 送出前把行內 code 與不翻清單換成佔位符
      const masked = mask(u.src, protectedFragments(u.el, glossary));
      // 距視窗中心越近越先翻 —— 捲到新一屏時會插隊到預翻的遠處區塊前面
      // 優先度傳 thunk,不傳數字 —— 佇列在出隊時才問「現在離視窗多遠」。
      // 傳數字的話,捲動之前入隊的區塊會帶著過期的順序卡在佇列深處(見 l0.ts slot())
      /*
       * 第二個參數是**輪到它時**才問的「還要嗎」。
       *
       * 慢機器上 L0 佇列可以排到一兩百個,而那段時間裡 L1 會陸續把它們
       * 升級掉 —— 輪到的時候譯文早就在畫面上了,再翻一次是純粹的浪費。
       * 入隊時的 `u.l1Text !== undefined` 只擋得住入隊那一刻的狀況。
       */
      const raw = await engine.translate(masked.text, () => Math.round(priorityOf(u)), () => u.l1Text === undefined);
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
 * §4.2 佇列看門狗:排進去的區塊不准無聲無息地留在那裡。
 *
 * 使用者的原話:「都顯示完成 或是已經在佇列裡 但沒有變 L1
 * 有打到 TPM Ratelimit 之類的嗎」—— 送來的 log 裡**沒有** 429、
 * 沒有 notice、沒有 fuse-blocked,連一行都沒有說明那五塊去了哪裡。
 *
 * 從送出到收到中間有好幾個安靜的斷點:worker 的 post() 把
 * `chrome.tabs.sendMessage` 的錯誤整個吞掉(而那時佇列已經清了)、
 * pageKey 對不上的結果直接 return、service worker 被回收後
 * alarm 沒接回來。一個一個追太慢,而且下一個斷點還是會有。
 *
 * 所以這一版換個方向:**讓「卡住」這個狀態不存在。**
 * 超過 STUCK_L1_MS 沒有回音就重排一次 —— worker 的 enqueue 會去重,
 * 所以還躺在佇列裡的只是被順手踢一下 drain,不會重複計費;
 * 再卡就標成失敗,提示線轉警示色、hover 可以重試。
 * 有出口總比永遠等下去好。上限一次,不做無人看管的重試迴圈。
 */
let sweeping = false;

async function sweepStuckL1(now: number): Promise<void> {
  if (!usesL1(effective) || sweeping) return;
  /*
   * **先問 worker「這幾筆還在不在你手上」。**
   *
   * 上一份 log 抓到看門狗做多了:那一塊「卡了 45 秒」的同一秒,
   * worker 的佇列深度是 16 —— 它一直好好地排在隊伍裡,只是前面還有
   * 十幾塊。重排是個 no-op(worker 端以 id 去重),卻白白花掉一次
   * 重試預算,下一次真的掉了就直接被判失敗。
   *
   * 在佇列裡 = 塞車,碼表歸零繼續等;不在 = 真的不見了,才重排。
   */
  const overdue = [...units].filter((u) => stuckPlan(u, now) !== 'ok');
  if (overdue.length === 0) return;
  sweeping = true;
  let held: Set<string>;
  try {
    const r = await ask<{ has?: string[] }>({
      type: 'page-status',
      pageKey,
      ids: overdue.map((u) => u.id),
    });
    held = new Set(r?.has ?? []);
  } finally {
    sweeping = false;
  }
  const waiting = overdue.filter((u) => held.has(u.id));
  for (const u of waiting) u.l1CheckedAt = Date.now();
  if (waiting.length > 0) {
    diag('info', 'l1-waiting', { units: waiting.length, oldestMs: Math.round(now - Math.min(...waiting.map((u) => u.upgradeQueuedAt ?? now))) });
  }
  const requeue: Unit[] = [];
  let gaveUp = 0;
  let oldest = 0;
  for (const u of overdue) {
    const plan = stuckPlan(u, now);
    if (plan === 'ok' || held.has(u.id)) continue;
    oldest = Math.max(oldest, now - (u.upgradeQueuedAt ?? now));
    u.l1Queued = false;
    u.upgradeQueuedAt = undefined;
    if (plan === 'give-up') {
      gaveUp++;
      // §5.1 有 L0 可讀就停在 L0 並標記,沒有的話才是真的失敗
      u.tier = u.l0Text !== undefined ? 'l1-failed' : 'failed';
      u.failReason = 'stuck';
      if (u.kind === 'label') labelQueuedText.delete(u.src);
      else if (u.l0Text === undefined) layer?.drop(u);
      continue;
    }
    u.l1Retries = (u.l1Retries ?? 0) + 1;
    requeue.push(u);
  }
  const stuck = requeue.length + gaveUp;
  if (stuck === 0) return;
  diag('warn', 'l1-stuck', {
    stuck,
    requeued: requeue.length,
    gaveUp,
    oldestMs: Math.round(oldest),
  });
  if (requeue.length > 0) queueUpgrade(requeue);
  if (gaveUp > 0) {
    renderChips();
    scheduleFlush();
  }
  updateHud();
}

/**
 * feature.md §4.2 / D21:可見且**停留超過 1.5 秒**才排入 L1。
 * 純粹滑過去的區塊留在 L0,不花錢 —— 這一條直接對治
 * 「有 L0 打底反而燒更多」。
 */
function dwellTick(): void {
  if (!running) return;
  const now = Date.now();
  void sweepStuckL1(now);
  if (effective !== 'progressive') return;
  const due = [...units].filter(
    (u) => dwellReady(u, now, settings.upgradeDwellMs, effective) && !hiddenByDisclosure(u.el),
  );
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
/**
 * 這個元素的文字已經被某個內文疊層蓋住了嗎?
 *
 * 只比對元素本身是不夠的:單元常常建在**祖先**上。段落裡夾一個
 * 「docs」連結,單元在 `<p>` 上;圖表儲存格 `<td><a>Link</a><img></td>`
 * 的單元在 `<td>` 上。兩種情況下那個 `<a>` 都還是會被加翻層收走,
 * 於是同一段文字既有常駐疊層、又有 hover 貼片 —— 重複,而且多送一次 API。
 */
function covered(el: Element): boolean {
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    if (unitByEl.has(n)) return true;
  }
  return false;
}

function scanLabels(): void {
  if (!settings.annotate) return;
  if (labels.size >= ANNOTATION_CAP) return;
  const skip = (el: Element): boolean => labelByEl.has(el) || covered(el);
  const found = findLabels(document.body, ANNOTATION_CAP, skip);
  /*
   * 圖表 svg 裡的 `<text>` 走同一條貼片路(`docs/plan-images.md` §10-1)。
   * mermaid / d3 的圖上文字是真的文字節點,所以這一份**零視覺模型成本** ——
   * 圖片階段的第一步刻意先做不用 OCR 的那一半。
   */
  const svgTexts = findSvgTexts(document.body, ANNOTATION_CAP - found.length, skip);
  let added = 0;
  for (const c of [...found, ...svgTexts]) {
    if (labels.size >= ANNOTATION_CAP) break;
    makeLabelUnit(c.el, c.src);
    added++;
  }
  if (added > 0) dbg('scan labels', { added, svg: svgTexts.length, total: labels.size });
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
/**
 * 臨時加翻 / 選取加翻的長度上限。
 *
 * 原本是 240,而回報的那段 Note 是 400 字 —— **hover 與選取兩條路都在
 * 同一個上限上被靜靜擋掉**,於是看起來像「選了也沒有翻」。
 *
 * 500 字在 26em 寬、13px 的貼片裡大約十行,對「我想知道這段在寫什麼」
 * 來說是可以讀的;再長就真的是一面牆,那是疊翻的守備範圍。
 */
const ADHOC_MAX_CHARS = 500;

/**
 * **選取**的上限,和 hover 分開。
 *
 * hover 是被動的 —— 滑鼠掃過去就觸發,保守是對的。
 * 選取是使用者拉了一段話出來明講「翻這個」,那和按「翻譯這一頁」同一類
 * (§CP-2:自動的規則可以保守,使用者親手做的動作不行)。
 * 上一版兩條共用 500,於是那段 1576 字的引言連選起來都被靜靜擋掉,
 * log 裡兩則 `selection-skipped {"why":"too-long"}` 就是使用者在試。
 *
 * 貼片會很高,但那是使用者自己要的,而且比「什麼都沒發生」好。
 */
const SELECTION_MAX_CHARS = MAX_UNIT_CHARS;
const ADHOC_HOPS = 6;
/**
 * 看過但不合格的元素。mouseover 在導覽列上會反覆打到同一批元素,
 * 沒有這個集合就會一直重跑 ownText 與樣式查詢。
 */
const adhocRejected = new WeakSet<Element>();

/**
 * 圖片的替代文字(`docs/plan-images.md` §10-2)。
 *
 * 有 alt 的圖**已經有一份現成的描述**,翻它比 OCR 便宜兩個數量級,
 * 而且不必等視覺模型。滑到圖上就出貼片,走的是導覽列標籤那條路。
 *
 * 只收有意義的 alt。三種要濾掉:
 * - 空字串 —— 那是裝飾圖的**正確**寫法,不是缺漏
 * - 檔名 —— ClickHouse 的圖 alt 全都是 `Elasticsearch_blog1_01.png`
 * - `image` / `photo` / `圖` 這種佔位詞
 */
const IMG_ALT_MAX_CHARS = 240;
const FILENAME_ALT = /^[\w .,()\[\]-]+\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const PLACEHOLDER_ALT = /^(image|img|photo|picture|graphic|icon|logo|thumbnail|screenshot)$/i;

function imageAltAt(target: EventTarget | null): Unit | null {
  if (!settings.annotate) return null;
  if (!(target instanceof Element)) return null;
  const img = target.closest('img,[role="img"]');
  if (!img) return null;
  const known = labelByEl.get(img);
  if (known) return known;
  if (adhocRejected.has(img)) return null;
  if (labels.size >= ANNOTATION_CAP) return null;
  if (inExcluded(img)) {
    adhocRejected.add(img);
    return null;
  }
  const raw = img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? '';
  const text = normalizeText(raw);
  if (
    text.length === 0 ||
    text.length > IMG_ALT_MAX_CHARS ||
    FILENAME_ALT.test(text) ||
    PLACEHOLDER_ALT.test(text) ||
    !isMeaningfulText(text) ||
    looksLikeTargetLang(text) ||
    img.getClientRects().length === 0
  ) {
    adhocRejected.add(img);
    return null;
  }
  diag('info', 'image-alt', { chars: text.length });
  return makeLabelUnit(img, text);
}

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
    // 排除清單(.notranslate、分享 widget…)對臨時加翻同樣有效
    if (inExcluded(el)) {
      adhocRejected.add(el);
      continue;
    }
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
  // 被擋掉要留下痕跡:靜靜地什麼都不做,使用者只會覺得「這功能沒做」
  const why =
    text.length < SELECTION_MIN_CHARS
      ? 'too-short'
      : text.length > SELECTION_MAX_CHARS
        ? 'too-long'
        : !isMeaningfulText(text)
          ? 'not-text'
          : looksLikeTargetLang(text)
            ? 'already-target'
            : null;
  if (why) {
    diag('info', 'selection-skipped', { why, chars: text.length });
    return;
  }
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
  if (!layer) return;
  const items: ChipItem[] = [];
  /*
   * 圖片的 cue 走同一條渲染路。
   *
   * 它和 UI 標籤貼片是同一種東西(暫態、指名才出現、不蓋原文),
   * 差別只在內容是狀態不是譯文 —— 兩套渲染只會分岔(`lessons.md` §1)。
   */
  if (imageCue) {
    const r = imageCue.el.getBoundingClientRect();
    items.push({
      // 圖角:和 mockup 一致,不擋圖的內容
      anchor: { left: r.right - 8, top: r.top + 8, width: 0, height: 0 },
      text: imageCue.text,
      tone: imageCue.tone === 'warn' ? 'warn' : 'l1',
      /*
       * 圖片 cue 的配色是**固定**的,不從原文取樣。
       *
       * 內文貼片抄原文的顏色是為了不突兀;圖片 cue 相反 —— 它要在
       * 任何底色的圖上都看得見,而圖的底色是什麼都有可能。
       */
      style: {
        background: 'rgba(10,16,22,.88)',
        color: '#48CBBE',
        line: '#48CBBE',
        bar: '#48CBBE',
        fontSizePx: 11,
      },
      ...(imageCue.action ? { action: imageCue.action } : {}),
    });
  }
  if (settings.annotate) {
    const list = altScan ? visibleLabels() : chipUnit ? [chipUnit] : [];
    for (const u of list) {
      const item = chipItemFor(u);
      if (item) items.push(item);
    }
  }
  if (items.length === 0) {
    layer.hideChips();
    return;
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
  const masked = mask(u.src, protectedFragments(u.el, glossary));
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
  if (!settings.annotate || !running || hiddenAll) return;
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
  u.l1Retries = 0; // 使用者親手指定的重試,重試預算歸零
  probed.delete(u);
  if (u.l0Text !== undefined) {
    // L0 有譯文、掛掉的是 L1:直接重排 L1,不再等 §4.2 的停留時間 ——
    // 使用者的滑鼠**就停在上面**,停留條件早就滿足了。
    u.tier = 'l0';
    if (usesL1(effective)) queueUpgrade([u]);
  } else {
    // 連 L0 都沒有:退回 pending,讓 intake() 照正常流程重跑一次。
    // 重試次數歸零 —— 使用者親手指定的重試不該被 L0_MAX_TRIES 擋掉
    u.tier = 'pending';
    u.l0Tries = 0;
    void intake();
  }
  lastProblem = '';
  diag('info', 'hover-retry', { id: u.id, from, attempt: (hoverRetries.get(u) ?? 0) });
  scheduleFlush();
}

/**
 * §2.2 疊層 pointer-events: none,所以 hover 只能由來源元素反向驅動。
 */
/**
 * 同一個元素可能有好幾段行內單元(被圖片切開的段落、鬆散文字),
 * 而滑鼠只指著其中一段。用指標位置挑,不然滑到第二段卻讓第一段讓開。
 */
function pickUnit(list: readonly Unit[], e: Event): Unit {
  if (list.length === 1) return list[0]!;
  const p = e as MouseEvent;
  if (typeof p.clientX !== 'number') return list[0]!;
  const x = p.clientX + window.scrollX;
  const y = p.clientY + window.scrollY;
  for (const u of list) {
    const r = u.rect;
    if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return u;
  }
  return list[0]!;
}

function onMouseOver(e: Event): void {
  if (!layer) return;
  let node: Node | null = e.target as Node | null;
  let found: Unit | null = null;
  while (node && node !== document.body) {
    if (node instanceof Element) {
      const list = unitByEl.get(node);
      if (list && list.length > 0) {
        found = pickUnit(list, e);
        break;
      }
    }
    node = node.parentNode;
  }
  /*
   * 加翻層:內文區塊優先(它有自己的畫法),否則試 UI 標籤,
   * 再否則臨時加翻 —— 指到什麼就翻什麼,不讓偵測規則的縫變成「都不會翻」。
   */
  /*
   * 圖片加註走自己的一條路(`onImageMove`),而且**排在文字前面**:
   * 指標在圖上時,使用者要的是圖上的字,不是圖的 alt。
   */
  const onImage = settings.imageMode !== 'off' && imageUnder(e.target) !== null;

  const label =
    found || onImage
      ? null
      : (labelAt(e.target) ?? imageAltAt(e.target) ?? adhocLabelAt(e.target));
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
  /*
   * **決策在 keys.ts,這裡只執行**(§EB)。
   *
   * 上一版在這裡自己判斷,而「放大檢視開著就提前 return」寫在 Alt 前面 ——
   * 黑窗印著「按住 Alt 看原圖」,Alt 卻根本走不到收層的程式碼。
   * probe 直接呼叫 layer 驗過機制,沒驗按鍵這條路;抽成純函式之後
   * 這條路有單元測試看著。
   *
   * 按住 Alt = 暫時收起整層,放開就回來(hold,不是 toggle)。
   * 想瞄一眼原文是每分鐘都會做的事,常用的動作配最好按的鍵。
   */
  const act = keyDownAct(e.key, e.shiftKey, { zoomOpen: imageAnno.zoomOpen(), hiddenAll });
  switch (act) {
    case 'close-zoom':
      // 全螢幕的東西開著的時候,Esc 的意圖百分之百是關它 —— 吃掉事件
      imageAnno.closeZoom();
      e.preventDefault();
      e.stopPropagation();
      return;
    case 'hide':
      hiddenAll = true;
      layer?.setHiddenAll(true);
      // 對稱律的另一半(§2.5):文字掀開看原文,圖片就是收掉加註看原圖
      layer?.hideImage();
      closeChip(true);
      updateHud();
      break;
    case 'hide-keep-zoom':
      // 黑窗開著:setHiddenAll 會替它掛 lift(掀起來),不收窗、不動行內
      hiddenAll = true;
      layer?.setHiddenAll(true);
      updateHud();
      break;
    case 'restore':
      /*
       * Alt 加上別的鍵 = 那是一個和弦,不是「我想看原文」。
       * 按 Alt+R 時 Alt 會先單獨到達,整層收起來閃一下 ——
       * 收到第二個鍵就放回去,hold 的意圖只在 Alt 單獨按住時成立。
       */
      restoreLayer();
      break;
    case 'none':
      break;
  }
  // 和弦快捷鍵在黑窗裡不活(Esc 與 Alt 以外,黑窗把鍵盤讓給頁面)
  if (imageAnno.zoomOpen()) return;
  if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault();
    toggleDebugPanel();
  }
  if (e.altKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
    e.preventDefault();
    // 這個和弦要按住 Alt,而 Alt 已經把整層收起來了 —— 先放回來再切掃視
    restoreLayer();
    toggleAltScan();
  }
}

/** §2.1 標註樣式掃視:一眼看出哪些區塊被翻了。除錯用,所以配和弦鍵 */
function toggleAltScan(): void {
  altScan = !altScan;
  layer?.setAltScan(altScan);
  renderChips();
  diag('info', 'alt-scan', { on: altScan });
  updateHud();
}

function onKeyUp(e: KeyboardEvent): void {
  if (keyUpAct(e.key, { zoomOpen: imageAnno.zoomOpen(), hiddenAll }) === 'restore') restoreLayer();
}

/**
 * 把整層放回來。
 *
 * **兩件事,不是一件。** Alt 按下去時做了兩個動作:`setHiddenAll(true)`
 * 收文字疊層、`hideImage()` 收圖片加註。放開時上一版只做了第一件的反面 ——
 * 文字回來了,圖片加註沒有,而且**永遠回不來**:`move()` 看到滑鼠還在
 * 同一張圖上就不會重畫(§DL)。使用者的原話是「alt 按下後 layer 不見就
 * 再也不會回來了」。
 *
 * 收起來的動作有幾個,放回來的只能有一個 —— 否則下次又會漏掉一半。
 */
function restoreLayer(): void {
  if (!hiddenAll) return;
  hiddenAll = false;
  layer?.setHiddenAll(false);
  // 黑窗開著時 Alt 只掀了加註(沒收行內)—— repaint 反而會把行內疊層
  // 和 chip 畫到黑窗底下/上面
  if (!imageAnno.zoomOpen()) imageAnno.repaint();
  updateHud();
}

function onBlur(): void {
  // 切走視窗時 keyup 收不到,Alt 會卡在按住的狀態 —— 疊層就再也回不來了
  restoreLayer();
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
  /*
   * **分開數「壞掉」與「沒升級」。**
   *
   * `l1-failed` 的區塊有 L0 譯文在畫面上 —— 使用者讀得懂,只是品質停在 L0。
   * 把它算成「失敗」會讓狀態列變成警示級,而警示級是不自動淡出的(§CF-3),
   * 於是免費檔位偶爾吐一次空回應,畫面上就掛著一條永遠不會消失的紅色橫幅。
   * 使用者的結論是「一直卡在 missing-id,不會再翻了」——
   * 其實那一頁 328 塊裡有 326 塊翻完了。
   *
   * 真正還沒有東西可看的只有 `failed`。留下待辦要留對東西。
   */
  const hard = c.failed;
  const soft = c['l1-failed'];
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

  if (hiddenAll) {
    layer.setHud('疊 · 疊層暫時收起(放開 Alt 回來)', 'idle');
    return;
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
    layer.setHud(`疊 · 已啟用,${units.size} 塊待翻 —— 按 Alt+R 或 popup 開始`, 'idle');
    return;
  }
  const parts: string[] = [];
  if (c.l0 > 0) parts.push(`L0 ${c.l0}`);
  if (c.l1 > 0) parts.push(`L1 ${c.l1}`);
  if (hard > 0) parts.push(`失敗 ${hard}`);
  if (soft > 0) parts.push(`未升級 ${soft}`);
  if (settings.annotate && labels.size > 0) parts.push(`標籤 ${labels.size}`);
  const heldBack = [...units].filter((u) => u.pendingSwap !== undefined).length;
  if (heldBack > 0) parts.push(`待換 ${heldBack}`);

  const phase = translationPhase({ waiting, nearPending, farPending });
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
  /*
   * **有失敗也要說「完成」。**
   *
   * 原本有紅的時候只講「滑到紅線上重試」,把「跑完了」整個吞掉 ——
   * 於是使用者看到的是一條警示狀態列,幾秒後消失,而且從頭到尾
   * 沒人告訴他整頁其實翻完了。他的結論是「文章翻不完,HUD 不見了,
   * 是不是死掉了」。**沒說完成,就等於說了沒完成。**
   */
  /*
   * 「完成」要說得起。整頁跑完了,但還有區塊停在 L0(捲太快、沒停留過)——
   * 那不是壞掉,可是也不該讓使用者以為那就是最終品質。
   * 講清楚,而且**告訴他怎麼要**:同一顆按鈕再按一次就全部升級。
   */
  const onlyL0 = usesL1(effective)
    ? [...units].filter((u) => u.tier === 'l0' && !u.l1Queued).length
    : 0;
  const tail =
    hard > 0
      ? ` · ${done}(滑到紅線上重試)`
      : onlyL0 > 0 && phase === 'all-done'
        ? ` · ${done} · ${onlyL0} 塊只有 L0,Alt+R 全部升級`
        : ` · ${done}`;
  layer.setHud(`疊 · ${parts.join(' · ')}${tail}`, hard > 0 ? 'warn' : 'idle');
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
    device: device ?? undefined,
    l0Timing: l0?.timing(),
    unparsedColors: unparsedColors(),
    oversized: oversizedUnits(),
    cacheHits: cacheHitsTotal,
    motion: {
      stability: settings.stability,
      guard: guarding(),
      appShell: appShellPage,
      innerScroll: sawInnerScroll,
      pinned: pinnedCount,
    },
    l1Queue: l1QueueView(),
    pageKey,
    glossary: {
      names: matchedGlossaries(host, settings),
      terms: glossary.length,
      inPrompt:
        settings.glossaryPrompt === 'on' ||
        (settings.glossaryPrompt !== 'off' && TIERS[state.tier].glossaryPrompt),
    },
    swapsOffscreen,
    swapsTotal,
  };
}

/** 內容腳本認為還在 L1 佇列裡的區塊 —— 拿去和 worker 的數字對 */
function l1QueueView(): { queued: number; oldestMs: number; retried: number } {
  const now = Date.now();
  let queued = 0;
  let oldest = 0;
  let retried = 0;
  for (const u of units) {
    if (u.l1Retries) retried++;
    if (!u.l1Queued || u.l1Text !== undefined) continue;
    queued++;
    oldest = Math.max(oldest, now - (u.upgradeQueuedAt ?? now));
  }
  return { queued, oldestMs: Math.round(oldest), retried };
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
  resetColorCache();
  clearMeasureCache();

  // 整頁的字集要在掃描之前定案:日文 / 韓文頁面的純漢字標題不能被當成
  // 「已經是中文」而跳過(見 detect.ts 的 setPageScript)
  if (!device) {
    device = deviceProfile();
    diag('info', 'device', device);
  }
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
  layer.setVeilStrength(settings.imageVeil);
  layer.onChipAction((action) => {
    if (action === 'zoom') imageAnno.openZoom();
    // 失敗的 chip 說「點一下重試」,那句話要真的算數(§DS-1)
    if (action === 'retry') imageAnno.retry();
  });
  layer.onZoomDismiss(() => imageAnno.closeZoom());
  await checkModelId();

  io = new IntersectionObserver(
    (entries) => {
      let hit = false;
      for (const en of entries) {
        // 一個元素可以有好幾段行內單元,每一段都要跟著更新
        for (const u of unitByEl.get(en.target) ?? []) {
          u.inView = en.isIntersecting;
          if (en.isIntersecting) {
            // §4.2 第 2 條的計時起點
            if (u.inViewSince === undefined) u.inViewSince = Date.now();
            hit = true;
          } else {
            u.inViewSince = undefined;
          }
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
    adoptNewImages(records);
    onRouteChange();
    scheduleFlush(true);
  });
  /*
   * 屬性也要看,但只看收合元件那幾個。
   *
   * `<details open>` 的切換是**屬性**變動,而診斷 log 顯示 `toggle` 事件
   * 根本沒進來(頁面自己的 JS 直接改屬性時不會派發那個事件)。
   * attributeFilter 讓成本維持在只有這幾個名字才觸發。
   */
  mo.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'hidden', 'aria-expanded', 'aria-hidden'],
  });

  document.addEventListener('mouseover', onMouseOver, true);
  /*
   * 錨點的命中測試要**連續的座標** —— `mouseover` 只在跨元素邊界時觸發,
   * 而錨點是畫在疊層上的,滑鼠在同一張圖裡移動不會產生新的 mouseover。
   */
  document.addEventListener('mousemove', onImageMove, { passive: true, capture: true });
  document.addEventListener('click', onImageClick, true);
  document.addEventListener('mouseleave', onDocLeave);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', relayout);
  window.addEventListener('resize', onZoomResize);
  // capture:內層容器的捲動(水平卡片輪播、overflow 區塊)不冒泡到 window,
  // 但 capture 階段會經過 document —— 沒有這個,輪播一捲整排疊層就錯位
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('pagehide', onPageHide);
  // 上一頁 / 下一頁與 hash 路由不一定改動 DOM,MutationObserver 打不到
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  /*
   * <details> 展開 / 收折。
   *
   * 這是回報的「原本收折的沒展開就會爆掉」的元兇:切換 open 只是**屬性**
   * 變動,而 MutationObserver 只看 childList 與 characterData ——
   * 完全打不到。於是內容整片上移或下移,疊層留在舊座標,
   * 答案的譯文疊到問題的標題上。
   *
   * toggle 不冒泡,但 capture 階段抓得到。
   */
  document.addEventListener('toggle', onDisclosureToggle, true);
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
  /*
   * 應用程式外殼(document 本身不捲,像 Gmail / Slack)另外開一輪快檢。
   *
   * 那種頁面的捲動發生在內層容器裡,而**捲動事件不一定收得到**
   * (自訂捲動、虛擬清單、shadow DOM)。與其賭事件收得到,
   * 不如直接量:座標一錯就先藏起來再重排。
   * 只驗座標,不做遮擋檢查(那個貴,而且不會因為捲動而改變結論)。
   */
  const el = document.documentElement;
  const appShell = el.scrollHeight <= el.clientHeight + 4;
  appShellPage = appShell;
  diag('info', 'layout-mode', {
    appShell,
    stability: settings.stability,
    guard: motionGuard({ stability: settings.stability, appShell, innerScroll: sawInnerScroll }),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  });
  if (appShell) {
    driftTimer = window.setInterval(() => {
      if (document.hidden) return;
      auditPositions(false);
    }, 250);
  }
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
 * 會裁切這個單元的祖先(`overflow` 不是 visible 的那些)。
 *
 * 找一次就存起來:結構不會因為捲動而改變,只有重排才需要重算。
 * 每次 flush 重找的話是 59 個單元 × 十幾層 getComputedStyle。
 */
const clippersOf = new WeakMap<Unit, Element[]>();

function clippers(u: Unit): Element[] {
  const hit = clippersOf.get(u);
  if (hit) return hit;
  const out: Element[] = [];
  for (let p = u.el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    // 「真的會裁」只有一份定義(occlusion.ts)—— 第三份就是 §DZ 的事故
    if (clipsContent(p)) out.push(p);
  }
  clippersOf.set(u, out);
  return out;
}

/**
 * 疊層可以畫在視窗的哪一塊(視窗座標)。
 *
 * 使用者的話:「破版有辦法量 inner 的上下嗎?可以保守一點。」——
 * 對,而且該量的不只上下,是**四邊**,而且不只一層。
 *
 * 這是「疊在頁面外面」的最後一個代價:內容捲出捲動容器時,頁面會把它裁掉,
 * 而我們的疊層在最上層,不受任何裁切 —— 於是畫到 Gmail 的搜尋列與
 * 工具列上面去。附圖裡那些浮在最上方的譯文全部是這樣來的。
 *
 * 修法和「被固定頁首蓋住」完全一樣:算出可見的矩形,用 clip-path 裁掉。
 * 保守的方向是**寧可多裁**:交集為空就整塊不見。
 */
/**
 * 被容器限制住時,底邊再往上收這麼多(px)。
 *
 * 使用者的原話:「下半部可以再加寬一下,就算最下面有一些內容沒 show layer,
 * 只要畫面中間有就可以了。」—— 這是對的取捨:容器底邊附近本來就常有
 * 陰影、漸層、釘住的按鈕列,量得再準也只是勉強擦邊。少蓋一點沒人會發現,
 * 多蓋一點整頁就髒了。
 *
 * 32 還是會擦到(譯文盒子比譯文本身高 —— 它要蓋住比較長的原文),
 * 使用者說「再多抓一倍就好,只要畫面中間有就好」。64 是那個一倍,
 * 再補 8px 收掉最後一點溢出 —— 譯文的最後一行常常只露出幾個像素的邊。
 *
 * **只在真的被容器限制住時才收。** 一般頁面(視窗捲動)的底邊是視窗本身,
 * 那裡的疊層是合法的、而且下面還有內容 —— 收 32px 會在每一頁的底部
 * 切出一條看得見的線。
 */
const CONTAINER_SAFETY_PX = 72;

function visibleBox(u: Unit): Box {
  let top = lastTopBand;
  let left = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight - lastBottomBand;
  let limiter: Element | null = null;
  for (const p of clippers(u)) {
    const r = p.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue; // 祖先自己沒被畫出來,交給別的檢查處理
    if (r.top > top) top = r.top;
    if (r.left > left) left = r.left;
    if (r.right < right) right = r.right;
    if (r.bottom < bottom) {
      bottom = r.bottom;
      limiter = p;
    }
  }
  /*
   * 餘裕只留給**真的會捲**的容器。裁切用的 overflow:hidden 內容一格都不會動,
   * 留 72px 只是把最後兩行的疊層白白切掉(見 cover.ts 的 scrolls())。
   * 只問限制底邊的那一個,不是每一層 —— 一個 frame 一次屬性讀取。
   */
  if (limiter && scrolls(limiter)) bottom -= CONTAINER_SAFETY_PX;
  return { top, right, bottom, left };
}

/** 探測容器底邊時往內縮幾 px */
const PIN_PROBE_PX = 4;

/**
 * 捲動容器底部有沒有釘著別的東西。
 *
 * Gmail 的 Reply / Forward 列蓋在郵件窗格的底部,而**窗格本身的矩形延伸到
 * 它底下** —— 所以「裁到容器」還是不夠,回報的「下半部疊到 reply forward
 * 那欄」就是這個。
 *
 * 只對「盒子已經碰到容器底邊」的單元做(通常零到兩個),
 * 用 `elementFromPoint` 問頁面:這個位置**現在畫的是什麼**?
 * 打到的東西如果和這個單元無關(既不是祖先也不是子孫),那就是蓋在上面的別人。
 *
 * 疊層的 `pointer-events: none` 在這裡第三次派上用場:命中測試打不到我們自己。
 *
 * 只認「橫跨大半個容器、而且貼著底邊」的東西 ——
 * 不然角落一顆小按鈕就會把整塊譯文裁掉。
 */
function pinnedBottom(u: Unit, box: Box, overlayBottom: number): number {
  if (overlayBottom < box.bottom - PIN_PROBE_PX) return box.bottom;
  const x = Math.round(Math.max(box.left + 4, Math.min(box.right - 4, (box.left + box.right) / 2)));
  const hit = document.elementFromPoint(x, Math.round(box.bottom - PIN_PROBE_PX));
  if (!hit || hit === u.el || hit.contains(u.el) || u.el.contains(hit)) return box.bottom;
  const r = hit.getBoundingClientRect();
  const wide = r.width >= (box.right - box.left) * 0.5;
  const atBottom = box.bottom - r.bottom <= PIN_PROBE_PX * 2;
  // 釘住的橫列也留同樣的餘裕 —— 貼著它的上緣切,邊界看起來還是很緊
  return wide && atBottom && r.top > box.top ? r.top - CONTAINER_SAFETY_PX : box.bottom;
}

/**
 * 把「頁面自己會裁掉、而我們不會」的部分從疊層上裁掉。
 *
 * 兩個來源:固定頁首 / 頁尾(蓋住原文),以及內層捲動容器(裁掉原文)。
 * 兩者的處置一樣 —— 原文看不到的地方,譯文也不該看得到。
 */
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
  let clipped = 0;
  for (const u of units) {
    if (!u.box) continue;
    const vTop = u.rect.top - window.scrollY - u.bleed.y;
    const vLeft = u.rect.left - window.scrollX - u.bleed.x;
    const vBottom = vTop + u.rect.height + u.bleed.y * 2;
    const vRight = vLeft + u.rect.width + u.bleed.x * 2;
    if (vBottom < -50 || vTop > h + 50) {
      layer.setClip(u, 0, 0, 0, 0);
      continue;
    }
    const box = visibleBox(u);
    box.bottom = pinnedBottom(u, box, vBottom);
    const ins = clipInsets({ top: vTop, right: vRight, bottom: vBottom, left: vLeft }, box);
    if (ins.top > 0 || ins.right > 0 || ins.bottom > 0 || ins.left > 0) clipped++;
    layer.setClip(u, ins.top, ins.right, ins.bottom, ins.left);
  }
  if (clipped !== lastClippedCount) {
    lastClippedCount = clipped;
    let noClipper = 0;
    for (const u of units) if (u.box && clippers(u).length === 0) noClipper++;
    /*
     * **只有 noClipper 變了才寫進診斷 log。**
     *
     * `clipped` 每次 flush 都在 2↔12 之間跳(捲一下就變),於是這一則
     * 在上一份 log 的 300 格環狀緩衝裡佔掉了 250 格 —— 使用者問
     * 「為什麼還有 L0」,而唯一能回答的那幾行早就被自己的雜訊擠掉了。
     *
     * 真正的訊號是 noClipper:大 = 我根本沒找到那個捲動容器。
     * clipped 的抖動留給 dbg,devtools 開著才看得到。
     */
    dbg('clip-to-container', clipped, noClipper, units.size);
    if (noClipper !== lastNoClipper) {
      lastNoClipper = noClipper;
      diag('info', 'clip-to-container', { clipped, noClipper, total: units.size });
    }
  }
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
    const gone = clippedAway(u.el);
    layer.setCovered(u, gone);
    if (gone) hidden++;
  }
  if (hidden !== lastCovered) {
    lastCovered = hidden;
    /*
     * **比例本身就是訊號**(lessons §35)。
     *
     * 「檢查 19 塊藏 19 塊」在上一份 log 裡出現了幾十次,而它安靜地待在
     * info 那一堆裡 —— 因為這一則平常也長這樣(捲到一半、輪播的另一份)。
     * 使用者看到的是一整頁原文,log 說一切正常,兩邊對不上號(§DV)。
     *
     * 幾乎全藏是**不正常的**:正常情況下視窗附近的單元大多看得見。
     */
    const all = checked >= 4 && hidden === checked;
    diag(all ? 'warn' : 'info', 'clipped-overlays', { hidden, checked });
  }
}

let lastOrigin = '';

/**
 * 驗證「絕對座標 (0,0) 真的等於文件原點」。
 *
 * 正常頁面一定成立,所以這裡多半什麼都不做(一次 rect 讀取的成本)。
 * 但應用程式外殼可能把 `<html>` / `<body>` 變成定位或 transform 的容器,
 * 那時整層疊層會平移一段固定距離 —— 而**每一塊都錯同樣的量**,
 * 症狀看起來就像「疊層整片跑掉」。
 *
 * 這是 §R / §X / §AA 三輪都在找、但當時是用「拿掉原點」的方式亂試的東西。
 * 這次把它變成一個明確的、會寫進 log 的檢查。
 */
function checkOrigin(): void {
  if (!layer) return;
  const r = layer.hostRect();
  const dx = Math.round(r.left + window.scrollX);
  const dy = Math.round(r.top + window.scrollY);
  const key = `${dx},${dy}`;
  if (key === lastOrigin) return;
  lastOrigin = key;
  layer.setOrigin(-dx, -dy);
  if (dx !== 0 || dy !== 0) diag('warn', 'origin-offset', { dx, dy });
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
  // 還在動的時候疊層已經藏起來了,不必每個 frame 再量 —— 結論永遠是「還在動」
  if (!settled()) return;
  // 疊層本身由瀏覽器跟著頁面捲(document 座標),JS 不碰位置。
  // 這裡只處理「被固定頁首蓋住的那一段要跟著消失」。
  applyChromeClip();
  // 再看內容自己有沒有移動(sticky、lazy load、內容插入)
  /*
   * 哨兵**不能是釘住的單元**。
   *
   * sticky / fixed 的元素在 document 座標裡本來就會隨捲動移動,移動量
   * 正好是捲動距離 —— 拿它當「內容有沒有自己在動」的哨兵,等於每一幀
   * 都判定「漂移了」,然後每一幀重量 373 個單元。診斷 log 裡
   * `scroll-drift {"dy":5884}` 那種數字不是漂移,是捲動距離本身。
   *
   * 這是 build 47 讓 sticky 子樹產生單元之後才出現的:u1 變成
   * `<header class="sticky top-0">` 裡的按鈕,而它永遠在視窗裡。
   * **放寬了誰能成為單元,就要重新檢查誰在拿單元當量尺。**
   */
  const probe = [...units].find(
    (u) => u.box && u.inView && u.tier !== 'skipped' && u.pinned !== true,
  );
  if (!probe) return;
  const d = driftOf(probe);
  const off = Math.max(Math.abs(d.dx), Math.abs(d.dy));
  if (off <= 2) return;
  noteDrift(probe.id, d);
  /*
   * 差幾像素只是沒對齊,重排一下就好;差一大截代表疊層已經蓋在
   * **別人的內容**上,那才是「破版」—— 先藏起來再說。
   * 門檻分開是為了不讓 parallax / sticky 那種長期小幅漂移一直閃。
   */
  if (off > GROSS_DRIFT_PX && guarding()) {
    markAllStale();
    noteMotion();
  }
  flushNow();
}

/**
 * 座標已知是錯的 → **先全部藏起來**。
 *
 * 這是回報的「破版」的正解:不透明的盒子畫在錯的位置上,蓋掉的是別人的
 * 內容,看起來就是整頁爛掉。疊層暫時消失只是看到原文 —— 兩害相權,
 * 沒有疑問。
 *
 * 換句話說,這裡建立一條不變式:**我們不顯示已知錯位的疊層**。
 * 之前只有「捲動中」這一種情況會藏,但錯位的來源不只捲動
 * (內容插入、圖片載入、應用程式重繪),而且捲動事件不一定收得到。
 */
/** 超過這個位移就不只是「沒對齊」,是蓋到別人身上了(px) */
const GROSS_DRIFT_PX = 12;

function markAllStale(): void {
  if (!layer) return;
  for (const u of units) if (u.box || u.hint) layer.setStale(u, true);
}

/** 繞過 scheduleFlush 的 120ms debounce —— 錯位的每一毫秒都看得見 */
function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  requestAnimationFrame(flush);
}

/** 只在量級變化時記一筆,不然捲動時每 frame 一筆會把 log 洗掉 */
function noteDrift(id: string, d: { dx: number; dy: number }): void {
  const bucket = `${id}:${Math.round(d.dx / 20)},${Math.round(d.dy / 20)}`;
  if (bucket === lastShiftBucket) return;
  lastShiftBucket = bucket;
  diag('info', 'scroll-drift', { id, dx: Math.round(d.dx), dy: Math.round(d.dy) });
}

/**
 * 內層容器捲動之後多久重新量(ms)。
 * 太短會在慣性捲動中反覆重排,太長會讓疊層消失得很明顯。
 */
/**
 * 「頁面靜下來了」的單一判準。
 *
 * 前四輪是打地鼠:捲動事件一條路、座標稽核一條路、內層沉澱一條路,
 * 每一條都各自決定要不要把疊層放出來 —— 於是總有一條會在還在動的時候
 * 把它放出來。log 裡 position-drift 一秒兩三筆、dy 最大 4255,
 * 每一筆都代表「藏起來 → 量 → 放出來」跑了一遍。那就是閃爍。
 *
 * 改成**一個概念**:任何一種「內容在動」的訊號都只做一件事 ——
 * 蓋上時間戳。疊層只在「距離最後一次動超過 200ms」時才顯示。
 * 誰偵測到的不重要,偵測到幾次也不重要。
 */
const MOTION_SETTLE_MS = 200;
let lastMotionAt = -1e9;
let settleTick = 0;

function settled(): boolean {
  return performance.now() - lastMotionAt >= MOTION_SETTLE_MS;
}

function checkSettled(): void {
  const left = MOTION_SETTLE_MS - (performance.now() - lastMotionAt);
  if (left > 0) {
    settleTick = window.setTimeout(checkSettled, left);
    return;
  }
  settleTick = 0;
  // 靜下來了:量一次,一次顯示
  flushNow();
}

/**
 * 頁面捲動停了嗎?只有 pinned 單元在意這件事 ——
 * 一般段落在 document 座標裡不會因為捲動而改變位置。
 */
function scrollIdle(): boolean {
  return performance.now() - lastScrollAt >= MOTION_SETTLE_MS;
}

/**
 * 這一頁要不要用「動就先藏起來」的策略。
 *
 * 判斷收在一個地方,而且**每次都重問** —— sawInnerScroll 會在頁面用了
 * 內層捲動的那一刻變成 true,設定也可能在使用中改掉。
 */
function guarding(): boolean {
  return motionGuard({
    stability: settings.stability,
    appShell: appShellPage,
    innerScroll: sawInnerScroll,
  });
}

function noteMotion(): void {
  lastMotionAt = performance.now();
  if (settleTick === 0) settleTick = window.setTimeout(checkSettled, MOTION_SETTLE_MS);
}

function innerScrollerOf(e: Event): Element | null {
  const t = e.target;
  if (!(t instanceof Element)) return null;
  if (t === document.documentElement || t === document.body) return null;
  return t;
}

function onScroll(e: Event): void {
  lastScrollAt = performance.now();
  /*
   * 內層容器捲動 —— 疊層在 document 座標,不會跟著動。
   *
   * **不**再逐一檢查哪些單元在這個容器裡:log 裡出現過
   * `inner-scroll {"units":0}`,因為 Gmail 有巢狀捲動容器,
   * 捲的那一個不一定是我們追蹤的單元的祖先。動了就是動了,
   * 全部先藏起來,靜下來再一次顯示。
   */
  if (layer && running && innerScrollerOf(e)) {
    // 證據比推測強:收到過就從此開啟守衛(一般文章一輩子收不到)
    sawInnerScroll = true;
    if (guarding()) {
      if (settled()) {
        markAllStale();
        diag('info', 'inner-scroll', { units: units.size });
      }
      noteMotion();
    }
  }

  /*
   * 貼片是 position: fixed,不跟著頁面捲 —— 所以捲動時直接關掉。
   * 這是**刻意**不走疊翻那套 document 座標 + 捲動自我修正:
   * 貼片是暫態的,不需要跟著捲;不跟著捲就沒有 build 14 那種
   * 「JS 慢合成器一幀 → 疊層抖動」的問題。
   */
  if (chipUnit || layer?.chipsVisible()) closeChip(true);
  if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollSync);
  /*
   * pinned 單元靠 flush 才會重新量、重新顯示,而 flush 不會自己因為
   * 「捲動停了」被排程。沒有這個計時器,右側浮動目次會在第一次捲動後
   * 永遠藏著 —— 藏起來容易,記得放回來才是重點。
   */
  if (pinnedCount > 0 && !pinnedTimer) {
    pinnedTimer = window.setTimeout(function tick(): void {
      if (!scrollIdle()) {
        pinnedTimer = window.setTimeout(tick, MOTION_SETTLE_MS);
        return;
      }
      pinnedTimer = 0;
      scheduleFlush(true);
    }, MOTION_SETTLE_MS);
  }
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
  clearTimeout(pinnedTimer);
  pinnedTimer = 0;
  pinnedCount = 0;
  appShellPage = false;
  sawInnerScroll = false;
  cacheHitsTotal = 0;
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mousemove', onImageMove, true);
  document.removeEventListener('click', onImageClick, true);
  document.removeEventListener('mouseleave', onDocLeave);
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('selectionchange', onSelectionChange);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', relayout);
  document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('popstate', onRouteChange);
  window.removeEventListener('hashchange', onRouteChange);
  document.removeEventListener('toggle', onDisclosureToggle, true);
  document.removeEventListener('transitionend', onMotionEnd, true);
  document.removeEventListener('animationend', onMotionEnd, true);
  document.removeEventListener('load', onResourceLoad, true);
  document.removeEventListener('error', onResourceLoad, true);
  clearInterval(settleTimer);
  settleTimer = 0;
  clearInterval(driftTimer);
  driftTimer = 0;
  lastOrigin = '';
  clearTimeout(motionTimer);
  motionTimer = 0;
  clearTimeout(hoverRetryTimer);
  hoverRetryTimer = undefined;
  clearTimeout(settleTick);
  settleTick = 0;
  lastMotionAt = -1e9;
  clearTimeout(rescanTimer);
  rescanTimer = 0;
  lastScanAt = -1e9;
  scanGapMs = MIN_SCAN_GAP_MS;
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  emptyScans = 0;
  for (const u of units) layer?.drop(u);
  layer?.hideHud();
  manualArmed = false;
  hiddenAll = false;
  altScan = false;
  lastProblem = '';
  units.clear();
  unitById.clear();
  // 重建而不是清空:WeakMap / WeakSet 沒有 clear(),
  // 留著會讓下一次 scan() 認為整頁都已經建過單元
  unitByEl = new WeakMap<Element, Unit[]>();
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
  lastHref = location.href;
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

/** worker 送來的是上一頁(或另一個 pageKey)的東西 —— 丟掉,但要看得見 */
function stale(kind: string, from: string, n: number): void {
  diag('warn', 'stale-message', { kind, n, from: from.slice(-24), now: pageKey.slice(-24) });
}

/**
 * 圖片上的滑鼠移動。
 *
 * 節流到每幀一次:`mousemove` 在 60Hz 下一秒幾十次,而每次都要問
 * `getBoundingClientRect` 與跑一遍命中測試。
 */
let imageMoveRaf = 0;
let lastImageMove: { target: EventTarget | null; x: number; y: number } | null = null;

/**
 * 站方的 lightbox 開出來的新 `<img>`:同一個 src 就直接把加註畫過去(§2.4)。
 *
 * 圖片是非同步載入的,插進 DOM 的當下 `currentSrc` 常常還是空的 ——
 * 所以拿不到就掛一次 `load` 再試。
 */
function adoptNewImages(records: readonly MutationRecord[]): void {
  if (settings.imageMode === 'off') return;
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (!(node instanceof Element)) continue;
      const imgs =
        node instanceof HTMLImageElement ? [node] : [...node.querySelectorAll('img')];
      for (const img of imgs) {
        if (!(img instanceof HTMLImageElement)) continue;
        if (imageAnno.adopt(img)) continue;
        if (!img.complete) {
          img.addEventListener('load', () => imageAnno.adopt(img), { once: true });
        }
      }
    }
  }
}

/** 放大檢視是 fit 到視窗的,視窗變了要重算 */
function onZoomResize(): void {
  if (!imageAnno.zoomOpen()) return;
  const box = layer?.zoomSize();
  const img = imageAnno.currentImage();
  if (!box || !img) return;
  imageAnno.relayoutZoom(box, { w: img.naturalWidth, h: img.naturalHeight });
}

function onImageMove(e: MouseEvent): void {
  /*
   * **最後一道保險:Alt 已經放開了,但 keyup 沒有到。**
   *
   * keyup 可能整個消失(焦點被別的東西搶走、切分頁再切回來、
   * 作業系統攔截了那一下)。`blur` 接得住大部分,接不住的就卡在
   * 「整層不見」的狀態 —— 使用者的原話是「再也不會回來了」。
   *
   * 而 mousemove 每一顆事件都帶著 `altKey`:滑鼠一動就是最好的訊號,
   * 而且使用者想看回譯文時本來就會動滑鼠。
   */
  if (hiddenAll && !e.altKey) restoreLayer();
  if (settings.imageMode === 'off') return;
  lastImageMove = { target: e.target, x: e.clientX, y: e.clientY };
  if (imageMoveRaf) return;
  imageMoveRaf = requestAnimationFrame(() => {
    imageMoveRaf = 0;
    const m = lastImageMove;
    if (m) imageAnno.move(m.target, m.x, m.y);
  });
}

/**
 * Alt+click 升級到 L1(`docs/plan-images.md` §3.1)。
 *
 * **只有帶 Alt 才接手**:圖片常常是連結(卡片、相簿),普通的點擊要讓它
 * 照常導航。Alt+click 在瀏覽器預設是「下載連結」,而使用者在圖片上按
 * Alt 的意圖幾乎不會是下載 —— 這個鍵位和「按住 Alt 看原文」也一致。
 */
function onImageClick(e: MouseEvent): void {
  if (!e.altKey || settings.imageMode === 'off') return;
  if (imageAnno.upgrade(e.target)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

chrome.runtime.onMessage.addListener((raw: ToContent, _sender, reply) => {
  if (!raw || typeof raw !== 'object') return;
  switch (raw.type) {
    case 'results': {
      // pageKey 對不上就丟掉是對的(那是上一頁的譯文),但**丟掉要留下痕跡** ——
      // 上一輪查「排進去卻沒有回音」時,這裡的沉默 return 是嫌疑人之一,
      // 而 log 裡看不出來到底有沒有走到這條路。
      if (raw.pageKey !== pageKey) return stale(raw.type, raw.pageKey, raw.results.length);
      applyResults(raw.results);
      break;
    }
    case 'image-result': {
      if (raw.pageKey !== pageKey) return stale(raw.type, raw.pageKey, raw.blocks.length);
      imageAnno.onResult(raw.url, raw.hash, raw.lane, raw.blocks);
      break;
    }
    case 'image-error': {
      if (raw.pageKey !== pageKey) return;
      imageAnno.onError(raw.url, raw.reason);
      break;
    }
    case 'failures': {
      if (raw.pageKey !== pageKey) return stale(raw.type, raw.pageKey, raw.failures.length);
      for (const f of raw.failures) {
        const u = unitById.get(f.id);
        if (!u) continue;
        /*
         * **有譯文就不是失敗。**
         *
         * results 與 failures 是兩則訊息,results 先到 —— 所以一則遲到的
         * 失敗可以把一塊已經翻好的字降級成紅色。worker 那一側已經不會再送
         * 這種東西了(protocol.ts 把有結果的 id 濾掉),但這條不變式便宜,
         * 而且它防的是「未來某條路徑又送了一次」。
         */
        if (u.l1Text !== undefined) continue;
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
    case 'export-page': {
      const done = [...units].filter((u) => hasText(u)).length;
      if (done === 0) {
        reply({ error: '這一頁還沒有任何譯文 —— 先翻再匯出' });
        return true;
      }
      const snap = buildSnapshot({
        units,
        hostId: HOST_ID,
        url: location.href,
        version: chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version,
      });
      reply({ html: snap.html, applied: snap.applied, title: document.title, total: done });
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
  let retryCount = 0;
  for (const u of units) {
    if (u.tier === 'failed' || u.tier === 'l1-failed' || u.tier === 'l0-failed') {
      retryCount++;
      u.tier = u.l0Text !== undefined ? 'l0' : 'pending';
      u.l1Queued = false;
      u.failReason = undefined;
      u.l0Tries = 0;
      probed.delete(u);
    }
  }
  /*
   * **再按一次 = 把還停在 L0 的也升上去。**
   *
   * §4.2 的停留門檻(1.5 秒)是成本閘門:純粹捲過去的段落留在 L0,一毛不花。
   * 那條規則是對的,但它留下一個沒有出口的狀態 —— 整頁「完成」了,
   * 其中十二塊卻只有 L0 品質,而使用者沒有任何方法說「那幾塊我要好的」。
   * 使用者的原話:「有些還停在 L0 但顯示完成」。
   *
   * 這個動作本來就叫「翻譯這一頁」,而且是使用者親手按的 ——
   * 讓它把工作做完是最不意外的行為,也不需要新的按鈕或快捷鍵。
   */
  /*
   * **卡住的也算「還沒排」。**
   *
   * 「都顯示完成 或是已經在佇列裡 但沒有變 L1」—— 上一版按下去只會回報
   * `alreadyQueued:5`,因為那五塊的 `l1Queued` 是 true。可是它們四十五秒
   * 前就排進去了,而且一則回音都沒有。使用者親手按的動作不該被一個
   * 早就過期的旗標擋下來。
   */
  const now = Date.now();
  let unstuck = 0;
  for (const u of units) {
    if (stuckPlan(u, now) === 'ok') continue;
    u.l1Queued = false;
    u.upgradeQueuedAt = undefined;
    u.l1Retries = 0;
    unstuck++;
  }
  const l0Units = [...units].filter((u) => u.tier === 'l0');
  const stillL0 = l0Units.filter((u) => !u.l1Queued);
  /*
   * **收折起來的內容也要升級。**
   *
   * 平常的停留門檻不理會收折的 `<details>`(看不見的東西不必花錢),
   * 上一版把同一條規則抄進這裡 —— 於是使用者按了「翻譯這一頁」,
   * 而那 12 塊剛好全在收折的 FAQ 裡,按鈕什麼都沒做。
   * 使用者的原話:「按翻譯這一頁跟 alt+shift+r 沒啥用」。
   *
   * 自動的規則可以保守,**使用者親手按的動作不行** ——
   * 他要的是「這一頁」,不是「這一頁我現在看得到的部分」。
   */
  for (const u of stillL0) if (u.maxChars === 0) u.maxChars = computeMaxChars(u);
  const ready = stillL0.filter((u) => u.maxChars > 0);
  /*
   * 這一則**每次都寫**,包括什麼都沒做的時候。
   *
   * 上一輪查「按了沒反應」時,log 裡連一行都沒有 —— 只能從缺席去推測,
   * 而缺席可以是「沒被呼叫」也可以是「呼叫了但集合是空的」,分不出來。
   * 使用者親手觸發的動作,一定要在 log 裡留下它做了什麼。
   */
  diag('info', 'translate-page', {
    l0: l0Units.length,
    upgrading: ready.length,
    alreadyQueued: l0Units.length - stillL0.length,
    noRoom: stillL0.length - ready.length,
    retried: retryCount,
    unstuck,
  });
  if (ready.length > 0) {
    ready.sort((a, b) => priorityOf(a) - priorityOf(b));
    queueUpgrade(ready);
  } else if (retryCount === 0) {
    /*
     * 按了就要有回音 —— 而「已經在佇列裡」這句話還不夠。
     *
     * 使用者的原話是「看起來要多按幾次才行」:他按下去,狀態列說
     * 「已經在佇列裡了」,畫面沒有任何變化,於是再按一次。那句話
     * 沒有說錯,但它沒有回答**還要等多久**,所以看起來像沒反應。
     *
     * 去問 worker 佇列現在多深,把數字說出來:排隊和當機是兩件事,
     * 使用者看得出差別就不會一直按。
     */
    const depth = await ask<{ page?: number; total?: number }>({
      type: 'page-status',
      pageKey,
    });
    const ahead = depth?.total ?? 0;
    lastProblem =
      l0Units.length > 0
        ? ahead > 0
          ? `這 ${l0Units.length} 塊在佇列裡,前面還有 ${ahead} 塊`
          : `這 ${l0Units.length} 塊已經送出去了,等回應`
        : '沒有可以再升級的區塊';
    window.setTimeout(() => {
      if (lastProblem !== '') lastProblem = '';
      updateHud();
    }, 2500);
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
    (u) =>
      u.tier === 'l0-failed' &&
      u.l1Text === undefined &&
      u.maxChars > 0 &&
      (u.l0Tries ?? 0) < L0_MAX_TRIES,
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
      glossary = resolveGlossary(host, settings);
      setDebug(settings.debug);
      /*
       * 詞表改了 → 已經翻好的譯文是用舊詞表翻的。
       * 快取 key 帶了詞表指紋(§6),所以重翻不會拿到舊的;
       * 但已經畫在畫面上的那些不會自己更新 —— 那是使用者按
       * 「翻譯這一頁」的守備範圍,不在設定變更時自動重翻(要花錢)。
       */
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
  glossary = resolveGlossary(host, settings);
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
