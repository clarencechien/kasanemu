# 與 PRD 不一致的地方

五處。每一處都是實作時撞到的,不是偏好問題。

## 1. §4.2 襯線判定式子會誤判最常見的字型 stack

PRD:

```js
isSerif = /serif|georgia|times|garamond|charter|freight/i.test(ff)
          && !/sans-serif/i.test(ff.split(',')[0])
```

負向條件只看 stack 的第一項,所以 `system-ui, -apple-system, sans-serif`
會因為字串裡含有 `serif` 而被判成襯線體 —— 這是世界上最常見的 stack。

改成先把 `sans-serif` 從整個 stack 抽掉再測襯線關鍵字,第一項的守衛保留
(`sans-serif, Georgia` 仍算非襯線)。有測試蓋住(`tests/style.test.ts`)。

## 2. §3.2 語言判定加了假名例外

PRD:「CJK 字元佔可見字元 > 30% 視為已是中文,跳過。」

日文的漢字比例輕易超過 30%,照字面實作會讓所有日文頁面被判成「已是中文」
而完全不翻。改成:漢字比例 > 30% **且** 假名比例 < 5% 才視為已是目標語言。

## 3. §4.1 parent chain 走到根不算「取不到」

PRD:「取不到 → fallback 至標註樣式,不要猜。」

問題是絕大多數頁面的 `html` / `body` 的 `background-color` computed 值就是
`rgba(0, 0, 0, 0)` —— 畫面上的白色是瀏覽器畫的 canvas,不是任何元素的背景。
照字面實作會讓幾乎每一頁都落到標註樣式。

拆成兩種情形:

- **背景圖、漸層、`backdrop-filter`** → 真的取不到實色,走標註樣式(維持 PRD 意圖)
- **chain 走到根都是透明** → 那是 UA canvas,可知:依 root 的 `color-scheme`
  與 `prefers-color-scheme` 取白或 `#121212`

## 4. §4.2 字型體積目標做不到

PRD:「全字集超過 10 MB,必須 subset。基準:常用 6000 字 …… 目標單檔 < 300 KB。」

實測(`scripts/fetch-fonts.mjs`,Noto TC variable、woff2、5954 字):

| | 大小 |
|---|---|
| Sans TC · 5954 字 | 1609 KB |
| Serif TC · 5954 字 | 2210 KB |
| Sans TC · 3000 字 | 783 KB |
| Serif TC · 3000 字 | 1044 KB |

CJK 字形的壓縮後成本大約每字 250–350 bytes,300 KB 只夠約 1000 字。
Google Fonts 自己的 CJK woff2 會切成上百個 unicode-range 分片就是這個原因。

預設改成:**只打包 sans + Big5 第一階前 3000 字 = 783 KB**,仍在 §10.2 的
1.5 MB 預算內;襯線站台落到系統的 Songti / PMingLiU。
`--level=full` 與 `--serif` 可以加回去,體積換覆蓋率的取捨留給使用者。
細節見 `docs/fonts.md`。

## 5. §4.5 `line-height: normal` 沒有 px 值可繼承

PRD:「行高直接繼承來源元素的 computed `line-height`,不做任何調整。」

`normal` 是合法的 computed 值,取不到 px。拉丁字型的 `normal` 實際約 1.2,
但譯文是中文,1.2 會擠。這種情況(且只有這種情況)用 `font-size × 1.28`。
來源有明確 px 值時完全照抄,不拉伸不壓縮。

---

## 順帶記一下:PRD 沒講但實作必須決定的事

- **§3.1 巢狀規則的方向。** PRD 說「巢狀命中時只取最外層」。照字面做,
  `<div>` 包十個 `<p>` 會變成一個巨大單元。實作取的是「沒有 block 候選子孫的
  最內層 block」,這樣既解掉「一句話被 `<a>`/`<em>` 切碎」(整段一起翻),
  也不會把整篇文章併成一個單元。
- **§5.4 缺句不重送。** 「不要用縮小 chunk 再戰解決缺句」已寫進 scheduler:
  缺 id 直接標記失敗(虛線提示線),不會用更小的 batch 重試。
- **字級縮放與行高的關係。** 字級縮到 0.8 時行高仍維持來源的 px 值(§4.5 優先),
  所以縮小後的行距比例會變鬆一點,這是刻意的。

---

# 漸進式翻譯(feature.md)的偏離與實作決定

## A. 兩道閘門在這一版都還沒驗

