# 疊 Kasanemu

把譯文以**不透明疊層**覆蓋在原文之上,完全不改動網頁 DOM 與 CSS 的 Chrome 擴充。
自己安裝、自己付 API 帳單。不上架、不做 onboarding、不服務任何非我的使用情境。

Phase 1(`kasanemuphase1prd.md` v1.0)+ 漸進式翻譯(`feature.md` v1.0)+
加翻層(`docs/plan-annotation.md`)。**0.1.0 文字階段收關。**

- 每一版做了什麼:[`CHANGELOG.md`](CHANGELOG.md)
- 走過的每一個坑與它的理由:[`docs/deviations.md`](docs/deviations.md)(111 節)
- 從那些坑裡歸納出來的通則:[`docs/lessons.md`](docs/lessons.md) ← **先讀這個**

## 一分鐘上手

```bash
npm install
npm run fonts        # 需要 pip install fonttools brotli;略過的話譯文會用系統中文字型
npm run package      # build + release/kasanemu-<version>.zip
```

`chrome://extensions` → 開開發人員模式 → 「載入未封裝項目」→ 選 `dist/`。
在設定頁填 Gemini API key,然後在任一頁面按 popup 的「啟用」或 `Alt+T`。

版本號會在 build 時蓋上 build number:`manifest.version` 是 `0.1.0.<commit 數>`,
`version_name` 是 `0.1.0 build 64 · 07a0fc6 · 2026-08-25`,popup 右上角與診斷 log
的第一行都看得到。每一包都叫 0.1.0 的話,回報問題時沒人知道手上那包含不含某個修正。

不想自己 build:GitHub Actions 每次 push 都會跑 typecheck + test + 字型 subset +
build,並把 `dist/` 與 zip 當 artifact 掛在該次 run 上;打 `v*` tag 會另外開 release。

## 操作

| 操作 | 行為 |
|---|---|
| `Alt+T` | 本網域啟用 / 關閉 |
| `Alt+Shift+T` | 全開 ⇄ 點閱 |
| `Alt+R` | 翻譯這一頁:重試失敗的、把停在 L0 的升上去(收折的內容也算) |
| **按住 `Alt`** | 整層暫時收起,放開就回來 —— 想看原文時最順手的動作 |
| `Alt+Shift+H` | 標註樣式掃視(所有疊層切成半透明,看得出哪些區塊被翻了) |
| 滑過區塊 | 全開時淡出露出原文;點閱時顯示譯文 |
| 滑過 / 選取沒被疊翻的東西 | 旁邊出現譯文貼片(加翻層) |
| 滑過紅色的區塊 | 自動重排一次(失敗的區塊的重試入口) |
| `Alt+Shift+D` | debug 抽樣面板(需在設定頁開 debug) |

狀態、檔位、管線都**以網域為單位**記憶:技術文件站可以留在點閱,長文站留在全開。

**預設不自動翻。** 啟用只是把擴充叫醒,真正開始送出要按 popup 的「翻譯這一頁」
或 `Alt+R` —— 不想一開頁面就花錢。想恢復「啟用就翻」在設定頁打開 autoTranslate。
SPA 換路由時這個「已授權」會歸零,不會跟著你逛完整站(§BB)。

預設管線是 **progressive**、預設檔位 **free**、捲動策略 **auto**、快取 **persistent**。

頁面左下角的狀態列會講現在在做什麼(`疊 · L0 12 · L1 3 · 待翻 9`),
完成時說「完成」再淡出,失敗時轉警示色並說原因。

## 兩件必須自己做的事

1. **在 Google Cloud 設專案層日配額。** 擴充管不到那一層,而那是唯一擋得住失控的
   硬牆(§8 第 1 層)。設定頁有連結。
2. **檢查花費。** popup 的 thoughts 欄位不是 0 就代表 thinking 沒關掉,那一項以輸出價計費。

## 出問題的時候

按 popup 的**「匯出診斷 log」**:掃描結果、L0 狀態、兩側的佇列深度、API 錯誤、
id 紀律統計、太長被擋掉的區塊、解析不了的顏色,組成一份 Markdown,
複製到剪貼簿並存檔,可以直接貼出來。API key 只留長度與前後兩碼,
所有字串截斷到 60 字 —— **那份東西是設計來給別人看的。**

log 讀法(踩過的坑見 `docs/lessons.md` §4):

- `queue-l1` 與 `[worker] enqueued` 應該成對出現。只有前者 = 訊息掉在中間。
- `L1 佇列:頁面認為 N 塊在排隊 · worker 佇列本頁 M` —— 兩個數字對不起來就是投遞掉了。
- `l1-stuck` = 看門狗把石沉大海的區塊撈回來;`l1-waiting` = 只是塞在隊伍後面。
- `太長被擋掉 N 塊` = 有個結構我沒想到,把那段 HTML 貼出來。

其他排錯入口:

```js
// content script 的 isolated world(devtools console)
__ksnm.explain(document.querySelector('h1'))  // 這個元素為什麼沒被翻
__ksnm.at(x, y)                               // 這個座標上是哪一塊、它的來源在哪
```

