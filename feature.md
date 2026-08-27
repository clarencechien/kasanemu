# Feature:漸進式翻譯(Progressive Translation)

> Kasanemu · Feature 規格 v1.0 · 2026-08-24
>
> **狀態:已實作**,而且已經是預設管線(`defaultPipeline: 'progressive'`)。
> 原本寫的進場條件是「Phase 1 驗收通過、且已實際自用兩週之後才實作」。
>
> **前置文件:** `kasanemu-phase1-prd.md`(基準規格)、`docs/gemini-api-lessons.md`(模型與保險絲教訓)。本文件只描述**相對於 Phase 1 的增量**,未提及的行為一律沿用 Phase 1。

---

## 1. 這個 feature 是什麼

Phase 1 的行為是:啟用 → 等 LLM 回應 → 疊層出現。可見區優先,但第一屏仍有 0.5–1.2 秒的空窗。

漸進式翻譯改成兩段:

1. **L0(即時層)** — 用 Chrome 內建 Translator API 在本機翻譯,毫秒級,零成本,離線可用。疊層立刻出現。
2. **L1(升級層)** — Gemini / Gemma 的譯文陸續回來後,**就地替換**同一個疊層的內容。

使用者從不面對空窗,但最終讀到的是好譯文。

疊層架構天生適合這件事:不動 DOM,替換只是換疊層元素的 `textContent`,幾何完全不變。

---

## 2. 為什麼要 A/B,不直接取代

Phase 1 的單段模式必須保留為對照組,理由有三:

1. **L0 的品質天花板是 Google 翻譯離線版。** TranslateKit 的模型血緣就是 Google 翻譯離線模式那一批,官方定位為 casual translation。它不會給台灣用語——而「不要翻譯腔」是本專案唯一真正在意的品質軸。先看到一份不合格的譯文再被換掉,可能比多等 0.8 秒更煩。
2. **成本可能反向上升。** 有了 L0 打底,心理上會放心讓整頁都升級,LLM 呼叫量反而比「只翻可見區」更多。
3. **替換本身是新的視覺風險。** 文字在眼前跳掉、字級抖動,都是 Phase 1 沒有的問題。

所以這是一個可切換的 feature,不是一次性的改版。

### 2.1 A/B 設計

- options 提供三個模式:`single`(Phase 1 行為)/ `progressive` / `l0-only`
- 模式**以網域為單位記憶**,與顯示狀態、模型檔位分開存
- `l0-only` 不只是除錯選項:它是零成本、離線、無額度的實用模式,值得獨立保留

### 2.2 A/B 的判準

不要靠感覺。跑兩週,每週一種模式,記錄:

| 指標 | 取得方式 |
|---|---|
| 首屏疊層出現時間 | 內建計時,popup 顯示 |
| 每頁 LLM token 消耗 | 既有的花費統計,按模式分開累計 |
| 「L0 譯文讀完就沒再看 L1」的比例 | 替換發生時該區塊是否已離開可見區 |
| 主觀:有沒有被替換干擾 | 自己記,沒有量化辦法 |

最後一項才是決定性的。前三項只是輔助。

---

## 3. L0:Chrome Translator API

### 3.1 環境要求(必須先驗證)

| 項目 | 要求 |
|---|---|
| OS | Windows 10/11、macOS 13+、Linux、**ChromeOS 需 Chromebook Plus** |
| Chrome | 138+,**桌機限定**,行動版不支援 |
| 儲存空間 | profile 磁區 22 GB 以上可用;掉到 10 GB 以下模型會被移除,補足後自動重新下載 |
| RAM / CPU | 16 GB 以上、4 核以上 |
| GPU | **不需要**(4 GB VRAM 那條是 Prompt API 帶音訊才需要) |

**主要開發機(HP Elite Dragonfly Chromebook)可能不符合 Chromebook Plus 認證。** 這是實作前的第一個檢查點:

```js
// 1. API 是否存在
'Translator' in self
// 2. 語言對狀態
await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh-Hant' })
// → 'available' | 'downloadable' | 'downloading' | 'unavailable'
```

