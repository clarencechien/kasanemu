import { dbg, warn } from '../shared/log';
export { pageSourceLang, toTranslatorTarget } from './lang';

/**
 * feature.md §3 L0:Chrome 內建 Translator API。
 * 毫秒級、零成本、離線可用。疊層立刻出現,之後才被 L1 就地替換。
 *
 * §3.2 的六條硬性規則都在這個檔案裡兌現,尤其:
 *  - availability() 會騙人(建立過 translator 之前一律回報 downloadable),
 *    所以**不拿它的回傳值做邏輯判斷**,只拿來顯示;要知道能不能用就直接 create()
 *  - downloadable 時的 create() 需要 user gesture → NotAllowedError 不是錯誤,
 *    是「請使用者按 popup 的按鈕」的訊號
 *  - 實例以語言對為 key 重用,不要每個區塊建一個;頁面卸載時 destroy()
 */
export type L0State =
  | 'idle'
  | 'ready'
  | 'needs-gesture'
  | 'downloading'
  | 'unsupported'
  | 'failed';

interface TranslatorOpts {
  sourceLanguage: string;
  targetLanguage: string;
}

interface TranslatorInstance {
  translate(input: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorMonitor {
  addEventListener(type: 'downloadprogress', fn: (e: { loaded: number }) => void): void;
}

interface TranslatorCtor {
  availability(opts: TranslatorOpts): Promise<string>;
  create(
    opts: TranslatorOpts & { monitor?: (m: TranslatorMonitor) => void },
  ): Promise<TranslatorInstance>;
}

function ctor(): TranslatorCtor | null {
  // §3.1 第一個檢查點
  const g = self as unknown as { Translator?: TranslatorCtor };
  return typeof g.Translator === 'object' || typeof g.Translator === 'function'
    ? (g.Translator as TranslatorCtor)
    : null;
}

export function translatorSupported(): boolean {
  return ctor() !== null;
}

/**
 * 併發**隨機器調整**,不是固定值。
 *
 * 這一條是量錯之後學到的。先前把併發從 4 提到 8,理由是「瓶頸是等待,
 * 不是 CPU」—— 錯了。乾淨的量測(把排隊與呼叫分開)顯示:
 *
 * | 併發 | translate() 本身 | 被排隊吃掉 |
 * |---|---|---|
 * | 4 | 0.8–3.7 秒 | — |
 * | 8 | 6–12 秒(最高 25) | 1–5 秒 |
 *
 * **on-device 模型共用同一份計算資源**,八個一起跑只是讓每個都變慢。
 * 吞吐量差不多,但單塊延遲翻倍 —— 而使用者的體感是
 * 「我正在看的那塊什麼時候好」,那是延遲,不是吞吐。
 *
 * 同一份程式在 Windows 桌機上可以一口氣翻完整頁,在低階 Chromebook 上
 * 每塊要好幾秒。所以起始值看機器,再依實測延遲上下調。
 */
function initialConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(8, Math.floor(cores / 2)));
}

/** 超過這個延遲就降併發(ms) */
const SLOW_CALL_MS = 3000;
/** 低於這個延遲才敢升(ms) */
const FAST_CALL_MS = 600;
/** 每幾次呼叫檢討一次 */
const ADAPT_EVERY = 6;

export class L0Engine {
  state: L0State = 'idle';
  progress = 0;
  detail = '';
  readonly sourceLang: string;
  readonly targetLang: string;

  private instance: TranslatorInstance | null = null;
  private creating: Promise<boolean> | null = null;
  /** §3.2 規則 5:實例以語言對為 key 重用 */
  private readonly key: string;
  /** feature.md §4.6 L0 譯文也快取,避免重複呼叫(導覽列、重複標題命中率高) */
  private readonly cache = new Map<string, string>();
  private inFlight = 0;
  /** 依優先度排序的等待佇列(數字小的先跑) */
  private queue: Array<{ priority: number; go: () => void }> = [];
  /**
   * 實際 translate() 呼叫的耗時統計(不含排隊)。
   *
   * 之前只量「整批從開始到結束」,而預翻範圍拉大之後多輪請求擠在同一個
   * 併發池裡 —— log 出現 perUnit 20 秒,看起來像 API 慢到不能用,
   * 其實那是排隊。**儀表把排隊算成延遲,就會得出錯誤的結論。**
   */
  calls = 0;
  callMsTotal = 0;
  callMsMax = 0;
  waitMsTotal = 0;
  /** 目前的併發上限;依實測延遲調整 */
  private concurrency = initialConcurrency();
  /** 檢討用的滑動視窗(累計值要留給 timing()) */
  private recentCalls = 0;
  private recentMs = 0;

  constructor(sourceLang: string, targetLang: string) {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.key = `${sourceLang}→${targetLang}`;
    if (!translatorSupported()) {
      this.state = 'unsupported';
      this.detail = '這個環境沒有 Translator API(需要桌機版 Chrome 138+)';
    }
  }

  /** 只用來顯示,不做邏輯判斷 —— availability() 在建立過 translator 前一律說 downloadable */
  async report(): Promise<string> {
    const T = ctor();
    if (!T) return 'unsupported';
    try {
      return await T.availability(this.opts());
    } catch (e) {
      return `error: ${String(e)}`;
    }
  }

  private opts(): TranslatorOpts {
    // §3.2 規則 1:availability() 與 create() 必須傳完全相同的 options
    return { sourceLanguage: this.sourceLang, targetLanguage: this.targetLang };
  }

