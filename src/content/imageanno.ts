/**
 * 圖片加註的生命週期 —— hover 觸發、結果落地、重錨定、放大檢視。
 *
 * 規格:`docs/plan-images.md` §2.2(兩段式)、§2.4(同 src)、§2.5(對稱律)、§3。
 *
 * 這個模組**不直接碰 worker**,也不直接碰 overlay 的 shadow root:
 * 兩者都由 `index.ts` 注入。理由是 `index.ts` 已經是三千行的協調者,
 * 再往裡面塞一套狀態機只會讓兩件事互相絆住。
 */

import { diag } from '../shared/diag';
import type { ImageBlock } from '../shared/imageblocks';
import {
  drawnRect,
  parsePosition,
  placeBlocks,
  pinAt,
  worthTranslating,
  type ObjectFit,
  type PlacedBlock,
} from './imagegeo';

/** 滑上圖片停多久才送 L0。和 UI 標籤的 180ms 不同 —— 這個要花配額 */
export const IMAGE_HOVER_MS = 500;

/** 一張圖現在的狀態 */
export interface ImageEntry {
  url: string;
  blocks: ImageBlock[];
  /** 'l0' 已經有免費譯文;'l1' 已升級 */
  tier: 'l0' | 'l1';
  hash: string;
}

export interface ImageHost {
  /** 送出請求。lane 決定用哪個模型 */
  request(url: string, lane: 'l0' | 'l1'): void;
  showImage(
    rect: { left: number; top: number; width: number; height: number },
    placed: readonly PlacedBlock[],
  ): void;
  hideImage(): void;
  setActivePin(n: number): void;
  /** chip 文案。null 代表收起來;`action` 有值時貼片可以按 */
  cue(el: Element, text: string | null, tone: 'idle' | 'busy' | 'warn', action?: string): void;
  /** 開放大檢視,回傳圖片實際被畫成多大(等 img 載入後量的) */
  openZoom(src: string, natural: { w: number; h: number }): { w: number; h: number } | null;
  setZoomBlocks(placed: readonly PlacedBlock[]): void;
  closeZoom(): void;
}

/**
 * 這個元素是「值得翻的圖」嗎。
 *
 * 顯示尺寸是門檻,不是原始尺寸:2042px 的圖縮在 120px 的縮圖格裡,
 * 上面的字使用者一個都讀不到,翻了也是白花錢(`imagegeo.worthTranslating`)。
 */
