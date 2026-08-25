# 圖片翻譯規格 v0.1

> 狀態:計劃(含可行性實驗結果)。尚未實作。
> 前置:`docs/plan-annotation.md` §7 已把介面留好(`region` kind、正規化子矩形、
> `patch` 放置模式);這份文件把開放問題逐一關掉。
> 實驗:`scripts/probe-vision.mjs`(2026-08-25),
> 視覺驗證台:https://claude.ai/code/artifact/45f7c96a-f1ab-4eaf-8121-d88d402a66f0

## 0. 一句話

圖片翻譯不是一個功能,是**兩個**:字大的貼回原位(patch),
字小的跟著使用者進放大檢視(黑窗)再貼。分流的量尺只有一把 ——
**這個字在螢幕上有幾個像素高**。

## 1. 實地觀察:兩個範例頁(2026-08-25 probe)

### 1.1 clickhouse.com 的 benchmark 長文

- **44 張**可縮放的圖表。每張圖上蓋著一顆 `button.cursor-zoom-in`
  (絕對定位、透明),點下去出現:
  `span.fixed.inset-0.bg-black/80.backdrop-blur` + **一個新的 `<img>`,
  src 與原圖相同**,置中放大(行內 802px → 黑窗 1000px)。
- 這就是使用者說的「獨立的黑窗視窗」。關鍵事實:**黑窗裡的圖是另一個
  DOM 元素,但 `currentSrc` 相同**。
- 圖片走 `_next/image` 代理,同源;`alt` 是檔名(沒有用)。
- 圖型:深色底 bar chart,**8 段短文字、字大**(標題 ~28px、數字 ~24px)。

### 1.2 claude.com 的 blog 文章

- 內文圖原始 **2042×1546**,行內只顯示 **565px** —— 縮到 28%。
  圖的內容其實是**整頁 UI 截圖**:標題、tab 列、卡片、卡片裡的小字,
  幾十段文字、字級落差極大。
- **沒有 lightbox**。字太小,連英文讀者都得「在新分頁開啟圖片」。
- 跨域(webflow CDN)、`alt` 全空。

### 1.3 兩頁合起來給的結論

| | clickhouse chart | claude.com 截圖 |
|---|---|---|
| 文字段數 | 少(7-8) | 多(50+) |
| 顯示字高 | 大(≥18px) | 大小混雜,小至 3px |
| 放大途徑 | 站方 lightbox(同 src 新元素) | 沒有 —— 需要我們自己給 |
| 適合的呈現 | 原位 patch | 大字 patch + 小字進放大檢視 |

**同一套規格必須同時吃下這兩種。** 而「黑窗」不是要另外支援的邊角,
是小字圖的**主要閱讀面**。

## 2. 核心決定

### 2.1 翻譯還是加註?—— 按顯示字高分流,不是二選一

驗證台的 patch 模擬直接給出了答案(親眼看得到):

- chart 的 patch **全部原位可讀** —— 這種圖就該翻譯(蓋回去)。
- 截圖的大標題可讀,但卡片小字在行內尺寸下 patch 出來是**糊的**:
  中文在 11px 以下不可讀,而那些字在 565px 顯示寬度下只有 3-6px 高。

**規則:`patch 高度 × 0.72 ≥ 11px`(顯示座標)才畫原位 patch。**
低於門檻的區域不硬塞,改走放大檢視(§3.3)。門檻是常數
`MIN_PATCH_FONT_PX = 11`,放 `annotate.ts`,測試錨死。

「加註」在圖片上的意義由此確定:**不是在圖旁邊列清單**
(幾十條對不回原位,等於沒翻),而是「把譯文貼在字的原位,
在一個字夠大的檢視裡」。

### 2.2 黑窗:跟著 src 走,不跟著元素走

譯文快取以**圖片內容**為鍵(§6),不以元素為鍵。於是:

- 站方 lightbox(clickhouse):黑窗裡的 `<img>` 是新元素但同 src →
  快取直接命中,**patch 立刻畫在黑窗的圖上**,而且黑窗顯示得更大,
  行內過不了字高門檻的區域在這裡過了 → 自動翻得更全。
- 沒有 lightbox 的站(claude.com):我們自己給一個放大檢視(§3.3)。

偵測「新的同 src 圖」:content 已有 MutationObserver 追蹤版面,
加一條 —— 新增的 `<img>` 若 `currentSrc` 命中已翻譯集合,直接掛 patch。

### 2.3 絕不自動翻。一張圖一次明確動作

一張圖的成本是一段文字的 10-100 倍(§7),而且大多數圖(照片、插畫、
logo)**根本沒有字**。停留門檻那套自動升級對圖片全部不適用:

