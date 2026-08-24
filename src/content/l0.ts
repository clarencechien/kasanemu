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

/*
 * 診斷 log:一批 9 塊要 3.7 秒、單獨一塊也要 0.7–2.3 秒 ——
 * 瓶頸是每次呼叫的等待,不是本機 CPU 吃緊。提高併發直接縮短整批的牆鐘時間。
 * 再高沒有意義:on-device 模型內部本來就會排隊。
 */
const CONCURRENCY = 8;

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
  private slot(priority: number): Promise<void> {
    if (this.inFlight < CONCURRENCY) {
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
    const next = this.queue.shift();
    if (next) next.go();
  }

  /** 給診斷用:真正的呼叫延遲,以及被排隊吃掉多少 */
  timing(): { calls: number; avgMs: number; maxMs: number; avgWaitMs: number; queued: number } {
    return {
      calls: this.calls,
      avgMs: this.calls > 0 ? Math.round(this.callMsTotal / this.calls) : 0,
      maxMs: Math.round(this.callMsMax),
      avgWaitMs: this.calls > 0 ? Math.round(this.waitMsTotal / this.calls) : 0,
      queued: this.queue.length,
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