feature.md 自己寫著:狀態「待啟動」,要 Phase 1 驗收通過 + 自用兩週之後才實作;
而 §3.1 更硬:**主要開發機若不支援 Translator API,本 feature 直接不實作。**

這一版在兩道閘門都還沒有答案的情況下寫出來,所以做了兩件保護:

1. **預設仍是 `single`。** `defaultPipeline` 的預設值是 Phase 1 的行為,
   漸進式要自己在 options 或 popup 打開。不打開的話,整條 L0 路徑不會執行。
2. **環境不支援就自動退回 `single` 並明確告知**(§6 最後一條),
   不是留下一條半死的路徑。`l0-only` 在不支援的機器上會直接說「無法翻譯」,
   而不是假裝在跑。

閘門的答案是 no(Chromebook 沒有 Chromebook Plus 認證)的話,
這個 feature 對那台機器等於不存在,不需要移除任何程式碼。

## B. 來源語言:規格沒講,但非做不可

Translator API 要求明確的 `sourceLanguage`,而 Phase 1 §3.2 只做
「這段是不是已經是中文」的判定,沒有語言偵測。實作取 `<html lang>` 正規化後的
主語言碼(`en-US` → `en`),取不到時用 options 的 `l0SourceLang`(預設 `en`)。

沒有用 LanguageDetector API:那是另一個要下載模型、另一個要驗證環境的 API,
為了一個大多數情況下 `<html lang>` 就答得出來的問題,不值得再開一道閘門。

## C. L0 快取只在頁面生命週期內

feature.md §4.6 要求「TranslateKit 譯文也快取,避免重複呼叫」,
並說快取 key 的 `modelId` 欄位加入 `l0`。

實作只做了頁面生命週期內的記憶體快取(`L0Engine` 內的 Map),沒有走
IndexedDB。理由:一次 L0 呼叫是毫秒級且零成本,而跨頁持久化要付
「content script → service worker → IndexedDB」的來回,成本比省下來的多。
導覽列、頁尾、重複標題這些真正會重複的字串在同一頁內就命中了。

代價:重新載入同一頁會重跑一次 L0(仍然是毫秒級)。
`l0-only` 模式因此沒有跨 session 的快取 —— 如果實際用起來覺得慢,
這是第一個該改的地方。

## D. 「L0 全部完成」的判定

feature.md §4.4 規則 1 說字級分組在「L0 全部完成時」定案並鎖定。
整頁的 L0 永遠不會完成 —— 捲動會一直帶來新區塊,無限捲動更是如此。

實作的判定是:**目前可見區內沒有還在跑 L0 的區塊**就鎖定。
新捲進來的區塊在下一輪 L0 收斂後鎖定自己的字級,已鎖定的不再動。
這樣 D19 的目的(單一段落的 L1 替換不得造成全頁字級跳動)成立,
而鎖定不會永遠不發生。

## E. 快取命中要多付一次 round trip

D23(快取命中跳過 L0)需要在跑 L0 **之前**就知道 L1 快取有沒有命中,
所以新增了一條 `cache-probe` 訊息:純讀,不碰保險絲、不碰 token bucket、
不排佇列。代價是 L0 之前多一次 service worker 來回(約 5–20ms),
換掉「重讀同一頁時先閃一次 L0」。§6 的驗收條件裡有這一條,值得。

## F. 待實測:popup 下載的語言包,content script 能不能直接用

§3.2 規則 2 要求語言包下載綁在 user gesture 上,所以下載按鈕在 popup。
實作假設**語言包是瀏覽器層級的資源**,popup 下載完之後 content script 的
`create()` 就不再需要手勢。

這個假設沒有被驗證(這裡沒有支援的機器)。如果假設錯了,行為是
content script 繼續回報 `needs-gesture`、popup 繼續顯示下載按鈕 ——
會很煩,但不會壞掉,也不會靜默失敗。真的錯的話,替代方案是把 L0 整段
搬進 service worker 或 offscreen document 執行。

---

# 真實網站回報的修正(2026-08-24,claude.com/blog)

第一次拿到真的網頁跑,三個問題:

## G. `<style>` 的 CSS 被當成文章翻譯

頁面頂端出現一行「在多個作者之間添加 comman `.blog_author_wrap > div:not(:last-child)`…」。

病根:`walk()` 不會遞迴進 `<style>`,但單元的 `src` 取的是 `el.textContent`,
而 `textContent` **會把被排除的子樹一起吃進來**。Webflow 在 body 內散佈 `<style>`,
於是 CSS 原始碼混進了段落。