- 觸發 = **hover 圖片 500ms 出提示 chip(顯示估價)→ Alt+click 或點 chip**。
- chip 是 overlay 裡唯一 `pointer-events: auto` 的元素(§3.4 有理由)。
- 每網域可設「本站圖片自動翻」——只在使用者明確打開後,
  而且只翻**可視且 ≥ 400×200 顯示像素**的圖。預設一律關。

## 3. UI/UX 規格

### 3.1 觸發與提示

1. hover 圖片(顯示面積 ≥ 200×100)停 500ms → 圖片右上角出小 chip:
   `譯圖 ≈ $0.002`(free 檔位顯示 `譯圖 · 免費·較慢`)。
2. Alt+click 圖片、或點 chip → 送出。chip 轉為進度態(`辨識中…`),
   同一張圖不可重複送(in-flight 去重)。
3. 完成 → patch 淡入(200ms,`prefers-reduced-motion` 時直接出現)。
   失敗 → chip 轉紅短訊(`辨識失敗 · 再點一次重試`),重試上限 2,
   與現有 L1 重試語彙一致。

### 3.2 原位 patch

- 不透明,硬規則不變(PRD §2.2)。背景色 = **框外圍 3px 環帶像素的
  中位數**,前景色 = 依背景亮度選黑/白(驗證台已用同一演算法,
  深色 chart 與白底截圖都取對了)。
- 字級 = `min(框高 × 0.72, 40px)`,低於 11px 的區域不畫(§2.1)。
- 譯文比框寬 → 先縮字級至 85%,再不行就折行,patch 允許向下長高
  10%(圖片上蓋的是像素不是活文字,輕微超界無害)。
- hover patch → 該 patch 隱藏,看得到原文(和內文疊層同語彙:
  按住 Alt 全部隱藏)。
- 專有名詞不翻由 prompt 承擔(§8);`code` 樣式的字(等寬、深底)
  請模型標記 `kind:"code"`,一律不翻,原樣不畫 patch。

### 3.3 放大檢視(我們自己的黑窗)

沒有站方 lightbox 時,翻譯完成後 chip 變成兩個動作:`貼回原圖` / `放大檢視`。
放大檢視 = overlay 裡的全螢幕層:深色底、圖片 fit 置中、patch 按放大後
座標重畫(於是小字過門檻)。**互動全部走 document 層級的事件監聽**
(Esc 關、點圖外關、滾輪縮放),層本身維持 `pointer-events: none` ——
和現有架構一致,不必為它開洞。

站方有 lightbox 的(§2.2)不出這個入口,跟著站方走。

### 3.4 chip 是唯一的 pointer-events 例外

overlay 全域 `pointer-events: none` 是「絕不擋頁面」的兌現。chip 例外的
理由:Alt+click 是鍵盤+滑鼠的複合動作,只有它的話**觸控裝置與單手
操作完全無入口**。例外收得極窄:chip ≤ 90×28px、只在 hover 圖片時存在、
從不蓋在互動元素上(放置演算法避開 `a`/`button` 的 client rect)。

### 3.5 A11y 與狀態

- patch 帶 `role="img"` + `aria-label="譯文:…"`(overlay 在 closed shadow
  root 裡,讀屏可及性有限,但不主動變差)。
- 頁內狀態列沿用:圖片翻譯計數獨立一格(`圖 2/3`),診斷 log 記
  `image-translate` scope,匯出遮罩規則不變。
- 匯出疊好的 HTML:圖片 patch 一併輸出(絕對定位 div,同一套 CSS 兌現)。

## 4. 幾何

- 模型回傳 `box_2d: [ymin, xmin, ymax, xmax]`,0-1000 正規化,
  基準是**送出的點陣圖**。
- content 端換算:正規化 → 圖片 content box。必須處理
  `object-fit: cover/contain` 與 `object-position`(裁掉的部分要位移),
  純函式 `mapBox(box, naturalSize, contentRect, fit, position): ViewRect`,
  jsdom 測試 + probe 真瀏覽器各驗一次。
- `<picture>`/srcset:以 `currentSrc` 為準 —— 不同斷點可能是**不同裁切**,
  快取鍵含 bytes hash(§6)自然分開。
- `background-image` 第一版不做(§12)。

## 5. 管線