以及 `chrome://on-device-translation-internals/` 手動確認語言包裝得起來。

**若該機器不支援,本 feature 直接不實作。** 不為自己用不到的環境寫程式;等真的換到 Windows / Mac 再回來。

### 3.2 API 使用的硬性規則

```js
const opts = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' };
const avail = await Translator.availability(opts);
const translator = await Translator.create({
  ...opts,                       // 必須與 availability() 完全相同的 options
  monitor(m) {
    m.addEventListener('downloadprogress', e => { /* 回報進度 */ });
  }
});
```

1. **`availability()` 與 `create()` 必須傳完全相同的 options 物件。** 不一致會出問題。
2. **`downloadable` 時的 `create()` 需要 user gesture。** 頁面載入時無條件呼叫會丟 `NotAllowedError`。→ 首次啟用某語言對必須綁在 popup 的按鈕點擊後。
3. **必須實作 `downloadprogress` 監聽**,否則首次使用時使用者會以為卡住。
4. **`availability()` 會騙你。** 為保護隱私,所有語言對在本 origin 建立過 translator 之前一律回報 `downloadable`,問不到「其實已經裝好」。→ 不要用 `availability()` 的回傳值做快取判斷,直接 `create()` 並處理失敗。
5. Translator 實例可重用,**不要每個區塊建一個**。以語言對為 key 快取實例,頁面卸載時 `destroy()`。
6. 目前約 39 個語言碼,實際語言對可用性只能 runtime 判定。

### 3.3 L0 不套用的 Phase 1 規則

| Phase 1 規則 | L0 的處理 |
|---|---|
| §6.2 長度預算(`maxChars` 寫進 prompt) | **不適用。** Translator API 沒有 system prompt,無法要求長度 |
| §6.1 batch JSON 協定 | **不適用。** 一區塊一次呼叫,無 batch |
| §6.4 id 紀律三層防線 | **不適用。** 一對一呼叫不存在 batch 內 id 對滑 |
| §6.5 失敗可見 | **適用且加強**,見 §5.1 |
| §7.2 token bucket / §8 成本保險絲 | **不適用。** 本機、零成本、無額度 |
| §4 全部視覺規格 | **完全適用。** L0 與 L1 的疊層在視覺上除了提示線顏色以外完全相同 |

### 3.4 L0 的過濾前處理

沒有 system prompt 可以下指令,所以要在送出前自己處理:

- 程式碼、變數名、CLI 指令:Phase 1 的 §3.1 排除規則已擋掉 `code` / `pre`,但行內 `<code>` 仍在段落中。L0 送出前把行內 code 的內容替換為佔位符,翻完再還原。
- 專有名詞保留:維護一份使用者可編輯的「不翻清單」(公司名、產品名、人名),同樣以佔位符處理。
- L1 不需要這層——直接寫進 prompt 就好。這是 L0 額外的實作成本。

---

## 4. 升級管線

### 4.1 區塊狀態機

```
pending → l0 → queued → l1
              ↘ l1-failed(停在 l0,標記)
   ↘ l0-failed → queued → l1
                        ↘ failed(顯示原文,標記)
```

`UnitState` 存在 `WeakMap`(沿用 Phase 1 §3.4),新增欄位:

```ts
{
  tier: 'pending' | 'l0' | 'l1' | 'l0-failed' | 'l1-failed' | 'failed';
  l0Text?: string;
  l1Text?: string;
  lockedFontSize: number;   // 見 §4.4
  upgradeQueuedAt?: number;
}
```

### 4.2 升級佇列的排程

**以視線為準,不是文件順序。**

排入 L1 佇列的條件,全部滿足:

1. 該區塊在可見區內(`IntersectionObserver`,`rootMargin: "200px 0px"`)
2. **已在可見區內停留超過 1.5 秒**
3. 快取未命中
4. 當前模式為 `progressive`
5. 成本保險絲未觸發(Phase 1 §8 全部適用)

