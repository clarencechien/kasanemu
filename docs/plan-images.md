# 圖片翻譯規格 v0.2

> 狀態:計劃(含可行性實驗)。尚未實作。
> v0.1 → v0.2:呈現從「不透明 patch 重繪」改為 **sukemu 的 acetate 加註**
> (v0.1 的 patch 在驗證台實測:配色貼片要嘛破版要嘛小字糊 —— 否決,見 §3.0);
> 分層改成與文字管線同構的 **L0(gemma,免費,hover 自動)→ L1(flash-lite,
> Alt+click 升級)**。
> 前作:https://github.com/clarencechien/sukemu —— 同一個問題在「拍照翻譯」
> 場景做過一輪,`docs/handoff.md`、`docs/adr/0001`、`acetate-lens.html`
> 是這份規格的直接依據,下面凡標 (sukemu §x) 的都出自那邊的實測。
> 實驗:`scripts/probe-vision.mjs`(2026-08-25)。
> **Mockup(互動與視覺的規格書,沿 sukemu 慣例)**:
> https://claude.ai/code/artifact/45f7c96a-f1ab-4eaf-8121-d88d402a66f0
> —— 資料是真實 API 結果(gemma = L0、lite = L1),時序是模擬的。
> **Mockup 2(部落格情境,文字繞圖)**:
> https://claude.ai/code/artifact/b9a368ff-4eb7-412b-abb7-6e7f386d5b7f
> —— 翻譯後的閱讀狀態,§2.5 對稱律的實景。

## 0. 一句話

圖片翻譯是**加註,不是重繪**:一層透明疊膜把原文壓暗,譯文帶光暈浮在
原位上 —— 按住就看原圖。分層照抄文字管線:免費的先自動來,好的等使用者
點名再上。

## 1. 實地觀察:兩個範例頁(2026-08-25 probe)

### 1.1 clickhouse.com 的 benchmark 長文

- **44 張**可縮放圖表,每張蓋著透明的 `button.cursor-zoom-in`,點開出現
  `span.fixed.inset-0.bg-black/80` + **新的 `<img>`,src 與原圖相同**,
  置中放大(行內 802px → 黑窗 1000px)。這就是「獨立的黑窗視窗」。
- 圖走 `_next/image` 同源代理;`alt` 是檔名(沒有用)。
- 圖型:深色底 bar chart,7-8 段短文字、字大(≥18px 顯示)。

### 1.2 claude.com 的 blog 文章

- 內文圖原始 **2042×1546**,行內只顯示 **565px**(縮到 28%)。內容是
  **整頁 UI 截圖**:幾十段文字、字級落差極大、小字在行內只有 3-6px 高。
- **沒有 lightbox**,跨域(webflow CDN),`alt` 全空。

### 1.3 結論

「黑窗」不是邊角:小字圖的主要閱讀面就是放大檢視。同一套規格必須同時
吃下「字大的 chart」與「字小的截圖」。

## 2. 核心決定

### 2.1 加註,不重繪(sukemu handoff §1、§7)

v0.1 的做法是取樣背景色畫不透明 patch(重繪)。驗證台實測兩個死穴:
配色與折行永遠有例外(破版),小字縮到 11px 以下必糊。sukemu 為同一個
問題選了另一條路,而它**沒有這兩個死穴**:

> 毛玻璃 veil(`backdrop-filter: blur + saturate(.55) + brightness(1.16)`)
> 把該區原文壓暗退後,譯文(高彩度 + 白色光暈)浮在其上。
> 不用知道背景色、不裁切原圖、譯文長一點就長一點 —— 因為這是**標註**,
> 使用者知道底下是原圖,按住(`O` 鍵 / 長按)整層掀開。

視覺紀律照搬(sukemu handoff §8):**標註色只給譯文**,一眼分得出哪些字
是加上去的;HUD 與框線用另一支冷色。kasanemu 的具體配色在 mockup 定案。

### 2.2 兩段式,與文字管線同構

| | 文字 | 圖片 |
|---|---|---|
| L0 | Translator API,本機免費 | **gemma-4-31b-it**,API 免費檔 |
| L0 觸發 | 進視窗就翻 | **hover 圖片 500ms** 自動送 |
| L1 | 檔位模型 | **flash-lite**(quality 檔可設 flash) |
| L1 觸發 | 停留 1.5s 升級 | **Alt+click**(或點 chip)明確點名 |
| 替換 | cross-fade 就地換 | 同 —— veil 不動,譯文 cross-fade |

- 「絕不自動」修訂為「**自動的只能是免費的**」:gemma $0,hover 是
  明確的注意力訊號,和文字 L0 的哲學一致。gemma 慢(實測 9-68s)——
  但這是**背景填充**,chip 顯示進度,使用者不必等它。