```
content                          worker
───────                          ──────
偵測 img + 觸發                   fetch bytes(≤ 4MB、http/https only、
  │  {url, naturalW/H}     ──▶     data: 直收、每 URL 只抓一次)
  │                                 │ OffscreenCanvas decode
  │                                 │ 長邊 > 1536 → 縮到 1536 再編碼(§13 驗)
  │                                 │ bytes SHA-256 → 快取查詢
  │                                 │ miss → 視覺呼叫(schema 強制)
  ◀──  {regions[], colors[]}        │ 每 region 取樣 bg/fg 色(§3.2 演算法)
patch 渲染 + 同 src 重錨定          └ 寫快取
```

- 視覺請求**不進**文字 batch 佇列(token 量級不同會把文字餓死),
  另開 `imageQueue`:同機制(mutateQueue、退避、預算),不同隊。
- 一張圖一個請求,不 batch(混批會讓 box 歸屬出錯,而且單圖延遲已可接受)。

## 6. 快取

鍵 = `img:{bytesHash}:{targetLang}:{modelId}`。

- **以 bytes 不以 URL**:同圖不同 CDN 參數命中同一份;srcset 不同裁切
  自然分開。
- 值 = `{regions: [{box, text, zh, kind}], colors, at}`。譯文快取的
  匯出匯入直接相容(同一個 store,條目自帶 `img:` 前綴)。
- 詞表 fingerprint **要**進鍵(§8 路徑 B 生效時),規則同文字:
  沒命中 → 鍵不變。命中與否看 OCR 後的 text,所以只能在**回應後**判定 ——
  實作為:先查無詞表鍵,命中的舊條目若含詞表詞才重打。v1 簡化:
  詞表變更後圖片快取直接視為 miss(圖片條目少,代價可接受)。

## 7. 可行性實驗(2026-08-25,`scripts/probe-vision.mjs`)

三檔現役模型 × 兩張真實圖,schema 強制 JSON、`thinkingLevel: minimal`:

| 模型 | chart(1580×530) | 截圖(2042×1546) |
|---|---|---|
| gemini-3.5-flash | 2.0s · 7 區 · in 1192 / out 327 | 4.7s · 29 區 · out 1033 |
| gemini-3.5-flash-lite | 2.8s · 7 區 · in 1192 / out 326 | **7.3s · 53 區** · out 2612 |
| gemma-4-31b-it | 9.2s · 7 區 · in 367 | **68s** · 35 區 |

發現(重要性排序):

1. **三個模型都會畫框**,而且準:chart 的 7 區三家一致,box 誤差
   目測 ≤ 2%(驗證台可切換親驗)。這是整個 patch 路線的地基,現在驗過了。
2. **flash-lite 找得最全**(53 區,連截圖裡插畫上的迷你表格欄位都撈到),
   又是三家裡最便宜的付費檔 —— **圖片翻譯的預設模型定為 flash-lite**,
   quality 檔也一樣(flash 反而漏小字,29 區)。這打破「檔位越高越好」
   的直覺,值得記錄。
3. **gemma 能用但慢**(免費檔的圖片輸入只計 ~256 token,真·零成本,
   但 68 秒的互動不可接受)——free 檔位保留此路,chip 標示「免費·較慢」,
   並把 in-flight 提示做明顯。
4. 兩行字的區域(`19 times\nsmaller`)模型會合併成一框 —— patch 折行
   邏輯(§3.2)必要。
5. 中文譯文品質三家都可用;專有名詞不翻的指示三家都遵守
   (Elasticsearch / ClickHouse / Claude.ai 全數原樣)。

單張成本(牌價):chart 級 flash-lite ≈ **$0.0012**,截圖級 ≈ **$0.007**;
flash 同圖 $0.005 / $0.011。chip 上的估價用
`(naturalW×naturalH 折算 tile 數) × 檔位單價` 預估,誤差標示 ≈。

## 8. 詞表:路徑 A 在圖片上不成立

文字管線的佔位符(路徑 A)前提是**我們能在送出前改寫來源** ——
圖片做不到,模型看到的是像素。所以:

- 圖片只有**路徑 B**(prompt 詞表):`promptTerms` 同一套,附在視覺
  請求的 system prompt。gemma 的遵循率已在文字側實測 100%,
  圖片側納入 §13 的補驗清單。
- 「只寫原文 = 不翻」在圖片上**天然成立一半**:模型不翻專有名詞的
  基線行為已經對(§7 發現 5),詞表把它變成保證。
- `manual.html` 詞表節要補一句:圖片翻譯裡詞表靠模型遵守,
  沒有佔位符那道硬保證。

## 9. 成本閘門

- 絕不自動(§2.3 是第一道也是最大的一道閘門)。
- `imageQueue` 共用每日預算與 token bucket;**每頁圖片預算獨立**
  (預設 20 張/頁,options 可調)。