  /**
   * 建立 translator。回傳能不能用。
   * `gesture` 為 true 表示這次呼叫發生在使用者手勢裡(popup 的按鈕),
   * 可以觸發語言包下載。
   */
  ensure(gesture = false): Promise<boolean> {
    if (this.instance) return Promise.resolve(true);
    if (this.state === 'unsupported') return Promise.resolve(false);
    if (this.creating && !gesture) return this.creating;
    this.creating = this.create(gesture);
    return this.creating;
  }

  private async create(gesture: boolean): Promise<boolean> {
    const T = ctor();
    if (!T) return false;
    try {
      const instance = await T.create({
        ...this.opts(),
        // §3.2 規則 3:必須實作 downloadprogress,否則首次使用像卡住
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e) => {
            this.state = 'downloading';
            this.progress = typeof e.loaded === 'number' ? e.loaded : 0;
            this.detail = `語言包下載中 ${Math.round(this.progress * 100)}%`;
            dbg('l0 download', this.key, this.progress);
          });
        },
      });
      this.instance = instance;
      this.state = 'ready';
      this.progress = 1;
      this.detail = `${this.key} 就緒`;
      return true;
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError') {
        // §3.2 規則 2:downloadable 的 create() 需要 user gesture
        this.state = 'needs-gesture';
        this.detail = '需要在 popup 按一下才能下載語言包';
      } else if (name === 'NotSupportedError') {
        this.state = 'unsupported';
        this.detail = `這台機器沒有 ${this.key} 的語言包`;
      } else {
        this.state = 'failed';
        this.detail = `Translator.create 失敗:${String(e)}`;
        warn('l0 create failed', e);
      }
      this.creating = null;
      return false;
    }
  }

  /** 一區塊一次呼叫,無 batch、無 id 對位問題(§3.3) */
  async translate(text: string, priority = 0): Promise<string | null> {
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    if (!(await this.ensure())) return null;
    const instance = this.instance;
    if (!instance) return null;
    const queuedAt = performance.now();
    await this.slot(priority);
    const startedAt = performance.now();
    this.waitMsTotal += startedAt - queuedAt;
    try {
      const out = (await instance.translate(text)).trim();
      const took = performance.now() - startedAt;
      this.calls++;
      this.callMsTotal += took;
      if (took > this.callMsMax) this.callMsMax = took;
      this.recentCalls++;
      this.recentMs += took;
      this.adapt();
      if (out.length === 0) return null;
      if (this.cache.size < 3000) this.cache.set(text, out);
      return out;
    } catch (e) {
      warn('l0 translate failed', e);
      return null;
    } finally {
      this.release();
    }
  }

  /**
   * 不要一次把整頁丟進去,Translator 是本機資源。
   *
   * 佇列依優先度排序:使用者捲到新的一屏時,那些區塊會**插隊**到
   * 預翻進去的遠處區塊前面。預翻範圍拉大之後這件事變得必要 ——
   * 否則新看到的段落要排在幾十個離螢幕很遠的區塊後面。
   */
  /**
   * 依實測延遲調整併發:慢就降(讓每塊早點好),快就升(把機器吃滿)。
   * 降到 2 為止 —— 再低就等於序列化,連預翻都跑不動。
   */
  private adapt(): void {
    if (this.recentCalls < ADAPT_EVERY) return;
    const avg = this.recentMs / this.recentCalls;
    const before = this.concurrency;
    if (avg > SLOW_CALL_MS) this.concurrency = Math.max(2, this.concurrency - 1);
    else if (avg < FAST_CALL_MS) this.concurrency = Math.min(8, this.concurrency + 1);
    this.recentCalls = 0;
    this.recentMs = 0;
    if (this.concurrency !== before) {
      dbg('l0 concurrency', before, '→', this.concurrency, `avg ${Math.round(avg)}ms`);
    }
  }

  private slot(priority: number): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const entry = {
        priority,
        go: () => {
          this.inFlight++;
          resolve();
        },
      };
      const at = this.queue.findIndex((q) => q.priority > priority);
      if (at < 0) this.queue.push(entry);
      else this.queue.splice(at, 0, entry);
    });
  }

  private release(): void {
    this.inFlight--;
    // 併發降下來時,多出來的正在跑的請求跑完就好,不再補新的
    if (this.inFlight >= this.concurrency) return;
    const next = this.queue.shift();
    if (next) next.go();
  }

  /** 還有呼叫在跑或在排隊 —— 狀態列判斷「跑完了沒」要用 */
  busy(): boolean {
    return this.inFlight > 0 || this.queue.length > 0;
  }

  /** 給診斷用:真正的呼叫延遲,以及被排隊吃掉多少 */
  timing(): {
    calls: number;
    avgMs: number;
    maxMs: number;
    avgWaitMs: number;
    queued: number;
    concurrency: number;
  } {
    return {
      calls: this.calls,
      avgMs: this.calls > 0 ? Math.round(this.callMsTotal / this.calls) : 0,
      maxMs: Math.round(this.callMsMax),
      avgWaitMs: this.calls > 0 ? Math.round(this.waitMsTotal / this.calls) : 0,
      queued: this.queue.length,
      concurrency: this.concurrency,
    };
  }

  destroy(): void {
    // §3.2 規則 5:頁面卸載時 destroy()
    this.instance?.destroy?.();
    this.instance = null;
    this.creating = null;
    this.cache.clear();
    this.queue = [];
    this.inFlight = 0;
    if (this.state === 'ready') this.state = 'idle';
  }
}
