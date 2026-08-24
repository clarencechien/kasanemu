# 疊 Kasanemu

把譯文以**不透明疊層**覆蓋在原文之上,完全不改動網頁 DOM 與 CSS 的 Chrome 擴充。
自己安裝、自己付 API 帳單。不上架、不做 onboarding、不服務任何非我的使用情境。

Phase 1 實作(對照 `kasanemuphase1prd.md` v1.0)+ 漸進式翻譯 feature(對照 `feature.md` v1.0)。

## 一分鐘上手

```bash
npm install
npm run fonts        # 需要 pip install fonttools brotli;略過的話譯文會用系統中文字型
npm run build        # → dist/
npm run package      # build + release/kasanemu-<version>.zip
```

`chrome://extensions` → 開開發人員模式 → 「載入未封裝項目」→ 選 `dist/`。
然後在擴充的設定頁填 Gemini API key,在任一頁面按 popup 的「啟用」或 `Alt+T`。

不想自己 build:GitHub Actions 每次 push 都會跑 typecheck + test + 字型 subset + build,
並把 `dist/`(未封裝)與 zip 當 artifact 掛在該次 run 上;打 `v*` tag 會另外開一個
release 並附上 zip。

| 操作 | 行為 |
|---|---|
| `Alt+T` | 本網域啟用 / 關閉 |
| `Alt+Shift+T` | 全開 ⇄ 點閱 |
| 按住 `Alt` | 所有疊層切成標註樣式,用來掃視哪些區塊被翻了 |
| 滑過區塊 | 全開時淡出露出原文;點閱時顯示譯文 |
| `Alt+Shift+R` | 翻譯這一頁 / 重試失敗的區塊 |
| `Alt+Shift+D` | debug 抽樣面板(需在設定頁開 debug) |

狀態、檔位都**以網域為單位**記憶:技術文件站可以留在點閱,長文站留在全開。

頁面左下角的狀態列會講現在在做什麼(`疊 · L0 12 · L1 3 · 等升級 9`),
失敗時轉成警示色並說原因。設定頁可以關掉自動翻譯,改成只有按
「翻譯這一頁」才送出。

## 先跑這個實驗

PRD 開放問題 3 說得對:free 檔的價值全押在 Gemma 走 Gemini API 的行為上,
而那件事半天就能驗完,不該等 DOM 那半寫完才發現。

```bash
GEMINI_API_KEY=... npm run probe:gemma
GEMINI_API_KEY=... node scripts/probe-gemma.mjs --model=gemini-3.5-flash-lite --runs=3
```

會逐一回報:`thinkingLevel: "minimal"` 是否被接受、thoughts 是否真的歸零、
systemInstruction 是否支援、schema 強制或只有 JSON mode、以及
**echo 對位的通過率**。最後一欄不是 0 就代表有 id 對滑,free 檔不能用。

## 這一版做了什麼

| PRD | 狀態 |
|---|---|
| §2 三狀態、hover、`pointer-events: none`、130ms 轉場、reduced-motion | 完成 |
| §3 block 級單元選取、排除清單、CJK 判定、document 座標、重新錨定、`WeakMap` 綁 id | 完成 |
| §3.5 float / 背景圖 / sticky-fixed 的降級與跳過 | 完成 |
| §4 背景繼承、Noto 指定、字重 +100、字級分組五級、行高不動、標註樣式、提示線 | 完成 |
| §5 三檔模型、模型 ID 驗證、thinking 全關 + 400 降級階梯、3.6 排除 | 完成 |
| §6 batch 協定、長度預算、echo 對位、三層防線、JSON 截斷修復、失敗可見 | 完成 |
| §7 可見區優先、token bucket、429 退避、SW 回收後可重建 | 完成 |
| §8 四層保險絲、花費可視(prompt / output / thoughts 分列)、壞掉時放行 | 完成 |
| §9 三段式快取(session / IndexedDB / off)、LRU、長度分桶 | 完成 |
| §10 canvas 離線量測、讀寫分離、體積回報 | 完成 |
| §11 MV3 + TypeScript、closed shadow DOM、無後端無遙測 | 完成 |
| §12 驗收 | 自動化只涵蓋選取與協定;幾何與視覺是人工目視,見 `docs/acceptance.md` |
| Phase 2 圖片翻譯 | 不做(進場條件是連續用兩週) |

漸進式翻譯(`feature.md`):

