/**
 * 圖片加註的生命週期 —— hover 觸發、結果落地、重錨定、放大檢視。
 *
 * 規格:`docs/plan-images.md` §2.2(兩段式)、§2.4(同 src)、§2.5(對稱律)、§3。
 *
 * 這個模組**不直接碰 worker**,也不直接碰 overlay 的 shadow root:
 * 兩者都由 `index.ts` 注入。理由是 `index.ts` 已經是三千行的協調者,
 * 再往裡面塞一套狀態機只會讓兩件事互相絆住。
 */

import { diag } from '../shared/diag.ts';
import { MAX_PLATES, type ImageBlock } from '../shared/imageblocks.ts';
// 時限彼此有順序,所以住在同一個檔案裡(`shared/imagetiming.ts` 的開頭有那張圖)
import { IMAGE_WATCHDOG_MS } from '../shared/imagetiming.ts';
import {
  drawnRect,
  parsePosition,
  placeBlocks,
  worthTranslating,
  type ObjectFit,
  type PlacedBlock,
} from './imagegeo.ts';

/** 滑上圖片停多久才送 L0。和 UI 標籤的 180ms 不同 —— 這個要花配額 */
export const IMAGE_HOVER_MS = 500;


/**
 * 滑鼠離開圖片之後多久才真的收起來。
 *
 * 不是動畫,是**可達性**:chip 貼在圖的外緣,滑鼠要從圖走到 chip 上,
 * 中間那一兩個像素兩邊都不屬於。立刻收的話那片 chip 永遠按不到。
 */
export const LEAVE_GRACE_MS = 220;

export { IMAGE_WATCHDOG_MS };


/** 一張圖現在的狀態 */
export interface ImageEntry {
  url: string;
  blocks: ImageBlock[];
  /** 'l0' 已經有免費譯文;'l1' 已升級 */
  tier: 'l0' | 'l1';
  hash: string;
}

export interface ImageHost {
  /**
   * 送出請求。lane 決定用哪個模型;`brief` 只問最顯眼的幾塊。
   *
   * brief 是**逾時的出路**:整頁截圖的輸出長到跑不完 100 秒,
   * 同一份請求再送一次只會再逾時(§DS-2)。
   */
  request(url: string, lane: 'l0' | 'l1', brief?: boolean): void;
  showImage(
    rect: { left: number; top: number; width: number; height: number },
    placed: readonly PlacedBlock[],
  ): void;
  hideImage(): void;
  /**
   * 這個事件目標是**我們自己的疊層**嗎(chip、放大檢視)。
   *
   * closed shadow root 會把事件目標重定向成 host,所以從外面看,
   * 「滑鼠在 chip 上」和「滑鼠在頁面某個角落」長得一模一樣 ——
   * 只有 host 那一層分得出來。
   */
  ownsTarget(t: EventTarget | null): boolean;
  /** chip 文案。null 代表收起來;`action` 有值時貼片可以按 */
  cue(el: Element, text: string | null, tone: 'idle' | 'busy' | 'warn', action?: string): void;
  /** 開放大檢視,回傳圖片實際被畫成多大(等 img 載入後量的) */
  openZoom(src: string, natural: { w: number; h: number }, reserve?: number): { w: number; h: number } | null;
  setZoomBlocks(placed: readonly PlacedBlock[]): void;
  closeZoom(): void;
}

/**
 * 這個元素是「值得翻的圖」嗎。
 *
 * 顯示尺寸是門檻,不是原始尺寸:2042px 的圖縮在 120px 的縮圖格裡,
 * 上面的字使用者一個都讀不到,翻了也是白花錢(`imagegeo.worthTranslating`)。
 */
