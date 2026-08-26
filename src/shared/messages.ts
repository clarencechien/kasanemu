import type { Tier } from './models';
import type { ImageBlock } from './imageblocks';
import type {
  DomainState,
  Pipeline,
  Settings,
  UnitFailure,
  UnitRequest,
  UnitResult,
  UnitTier,
} from './types';

/** content → worker */
export type ToWorker =
  | {
      type: 'enqueue';
      pageKey: string;
      tier: Tier;
      /** feature.md §2.2 花費按模式分開累計 */
      pipeline: Pipeline;
      units: UnitRequest[];
      /** feature.md §4.2 距視窗中心越近越優先,數字越小越優先 */
      priorities?: Record<string, number>;
    }
  /**
   * feature.md §4.6 / D23:快取命中時跳過 L0,直接以 L1 譯文渲染,
   * 所以 L0 之前要先便宜地問一次快取。這條路徑不碰保險絲、不碰 token bucket。
   */
  | {
      type: 'cache-probe';
      tier: Tier;
      units: Array<{ id: string; src: string; maxChars: number }>;
      /** 詞表以網域為範圍,所以快取 key 也要知道是哪一頁 */
      pageKey?: string;
    }
  /** feature.md §4.2 使用者捲動時重排佇列;已送出的請求不取消 */
  | { type: 'reprioritize'; pageKey: string; priorities: Record<string, number> }
  | { type: 'drop-page'; pageKey: string }
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<Settings> }
  | { type: 'get-domain-state'; host: string }
  | { type: 'set-domain-state'; host: string; patch: Partial<DomainState> }
  | { type: 'get-spend' }
  | { type: 'validate-models' }
  | { type: 'clear-cache' }
  | { type: 'export-cache' }
  | { type: 'import-cache'; dump: unknown }
  /**
   * worker 佇列的現況。`ids` 給的話,回傳其中哪幾筆還在佇列裡 ——
   * 看門狗要靠它分辨「塞在後面」和「真的不見了」。
   */
  | { type: 'page-status'; pageKey: string; ids?: string[] }
  /**
   * 一張圖的加註(`docs/plan-images.md` §5)。
   *
   * `lane` 決定用哪個模型與哪條併發道:`l0` 是 hover 自動觸發的免費檔,
   * `l1` 是使用者 Alt+click 明確點名的付費檔。兩條分開排隊 ——
   * 免費的慢(實測 9–68 秒)不能把使用者剛點的那張堵在後面。
   */
  | {
      type: 'translate-image';
      pageKey: string;
      url: string;
      lane: 'l0' | 'l1';
      /** 這個網域選的檔位。`lane: 'l0'` 時會被忽略 —— 免費那條路一律走 free */
      tier: Tier;
    };

/** worker → content,以及 popup → content */
export type ToContent =
  | { type: 'results'; pageKey: string; results: UnitResult[] }
  | { type: 'failures'; pageKey: string; failures: UnitFailure[] }
  | { type: 'notice'; pageKey: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'domain-state'; host: string; state: DomainState }
  /** 一張圖翻好了。`hash` 是圖片 bytes 的指紋 —— 同 src 的放大檢視靠它認親 */
  | {
      type: 'image-result';
      pageKey: string;
      url: string;
      hash: string;
      lane: 'l0' | 'l1';
      blocks: ImageBlock[];
    }
  /** 失敗要說得出原因:「太大」和「辨識失敗」對使用者是兩件事 */
  | { type: 'image-error'; pageKey: string; url: string; reason: string; retriable: boolean }
  /** translate-page:手動觸發,同時也是失敗區塊的重試入口 */
  | { type: 'command'; command: 'toggle-enabled' | 'toggle-mode' | 'translate-page' }
  /** feature.md §5.2 popup 讀本頁的階層統計 */
  | { type: 'get-page-stats' }
  | { type: 'export-page' }
  /**
   * feature.md §3.2 規則 2:downloadable 的 create() 需要 user gesture,
   * 所以語言包由 popup 的按鈕點擊觸發下載,完成後叫 content 重試 L0。
   */
  | { type: 'l0-ready' };

export interface PageStatus {
  queued: number;
  inFlight: number;
  done: number;
  failed: number;
  tokensUsed: number;
  capped: boolean;
}

/** feature.md §5.2 本頁的階層統計,popup 直接向 content script 問 */
export interface PageStats {
  pipeline: Pipeline;
  /** 實際生效的管線 —— 環境不支援 Translator API 時會與 pipeline 不同 (§6) */
  effective: Pipeline;
  counts: Record<UnitTier, number>;
  total: number;
  /** feature.md §2.2 首屏疊層出現時間,ms;-1 = 還沒出現 */
  firstPaintMs: number;
  /** feature.md §5.2 L1 = 0 且佇列非空持續超過 10 秒 → 明確警示 */
  stalled: boolean;
  stalledMs: number;
  l0: {
    supported: boolean;
    state: 'idle' | 'ready' | 'needs-gesture' | 'downloading' | 'unsupported' | 'failed';
    sourceLang: string;
    progress: number;
    detail: string;
  };
  /**
   * 機器畫像。同樣是「Intel 12 代 U」,Chromebook 與 Win11 筆電的
   * L0 速度可以差好幾倍 —— 要比較就要有可比的數字,不能比型號。
   */
  device?: { threads: number; memoryGB: number; cpuMs: number; platform: string };
  /** L0 呼叫的實測延遲(不含排隊),診斷用 */
  l0Timing?: { calls: number; avgMs: number; maxMs: number; avgWaitMs: number; concurrency: number };
  /**
   * 解析不了的顏色字串。lab() / oklch() / color-mix() 這類新語法
   * 解析失敗時是**完全沉默的**:疊層照畫,只是選錯底色 ——
   * 要靠使用者截圖才看得見。列在報告裡就不必再猜。
   */
  unparsedColors?: string[];
  /**
   * 因為太長被擋掉的區塊。門檻拉高之後撞到它就代表「有個結構我沒想到」,
   * 那比顏色解析失敗更該看得見 —— 上一版它是完全靜默的。
   */
  oversized?: string[];
  /** 這一頁有幾塊直接命中快取,沒有再打一次 API */
  cacheHits?: number;
  /** 捲動時的疊層策略與它的判斷依據(見 content/motion.ts) */
  motion?: {
    stability: string;
    guard: boolean;
    appShell: boolean;
    innerScroll: boolean;
    pinned: number;
  };
  /**
   * 內容腳本這一側看到的 L1 佇列。
   * 要和 worker 的 `page-status` 擺在一起看 —— 兩個數字對不起來,
   * 就表示訊息掉在中間;分開看,兩邊都像正常的。
   */
  l1Queue?: { queued: number; oldestMs: number; retried: number };
  /** 這一頁在 worker 佇列裡的鍵 —— popup 要拿它去問對面的深度 */
  pageKey?: string;
  /**
   * 這個網域命中的詞表。沒有這一行的話,「我明明設了」與
   * 「pattern 沒對上」看起來一模一樣(`docs/plan-glossary.md` §8)。
   */
  glossary?: { names: string[]; terms: number; inPrompt: boolean };
  /** feature.md §2.2「L0 讀完就沒再看 L1」:替換時該區塊已離開可見區的次數 */
  swapsOffscreen: number;
  swapsTotal: number;
}