| feature.md | 狀態 |
|---|---|
| §2.1 三種管線 single / progressive / l0-only,以網域記憶 | 完成 |
| §2.2 A/B 判準:首屏時間、按管線分列的 token 與金額、離屏替換比例 | 完成(第四項「有沒有被干擾」只能自己記) |
| §3 L0 Translator API:六條硬性規則、下載進度、user gesture | 完成 |
| §3.4 行內 code 與不翻清單的私用區佔位符保護 | 完成 |
| §4.2 可見且停留 > 1.5 秒才升級、依距視窗中心排序、捲動時重排 | 完成 |
| §4.3 hover 中 / 剛捲動的區塊延後替換 | 完成 |
| §4.4 字級在 L0 收斂時鎖定、L1 不重算、maxChars 以鎖定字級計算 | 完成 |
| §4.5 80ms cross-fade、幾何不變、尊重 reduced-motion | 完成 |
| §4.6 快取命中跳過 L0 | 完成 |
| §5 提示線階層色、popup 階層統計與停滯警示、debug 三欄並列 | 完成 |
| §6 不支援 Translator API 時自動退回 single | 完成 |

**預設仍是 `single`。** 漸進式要自己在設定頁或 popup 打開 —— feature.md 自己說
這是 A/B,不是改版;而且 §3.1 的環境閘門(Chromebook Plus 認證)還沒驗。

跟規格有出入的地方都寫在 `docs/deviations.md`:PRD 五處、feature.md 六處,
每一處都有理由。其中一處是 PRD §4.2 的襯線判定式子會把
`system-ui, -apple-system, sans-serif` 判成襯線體(字串裡有 "serif"),已修;
另一處是 feature.md §4.4 的「L0 全部完成時鎖定」在無限捲動的頁面上永遠不會發生,
改成「目前可見區的 L0 收斂時鎖定」。

> PRD 的必讀前置 `docs/gemini-api-lessons.md` 不在這個 repo 裡。
> 模型、thinking、保險絲、batch 協定的實作依據是 PRD §5/§7/§8 的條文;
> 之後那份文件進來,以它為準再核對一次。

## 開發

```bash
npm run typecheck
npm test          # 63 個測試:選取規則、id 紀律、截斷修復、字重、快取 key、
                  #            佔位符保護、升級資格、替換時機、長度預算、提示線階層
npm run build     # 也會回報 dist 體積對 §10.2 的 1.5 MB 預算
npm run zip       # dist/ → release/kasanemu-<version>.zip(自己寫的 zip,無外部依賴)
npm run watch
npm run check     # typecheck + test + build
```

```
src/
  manifest.json
  shared/     types / models(三檔與牌價)/ settings / hash / log
  content/    detect  幾何  styleprobe  measure  bleed  fonts  overlay  index
              l0(Translator API)  mask(佔位符)  lang  upgrade(升級管線的純判斷)
  worker/     gemini  protocol  scheduler  tokenBucket  budget  cache  index
  options/    設定頁(金鑰、三檔、視覺、快取、保險絲)
  popup/      啟用開關、管線、檔位、L0 語言包、本頁階層統計、花費
scripts/      fetch-fonts.mjs(subset 打包)  probe-gemma.mjs(模型實驗)  zip.mjs
tests/        node:test + jsdom
docs/         fonts / acceptance / deviations
feature.md    漸進式翻譯的規格
.github/      build.yml(typecheck + test + 字型 + build + zip artifact)
```

資料流(`single`):content script 偵測單元 → 幾何算出 `maxChars` → 可見的送進
service worker → 先吃快取 → 過保險絲與 token bucket → 呼叫 Gemini → id 紀律三層檢查
→ 結果回 content → 字級分組後畫進 closed shadow DOM。捲動不重算,重排才重算。

資料流(`progressive`):可見單元先問一次 L1 快取(命中就直接畫 L1,不閃 L0)→
未命中的用 Translator API 在本機翻好、立刻畫出來 → 這一輪 L0 收斂後**鎖定字級** →
在可見區停留超過 1.5 秒的區塊才排進 L1 佇列(距視窗中心越近越優先)→
L1 回來時就地 cross-fade 替換,不動幾何、不重算字級;hover 中或剛捲動的區塊延後換。

## 兩件必須自己做的事

1. **在 Google Cloud 設專案層日配額。** 擴充管不到那一層,而那是唯一擋得住失控的硬牆
   (§8 第 1 層)。設定頁有連結。
2. **檢查花費。** popup 的 thoughts 欄位不是 0 就代表 thinking 沒關掉,那一項以輸出價計費。

## 已知的失敗情形(Phase 1 接受)

環繞浮動圖片的段落跳過;背景是圖片/漸層/`backdrop-filter` 的降級為標註樣式;
`sticky` / `fixed` 元素跳過;iframe、closed shadow DOM、canvas 文字不處理;
`justify`、首行縮排、drop cap、`column-count` 的譯文與周圍不一致。

L0 只在桌機版 Chrome 138+ 且語言包裝得起來時存在;不支援的環境會自動退回
`single`,popup 會說「已退回」。

字型 subset 的實測結論在 `docs/fonts.md`:PRD §4.2 的「單檔 < 300 KB」在 CJK
variable font 上做不到(6000 字實測 1.6–2.2 MB),預設改成只打包 sans + 3000 字
= 783 KB。