第 2 條是成本控制的關鍵:純粹滑過去的區塊留在 L0,不花錢。這一條直接對治 §2 提到的「有 L0 打底反而燒更多」。

佇列排序:距離視窗中心越近越優先。使用者捲動時**重排佇列**,已送出的請求不取消(取消不會退錢)。

### 4.3 替換時機

**不得替換使用者當前正在互動的區塊。**

- 該區塊處於 hover 狀態(正在顯示原文)→ 延後,`mouseleave` 後執行
- 該區塊在可見區的中央三分之一內且距上次捲動 < 400ms → 延後 400ms 再試

### 4.4 字級鎖定(最重要的一條)

**問題:** L1 譯文通常比 L0 長。一個區塊替換後撐破容器 → 觸發 Phase 1 §4.4 的字級分組重算 → **整組正文的字級一起變小**。單一段落的替換造成全頁跳動,視覺上非常糟。

**規則:**

1. 字級分組在 **L0 全部完成時定案並鎖定**,寫入各 `UnitState.lockedFontSize`
2. **L1 替換不重算分組。** 個別區塊超出就個別垂直溢出,不動整組
3. 只有以下事件才解鎖重算:視窗 resize、字型載入完成、SPA 換路由、使用者手動重新翻譯

**同時,把 L1 的 `maxChars` 設為「L0 譯文所在容器在鎖定字級下的容量」**,而不是原本以來源幾何算出的值。這樣 L1 譯文在多數情況下根本不會超出,長度預算從「排版工具」升級成「替換穩定性工具」。

```
maxChars_L1 = floor(rectWidth / (lockedFontSize × 1.02))
            × floor(rectHeight / lineHeightPx)
            × 0.92
```

### 4.5 過場

- 直接切換,或 **80ms cross-fade**。不要做長淡入——越明顯的動畫越吸引注意,替換應該低調
- `prefers-reduced-motion: reduce` → 直接切換
- 替換時**不改變疊層盒子的幾何**,只換內容

### 4.6 快取互動

- 快取命中時**跳過 L0**,直接以 L1 譯文渲染。第二次讀同一頁不該先閃一次 L0
- 快取 key 沿用 Phase 1 §9,但 `modelId` 欄位加入 `l0`(TranslateKit 譯文也快取,避免重複呼叫)
- L0 與 L1 的快取分開存,`l0-only` 模式只讀 L0 的快取

---

## 5. 狀態可見性

### 5.1 提示線的狀態色(不是美觀選項)

**這是本 feature 最重要的安全設計。**

L0 打底的副作用是**讓失敗變隱形**:如果 L1 整條管線死了——429、預算燒完、key 打錯、模型 ID 不存在、CF 出口地區被拒——使用者看到的是一份完整的譯文,一切看起來運作正常,不會發現已經降級。這直接違反「可見的失敗優於沉默」。

所以提示線必須以顏色區分階層:

| 狀態 | 提示線 |
|---|---|
| `l0` | 頁面連結色,`opacity: 0.25`,**虛線** |
| `l1` | 頁面連結色,`opacity: 0.4`,實線(Phase 1 樣式) |
| `l1-failed` | 警示色,實線 |
| `failed` | 警示色,虛線 |

判準:**掃一眼就要能看出整頁是不是還停在 L0。** 如果全頁都是虛線,升級管線死了。

### 5.2 popup 的階層統計

顯示本頁 `L0 / L1 / 失敗` 的區塊數。`L1 = 0` 且佇列非空持續超過 10 秒 → popup 顯示明確警示,不要只是靜靜地不動。

### 5.3 debug mode

新增「L0 / L1 並列」檢視:隨機抽 5 個已升級區塊,並列原文、L0 譯文、L1 譯文。

這是判斷「L1 到底值不值得那些錢」的唯一可靠辦法。如果多數區塊的 L1 只是把 L0 換成同義句,`l0-only` 就是正確答案,整個 feature 應該退回去。

---

## 6. 驗收標準

沿用 Phase 1 §12 的測試站台與全部通過條件,額外要求:

- 首屏疊層出現 **< 150ms**(L0 語言包已就緒時)
- L1 替換時**沒有任何區塊的字級改變**
- L1 替換時**沒有任何區塊的幾何改變**
- 純捲動通過的區塊**不產生 LLM 呼叫**(用 popup 的 token 統計驗證)
- 刻意填入錯誤 API key → 全頁提示線維持虛線 + popup 明確警示,**不得看起來像正常運作**
- 刻意讓預算耗盡 → 同上
- 快取命中的頁面**不出現 L0 → L1 的閃動**
- hover 中的區塊不被替換
- 在不支援 Translator API 的環境下,自動退回 `single` 模式且明確告知,不報錯

---

## 7. 決策紀錄(增量)

| # | 決策 | 理由 |
|---|---|---|
| D16 | L0 用 Translator API,不用 Prompt API / Gemini Nano | Nano 是通用小模型,翻譯不是它的強項;Translator API 是專用語言包,更快更準 |
| D17 | 保留 Phase 1 單段模式為對照組,不直接取代 | L0 品質天花板是 Google 翻譯離線版,先看爛譯文再被換掉可能比等 0.8 秒更煩 |
| D18 | `l0-only` 為正式模式,非除錯選項 | 零成本、離線、無額度,本身就有用 |
| D19 | 字級分組在 L0 完成時鎖定,L1 替換不重算 | 單段落替換觸發全頁字級重算是不可接受的視覺缺陷 |
| D20 | L1 的 `maxChars` 以鎖定字級的容量計算 | 長度預算從排版工具變成替換穩定性工具,一石二鳥 |
| D21 | 升級需「可見且停留 > 1.5 秒」 | L0 打底會誘使整頁升級,反而比只翻可見區更貴 |
| D22 | 提示線以虛線/實線區分 L0/L1 | L0 會讓 L1 的失敗變隱形,狀態指示是安全需求不是美觀 |
| D23 | 快取命中跳過 L0 | 避免重讀同頁時的無意義閃動 |

---

## 8. 開放問題

1. **L0 的中文能不能忍。** 先翻一段真實文章自己看。這一題的答案決定本 feature 是「首屏層」還是只是「額度用完時的降級」。
2. **Chromebook Plus 認證。** 主要開發機是否支援 Translator API,決定本 feature 是否開工。
3. **行內 `<code>` 的佔位符處理**是 L0 獨有的實作成本,佔位符會不會被 TranslateKit 翻掉或搬位置需要實測。建議用不含字母的符號(如 `U+E000` 私用區字元)而非 `__CODE_1__`。
4. **L0 的段落級 vs 句子級呼叫。** Translator API 對長段落的處理品質未實測。若段落級明顯較差,可能要自己斷句再逐句翻,但那會讓語意更破碎。
5. **是否讓 hover 顯示 L0 而非原文。** 若 L1 是主體,對照 L0 可能比對照原文更有用(尤其對不熟悉來源語言的內容)。作為第二層 A/B,不在本次範圍。

---

## 實作註記(2026-08-24)

以下是實作時相對本規格的決定,詳見 `docs/deviations.md` 的「漸進式翻譯」段:

- **§3.1 的兩道閘門(Phase 1 自用兩週、開發機支援 Translator API)在寫這一版時都還沒驗。**
  程式碼因此把「環境不支援 → 自動退回 `single` 並明確告知」做成硬性行為(§6 最後一條),
  而不是假設 L0 一定在。閘門的答案是 no 時,這個 feature 等於不存在,不會留下半死的路徑。
- **來源語言**:Translator API 要求明確的 `sourceLanguage`,而 Phase 1 §3.2 只做「是不是已經是中文」
  的判定,沒有語言偵測。實作取 `<html lang>` 正規化後的主語言碼,取不到時退到 options 的
  預設值(`en`)。這是本規格沒講但非做不可的決定。
- **L0 快取只在頁面生命週期內**(記憶體 Map),沒有走 IndexedDB。理由與取捨見 deviations。