export function imageUnder(
  target: EventTarget | null,
  clientX?: number,
  clientY?: number,
): HTMLImageElement | null {
  const direct = imageOf(target);
  if (direct) return direct;
  if (clientX === undefined || clientY === undefined) return null;
  /*
   * **站方蓋在圖上的透明按鈕會吃掉事件目標。**
   *
   * ClickHouse 那篇每張圖上都壓著一顆
   * `<button style="position:absolute;inset:0;cursor:zoom-in;opacity:0">`,
   * 所以 `target.closest('img')` 永遠是 null —— 滑上去什麼都不會發生。
   * 使用者回報的「沒點之前 mouse over 不會翻,要點起來再 mouse over 才有」
   * 就是這個:站方的 lightbox 打開之後 `<img>` 才直接吃得到滑鼠。
   *
   * 諷刺的是我們**早就認得**那顆按鈕 —— `hasNativeZoom()` 就是靠它判斷
   * 站方有自己的放大檢視。認得出來卻沒想到它會擋住 hover。
   *
   * 只掃最上面幾層:透明覆蓋層通常就一兩片,掃太深會把「被不透明的東西
   * 蓋住的圖」也算進來。
   */
  for (const el of document.elementsFromPoint(clientX, clientY).slice(0, OVERLAY_SCAN_DEPTH)) {
    const img = imageOf(el);
    if (img) return img;
  }
  return null;
}

/** 站方壓在圖上的透明層最多掃幾層 */
export const OVERLAY_SCAN_DEPTH = 4;

function imageOf(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const img = target.closest('img');
  if (!(img instanceof HTMLImageElement)) return null;
  if (!img.currentSrc && !img.src) return null;
  const r = img.getBoundingClientRect();
  if (!worthTranslating({ w: r.width, h: r.height })) return null;
  return img;
}

/**
 * 這個站自己就有放大檢視嗎(`docs/plan-images.md` §2.4)。
 *
 * 有的話**不出我們的入口** —— 跟著站方走,加註靠同 src 認親跟過去。
 * 兩個都出只會讓使用者面對兩顆意思一樣的按鈕,而且站方那顆通常做得更好
 * (它知道自己的高解析原圖在哪)。
 *
 * 訊號:
 * - `cursor: zoom-in` —— ClickHouse 那篇每張圖上都蓋著一顆
 *   `button.cursor-zoom-in`,實測就是這個
 * - 連到圖片檔的 `<a>` —— WordPress 與大多數相簿外掛的寫法
 * - 常見縮放外掛的類別名(medium-zoom / react-medium-image-zoom / lightbox)
 */