- 送出前先過 `fuse`:單張估價 > 剩餘日預算 → chip 直接顯示
  `今日預算不足`,不送。
- bytes > 4MB 或解碼後 > 16MP:縮圖後仍超 → 拒絕,chip 說明。

## 10. 低垂的果實(排在真 OCR 前面,零/低視覺成本)

1. **inline `<svg>` 的 `<text>`**:真文字節點,現在被 `NON_TEXT_TAGS`
   一刀切。當 label 走既有文字管線,**零視覺模型成本**。
   (mermaid、d3 圖表全是這種 —— 技術文件站的大宗。)
2. **`<img alt>` / `aria-label` / `<figcaption>`**:有現成描述文字的圖,
   hover chip 直接給「alt 譯文」,比 OCR 便宜兩個數量級。
   兩者做完,「圖裡的字」剩下的才是真像素 —— 而且使用者已經有
   可用的東西在手上。

## 11. 資料模型與檔案落點

```ts
// shared/types.ts
export type UnitKind = 'block' | 'label' | 'region';   // 預留的第三種,現在啟用
export interface ImageRegion {
  box: [number, number, number, number]; // 0-1000 正規化
  text: string;
  zh: string;
  kind: 'text' | 'code';
  bg: string;  // worker 取樣
  fg: string;
}
// messages.ts 增量
//   content → worker: { type: 'translate-image', url, naturalW, naturalH }
//   worker → content: { type: 'image-result', url, hash, regions } | { type: 'image-error', url, reason }
```

| 檔案 | 動作 |
|---|---|
| `content/imagedetect.ts` | 新:合格圖偵測、同 src 追蹤、object-fit 換算(純函式) |
| `content/annotate.ts` | `place()` 加 `patch` 模式(§7.1 既有約定);字高門檻 |
| `content/overlay.ts` | patch 節點、chip(唯一 pointer-events 例外)、放大檢視層 |
| `worker/imagefetch.ts` | 新:bytes 抓取 + 縮圖 + hash + 色彩取樣(OffscreenCanvas) |
| `worker/vision.ts` | 新:視覺請求組裝(schema、詞表 prompt)、回應驗證 |
| `worker/scheduler.ts` | `imageQueue`(複用 queuelogic 純函式) |
| `scripts/probe-vision.mjs` | 已有:可行性;實作時擴成 §13 的量測 |

## 12. 不做的事

- `<canvas>` 上畫的字:無來源可取,明確排除(沿 §7.3 舊決定)。
- `background-image` / CSS sprite:取 URL 要解 computed style 的多層
  background,v1 不做,記在下一輪。
- 圖片內文字的 L0:Translator API 不吃圖,沒有這一層 —— 圖片翻譯
  一律直接 L1,這也是成本閘門必須更嚴的原因。
- 自動偵測「這張圖有沒有字」的預請求:多一次視覺呼叫省不了錢,不做。

## 13. 實作前要補的量測(擴充 probe-vision.mjs)

1. **縮圖敏感度**:2042px 原圖 vs 長邊 1536 / 1024 / 768 —— 區域數與
   box 準度掉多少、token 省多少。決定 §5 的縮圖上限(現值 1536 是猜的)。
2. **gemma 的 box 品質統計**:chart 級目測可以,截圖級要量
   (IoU 對 flash-lite 的框)。
3. **詞表 prompt 在視覺請求上的遵循率**(§8)。
4. **日文圖**:直排文字的 box 方向 —— 至少確認不會亂框。

## 14. 實作順序

1. SVG `<text>` + alt/figcaption(§10,先交付可用的東西)
2. `imagedetect` + 幾何純函式 + 測試
3. worker:imagefetch(bytes、縮圖、hash、取樣)+ vision + imageQueue
4. content:chip 觸發 → patch 渲染 → 同 src 重錨定(站方 lightbox 即通)
5. 放大檢視層(§3.3)
6. 成本閘門接線 + 狀態列 + 診斷
7. §13 量測 → 調參 → 手冊與 README 收尾

## 15. 驗收

- clickhouse benchmark 頁:任一 chart 一次動作後原位可讀;點開黑窗,
  patch 跟過去且更全;第二張同圖(如有)零成本命中。
- claude.com blog:行內只出大字 patch;放大檢視裡卡片小字可讀。
- 無字的照片:回 0 區,chip 顯示「沒有偵測到文字」,計一次已花費,
  快取記空結果不再重問。
- 日文技術 blog(qiita 任選截圖一篇):§13-4 通過後補驗。
- 成本:預設設定下,不點就是 $0;整頁翻譯**不**觸發任何圖片請求。