修法:新增 `ownText()`,只收「真的會被讀到」的文字節點。
排除清單是 `NON_TEXT_TAGS`(script / style / noscript / template / svg / pre / 表單元件),
刻意**不含** `code` / `kbd` / `samp` —— 那些是行內的、給人讀的,
剝掉會讓「Call `compute()` before rendering.」變成「Call before rendering.」,
語意破碎比沒保護還糟。行內 code 仍然留在句子裡,由 L1 的 prompt 與
L0 的佔位符(§3.4)負責不讓它被翻掉。順手把 `[translate="no"]` / `.notranslate`
也接到同一條佔位符路徑上 —— 品牌名要留在原地,不是被剝掉。

## H. 整篇文章疊成一個巨大疊層

hover 之後整頁變成互相重疊的文字牆(使用者的圖 2)。

病根:`walk()` 的規則是「子孫有產生單元就不建自己的」,反過來說,
**子孫全部沒產生單元時,容器就自己變成一個單元**。
Webflow 的捲動動畫讓整篇文章的 `<p>` 初始 `opacity: 0`,每一段都被
「不可見 → 跳過」擋掉,於是父容器吃下了整篇文章 + 所有 CSS。

修法兩道:

1. `hasContainerChild()` —— 底下還有帶文字的結構性 block(p / div / section / li…)
   就**不建立**這個單元,即使那些子孫因為隱形、已是中文之類的理由沒有產生單元。
   容器永遠不是段落。
2. `MAX_UNIT_CHARS = 1000` —— 段落不會有一千字,超過一定是容器誤判。
   最後一道防線,擋掉所有還沒想到的結構。

代價:`opacity: 0` 的捲動動畫段落在動畫跑起來之前不會被翻譯。
下一次 `MutationObserver` / `ResizeObserver` 觸發重掃時會補上。
這比「整頁疊成一坨」好。

## I. 沒有明確的狀態,也沒有明確的「開始翻譯」

使用者的原話:「翻譯中還是沒翻譯沒有明確的 status,應該是啟用後再按翻譯之類的」。

疊層在「還沒送出」「送出了在等」「整條管線已經死了」三種情況下**長得一模一樣**,
這正是 feature.md §5.1 想防的那件事,只是 Phase 1 的單段模式沒有等價的指示。

修法:

- **頁內狀態列**(左下角,`pointer-events: none`,options 可關):
  `疊 · L0 12 · L1 3 · 等升級 9`,失敗時轉成警示色並顯示原因。
  worker 的 notice(API 400/401/429、id 紀律失敗)直接顯示在上面。
- **「翻譯這一頁」按鈕**(popup)與 `Alt+Shift+R`:手動觸發,
  同時是失敗區塊的重試入口。沒啟用的話會先啟用。
- **`autoTranslate` 開關**(預設開):關掉之後,啟用只會掃描並顯示
  「已啟用,N 塊待翻」,要按下去才送出。不想一啟用就花錢時用。
- **模型 ID 的驗證結果接到狀態列**:§5.2 說「不要等到執行時才 400」,
  但驗證結果本來只躺在 options 頁。現在啟用時就會講
  「free 檔的模型 ID 不存在:gemma-4-31b-it」。

## J. 還沒解決的:L0 的中文品質