- 併發防呆:gemma 免費檔 15 RPM / 12k TPM 與文字 free 檔**共用配額**,
  imageQueue 對 L0 一次只跑一張,hover 亂掃不會炸配額(佇列滿了 chip
  顯示排隊中,離開 hover 超過 10s 未開跑的取消)。
- L1 是付費動作,保留估價 chip:`升級 ≈ $0.007`。
- 每網域開關:`圖片翻譯 off / hover-L0(預設) / hover-L0 + 曾譯過的自動 L1`。

### 2.3 大小字分流:veil 加註 vs 編號錨點(sukemu 的 A 疊字 / C 註解)

量尺仍是顯示字高,但兩邊都是「加註」,只是形式:

- **過門檻(≥ 11px)→ veil 加註**:譯文就地浮在原文上。
- **不過門檻 → 編號錨點(pin)**:小圓點標在原位,**hover pin 出貼片**
  —— 直接複用 UI 標籤的 chip 管線與樣式,零新概念。
- **放大檢視**裡重算門檻:黑窗顯示更大,行內過不了的字在這裡自動
  變成 veil 加註。站方 lightbox(§2.4)與我們自己的放大檢視同理。

### 2.4 黑窗跟著 src 走

譯文快取以圖片 bytes hash 為鍵(§6)。站方 lightbox 的圖是新元素但同
src → 快取命中,加註直接跟過去且更全。沒 lightbox 的站,翻完 chip 給
`放大檢視`:overlay 全螢幕層、深底、圖 fit 置中、加註按放大座標重畫。
互動(Esc 關、點外關)走 document 層級監聽,overlay 維持
`pointer-events: none`。

### 2.5 對稱律:文字與圖片的預設面相反

|  | 預設看到 | hover 看到 |
|---|---|---|
| 文字 | **譯文**(常駐疊層) | 原文(掀開) |
| 圖片 | **原圖**(乾淨) | 譯文(加註浮上) |

理由:文字的資訊全在語言裡,不翻就讀不動,所以譯文是常駐面;
圖的資訊主體是圖形與版面,文字是輔助,所以原圖是常駐面 ——
加註常駐會讓整頁的圖都掛著標註色,閱讀時是噪音。

**所以加註不常駐**:翻譯完成(= 已快取)後,hover 圖片才浮現、移開就收,
浮現是即時的、不再打 API。圖角留一枚小 cue(`滑上來看譯文`)標記
「這張翻過了」,同時是可發現性的入口。options 提供「加註常駐」開關
給偏好相反的人。放大檢視裡加註**常駐**(進黑窗本身就是「我要讀字」)。

## 3. UI/UX 規格

### 3.0 sukemu 原型的可抄清單(handoff §7「照抄」條款)

- veil 參數:`blur(1.4px) saturate(.55) brightness(1.16)` + 淺色漸層底,
  **強度可調(0–0.6,預設 0.30)**,options 收一個滑桿。
- 譯文:`Noto Sans TC` 700、白色多層 text-shadow 光暈;四角 HUD 括號
  hover 才亮。
- 按住看原圖:整層帶位移+模糊「掀起」(`translateY(-1.6%) scale(1.03)
  blur(4px)`),不是瞬間消失;`prefers-reduced-motion` 直接切。
- 低信心(`c < 0.9`)框線換警示色,pin 模式照樣列出(sukemu 的「待複核」)。
- **陷阱**(handoff §7 原文):圖片尺寸由 JS 算寫進 style,不要讓
  `max-width:100%` 在彈性容器裡自我糾纏;註解清單選取用
  `order:-1 + sticky`,**不要 scrollIntoView**(畫面會跳)。

### 3.1 觸發時序

1. hover 圖片(顯示 ≥ 200×100)500ms → 送 L0(免費),圖角出小 chip:
   `⌛ 辨識中(免費)`。完成 → 加註淡入,chip 變 `↑ Alt+click 升級 ≈ $0.007`。
2. Alt+click(或點 chip)→ L1。in-flight 去重;失敗 chip 轉紅
   `辨識失敗 · 再點一次重試`,重試上限 2。
3. L0 結果已在畫面上時 L1 回來 → 逐塊 cross-fade(對位用 box IoU +
   原文 echo,對不上的塊整批換)。
4. 完成後回到 §2.5 的閱讀狀態:加註只在 hover 圖片時浮現。

### 3.2 加註渲染

- 字級:模型不估(sukemu handoff §6 說「選一個別混用」——我們選幾何反推),
  而且**不能只看框高**。mockup 第一版只用框高,gemma 把整張小卡合併成
  高瘦一塊(82×70 正規化、30+ 字),字級直接爆成巨柱。定案公式:

  ```
  fs = min(框高 × 0.8, √(框寬px × 框高px / (字數 × 1.35)))
  ```

  面積項讓「多行合併的框」自動縮回去;縮完仍 < 11px 就落到 pin ——
  於是 gemma 的粗框(整卡一塊)自然變成錨點,lite 的細框才疊字,
  **兩檔的輸出粒度差異被同一條公式吸收**,不用分模型寫規則。
  直排(§4)把寬高對調。