## 資料流

**`single`**:content script 偵測單元 → 幾何算出 `maxChars` → 可見的送進 service
worker → 先吃快取 → 過保險絲與 token bucket → 呼叫 Gemini → id 紀律三層檢查 →
結果回 content → 字級分組後畫進 closed shadow DOM。捲動不重算,重排才重算。

**`progressive`**(預設):可見單元先問一次 L1 快取(命中就直接畫 L1,不閃 L0)→
未命中的用 Chrome Translator API 在本機翻好、立刻畫出來 → 這一輪 L0 收斂後
**鎖定字級** → 在可見區停留超過 1.5 秒的區塊才排進 L1 佇列(距視窗中心越近越優先)
→ L1 回來時就地 cross-fade 替換,不動幾何、不重算字級;hover 中或剛捲動的區塊延後換。

排進 L1 佇列的區塊有**看門狗**:45 秒沒回音就先問 worker「還在不在你手上」——
在就是塞車、繼續等,不在就重排一次,再不行標成失敗(提示線轉紅、hover 可重試)。
**「卡住」不是一個有效狀態。**

## 三層防守:什麼會被翻、什麼不會

| 層 | 對象 | 畫法 |
|---|---|---|
| 內文疊翻 | 段落、標題、清單、表格儲存格、鬆散文字 | 不透明疊層蓋住原文 |
| 加翻層 | UI 標籤、選單、按鈕、導覽、頁尾 | hover / 選取時旁邊的貼片,**不覆蓋** |
| 不翻 | `code` / `pre`、`contenteditable`、`translate="no"`、`.notranslate`、分享 widget | — |

**詞表**(`docs/plan-glossary.md`):`原文 → 譯法` 固定譯法、只寫原文 = 不翻。
做法是送出前換成私用區佔位符、翻完再換成指定說法 —— **模型從頭到尾沒看到那個詞**,
所以每個檔位都有效,連沒有 prompt 的 L0 都有效。全域 + 具名詞表 + host pattern 綁定,
有自己的匯出匯入(快取那組不含詞表)。

沒有元素包著的鬆散文字、以及被行內圖片/公式切開的段落,用 `Range` 當錨點,
在媒體處切段;**段的聯集矩形只要蓋到圖就整段放棄 —— 不蓋圖是底線。**

## 覆蓋率怎麼量

不靠截圖猜。`scripts/sites.txt` 是 37 個台灣讀者常看的美日內容站與 CS 技術站
(文章頁,不是首頁 —— 偵測的難點在內文版型):

```bash
npm run audit:sites              # 全部
node scripts/audit-sites.mjs qiita zenn   # 只跑網址含關鍵字的
node scripts/audit-coverage.mjs <url>     # 單頁詳細
```

每站載入、捲一遍、把「看得見但沒人接手的文字」按 `explainCandidate()` 的原因彙總。
**這是回歸測試**:改完偵測規則跑一次,看哪一桶變大了。

> 沙箱環境註:這裡的 egress 會 reset Chromium 的 TLS 指紋(curl / openssl 都通,
> 只有 Chromium 被斷),所以稽核把每個請求攔下來由 Node 的 fetch 代抓再回填。

## 開發

```bash
npm run typecheck
npm test          # 217 個測試(node:test + jsdom)
npm run build     # 也會回報 dist 體積對 §10.2 的 1.5 MB 預算
npm run check     # typecheck + test + build + 三支 probe ← 提交前跑這個
npm run zip       # dist/ → release/kasanemu-<version>.zip(自己寫的 zip,無外部依賴)
npm run watch
```

jsdom 沒有 layout,所以**凡是牽涉幾何的規則都用真瀏覽器驗**(playwright,
沒裝就跳過不擋 `npm run check`):

```bash
npm run probe:detect     # 選取規則(scripts/fixtures/detect.html)
npm run probe:colors     # 背景與前景色解析(lab / oklch / 半透明疊色)
npm run probe:snapshot   # 匯出的 HTML 快照能不能疊、能不能看原文
GEMINI_API_KEY=... npm run probe:gemma       # 模型行為:thinking、schema、echo 對位
GEMINI_API_KEY=... node scripts/probe-glossary.mjs   # 詞表遵循率 + 速度品質對打
```

fixture 裡刻意裝著**會弄壞它的東西**(`docs/lessons.md` §2):`display:contents`
的版面包裝、逐字動畫的 `aria-hidden` 標題、標題裡的 24×24 錨點圖示、
文章自己的 `<header>`、`<script>` 標籤、折行後會蓋回圖的段落。
加規則時同時加正反兩例,然後**把修正暫時撤掉、確認 probe 真的會報錯**。

