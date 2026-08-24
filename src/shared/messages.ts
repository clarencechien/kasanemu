import type { Tier } from './models';
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
  | { type: 'cache-probe'; tier: Tier; units: Array<{ id: string; src: string; maxChars: number }> }
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
  | { type: 'page-status'; pageKey: string };

/** worker → content,以及 popup → content */
export type ToContent =
  | { type: 'results'; pageKey: string; results: UnitResult[] }
  | { type: 'failures'; pageKey: string; failures: UnitFailure[] }
  | { type: 'notice'; pageKey: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'domain-state'; host: string; state: DomainState }
  /** translate-page:手動觸發,同時也是失敗區塊的重試入口 */
  | { type: 'command'; command: 'toggle-enabled' | 'toggle-mode' | 'translate-page' }
  /** feature.md §5.2 popup 讀本頁的階層統計 */
  | { type: 'get-page-stats' }
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
  /** feature.md §2.2「L0 讀完就沒再看 L1」:替換時該區塊已離開可見區的次數 */
  swapsOffscreen: number;
  swapsTotal: number;
}
