import type { Glossary, Term } from './glossary';
import type { Tier } from './models';

export type DisplayMode = 'full' | 'peek';

/**
 * feature.md §2.1 三種管線模式。
 * single 是 Phase 1 的行為,保留為 A/B 對照組 (D17);
 * l0-only 是正式模式而非除錯選項 —— 零成本、離線、無額度 (D18)。
 */
export type Pipeline = 'single' | 'progressive' | 'l0-only';

/** feature.md §4.1 區塊狀態機 */
export type UnitTier = 'pending' | 'l0' | 'l1' | 'l0-failed' | 'l1-failed' | 'failed' | 'skipped';
export type OverlayStyleName = 'inherit' | 'annotation';
/** 捲動時的疊層穩定策略(見 content/motion.ts) */
export type Stability = 'auto' | 'always' | 'strict';

export type CacheMode = 'session' | 'persistent' | 'off';

/** 一個翻譯單元送去 API 的樣子 (§6.1) */
export interface UnitRequest {
  id: string;
  src: string;
  maxChars: number;
  role: UnitRole;
}

export type UnitRole = 'heading' | 'body' | 'meta' | 'list' | 'cell' | 'label';

/**
 * 疊層有兩種畫法(docs/plan-annotation.md):
 *  - block:不透明覆蓋,取代原文,常駐 —— 內文段落
 *  - label:不透明貼片,放在旁邊,暫態 —— UI 標籤、選單、連結
 * 之後圖片裡的文字會是第三種 region,共用同一條 L0 → L1 管線。
 */
export type UnitKind = 'block' | 'label';

/** API 回來、通過三層防線後的結果 (§6.3 / §6.4) */
export interface UnitResult {
  id: string;
  t: string;
}

export type UnitFailReason =
  /** echo 對不上,但沒有證據說是對滑 —— 多半是模型沒照抄 */
  | 'echo-mismatch'
  /**
   * echo 對到了**同一批裡另一筆**的原文 —— 這是 batch 內 id 對滑的直接證據。
   * 譯文被錯置到別的區塊上,而 JSON 合法、筆數正確、每筆都是通順的中文,
   * 自動指標抓不到(PRD §5.5 排除 3.6 系列就是因為這個)。
   * 一旦抓到,同一批的其他筆也不可信 —— 整批丟棄。
   */
  | 'echo-swap'
  | 'missing-id'
  | 'duplicate-id'
  | 'unknown-id'
  | 'empty'
  | 'api-error'
  | 'budget-stop'
  | 'rate-limit'
  | 'truncated';

export interface UnitFailure {
  id: string;
  reason: UnitFailReason;
  detail?: string;
}

export interface DomainState {
  enabled: boolean;
  mode: DisplayMode;
  tier: Tier;
  /** feature.md §2.1 管線模式以網域為單位記憶,與顯示狀態、模型檔位各自獨立 */
  pipeline: Pipeline;
}

export interface QuotaOverride {
  rpm?: number;
  tpm?: number;
  rpd?: number;
}

export interface PriceOverride {
  inPrice?: number;
  outPrice?: number;
}