export function hasNativeZoom(img: HTMLImageElement): boolean {
  if (img.closest('[data-rmiz],[class*="lightbox" i],[class*="medium-zoom" i]')) return true;
  const link = img.closest('a[href]');
  if (link instanceof HTMLAnchorElement && /\.(png|jpe?g|gif|webp|avif)([?#]|$)/i.test(link.href)) {
    return true;
  }
  // 圖片本身或蓋在它上面的透明按鈕
  if (getComputedStyle(img).cursor === 'zoom-in') return true;
  const parent = img.parentElement;
  if (parent) {
    if (getComputedStyle(parent).cursor === 'zoom-in') return true;
    for (const sib of parent.children) {
      if (sib !== img && getComputedStyle(sib).cursor === 'zoom-in') return true;
    }
  }
  return false;
}

/** 圖片本地座標系:點陣圖實際畫在 content box 的哪裡 */
export function geometryOf(img: HTMLImageElement): {
  drawn: ReturnType<typeof drawnRect>;
  clip: { w: number; h: number };
  rect: { left: number; top: number; width: number; height: number };
} {
  const cs = getComputedStyle(img);
  const r = img.getBoundingClientRect();
  const clip = { w: r.width, h: r.height };
  const drawn = drawnRect(
    { w: img.naturalWidth, h: img.naturalHeight },
    clip,
    (cs.objectFit || 'fill') as ObjectFit,
    parsePosition(cs.objectPosition || '50% 50%'),
  );
  return {
    drawn,
    clip,
    // 文件座標:加註和內文疊層同一個座標系,捲動交給瀏覽器
    rect: {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    },
  };
}

export class ImageAnnotator {
  /** 已經翻過的圖,以 `currentSrc` 為鍵 —— 同 src 的新元素直接命中(§2.4) */
  private byUrl = new Map<string, ImageEntry>();
  /**
   * 送出去還沒回來的:url → 走的是哪一條道。
   *
   * **記到 lane 而不只是「有沒有」**,因為兩者要問的問題不同:
   * hover 防抖問「有沒有」,而 Alt+click 問的是「有沒有**已經在升級**」。
   * 只記「有沒有」的那一版,免費檔還在跑的時候按升級會被整個吞掉 ——
   * 回傳 true(於是連結也不會走),卻什麼都沒送出去。
   * worker 那邊本來就允許 l1 蓋過同一張圖的 l0(imagequeue 的 addJob)。
   */
  private inFlight = new Map<string, 'l0' | 'l1'>();
  /** url → 這張圖為什麼失敗、能不能點一下再來一次 */
  private failed = new Map<string, Fail & { lane: 'l0' | 'l1' }>();
  /** 使用者親手升級過的圖。失敗之後重試要留在 l1,不要偷偷退回免費檔 */
  private upgraded = new Set<string>();

  private hoverTimer = 0;
  /** 延後收起來的計時器 —— 讓滑鼠有時間走到 chip 上 */
  private leaveTimer = 0;
  /** url → 看門狗的 timer id */
  private watchdogs = new Map<string, number>();
  private current: HTMLImageElement | null = null;
  private placed: PlacedBlock[] = [];

  private host: ImageHost;
  private enabled: () => boolean;
  private alwaysOn: () => boolean;
  /** 行內最多疊幾塊(settings.imageMaxPlates)。放大檢視在 placeBlocks 裡自動 ×2 */
  private maxPlates: () => number;

  /*
   * 刻意不用建構子參數屬性(`private host: ImageHost`)。
   *
   * `node --experimental-strip-types` 解不了那個語法,於是整個檔案
   * **在單元測試裡載不進來** —— 而這裡放的正是 hover/leave 的生命週期,
   * 也就是「chip 還沒被碰到就被自己刪掉」那一類 bug 的家(§DK)。
   * 少寫三行換到整條路可測,划算。
   */
  constructor(
    host: ImageHost,
    enabled: () => boolean,
    alwaysOn: () => boolean,
    maxPlates: () => number = () => MAX_PLATES,
  ) {
    this.host = host;
    this.enabled = enabled;
    this.alwaysOn = alwaysOn;
    this.maxPlates = maxPlates;
  }

  reset(): void {
    this.byUrl.clear();
    this.inFlight.clear();
    for (const t of this.watchdogs.values()) clearTimeout(t);
    this.watchdogs.clear();
    this.cancelLeave();
    this.failed.clear();
    this.upgraded.clear();
    this.leave();
  }

  /** 送出一個請求:登記 in-flight 並上看門狗 */
  private send(
    img: HTMLImageElement,
    url: string,
    lane: 'l0' | 'l1',
    busy: string,
    brief = false,
  ): void {
    this.inFlight.set(url, lane);
    this.host.cue(img, busy, 'busy');
    this.host.request(url, lane, brief);
    const prev = this.watchdogs.get(url);
    if (prev) clearTimeout(prev);
    this.watchdogs.set(
      url,
      window.setTimeout(() => this.giveUp(url), IMAGE_WATCHDOG_MS),
    );
  }

  private clearWatchdog(url: string): void {
    const t = this.watchdogs.get(url);
    if (t) clearTimeout(t);
    this.watchdogs.delete(url);
  }

  /**
   * 看門狗響了:沒有人回話。
   *
   * **「卡住」不可以是一個能永久停留的狀態**(`docs/lessons.md` §12 那條
   * 在文字管線學到的)。這裡不假裝知道原因,只把狀態交還給使用者:
   * 清掉 in-flight,圖角說得出「再試一次」。
   */
  private giveUp(url: string): void {
    this.watchdogs.delete(url);
    if (!this.inFlight.delete(url)) return;
    const fail = { text: '沒有回應 · 點一下重試', retry: true, lane: this.laneOf(url) };
    this.failed.set(url, fail);
    diag('warn', 'image-watchdog', { waitedMs: IMAGE_WATCHDOG_MS });
    if (this.current && this.urlOf(this.current) === url) this.showFail(this.current, fail);
  }

  private urlOf(img: HTMLImageElement): string {
    return img.currentSrc || img.src;
  }

  /**
   * 滑鼠移動。**這是對稱律的實作點**(§2.5):
   * 圖的預設面是原圖,譯文只在指名時浮現;移開就收。
   */
  move(target: EventTarget | null, clientX: number, clientY: number): void {
    if (!this.enabled()) return;
    /*
     * **滑到我們自己的 chip 上不算離開。**
     *
     * 使用者回報「那個 tip 不能點」——實測(scripts/probe-image.mjs)那片
     * chip 其實**點得下去**,而且 action 會觸發。問題是它在滑鼠碰到之前
     * 就被自己刪掉了:closed shadow root 會把事件目標重定向成 host,
     * 所以 `imageUnder()` 找不到 `<img>` → `leave()` → cue 收掉。
     * 那片「點這裡放大讀」於是永遠只存在於滑鼠碰不到的地方(§DK)。
     */
    if (this.host.ownsTarget(target)) {
      this.cancelLeave();
      return;
    }
    const img = imageUnder(target, clientX, clientY);
    if (!img) {
      // 立刻收會殺掉正要去按的那片 chip —— 圖與 chip 之間有一段路要走
      this.scheduleLeave();
      return;
    }
    this.cancelLeave();
    if (img !== this.current) {
      // 換到另一張圖是明確的意圖,不必寬限
      this.leave();
      this.current = img;
      this.arm(img);
    }
  }

  /** 進入一張圖:已翻過就直接畫,沒翻過就起 500ms 的計時 */
  private arm(img: HTMLImageElement): void {
    const url = this.urlOf(img);
    const known = this.byUrl.get(url);
    if (known) {
      this.render(img, known);
      return;
    }
    const err = this.failed.get(url);
    if (err !== undefined) {
      this.showFail(img, err);
      return;
    }
    if (this.inFlight.has(url)) {
      this.host.cue(img, '辨識中…', 'busy');
      return;
    }
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = 0;
      if (this.current !== img) return;
      this.send(img, url, 'l0', '辨識中 ·(免費 · 較慢)');
      diag('info', 'image-hover', { lane: 'l0' });
    }, IMAGE_HOVER_MS);
  }

  /**
   * 延後收起來。
   *
   * 寬限期存在的唯一理由是**滑鼠要走一段路**:chip 貼在圖的外緣,
   * 中間那一兩個像素不屬於圖也不屬於 chip,而 mousemove 節流到每幀一次,
   * 快速移動時剛好會取樣在那裡。沒有寬限的話,使用者永遠碰不到 chip。
   */
  private scheduleLeave(): void {
    if (this.leaveTimer) return;
    this.leaveTimer = window.setTimeout(() => {
      this.leaveTimer = 0;
      this.leave();
    }, LEAVE_GRACE_MS);
  }

  private cancelLeave(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = 0;
    }
  }

  private leave(): void {
    this.cancelLeave();
    // 放大檢視開著的時候滑鼠早就離開原圖了,收掉會把它一起關掉
    if (this.zoomUrl !== null) return;
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = 0;
    }
    if (this.current) this.host.cue(this.current, null, 'idle');
    this.current = null;
    this.placed = [];

    // 對稱律:移開就還原圖(除非使用者選了常駐)
    if (!this.alwaysOn()) this.host.hideImage();
  }

  /**
   * 新出現的 `<img>` 如果是**翻過的同一張圖**,直接畫上去(§2.4)。
   *
   * 站方的 lightbox 開出來的是**新的元素但同一個 src**(ClickHouse 那篇
   * 實測就是這樣)。沒有這一條的話,使用者點開黑窗會看到一張沒有加註的圖,
   * 得再滑上去一次才出現 —— 而他剛剛才在縮圖上看過。
   *
   * 只認**已經翻過的**:這條路不觸發任何請求,純粹是把手上的東西畫出來。
   */
  adopt(img: HTMLImageElement): boolean {
    if (!this.enabled()) return false;
    const r = img.getBoundingClientRect();
    if (!worthTranslating({ w: r.width, h: r.height })) return false;
    const entry = this.byUrl.get(this.urlOf(img));
    if (!entry || entry.blocks.length === 0) return false;
    // 已經指著同一個元素就不用重畫
    if (this.current === img) return false;
    this.current = img;
    this.render(img, entry);
    diag('info', 'image-adopt', { tier: entry.tier });
    return true;
  }

  /**
   * Alt+click:升級到 L1。
   *
   * 這是**付費動作**,所以一定要明確 —— hover 不會走到這裡。
   * 回傳有沒有接手,`index.ts` 用它決定要不要 preventDefault。
   */
  upgrade(target: EventTarget | null): boolean {
    if (!this.enabled()) return false;
    const img = imageUnder(target);
    if (!img) return false;
    const url = this.urlOf(img);
    const known = this.byUrl.get(url);
    if (known?.tier === 'l1') return false;
    if (this.inFlight.get(url) === 'l1') return true;
    this.failed.delete(url);
    this.upgraded.add(url);
    this.send(img, url, 'l1', '升級中…');
    diag('info', 'image-upgrade', {});
    return true;
  }

  /**
   * 失敗的 chip:文案和「能不能按」來自**同一格**(§DS-1)。
   *
   * 分開寫的那一版每一句都寫著「再點一次重試」而一個 action 都沒帶,
   * 於是文案在說謊而沒有任何測試會發現 —— chip 畫得好好的,只是點不下去。
   */
  private showFail(img: HTMLImageElement, f: Fail): void {
    this.host.cue(img, f.text, 'warn', f.retry ? 'retry' : undefined);
  }

  /** 這張圖上次是走哪一條道 —— 升級過就別退回免費檔重試 */
  private laneOf(url: string): 'l0' | 'l1' {
    return this.byUrl.get(url)?.tier === 'l1' || this.upgraded.has(url) ? 'l1' : 'l0';
  }

  /**
   * 點失敗的 chip:**真的再送一次**。
   *
   * 以前這條路完全不存在。文案寫著「再點一次重試」、「滑開再滑回來重試」,
   * 而 `arm()` 看到 `failed` 只會把同一句話再印一次 —— 從任何入口都回不去。
   * 使用者的原話:「怎麼點都沒有反應」。
   *
   * 逾時的重試會帶 `brief`:同一份請求再送一次只會再逾時一次(§DS-2)。
   */
  retry(): boolean {
    const img = this.current;
    if (!img) return false;
    const url = this.urlOf(img);
    const f = this.failed.get(url);
    if (!f || !f.retry || this.inFlight.has(url)) return false;
    this.failed.delete(url);
    this.send(img, url, f.lane, f.brief ? '只翻大字…' : '重試中…', f.brief);
    diag('info', 'image-retry', { lane: f.lane, brief: f.brief === true });
    return true;
  }

  /** worker 回來了 */
  onResult(url: string, hash: string, lane: 'l0' | 'l1', blocks: ImageBlock[]): void {
    this.inFlight.delete(url);
    this.clearWatchdog(url);
    this.failed.delete(url);
    const prev = this.byUrl.get(url);
    // L1 蓋掉 L0;L0 不可以蓋掉已經升級過的(晚到的免費結果會倒退品質)
    if (prev?.tier === 'l1' && lane === 'l0') return;
    this.byUrl.set(url, { url, blocks, tier: lane, hash });
    if (blocks.length === 0) {
      if (this.current && this.urlOf(this.current) === url) {
        this.host.cue(this.current, '沒有偵測到文字', 'idle');
      }
      return;
    }
    if (this.current && this.urlOf(this.current) === url) {
      this.render(this.current, this.byUrl.get(url)!);
    }
  }

  onError(url: string, reason: string): void {
    this.inFlight.delete(url);
    this.clearWatchdog(url);
    const known =
      FRIENDLY[reason] ??
      FRIENDLY_PREFIX.find(([p]) => reason.startsWith(p))?.[1] ??
      { text: '辨識失敗 · 點一下重試', retry: true };
    const fail = { ...known, lane: this.laneOf(url) };
    this.failed.set(url, fail);
    if (this.current && this.urlOf(this.current) === url) this.showFail(this.current, fail);
  }

  private render(img: HTMLImageElement, entry: ImageEntry): void {
    const { drawn, clip, rect } = geometryOf(img);
    const out = placeBlocks(entry.blocks, drawn, clip, this.maxPlates());
    this.placed = out.placed;
    /*
     * **不畫的三種情況,說的話不一樣。**
     *
     * 沒偵測到字 / 有字但沒有一塊需要翻(整張都是數值、產品名、代碼)/
     * 扣完還一大堆(這是文件不是圖,§DW)。前兩種是「不用再滑上來了」,
     * 第三種是「行內不畫,但放大讀得到」—— 三句話不能共用一句。
     */
    if (out.placed.length === 0) {
      this.host.hideImage();
      if (out.why === 'text-heavy' && !hasNativeZoom(img)) {
        this.host.cue(img, `字太多,像文件不像圖 · ⤢ 點這裡放大讀 ${out.left} 塊`, 'idle', 'zoom');
      } else if (out.why === 'text-heavy') {
        this.host.cue(img, `字太多,像文件不像圖 · 點開大圖才畫(${out.left} 塊)`, 'idle');
      } else {
        this.host.cue(img, entry.blocks.length > 0 ? '這張圖沒有需要翻的字' : '沒有偵測到文字', 'idle');
      }
      diag('info', 'image-render', {
        tier: entry.tier,
        veil: 0,
        left: out.left,
        why: out.why,
        skipped: entry.blocks.length,
      });
      return;
    }
    this.host.showImage(rect, this.placed);
    /*
     * **翻好的圖統一有放大檢視的入口**(§EA)。
     *
     * 以前只有「有塊沒放下」才出 —— 使用者的疑問是「原本沒有點開的
     * windows 決定要翻了就可以點 tip 開視窗?」:入口有時在有時不在,
     * 看起來像亂數。改成:行內畫了東西就能放大讀,畫布大、上限自動 ×2,
     * 行內被擋在門外的塊在裡面攤得開 —— 這正是「圖放大了預算就多」的
     * 具體形狀。
     *
     * 站方自己有 lightbox 就不出(§2.4)—— 跟著站方走,加註靠同 src
     * 認親跟過去;站方的大圖畫布 ≥900px 時 placeBlocks 的尺寸閘門
     * 一樣會放兩倍,不用另外接線。
     */
    const canZoom = !hasNativeZoom(img);
    /*
     * 文案要說得出**動作**,不是狀態。
     *
     * 使用者的原話是「放大檢視要怎麼放大」—— 舊文案看起來像一個標籤,
     * 而它其實是一顆按鈕。可按的 cue 全世界只有這一個(§3.3 的窄例外),
     * 所以它必須自己講出來。還有塊沒放下就把數字說出來 —— 「還有 N 塊」
     * 是點進去的理由,全放下的圖則只是「換個大畫布讀」。
     */
    this.host.cue(
      img,
      canZoom
        ? `⤢ 點這裡放大讀${
            out.left > 0
              ? ` · 還有 ${out.left} 塊`
              : entry.tier === 'l0'
                ? ' · Alt+click 升級'
                : ''
          }`
        : entry.tier === 'l0'
          ? '↑ Alt+click 升級'
          : `L1 · ${this.placed.length} 塊`,
      'idle',
      canZoom ? 'zoom' : undefined,
    );
    diag('info', 'image-render', {
      tier: entry.tier,
      veil: this.placed.length,
      left: out.left,
      why: out.why,
      // 譯完等於沒譯的塊被略過了 —— 看得見才知道規則有沒有吃太多
      skipped: entry.blocks.length - this.placed.length - out.left,
    });
  }


  /**
   * 放大檢視(§3.3)。
   *
   * **不重問模型** —— 同一份區塊,換一個顯示尺寸再算一次
   * `placeBlocks` 就好。行內過不了字級門檻的塊在這裡自動變成疊字,
   * 那正是 §2.3 分流規則想要的效果。
   */
  private zoomUrl: string | null = null;

  openZoom(): boolean {
    const img = this.current;
    if (!img) return false;
    const url = this.urlOf(img);
    const entry = this.byUrl.get(url);
    if (!entry) return false;
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    const size = this.host.openZoom(url, natural);
    if (!size) return false;
    this.zoomUrl = url;
    this.paintZoom(size, entry, natural, url);
    /*
     * **chip 的工作到這裡結束**(§EC)。
     *
     * 它是 fixed 定位、又只認滑鼠的 leave —— 黑窗開了它就浮在最上面,
     * 像個忘了收的路牌,要等滑鼠動一下或視窗失焦才被別的路收走。
     * 使用者的原話:「點了 3 秒內要消失」—— 不用等 3 秒,點開就收。
     */
    this.host.cue(img, null, 'idle');
    diag('info', 'image-zoom', { blocks: entry.blocks.length });
    return true;
  }

  private place(size: { w: number; h: number }, entry: ImageEntry, natural: { w: number; h: number }) {
    // 放大檢視一律 contain 置中,所以 drawn 就是整個 size
    const drawn = drawnRect(natural, size, 'contain', { x: { pct: 0.5 }, y: { pct: 0.5 } });
    return placeBlocks(entry.blocks, drawn, size, this.maxPlates());
  }

  /**
   * 放大檢視的排版。
   *
   * **要排兩次**,而且這不是浪費:「右邊要不要留位置給註解清單」取決於
   * 排出來是不是錨點模式,而排版又取決於畫布多寬 —— 循環只能靠排兩次
   * 打開。第一次用整個視窗看模式,是錨點就縮回去再排一次。
   */
  private paintZoom(
    size: { w: number; h: number },
    entry: ImageEntry,
    natural: { w: number; h: number },
    _url: string,
  ): void {
    this.host.setZoomBlocks(this.place(size, entry, natural).placed);
  }

  /** 視窗改變大小時重畫(放大檢視是 fit 到視窗的) */
  relayoutZoom(size: { w: number; h: number }, natural: { w: number; h: number }): void {
    if (!this.zoomUrl) return;
    const entry = this.byUrl.get(this.zoomUrl);
    if (entry) this.paintZoom(size, entry, natural, this.zoomUrl);
  }

  closeZoom(): void {
    if (!this.zoomUrl) return;
    const url = this.zoomUrl;
    this.zoomUrl = null;
    this.host.closeZoom();
    /*
     * 關窗後把 chip 畫回來:滑鼠多半還停在原圖上,而 `move()` 看到
     * `img === this.current` 不會重畫(§DL 的同一個坑)—— 開窗時收掉的
     * chip 沒有這一條就永遠回不來,要滑走再滑回來才有。
     */
    if (this.current && this.urlOf(this.current) === url) {
      const entry = this.byUrl.get(url);
      if (entry) this.render(this.current, entry);
    }
  }

  zoomOpen(): boolean {
    return this.zoomUrl !== null;
  }

  /**
   * 把加註畫回來(按住 Alt 看原圖之後放開)。
   *
   * **這半邊以前不存在。** Alt 按下去時 index.ts 呼叫 `hideImage()` 把圖片
   * 加註收掉,放開時只把 `.layer` 的 `hidden-all` class 拿掉 ——
   * 文字疊層回來了,圖片加註沒有。而且回不來:`move()` 看到
   * `img === this.current` 就不會再 `arm()` 一次,所以那張圖的加註
   * 要等你滑走再滑回來才出現(§DL)。
   */
  repaint(): void {
    if (!this.enabled() || !this.current) return;
    const entry = this.byUrl.get(this.urlOf(this.current));
    if (entry) this.render(this.current, entry);
  }

  /** 已經翻過的圖(給放大檢視與同 src 重錨定用) */
  entryFor(url: string): ImageEntry | undefined {
    return this.byUrl.get(url);
  }

  /** 現在指著的那張圖 */
  currentImage(): HTMLImageElement | null {
    return this.current;
  }
}