- 譯文超框:允許超出 box(這是標註不是替換),但夾在圖片 rect 內。
- 專有名詞不翻靠 prompt;`kind:"code"` 的塊(等寬深底)不加註不算數。
- 圖片加註計入頁內狀態列獨立一格(`圖 2/3`);診斷 scope `image`。
- 匯出疊好的 HTML:veil + 譯文一併輸出(backdrop-filter 是純 CSS,可攜)。

### 3.3 chip

overlay 裡唯一 `pointer-events: auto` 的元素(觸控裝置的唯一入口)。
≤ 90×28px、只在 hover 圖片時存在、避開 `a`/`button` 的 client rect。

## 4. 資料契約與座標防呆(sukemu 實測移植)

```ts
// shared/types.ts —— 沿 sukemu Block 形狀,欄位名對齊,方便沿用工具
export interface ImageBlock {
  box: [number, number, number, number]; // [ymin,xmin,ymax,xmax] 0-1000
  text: string;    // 原文
  zh: string;      // 譯文
  c: number;       // 版面信心 0-1,< 0.9 標待複核
  v?: boolean;     // 直排,前端 writing-mode: vertical-rl
  kind?: 'text' | 'code';
}
```

- **prompt 直接要 0-1000**(Gemini 空間標註的訓練慣例)。sukemu 要 0-100,
  lite 就掉回 0-1000(ADR 0001 破法 1)—— 我們順著慣例要,實測三模型
  全部照給。
- **`normalizeBlocks()` 照樣移植**(sukemu `worker/gemini.ts`):從數值
  範圍推斷實際規格(0-1000 / 0-100 / 0-1 / 像素)再換算 —— 模型不照規格
  是**何時**發生的問題,不是會不會。換算過就 log 一筆 diag。
- **幾何夾取**:橫排字高 ≤ 框高、直排字寬 ≤ 框寬;box 夾在 [0,1000]。
- **多語串接檢查**(ADR 0001 破法 3):zh 長度 > text 長度 × 4 的塊
  標低信心 —— lite 在多語並排素材上會把多行譯文串進同一塊。
- object-fit/position 換算、`currentSrc` 為準、同 src 重錨定:同 v0.1
  (純函式 `mapBox()`,jsdom + probe 雙驗)。

## 5. 管線

```
content                          worker
───────                          ──────
hover 500ms / Alt+click           fetch bytes(≤4MB、http/https、每 URL 一次)
  │ {url, naturalW/H, tier}        │ OffscreenCanvas decode,長邊 >1536 縮
  │                    ──▶         │ bytes SHA-256 → 快取(含 tier 檔)
  │                                │ miss → 視覺呼叫(schema、normalizeBlocks)
  ◀── {blocks[], hash}             └ 寫快取
veil/pin 渲染 + 同 src 重錨定
```

- `imageQueue` 與文字佇列分開(token 量級不同),同一套 queuelogic 純
  函式;L0 lane 併發 1、L1 lane 併發 2。
- 一張圖一請求,不 batch。
- P1/P2 兩趟制(sukemu §5)**不移植**:那是為譯註與在地化服務的,
  kasanemu 的圖片加註不產譯註;單趟就地翻。若日後品質不夠再開 P2,
  介面留在 vision.ts 的回應後處理。

## 6. 快取

鍵 = `img:{bytesHash}:{targetLang}:{modelId}`。L0/L1 各自條目(modelId
不同),L1 命中優先。值 = `{blocks, at}`。與譯文快取同 store 同匯出。
詞表 fingerprint:v1 簡化 —— 詞表變更後圖片條目視為 miss(條目少,可接受)。

## 7. 可行性實驗(2026-08-25,`scripts/probe-vision.mjs`)

三檔模型 × 兩張真實圖,schema 強制 JSON、`thinkingLevel: minimal`:

| 模型 | chart(1580×530) | 截圖(2042×1546) |
|---|---|---|
| gemini-3.5-flash | 2.0s · 7 區 | 4.7s · 29 區 |
| gemini-3.5-flash-lite | 2.8s · 7 區 | **7.3s · 53 區** |
| gemma-4-31b-it | 9.2s · 7 區 · in 367 tok | **68s** · 35 區 |

1. **三個模型都會畫框,而且在網頁渲染圖上都準**(box 誤差目測 ≤2%)。
2. **flash-lite 找字最全**(53 區,連插畫裡的迷你表格都撈到)。
3. **gemma 可用但慢** —— 所以它是 hover 背景的 L0,不是互動的主力。
4. 兩行字的區域模型會合併一框;中文譯文三家可用;專有名詞三家守。