export interface Settings {
  apiKey: string;
  targetLang: string;
  defaultTier: Tier;
  /** feature.md §2.1 新網域的預設管線模式 */
  defaultPipeline: Pipeline;
  /**
   * feature.md 實作註記:Translator API 要求明確的 sourceLanguage,
   * 而 Phase 1 沒有語言偵測。取不到 <html lang> 時用這個值。
   */
  l0SourceLang: string;
  /** feature.md §4.2 第 2 條:可見區停留超過這個時間才排入 L1 (D21) */
  upgradeDwellMs: number;
  /**
   * feature.md §3.4 不翻清單 —— **舊欄位,已被詞表取代**(`plan-glossary.md` §9)。
   * 讀取時搬進 `globalGlossary`,保留一輪相容,下一版拿掉。
   */
  noTranslateTerms: string[];
  /** 一律生效的詞,不需要掛網域 */
  globalGlossary: Term[];
  /** 具名詞表。key 是穩定 id,不是 name —— 改名不該讓網域綁定失效 */
  glossaries: Record<string, Glossary>;
  /** host pattern → 詞表 id[]。pattern 支援前綴 `*.` */
  glossaryBinding: Record<string, string[]>;
  /**
   * 路徑 B:把詞表也寫進 system prompt。
   * 'auto' = 依檔位的 `glossaryPrompt` 能力旗標決定(`plan-glossary.md` §5)。
   *
   * **關掉不代表詞表失效** —— 詞表一律以佔位符生效,
   * 這個開關只決定要不要額外請模型配合。
   */
  glossaryPrompt: 'auto' | 'on' | 'off';
  /**
   * 啟用後是否自動翻譯可見區(PRD §7.1 的行為)。
   * 關掉就必須按 popup 的「翻譯這一頁」或 Alt+R 才開始 ——
   * 想先看清楚狀態、或不想一啟用就花錢的時候用。
   */
  autoTranslate: boolean;
  /** 頁內狀態列:翻了幾塊、還在等幾塊、失敗幾塊 */
  hud: boolean;
  /**
   * 疊層額外往外撐幾 px。
   * 字型度量算得出來的溢出(緊排標題的 ascender / descender)會自動補,
   * 這個值是給量不到的東西用的:text-shadow、斜體尾巴、次像素捨入。
   */
  overlayBleedPx: number;
  /**
   * 疊層前先確認來源元素真的看得見(elementFromPoint 命中測試)。
   * 擋掉被裁切的重複 DOM 與被固定頁首蓋住的內容。
   * 頁面若有透明的點擊攔截層可能造成誤判,那時關掉。
   */
  occlusionCheck: boolean;
  /** §4.3 中文字重加權 */
  weightOffset: 0 | 100 | 200;
  /** §4.7 提示線 */
  hintLine: boolean;
  /**
   * 捲動時疊層要不要先藏起來(見 content/motion.ts)。
   *  - auto:只在「座標真的會跑」的頁面上藏(Gmail 這種內層捲動的應用程式)
   *  - always:一律不藏,接受捲動時可能短暫不對齊
   *  - strict:任何動靜都先藏,最保守
   */
  stability: Stability;
  /**
   * 加翻層:UI 標籤、選單、連結不覆蓋原文,改成 hover 時在旁邊顯示貼片。
   * 見 docs/plan-annotation.md。
   */
  annotate: boolean;
  /** 加翻層只在按住 Alt 時出現(不想被 hover 打擾的人) */
  annotateAltOnly: boolean;
  /** 強制全站使用標註樣式 (§4.6) */
  forceAnnotation: boolean;
  cacheMode: CacheMode;
  persistentCacheMB: number;
  /** §8 保險絲 */
  pageTokenCap: number;
  globalDailyTWD: number;
  usdToTwd: number;
  quota: Partial<Record<Tier, QuotaOverride>>;
  price: Partial<Record<Tier, PriceOverride>>;
  modelIds: Partial<Record<Tier, string>>;
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  targetLang: 'zh-TW',
  // 封測預設:L0 打底 + L1 升級,檔位 free(零帳單起步)。
  // 封測的人拿到的第一頁不該產生帳單;要更好的譯文再自己往上調。
  defaultTier: 'free',
  // feature.md §2.1 原本要 single 當對照組,但實測下來 progressive 明顯好用,
  // 對照組改成「需要時自己切」。
  defaultPipeline: 'progressive',
  l0SourceLang: 'en',
  upgradeDwellMs: 1500,
  noTranslateTerms: [],
  globalGlossary: [],
  glossaries: {},
  glossaryBinding: {},
  glossaryPrompt: 'auto',
  /*
   * 預設**不**自動翻。
   *
   * 競品多半一進站就整頁翻,但使用者的原話是「我沒有要每頁都翻,
   * 也不是這樣燒 token 的」。啟用 = 這個網域我要用 Kasanemu;
   * 真的要翻是另一個動作(popup 的按鈕 / Alt+R)。
   * 想要競品那種行為的人把這個打開就有。
   */
  autoTranslate: false,
  hud: true,
  overlayBleedPx: 2,
  occlusionCheck: true,
  weightOffset: 100,
  hintLine: true,
  // 預設自動:長文一直閃是比偶爾不對齊更明顯的干擾,而長文根本不需要藏
  stability: 'auto',
  annotate: true,
  annotateAltOnly: false,
  forceAnnotation: false,
  /*
   * **預設 persistent。**
   *
   * 原本是 session,而 `chrome.storage.session` 在瀏覽器關掉(以及每次
   * 重新載入擴充功能)時就清空 —— 使用者的疑問是「翻好的不是先存 local 嗎?
   * 怎麼會真的重來重翻?」。會,但只在同一次瀏覽器工作階段內。
   *
   * 這個工具的重點之一就是不要重複花錢,而快取的成本只是磁碟(有 LRU 上限)。
   * 預設值應該站在「不要再付一次錢」那邊。
   */
  cacheMode: 'persistent',
  persistentCacheMB: 50,
  pageTokenCap: 120_000,
  globalDailyTWD: 60,
  usdToTwd: 32,
  quota: {},
  price: {},
  modelIds: {},
  debug: false,
};

/** 一天的花費帳 (§8.1) */
export interface SpendDay {
  /** YYYY-MM-DD,本地日界線 */
  day: string;
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  usd: number;
  calls: number;
  /**
   * feature.md §2.2:每頁 LLM token 消耗要「按模式分開累計」,
   * 否則兩週的 A/B 沒有數字可比。
   */
  byPipeline?: Partial<Record<Pipeline, PipelineSpend>>;
}

export interface PipelineSpend {
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  usd: number;
  calls: number;
}

export interface SpendLedger {
  days: Record<string, SpendDay>;
  /** 計數器自己壞掉時放行並警示 (§8.3) */
  degraded?: string;
}