export function imageUnder(target: EventTarget | null): HTMLImageElement | null {
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
  /** 送出去還沒回來的,避免 hover 抖動重送 */
  private inFlight = new Set<string>();
  private failed = new Map<string, string>();

  private hoverTimer = 0;
  private current: HTMLImageElement | null = null;
  private placed: PlacedBlock[] = [];
  private activePin = 0;

  constructor(
    private host: ImageHost,
    private enabled: () => boolean,
    private alwaysOn: () => boolean,
  ) {}

  reset(): void {
    this.byUrl.clear();
    this.inFlight.clear();
    this.failed.clear();
    this.leave();
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
    const img = imageUnder(target);
    if (!img) {
      this.leave();
      return;
    }
    if (img !== this.current) {
      this.leave();
      this.current = img;
      this.arm(img);
    }
    // 已經有加註 → 更新錨點的 hover 態(疊層收不到事件,命中要自己算)
    if (this.placed.length > 0) {
      const r = img.getBoundingClientRect();
      const hit = pinAt(this.placed, clientX - r.left, clientY - r.top);
      const n = hit?.n ?? 0;
      if (n !== this.activePin) {
        this.activePin = n;
        this.host.setActivePin(n);
      }
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
      this.host.cue(img, err, 'warn');
      return;
    }
    if (this.inFlight.has(url)) {
      this.host.cue(img, '辨識中…', 'busy');
      return;
    }
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = 0;
      if (this.current !== img) return;
      this.inFlight.add(url);
      this.host.cue(img, '辨識中 ·(免費 · 較慢)', 'busy');
      this.host.request(url, 'l0');
      diag('info', 'image-hover', { lane: 'l0' });
    }, IMAGE_HOVER_MS);
  }

  private leave(): void {
    // 放大檢視開著的時候滑鼠早就離開原圖了,收掉會把它一起關掉
    if (this.zoomUrl !== null) return;
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = 0;
    }
    if (this.current) this.host.cue(this.current, null, 'idle');
    this.current = null;
    this.placed = [];
    this.activePin = 0;
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
    if (this.inFlight.has(url)) return true;
    this.inFlight.add(url);
    this.failed.delete(url);
    this.host.cue(img, '升級中…', 'busy');
    this.host.request(url, 'l1');
    diag('info', 'image-upgrade', {});
    return true;
  }

  /** worker 回來了 */
  onResult(url: string, hash: string, lane: 'l0' | 'l1', blocks: ImageBlock[]): void {
    this.inFlight.delete(url);
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
    const text = FRIENDLY[reason] ?? '辨識失敗 · 再點一次重試';
    this.failed.set(url, text);
    if (this.current && this.urlOf(this.current) === url) {
      this.host.cue(this.current, text, 'warn');
    }
  }

  private render(img: HTMLImageElement, entry: ImageEntry): void {
    const { drawn, clip, rect } = geometryOf(img);
    this.placed = placeBlocks(entry.blocks, drawn, clip);
    this.host.showImage(rect, this.placed);
    const pins = this.placed.filter((p) => p.kind === 'pin').length;
    /*
     * **有錨點才給放大檢視的入口。**
     *
     * 錨點的存在就是「這張圖上有字小到疊不下」的信號,而放大檢視正是
     * 為那件事做的。全部都疊得下的圖出這顆按鈕只是多一個沒用的東西。
     *
     * 站方自己有 lightbox 就不出(§2.4)—— 跟著站方走,加註靠同 src 認親。
     */
    const canZoom = pins > 0 && !hasNativeZoom(img);
    this.host.cue(
      img,
      canZoom
        ? `⤢ 放大檢視(${pins} 處小字)`
        : entry.tier === 'l0'
          ? '↑ Alt+click 升級'
          : `L1 · ${this.placed.length} 塊`,
      'idle',
      canZoom ? 'zoom' : undefined,
    );
    diag('info', 'image-render', {
      tier: entry.tier,
      veil: this.placed.length - pins,
      pin: pins,
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
    this.paintZoom(size, entry, natural);
    diag('info', 'image-zoom', { blocks: entry.blocks.length });
    return true;
  }

  private paintZoom(
    size: { w: number; h: number },
    entry: ImageEntry,
    natural: { w: number; h: number },
  ): void {
    // 放大檢視一律 contain 置中,所以 drawn 就是整個 size
    const drawn = drawnRect(natural, size, 'contain', {
      x: { pct: 0.5 },
      y: { pct: 0.5 },
    });
    this.host.setZoomBlocks(placeBlocks(entry.blocks, drawn, size));
  }

  /** 視窗改變大小時重畫(放大檢視是 fit 到視窗的) */
  relayoutZoom(size: { w: number; h: number }, natural: { w: number; h: number }): void {
    if (!this.zoomUrl) return;
    const entry = this.byUrl.get(this.zoomUrl);
    if (entry) this.paintZoom(size, entry, natural);
  }

  closeZoom(): void {
    if (!this.zoomUrl) return;
    this.zoomUrl = null;
    this.host.closeZoom();
  }

  zoomOpen(): boolean {
    return this.zoomUrl !== null;
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
 */
const FRIENDLY: Record<string, string> = {
  'too-large': '圖片太大,不翻',
  'decode-failed': '這個格式讀不了',
  'unsupported-scheme': '這張圖抓不到',
  'page-cap': '本頁 token 上限已滿',
  'daily-cap': '今日預算已用完',
  'no-key': '還沒設定 API key',
  'page-image-cap': '本頁圖片翻譯已達上限',
  empty: '圖片是空的',
};