```
src/
  manifest.json
  shared/   types · models(三檔與牌價)· settings · hash · log · diag · report · messages
            glossary(詞表解析:純函式,content 與 worker 共用同一份判斷)
  content/  detect(選取規則)· cover/geometry/measure/bleed(幾何)· styleprobe(顏色)
            overlay(closed shadow DOM)· annotate(加翻層)· snapshot(匯出)
            l0(Translator API)· queue(L0 併發池)· mask(佔位符)· lang · motion
            upgrade(升級管線的純判斷)· unit · device · fonts · index(協調)
  worker/   gemini · protocol(batch 協定與 id 紀律)· scheduler(IO 與流程)
            queuelogic(切批/去重/退避的純函式)· tokenBucket · budget · cache · index
  options/  設定頁(金鑰、三檔、視覺、捲動策略、快取、保險絲、匯入匯出)
  popup/    啟用、管線、檔位、L0 語言包、本頁階層統計、花費、匯出 log / 頁面 / 快取
scripts/    audit-sites · audit-coverage · probe-{detect,colors,snapshot,gemma}
            fetch-fonts(subset 打包)· zip · sites.txt · fixtures/
tests/      217 個 node:test
docs/       lessons(通則)· deviations(逐件記錄)· acceptance(人工驗收)
            fonts(subset 實測)· plan-annotation(加翻層規格)
            plan-glossary(詞表規格 + 模型實測)· manual.html(使用說明)
feature.md  漸進式翻譯的規格
```

## 發版

推 tag 就會打包並掛上 GitHub Release(`.github/workflows/build.yml` 的 `release` job)。

```bash
git tag -a v0.1.0 -m "$(sed -n '/^## v0.1.0/,/^## v0\.0/p' CHANGELOG.md)"
git push origin v0.1.0
```

附註標籤的訊息會直接變成發行說明。CI 那一步是冪等的:release 不存在就建、
已存在就 `gh release upload --clobber`,所以**補檔案只要 Re-run all jobs**,
不用重打 tag。

> **不要在 CI 上傳的期間開著草稿的編輯表單。**
> Release 是整份取代不是 patch:那份表單送出時帶的是它打開當下的狀態,
> 會把 CI 剛掛上去的 zip 洗掉(v0.1.0 就這樣掉過一次,`docs/deviations.md` §DD)。
> 要用網頁建 release 的話,**先發佈、關掉分頁,再推 tag**。

## 這一版做了什麼

PRD Phase 1 §2–§11 全部完成,§12 驗收的自動化只涵蓋選取與協定,
幾何與視覺是人工目視(`docs/acceptance.md`)+ 三支 playwright probe。
`feature.md` §2–§6 全部完成。加翻層(`docs/plan-annotation.md`)完成。

0.1.0 期間額外長出來、規格裡沒有的東西:

| 東西 | 為什麼 |
|---|---|
| 加翻層(hover / 選取貼片) | 按鈕與選單不該被蓋掉,但使用者仍然想知道它寫什麼 |
| 診斷 log 匯出 | 失敗大多發生在看不到的地方,而 console 分散在兩個 context |
| `__ksnm.explain()` / `__ksnm.at()` | 「為什麼這塊沒翻」需要一個能問的對象 |
| 快取匯出 / 匯入 | 譯文不該綁在安裝上,換版本不必整頁重翻 |
| 詞表(全域 + 具名 + 網域綁定)| 技術站要保護的 `Go` / `Rust`,在新聞站上該照常翻 |
| 匯出疊好的 HTML | 因為沒改過 DOM,所以不能只是「另存新檔」 |
| L1 佇列看門狗 + 兩側對帳 | 「排進去了但沒有變 L1」查了三輪,決定讓那個狀態不存在 |
| 捲動策略 auto / always / strict | Gmail 要藏、長文不要閃,同一個開關兩種答案 |
| 37 站批次稽核 | 一次修一張截圖太慢,而同一頁常同時卡著五種原因 |

**Phase 2 圖片翻譯不做** —— 進場條件是文字階段連續用兩週。

## 已知的失敗情形(接受)

- 環繞浮動圖片的段落跳過;背景是圖片 / 漸層 / `backdrop-filter` 的降級為標註樣式。
- iframe、別人的 closed shadow DOM、canvas 文字不處理。
- `justify`、首行縮排、drop cap、`column-count` 的譯文與周圍不一致。
- 導覽列、頁尾、表單裡的文字不畫常駐疊層(hover / 選取翻得到)—— 這是設計。
- 收折的 `<details>` 裡的內容要展開才翻(按 `Alt+R` 會把它也翻掉)。
- L0 只在桌機版 Chrome 138+ 且語言包裝得起來時存在;不支援會自動退回 `single`,
  popup 會說「已退回」。
- 字型 subset:PRD §4.2 的「單檔 < 300 KB」在 CJK variable font 上做不到
  (6000 字實測 1.6–2.2 MB),預設只打包 sans + 3000 字 = 783 KB(`docs/fonts.md`)。

跟規格有出入的地方**全部**寫在 `docs/deviations.md`,每一處都有理由。

> PRD 的必讀前置 `docs/gemini-api-lessons.md` 不在這個 repo 裡。
> 模型、thinking、保險絲、batch 協定的實作依據是 PRD §5/§7/§8 的條文;
> 之後那份文件進來,以它為準再核對一次。