/**
 * 失敗的原因要說得出來 —— 「這張圖太大」和「辨識失敗」對使用者是兩件事,
 * 而第二種值得再點一次,第一種不值得。
 *
 * **文案和「能不能點」寫在同一格(§DS-1)。** 上一版只有文案,
 * 於是每一句都寫著「再點一次重試」而 cue 一個 action 都沒帶 ——
 * chip 拿不到 act 類別、onclick 是 null、pointer-events 沒開。
 * 使用者的原話是「所以是要點哪裡? 怎麼點都沒有反應」。
 * 兩個欄位綁在一起,它們就不會再各自漂走。
 */
interface Fail {
  text: string;
  /** 點一下值不值得再送一次 —— 額度用完、格式讀不了那些點了也一樣 */
  retry: boolean;
  /** 重試時**只問大字**:逾時多半是輸出太長,同一份請求再送一次還是會逾時 */
  brief?: boolean;
}

const FRIENDLY: Record<string, Fail> = {
  'too-large': { text: '圖片太大,不翻', retry: false },
  'decode-failed': { text: '這個格式讀不了', retry: false },
  'unsupported-scheme': { text: '這張圖抓不到', retry: false },
  'page-cap': { text: '本頁 token 上限已滿', retry: false },
  'daily-cap': { text: '今日預算已用完', retry: false },
  'no-key': { text: '還沒設定 API key', retry: false },
  'page-image-cap': { text: '本頁圖片翻譯已達上限', retry: false },
  /*
   * 排到 content 的看門狗都響了才被收掉 —— 前面那幾張太慢。
   * 以前這句話寫「等太久已取消」,而實情是**它從來沒輪到過**(§DU)。
   */
  stale: { text: '前面排太久,這張沒輪到 · 點一下重試', retry: true },
  /* 一次滑過太多張,被更新的那幾張擠掉(worker 的 PENDING_L0_MAX) */
  'queue-full': { text: '一次排太多張,這張被讓位了 · 點一下重試', retry: true },
  empty: { text: '圖片是空的', retry: false },
  'fetch-timeout': { text: '這張圖抓不下來 · 點一下重試', retry: true },
  // 重派過還是沒回來 —— 別再叫使用者「滑開再滑回來」,那條路已經走過了
  'gave-up': { text: '試過兩次都沒回應 · 點一下只翻大字', retry: true, brief: true },
};

const FRIENDLY_PREFIX: [string, Fail][] = [
  /*
   * 逾時**不是隨機的**,是輸出太長(§DS-2):實測 ~2.3 秒一塊,
   * 100 秒的時限等於 43 塊。整頁截圖輕鬆超過,所以同一份請求再送一次
   * 只會再等 100 秒 —— 使用者已經證實了(Alt+click 升級之後照樣逾時)。
   * 重試因此要**問得比較少**:只要最顯眼的那幾塊。
   */
  ['timeout ', { text: '字太多沒能在時限內翻完 · 點一下只翻大字', retry: true, brief: true }],
];