### 7.1 與 sukemu ADR 0001 的表面矛盾,和它為什麼不是矛盾

sukemu 實測 lite 出局(框漂移、漏塊、多語串接)—— 素材是**照片**
(手寫白板、斜拍菜單)。kasanemu 的素材是**網頁渲染圖**:正拍、無透視、
字體乾淨。同一個模型在兩個域的表現可以天差地遠,兩邊的結論**都留著**:
kasanemu 選 lite 是基於自己域的實測,防呆(§4)全部照裝,
且 §13 的補量測要覆蓋照片型素材(部落格裡的實拍圖)再確認一次。

成本(牌價):lite 截圖級 ≈ **$0.007/張**、chart 級 ≈ $0.0012;gemma $0。

## 8. 詞表

路徑 A(佔位符)在圖片上不成立 —— 模型看的是像素,改寫不了來源。
只有路徑 B(prompt 詞表),`promptTerms` 同一套附在視覺 system prompt。
手冊詞表節補一句:圖片翻譯裡詞表靠模型遵守,沒有佔位符那道硬保證。

## 9. 成本閘門

- 自動的只能是免費的(L0);L1 一律明確動作 + 估價 chip。
- imageQueue 共用每日預算與 token bucket;每頁 L1 圖片預算(預設 20 張)。
- 單張估價 > 剩餘日預算 → chip `今日預算不足`,不送。
- bytes > 4MB 或 >16MP 縮圖後仍超 → 拒絕,chip 說明。

## 10. 低垂的果實(先做,零視覺成本)

1. inline `<svg>` 的 `<text>`:真文字節點,當 label 走文字管線
   (mermaid / d3 的大宗)。
2. `<img alt>` / `figcaption` / `aria-label`:hover chip 給 alt 譯文。

## 11. 檔案落點

| 檔案 | 動作 |
|---|---|
| `content/imagedetect.ts` | 新:合格圖偵測、同 src 追蹤、`mapBox()`(純函式) |
| `content/annotate.ts` | veil/pin 放置、字高門檻、fs 夾取 |
| `content/overlay.ts` | veil 層、pin、chip、放大檢視 |
| `worker/imagefetch.ts` | 新:bytes、縮圖、hash(OffscreenCanvas) |
| `worker/vision.ts` | 新:視覺請求、schema、`normalizeBlocks()` 移植 |
| `worker/scheduler.ts` | imageQueue(L0/L1 兩 lane) |

## 12. 不做的事

- `<canvas>` 畫的字、`background-image` / sprite(v1)、
  「有沒有字」預請求、P2 譯註趟(§5)。
- 直排**渲染**要做(`v` 旗標 + `writing-mode`),但 v1 若模型不回 `v`,
  先偵測寬高比異常標低信心,不靜默做錯(sukemu handoff §11 的態度)。

## 13. 實作前補量測(擴充 probe-vision.mjs)

1. 縮圖敏感度:長邊 1536 / 1024 / 768 對區域數與 box 準度。
2. **thinking 檔位 A/B**:sukemu 實測 P1 降 thinking 會框漂移(照片);
   我們的 probe 用 minimal 在渲染圖上沒事 —— 兩張圖 × default/minimal
   跑齊再定,不猜。
3. **照片型素材**:部落格裡的實拍圖(斜拍、光影)三張,確認 lite 在
   kasanemu 會遇到的照片上的表現,對照 §7.1。
4. 日文直排:`v` 旗標會不會回、box 方向對不對。
5. 詞表 prompt 在視覺請求上的遵循率。

## 14. 實作順序

1. SVG `<text>` + alt/figcaption(§10)
2. imagedetect + mapBox + normalizeBlocks + 測試
3. worker:imagefetch + vision + imageQueue(L0 lane)
4. content:hover-L0 → veil/pin 渲染 → 同 src 重錨定
5. L1 升級(Alt+click、估價、cross-fade 對位)
6. 放大檢視 + 成本閘門 + 狀態列
7. §13 量測 → 調參 → 手冊 README 收尾

## 15. 驗收

- clickhouse:hover 一張 chart,零成本出加註;點黑窗加註跟過去;
  Alt+click 後品質升級,快取第二次零成本。
- claude.com:行內大字 veil、小字 pin;放大檢視裡小字變 veil 可讀。
- 按住 O / 長按:整層掀開看原圖,三個入口都有效(sukemu 驗收原條)。
- 無字照片:0 塊,chip「沒有偵測到文字」,空結果進快取不重問。
- 預設設定下不 hover 就是 $0;整頁翻譯不觸發任何圖片請求;
  hover 掃過十張圖,gemma 配額不炸(佇列上限 + 取消生效)。
