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

const CONCURRENCY = 4;

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
  private queue: Array<() => void> = [];

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
  async translate(text: string): Promise<string | null> {
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    if (!(await this.ensure())) return null;
    const instance = this.instance;
    if (!instance) return null;
    await this.slot();
    try {
      const out = (await instance.translate(text)).trim();
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

  /** 不要一次把整頁丟進去,Translator 是本機資源 */
  private slot(): Promise<void> {
    if (this.inFlight < CONCURRENCY) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
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