同一頁的 `h1` 被 L0 翻成「人工教的教學方法 人工智慧」(原文
Anthropic's approach to teaching and learning AI)。

這不是 bug,是 feature.md 開放問題 1 的答案:**L0 的品質天花板就是
Google 翻譯離線版**,而「不要翻譯腔」是這個專案唯一在意的品質軸。
規格早就寫了「先看到一份不合格的譯文再被換掉,可能比多等 0.8 秒更煩」——
現在有了實例。要不要留 L0 當首屏層,等 L1 真的跑起來、能並排比較之後再決定
(debug 面板 Alt+Shift+D 的三欄就是為了這個)。

## K. 疊層蓋不住原文的墨水(緊排標題)

回報:標題疊層上方一排小點、下方一個孤零零的 `g` 尾巴露在外面。

病根不是「譯文太短」,是 **border-box ≠ 墨水範圍**。
`getBoundingClientRect()` 給的是 border-box,而字實際畫到哪裡由字型的
ascent / descent 決定。`line-height` 壓得比墨水高度小的時候(緊排大標的
標準做法,claude.com/blog 的 h1 就是 64px 字配 64px 行高),
第一行的頂端與最後一行的 descender 會落在 box 外面。
疊層精準貼合 border-box,那兩截就露出來。

修法:**出血(bleed)**。不是猜一個固定值往外加,而是用字型度量算:

```
溢出量 = max(0, 墨水高度 − line-height) / 2      // 上下各一半
墨水高度 = canvas measureText 的 fontBoundingBoxAscent + Descent
```

`line-height` 正常的段落算出來是 0,完全不會動到相鄰疊層;
只有真的緊排的標題才會撐開(那個 h1 撐 6px,剛好蓋掉 g 的尾巴)。

實作的關鍵是**盒子往外撐、padding 同量補回來**:

```
left  = rect.left − bleedX      padding-left = 原 padding-left + bleedX
width = rect.width + bleedX × 2
```

因為 `box-sizing: border-box`,這樣做**譯文的位置一格都沒動**
(§4.5 第一行基線仍然對齊原文),只有背景多蓋了一圈。
對齊靠 padding,遮蔽靠 border-box,兩件事分開。

另外 options 有一個固定出血(預設 2px),給量不到的東西:
`text-shadow`、斜體的尾巴、次像素捨入。表格儲存格左右不出血 ——
蓋掉相鄰資料比露出一點點更糟(PRD §14 開放問題 5)。

**沒有動的是譯文比原文短時底部的留白。** 那是 §4.5 / D09 明確決定接受的:
「早期版本嘗試譯文較短時拉大行距填滿空白,結果行距鬆到不自然,是退步。」
背景同色,視覺上只是段距略大,垂直節奏完全不動。

## L. 切換管線後「找不到可翻譯的區塊」

回報:切成 progressive 之後狀態列說找不到區塊,但 L0 其實是會動的。

病根:`unitByEl` 是 `WeakMap`,而 **WeakMap 沒有 `clear()`**。
切換管線會走 `stop()` → `start()`,`stop()` 清掉 `units` 這個 Set,
但 WeakMap 裡的元素→單元對應還在。於是重新掃描時,
`findCandidates(root, seen)` 的 `seen()` 對每個舊元素都回 true,
`walk()` 把它們當成「已建立過單元」,一個候選都不產生。

重新整理頁面就正常(全新的 WeakMap),再切一次又壞 —— 完全符合回報的樣子。

修法:`stop()` 時**重建**而不是清空(`unitByEl = new WeakMap()`)。
`probed`(WeakSet)同一個問題,一起重建。

順帶修掉一個自己製造的風險:一開始我在 `stop()` 裡把 `nextId` 重設回 1,
但 worker 佇列裡可能還有已送出的舊 id,那些結果回來會套到編號相同、
內容完全不同的新區塊上 —— 這正是 §6.4 要防的 id 對滑,只是由自己造成。
`nextId` 因此跨 stop/start 保持單調(§6.1 本來就說 id 要「單調遞增且穩定」)。

## M. echo 對不上的誤殺

回報:出現 echo mismatch,但譯文其實是對的。

§6.4 第二層防線比對原文前 8 個字元,原本只壓縮空白就比。
模型會做一些等價但不同碼位的改寫:彎引號 `’` → `'`、全形 → 半形、
大小寫、破折號種類、以及數到第 8 個字的方式不同(組合字、emoji)導致回短一截。

放寬成:NFKC 正規化 + 引號/破折號統一 + casefold,
再允許「互為前綴且至少 4 個字元」。

**沒有**放寬到失去偵測力:batch 內 id 對滑時,echo 來自完全不同的句子,
正規化後照樣對不上(測試裡有這一條)。誤殺的代價是把正確的譯文丟掉、
提示線轉警示色,比放寬這幾種等價寫法更糟。

PRD §6.4 說「對不上就丟棄該筆,不要嘗試修復」—— 這裡沒有修復任何東西,
只是把比對的等價類定義清楚。

## N. 診斷 log 匯出

回報:「是不是先出個 export log 可以馬上貼過來 debug」。對,這是對的。

這個擴充的失敗大多發生在看不到的地方:echo 對不上、模型 ID 不存在、
佇列卡住、掃描掃不到東西。而且 console 分散在頁面與 service worker 兩處,
service worker 被回收時記錄還會一起消失。

做法:`chrome.storage.session` 上的環狀緩衝(300 筆),
content / worker / popup 三邊都往裡面寫,popup 一鍵匯出成 Markdown ——
複製到剪貼簿**並且**下載成檔案。

安全規則(這是要拿去貼給別人的東西):

- **API key 只留長度與前後兩碼**,測試裡有一條專門驗完整 key 不會出現在報告裡
- 所有字串截斷到 60 字:log 不是原文備份
- 只記結構化事件(掃描結果、L0 狀態、佇列、API 錯誤、id 紀律統計),不記譯文

一個實作細節:`chrome.storage.session` 預設只開放 trusted contexts,
content script 讀不到也寫不了,所以 service worker 啟動時要呼叫
`setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`。
沒有這一行的話,log 會只剩下 worker 那一半 —— 而且是靜默地缺。

## O. 疊層整排錯位到頁面頂端

回報:卡片列表頁的譯文整排跑到頁面頂端,而且同一個原文出現兩份不同的譯文。

病根:**CSS transform 的入場動畫既不觸發 `ResizeObserver` 也不觸發
`MutationObserver`**。Webflow 的卡片用 `transform: translateY()` 入場,
`getBoundingClientRect()` 在動畫中途量到的是中途位置,動畫結束後
沒有任何一個既有的事件會叫我們重量,疊層就停在那裡。

§3.4 列的重新錨定事件裡沒有這一項 —— 規格假設幾何只在 resize、
DOM 變動、字型載入時改變,漏掉了「元素自己在動」。

修法兩條:

1. 監聽 `transitionend` / `animationend`(document 上 capture),
   debounce 120ms 後驗一次座標
2. 捲動停止後(既有的 300ms debounce)也驗一次

驗的方式是對**可見**單元比對 rect,差超過 1px 就重排。
不在捲動過程中做,§10.2 的「捲動時額外開銷 0」還是成立。

## P. 啟用時說「沒有可翻譯的區塊」,重新整理才會動

主因是 L 段那個 WeakMap 沒清的 bug。另外補一道:

掃到 0 個候選時,以 300 / 900 / 2000 / 4000ms 退避重掃四次,
狀態列在重試期間說「掃描中…」而不是「沒找到可翻譯的區塊」。
啟用的當下頁面可能還在載入,或入場動畫讓內容暫時是 `opacity: 0`
(那正是 H 段擋掉巨大容器的副作用)。

另外加了 `__ksnm.explain(el)`:把 §3.1 的十幾條規則重跑一遍,
回報**第一條**擋住這個元素的規則,包含被排除的祖先。
線上出問題時不必從 console 一條條試。

## Q. §4.3 的洞:停著讀的時候會被換掉

回報:「L0→L1 時會在 user 看的那個 block 直接被換掉」。

feature.md §4.3 的標題是「不得替換使用者當前正在互動的區塊」,
但字面規則只有兩條:hover 中,以及「在中央三分之一**且距上次捲動 < 400ms**」。

停著讀的時候沒有捲動,400ms 早就過了,所以正在讀的那一段**沒有任何保護** ——
規格把「互動」寫成了「剛捲過」,漏掉最常見的互動:停著讀。

收斂成:**視線帶(可見區中央三分之一)內一律不換**,
等它離開視線帶或使用者捲走再補做。捲動中(< 400ms)也一律不換。

代價寫在明處:一直不捲動的話那一段會停在 L0,花了錢的 L1 可能沒被看到。
狀態列因此多了「待換 N」,不然看起來會像 L1 沒回來。
而這個代價本來就在規格的視野裡 —— §2.2 要量的第三項指標
「L0 譯文讀完就沒再看 L1 的比例」講的就是這件事。

## R. 捲動時整片疊層平移到 header

§3.4 的「捲動**不**觸發重算」建立在一個假設上:疊層在 document 座標系,
頁面捲動時它跟著一起捲。這個假設在**用 transform 做平滑捲動的頁面上不成立** ——
Webflow / Lenis 那一類會在 body 底下的 wrapper 上套 `translate3d(0, -y, 0)`,
掛在 body 下的疊層 host 跟著那個 wrapper 走,而盒子的 left/top
是用上一次重排當下的原點算的,於是整片疊層平移到 header 上。

修法分兩層,都在 rAF 節流的 scroll handler 裡,每次只讀兩個 rect:

1. **原點同步**:比對 host 現在的原點與重排當下的原點,差了就在 layer 上
   套一個 `translate(dx, dy)` 補回去。**不重算任何盒子**,一次 transform 寫入。
2. **哨兵驗證**:抽一個可見單元比對它的 document 座標,差超過 2px 就重排 ——
   這抓的是內容自己在動(lazy load、sticky、SPA 插入)的情況。

§10.2 的「捲動時額外開銷 0」因此不再嚴格成立:每個 frame 兩次
`getBoundingClientRect()`(< 0.1ms)加上偶爾一次 transform 寫入。
規格寫那一條是為了避免逐塊重算,而這裡沒有逐塊重算 ——
錯位比這點開銷嚴重得多。

## S. 出血修不掉的那個 g:原文比自己的 border-box 還高

J 段的出血處理的是「墨水超出 line box」那幾 px。但回報裡的 `g`
離譯文底部遠超過那個距離,所以那是另一回事:
**原文的內容比它自己的 border-box 還大**。

元素設了固定 `height` 或 `max-height` 而 `overflow: visible` 時,
`getBoundingClientRect()` 給的 border-box 小於實際內容,照它蓋一定漏。
子元素有負 margin 也一樣。

修法:量測時取 `max(border-box, scrollHeight + border)`,寬度同理。
`scrollHeight` 是內容尺寸,涵蓋所有溢出的行。

兩層是互補的,不是重複:
- **scrollHeight** 補「內容比盒子高」(行數層級,可能是幾十 px)
- **出血** 補「墨水比 line box 高」(字型層級,通常 2–8 px)

另外加了 `__ksnm.outline()`:把疊層盒子的邊界畫成紅框,
角落標出 `寬×高 +出血` 與是否溢出。下次再遇到蓋不準,一眼就知道
是盒子算小了還是出血不夠。

## T. missing-id:每個段落各發一次請求

log 給的證據是 `got: 0` —— 模型回了空的,不是回錯 id。
而且整份 log 裡 `queue-l1 {units: 1}` 出現十幾次:
§5.4 給 free 檔的 6 塊/batch **從來沒湊滿過**。

病根是升級的觸發是零星的:停留滿 1.5 秒的區塊一個一個到期,
到期就送。於是每個段落各發一次 API 請求 —— 浪費 RPM,
而且單筆請求更容易讓小模型回出格式不對的東西。

兩個修法:

1. **聚合**:還沒湊滿 batch 上限且最舊的項目等不到 600ms 時先不送。
   代價是第一批 L1 晚 600ms —— 反正 L0 已經在畫面上了。
2. **格式容忍**:只送一筆時 gemma-4-31b-it 會回單一物件而不是
   只有一個元素的 array,也可能包成 `{results: [...]}`。
   兩種都收下並包成 array。

**格式容忍不等於放寬 id 紀律**:包裝過的單筆一樣要通過 echo 對位,
真的回空陣列時那一筆照樣算 missing 並標記失敗(測試有蓋)。

另外 `got: 0` 時會把原始回應的前 200 字記進診斷 log,
下次不必再靠猜。

## U. 卡片列表的譯文整排停在圖片上方 —— lazy-load

回報的截圖裡,四張卡片的標題譯文並排停在卡片圖片的**上方**,
y 座標一致,差距剛好是一張圖的高度;而卡片內的標題是正確的。
(旁證:上排的「Anthr」被下一個盒子的背景蓋掉 —— 那是四個獨立的盒子,
不是一個畫錯的。)

病根:**lazy-load 的圖片**。量測時圖片還沒載入、高度接近 0,
標題就在卡片頂端;圖片載入後把標題往下推 350px。

而這個位移**沒有任何一個現有的 observer 看得到**:

| 機制 | 為什麼漏掉 |
|---|---|
| `ResizeObserver` | 看的是單元自己的尺寸。標題只是被推走,尺寸沒變 |
| `MutationObserver`(childList / characterData) | 圖片載入不改 DOM 結構 |
| `auditPositions` | 只在捲動停止與 transitionend 跑;不捲動就永遠不驗 |

§3.4 列的重新錨定事件從頭到尾假設「幾何只在 resize、DOM 變動、
字型載入時改變」。實際上還有第四類:**同一份 DOM,內容自己長大**。

修法三條:

1. **`load` / `error` 事件**(capture 階段,load 不冒泡):
   `img` / `iframe` / `video` / `object` 載入完成或失敗都會改變佈局
2. **載入初期的週期性驗證**:前 12 秒每 600ms 驗一次座標。
   事件式偵測會漏掉沒有事件的位移(JS 直接改 style、web component 內部重排)
3. **驗誰的判定改掉**:原本只驗 `inView` 的來源元素,
   但錯位的症狀正是「來源元素跑掉了,疊層還留在視口裡」——
   改成用**疊層畫在哪**來決定要驗誰

第 3 條是前一輪 auditPositions 沒能修好這個問題的原因:
標題被推到視口外之後就不再被檢查,而留在視口裡的那個錯位疊層永遠沒人管。
