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

## V. echo-mismatch 與 echo-swap 分開報

「1 個區塊未通過 id 紀律檢查 (echo-mismatch)」這則訊息把兩件嚴重性差很多的事
混在一起報,等於沒報:

| 實際發生的事 | 嚴重性 | 該怎麼辦 |
|---|---|---|
| 模型沒照抄 echo(自己翻了、或亂寫) | 低 —— 那一筆丟掉,停在 L0 | 不用管 |
| echo 對到**同批另一筆**的原文 | 高 —— 這是 batch 內 id 對滑 | 換檔位或縮小 batch |

第二種是 PRD §5.5 把 `gemini-3.6-flash` 整個系列排除的理由:
譯文被錯置到別的區塊上,JSON 合法、筆數正確、每筆都是通順的中文,
自動指標抓不到,只有 echo 對位抓得到。

所以 parse 時建一張反查表(正規化的 echo → 是誰的原文):
對不上時查一下那個 echo 是不是同批別人的,是的話報 `echo-swap`,
notice 升到 error 並直接說「換檔位,或把該檔的 batch 調小」。

**而且抓到對滑就整批丟棄**,不是只丟被抓到的那一筆 ——
既然證實這一批發生過錯置,其他筆的對位也失去可信度
(它們的 echo 可能剛好也被移到對得上的位置)。§6.4 說模型輸出視為敵意輸入。

一個誤判要避免:同批兩筆的原文**前 8 字剛好相同**時無法判別歸屬,
那個 key 就不拿來做對滑判定,退回普通的 mismatch。

原有的測試「echo 對不上就丟棄該筆」編碼的正是舊的、較弱的行為
(它的註解自己寫著「對滑:拿了 u1 的原文」,卻期待留下 u1)。
那條測試連同期待一起更新了,不是把新行為改回去遷就它。

另外 notice 現在會帶上第一筆的 `want`/`got`,不必匯出 log 才知道模型回了什麼。

## W. 我自己製造的無限重排迴圈

診斷 log 被這兩條洗版:

```
position-drift {"dh":7.55,"dw":0.10,"dx":0,"dy":0,"id":"u35"}
content-overflows-box {"count":62}
```

`dx` / `dy` 都是 0(位置根本沒動),但高度永遠差 7.5px。

原因是 S 段把 `unit.rect.height` 改成 `max(border-box, scrollHeight)`,
而 `auditPositions` 比對時用的是**原始的** `getBoundingClientRect().height` ——
於是那 62 個「內容比盒子高」的區塊每次都被判定成漂移,
觸發重排 → 再判定 → 再重排,每 600ms 空轉一次。

教訓很簡單:**量測與驗證必須共用同一個函式**。抽成 `coverRect()`,
`measureUnit`、`auditPositions`、捲動哨兵三處都用它。

另外 `content-overflows-box` 這條每次重排都記一筆,把真正有用的事件擠掉了。
改成只在數量變化時記。

## X. 整片平移補償量錯了對象

R 段做的補償量的是 **host 自己**有沒有移動。但回報的「滾上去還是破版」
顯示真正在動的是**內容相對於 host** —— 量錯了對象,所以補不到。

改成量兩個哨兵(頭尾各一個可見單元)實際位移多少:

| 兩者位移 | 意義 | 處置 |
|---|---|---|
| 一致 | 整片內容在動(transform 平滑捲動) | 平移整個 layer 補回去,不重算任何盒子 |
| 不一致 | 個別元素在動(lazy load、內容插入) | 重排 |

**兩個哨兵是必要的**:只看一個分不出這兩種情況,而它們的處置完全相反 ——
整片位移時去重排會慢半拍且抖動,個別位移時去平移會把其他正確的疊層全部弄歪。

同時把疊層 host 從 `body` 改掛 `documentElement`:body 常被頁面拿去做別的事
(smooth scroll 的 wrapper、開選單時 `position: fixed`、transform 動畫),
那些都會讓 host 自己跟著跑掉;html 幾乎不會被這樣對待。

## Y. 查錯位的工具:`__ksnm.at(x, y)`

滑鼠停在錯位的譯文上,F12 執行 `__ksnm.at(x, y)`(viewport 座標),回報:

- `painted`:疊層畫在哪(document 座標)
- `live`:來源元素**現在**在哪
- `visible`:來源元素有沒有繪製面積

兩者差很多 → 位置漂移沒被偵測到,是幾何問題;
兩者一致 → 疊層位置其實是對的,問題在**那個元素根本不該被翻**
(隱藏的重複 DOM、被 `overflow: hidden` 裁掉的內容)。

這兩類的修法完全不同,而從截圖上分不出來 —— 卡片列表上方那排錯位的譯文
到底屬於哪一類,還沒有資料可以判定。

## Z. 稽核永久化 + 內層捲動

兩個 build 12 仍修不掉的錯位,各對應一個偵測死角:

1. **卡片圖是 CSS `background-image` 的 lazy load。** `<img>` 載入有 `load`
   事件可聽,background-image **沒有任何 DOM 事件**;而座標稽核只跑載入後
   12 秒,晚於 12 秒才載入的背景圖照樣把標題推走,之後永遠沒人管。
   → 稽核改成**永久**每 900ms 一輪(分頁在背景時跳過)。成本:每輪對
   疊層附近的單元各讀一次 rect,layout 是 clean 的,< 1ms,抓到第一個
   漂移就收手重排。

2. **水平卡片輪播的內層捲動。** `scroll` 事件不冒泡,掛在 window 上的
   監聽只看得到頁面本身的捲動;輪播自己一捲,整排疊層就錯位。
   非冒泡事件仍會走 **capture 階段**,改掛 document + capture 就攔得到。

這一步等於承認:事件式的「幾何什麼時候變」偵測補不完 ——
§3.4 列得出來的事件(resize、mutation、字型)之外,永遠有下一個來源
(transform 動畫、`<img>`、背景圖、輪播、JS 改 style)。
週期性稽核是兜底,事件監聽只是讓修正更快。

## AA. 拿掉原點:host 改 `position: fixed`,盒子用 document 座標

build 13 的診斷 log 是決定性的一份:3.5 分鐘只有 4 筆 `position-drift`,
其中兩筆是真的元素位移(dy 452 / 502),其餘乾乾淨淨 ——
**而畫面明顯是歪的。**

也就是說座標稽核對真正的病因是瞎的。原因很直接:

- 稽核比的是「疊層記錄的 document 座標」對「元素現在的 document 座標」
- 但畫到螢幕上還要再減一個**原點**(`host.getBoundingClientRect() + scroll`)
- **原點從來沒有被任何機制驗證過**,而且只在重排時算一次

原點一錯,整片一起歪,而稽核照樣回報一切正常。R / X 段兩次補償都在猜
「是誰把 host 弄歪的」(body 的 transform?smooth-scroll wrapper?),
猜錯了兩次。

這次不猜了,**把原點整個拿掉**:

| 之前 | 現在 |
|---|---|
| host `position: absolute` 掛在 body / html | host **`position: fixed`**,錨在視窗 |
| 盒子 left = docX − originX | 盒子 left = **docX**(直接用 document 座標) |
| 捲動時猜原點有沒有跑掉 | layer 每個捲動 frame `translate(−scrollX, −scrollY)` |

document 座標 (X, Y) 於是永遠落在視窗的 (X − scrollX, Y − scrollY)。
**沒有原點可以過期,因為沒有原點了。** body 的 margin、position、transform、
smooth-scroll wrapper 一律影響不到 fixed 的 host。

代價:每個捲動 frame 一次 transform 寫入(§10.2 的「捲動零開銷」在 R 段
就已經放棄了,這裡沒有變得更貴 —— 反而少了兩次 rect 讀取)。
留下來的哨兵檢查只負責一件事:**內容自己在動**(sticky、lazy load、插入),
那個要重排,不是平移。

## AB. L0 晚到造成的 6 秒首屏

同一份 log:

```
08:27:32 l0-done {"asked":12,"failed":12,"state":"needs-gesture"}
08:28:00 l0-done {"asked":2, "failed":0, "state":"ready"}
首屏:6129ms
```

一開始的 12 個區塊全部 L0 失敗(語言包還沒下載),只能空等 L1 ——
L0 打底的意義完全沒發揮到。而 L0 後來就緒了,那 12 個卻沒人回頭補。

原本只有 popup 按下下載鈕才會觸發補翻(`l0-ready` 訊息)。
現在週期性 tick 也會檢查:L0 是 ready 而且還有 `l0-failed` 的區塊沒等到 L1,
就補翻一次。

## AC. 「跑到 header」從頭到尾不是幾何問題

build 14 的診斷 log 裡 **`position-drift` 是零筆** —— 疊層記錄的座標與元素
現在的座標完全吻合 —— 而畫面上譯文明明浮在頁首上。

因為那根本不是錯位:原文捲到 **fixed 頁首底下被蓋住**了,
而疊層的 z-index 是 2147483000,畫在頁首**上面**。位置一直都對,
只是沒有任何東西遮住它。

我前面三輪(R / X / AA)全部在修「座標算錯」,而座標從來沒錯過。
這是這整串除錯裡最貴的一次誤判:**症狀說「位置不對」,
但唯一的證據(drift = 0)一直在說位置是對的,我沒有聽。**

修法是讓疊層跟原文一起被遮:每個捲動 frame 用 `elementFromPoint`
量出視窗上下緣被 fixed / sticky 元素佔掉多少(兩次命中測試),
再對每個盒子套 `clip-path: inset(...)` 把被蓋住的那一段裁掉。
純算術,不讀 layout —— `u.rect` 是快取值。

疊層的 `pointer-events: none` 在這裡第二次派上用場:
`elementFromPoint` 打不到我們自己,回來的一定是頁面的東西。

## AD. build 14 我自己弄壞的兩件事

**HUD 消失。** build 14 在 layer 上加了 `transform: translate(-scrollX, -scrollY)`,
而 HUD 是 `position: fixed` 且掛在 layer 裡面 ——
**祖先一有 transform,`position: fixed` 就退化成相對那個祖先定位**,
於是 HUD 跟著捲動跑出畫面。HUD 與 debug 面板改成 shadow root 的直接子節點,
與 layer 平行:layer 是 document 座標,那兩個是視窗座標,不該混在一起。

**捲動抖動、原文從縫隙漏出來。** 同一個 transform:JS 在 scroll 事件的 rAF 裡
補捲動量,而瀏覽器自己的捲動跑在合成器上,**JS 永遠慢一幀**。
在一個以「不動版面」為唯一形式差異的專案裡,這種抖動比任何錯位都糟。

所以 AA 段的方向整個倒回去:host 回到 `position: absolute`,
疊層留在 document 座標系,**位置交還給瀏覽器,JS 完全不參與捲動**。
AA 段擔心的原點問題用另一個方式解掉:host 掛在 `documentElement` 下,
它的 absolute 定位基準就是初始包含塊,`left/top` 直接等於 document 座標,
沒有原點要算。

## AE. 診斷報告的表頭曾經整段是假的

build 14 的 log:

```
管線:progressive(實際生效 single)   ← 事件裡 start 明明是 progressive
區塊:總 0 · 首屏 -1ms · L0:idle      ← 事件裡 69 個單元、L0 ready、一直在翻
```

`chrome.tabs.sendMessage(tabId, …)` 會**廣播到分頁裡的每一個 frame**,誰先回誰算。
回答的是某個 iframe 裡的實例(`effective` 還停在模組初始值 `single`、
`units` 是空的)。加 `{ frameId: 0 }` 只問最上層。

這條的教訓比它的修法重要:**診斷工具自己說謊的時候,
它會把後面每一輪的判斷一起帶偏。** 那份 log 的表頭我看了兩輪才發現與事件矛盾。

## AF. 看不見的重複 DOM

卡片列上方那排、按鈕右上角那兩個,座標一直沒有漂移紀錄,
而且同一段原文出現兩份**不同**譯文(一份 L0、一份 L1)——
那是兩個單元:看得見的那個,和一份被 `overflow: hidden` 裁掉的重複
(輪播的另一份、隱藏的行動版選單)。頁面把它裁掉了,
但我們的疊層在最上層,不受任何裁切影響,於是浮在無關的位置上。

修法:`elementFromPoint` 打在來源元素自己的位置上,
打中的不是它、不是它的子孫、也不是它的祖先 → 那個元素其實看不見,
疊層藏起來(不是刪掉 —— 它可能又出現)。
每輪稽核最多測 80 個,只測視窗內的。

options 有開關:頁面若有透明的點擊攔截層可能誤判,那時關掉。

## AG. 提示線跑過頭

S 段為了蓋住溢出的墨水,把 `rect.height` 改成
`max(border-box, scrollHeight)`。提示線的高度也是用那個值算的,
於是**線比文字長一截**(回報:「捲動破版剩下線會跑過頭」)。

覆蓋高度與提示線高度是兩件事,不該共用同一個數字:
覆蓋要寧可多蓋,提示線要精準對齊文字。
量測時另外記 `lastRectBottom`(最後一個 client rect 的底部),提示線用它。

## AH. 遮蔽判定用錯方法,把正確的疊層藏掉了

build 15 用 `elementFromPoint` 判斷來源元素看不看得見。結果是
**卡片內的標題譯文消失,而錯位的那排還在** —— 完全反了。

原因:卡片設計常有一個絕對定位的 stretched link 蓋住整張卡
(`<a class="card-link">` 鋪滿整個卡片)。它既不是標題的祖先也不是子孫,
命中測試就判成「被蓋住」。

換成**幾何判定**:沿祖先鏈找 `overflow` 非 visible 的容器,
問「這個元素的矩形有沒有整個落在裁切框外面」。
不管誰蓋在上面,所以沒有 stretched link 的誤判;
而它正好精準對應真正要擋的東西 —— 被 `overflow: hidden` 裁掉的重複 DOM。

可捲動的容器照樣算:現在看不見就是看不見,
使用者把它捲進來之後下一輪稽核會再把疊層放出來。

## AI. 按鈕與 widget:別人的答案是「整個不翻」

回報的問題裡有一類一直修不好:`See pricing` / `Contact sales` 這種
連結型按鈕的譯文浮在按鈕旁邊。

去看了 Margin(`withmargin/margin-read`)怎麼處理。兩個發現:

1. **Margin 根本不做疊層** —— 譯文插在原文下方。所以按鈕位移對它無害:
   插入式頂多把版面撐開,不會有「浮在旁邊」這種錯位。
   這是 D02 那個取捨的代價在真實網站上的樣子。
2. **Margin 直接排除按鈕與 widget**:「避開導覽、表單、按鈕、
   程式碼區塊、隱藏文字與頁面 chrome」。

PRD §3.1 排除了 `<button>`,但沒排除 `<a class="button">` —— 而按鈕正好是
疊層最容易出事的地方(hover 位移、隱藏的行動版複本、輪播複製),
翻譯價值又最低(兩三個字)。

採用中間值,以**長度**分辨 UI 標籤與內容:

- 互動元素(`a[href]`、`button`、`role=button/link/tab/menuitem/...`)
  內的文字 ≤ 24 字 → 當成 UI 標籤,跳過
- 文字**全部**來自互動子孫的容器(按鈕列、連結列)→ 同樣跳過
- 連結裡的長文字照翻:卡片標題、文章裡的行內連結都是內容
- 段落裡夾一個短連結不受影響 —— 那時連結外面還有文字

比 Margin 寬鬆一點(保留長連結文字),但把最會出事的那一類拿掉了。

## AJ. L0 其實不快 —— 而且有一半是我擋的

回報:「L0 應該要很快,user 捲下來前就好了」「感覺太慢了」。對,而 log 證實了:

```
09:19:29.527  intake {fresh:9}
09:19:33.192  l0-done {asked:9}     ← 3.7 秒
09:20:00.661  intake {fresh:1}
09:20:03.014  l0-done {asked:1}     ← 單獨一塊 2.35 秒
首屏:4045ms
```

首屏那 4 秒幾乎全花在 L0,不是 L1。三個成因:

**1. service worker 的往返被擋在 L0 前面。**
為了 D23(快取命中跳過 L0),`intake()` 先 `await probeCache()` 才跑 L0 ——
那是一次跨 context 的訊息往返,SW 睡著時還要先喚醒。
**L0 存在的唯一理由就是快,而我在它前面放了一個網路等級的延遲。**
改成兩邊並行:快取先回來時,`runL0` 內部跳過已經有 L1 譯文的區塊,
D23 在 SW 熱的時候仍然成立。

**2. L0 的取材範圍被 L1 的成本規則綁住。**
§7.1 的 `rootMargin: 200px` 是**成本**規則 —— 控制 TPM 與帳單,那是 L1 的顧慮。
L0 在本機跑、零成本、不吃額度,卻一直跟著同一條規則,
於是每捲一段就要重等一次。

分開:L0 提前翻視窗外 1500px(捲到之前就翻好),
L1 仍嚴守「可見 + 停留 1.5 秒」(D21 是拿來省錢的,不能鬆)。
這正是回報說的「預翻」。

**3. 併發 4 → 8。** 單塊就要 0.7–2.3 秒,表示瓶頸是每次呼叫的等待而不是
本機 CPU;提高併發直接縮短整批的牆鐘時間。

另外在 `l0-done` 加了 `ms` 與 `perUnit` —— L0 的賣點就是快,
慢下來必須在 log 裡看得見。這一項之前完全沒有量,
所以「L0 很快」這個假設從頭到尾沒有被檢驗過。

## AK. 提示線的兩個問題

**線比譯文長。** §4.7 說提示線「涵蓋整個文字區塊」,實作照原文區塊的高度畫。
但英文通常比中文長,原文區塊往往高出一截 ——
線就從譯文末尾繼續往下拖一段,看起來像壞掉。
改成以**譯文**的估算高度為準(行數 × 行高),上限仍是原文最後一行的底部。

**線畫在固定頁首上。** AC 段的頁首裁切只套用在 `.box`,忘了 `.hint` ——
盒子被裁掉了,線照樣畫在 header 上。兩者現在共用同一個 clip。

## AL. 卡片上方那排:螢幕閱讀器專用標籤

回報直接給了 HTML:

```html
<a class="clickable_link w-inline-block" href="...">
  <span class="clickable_text u-sr-only">Build production agents with computer use…</span>
</a>
```

`u-sr-only` 是螢幕閱讀器專用標籤。經典寫法
`position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0)` ——
對視覺使用者完全不存在,而 §3.1 的檢查**全部漏掉它**:
不是 `display:none`、不是 `visibility:hidden`、`opacity` 是 1、
`getClientRects()` 還會回一個 1×1 的矩形,「有繪製面積」也過關;
文字長度 66 字,UI 標籤那條規則也擋不住。

**而那排寬得離譜的疊層是我自己算出來的。** S 段的 `coverRect` 為了蓋住溢出的墨水
取 `max(border-box, scrollWidth)`,而 sr-only 的 `white-space: nowrap` 讓
`scrollWidth` 等於整句話的寬度 —— 1×1 的元素於是長出一條橫跨整張卡的盒子,
貼在卡片左上角。四張卡就是那一排。

兩個修正:

1. **偵測 sr-only 並跳過**:看 computed style 的特徵而不是 class 名稱
   (`clip: rect(0,0,0,0)`、`clip-path: inset(50%/100%)`、
   或所有 client rect 都 ≤ 4px)。各家命名不同,行為一樣。
2. **`coverRect` 只在 `overflow: visible` 時吃 `scrollWidth/Height`。**
   元素自己有裁切時,溢出的內容根本沒被畫出來,
   拿它撐大盒子只會蓋到旁邊 —— 這是比 sr-only 更廣的一類錯誤。

前三輪我猜過「輪播複製」「隱藏的行動版選單」「被 overflow 裁掉的重複 DOM」,
全錯。一份真實的 HTML 片段勝過三輪推理。

## AM. 首屏從 4 秒變 13.9 秒 —— 預翻沒有配上逐塊上畫

AJ 段把 L0 的取材範圍從「可見區」改成「視窗外 1500px」,首屏反而更糟:

```
l0-done {asked:16, ms:13622, perUnit:851}
首屏:13970ms
```

`runL0` 是整批做完才 `scheduleFlush()` 一次。一批 16 塊、每塊 851ms、
併發 8 —— 13.6 秒內畫面上什麼都沒有。**取材範圍變大,批次就變大,
而「整批做完才畫」的成本跟著等比放大。**

兩個修正:

1. **逐塊上畫**:每塊 L0 譯文一好就 `scheduleFlush()`(自帶 120ms debounce,
   不會變成每塊一次重排)。
2. **先翻看得到的**:`fresh` 依距視窗中心排序再送。
   預翻範圍拉大之後,順序比以前重要得多。

## AN.「L0 是毫秒級」這個前提已經死了

feature.md §1 說 L0「毫秒級」,整個 feature 的定位建立在這句話上。
實測(Chromebook,CrOS x86_64):

| 批次 | 每塊 |
|---|---|
| 16 塊 | 851ms |
| 1 塊 | 2709ms / 2747ms / 3742ms |
| 12 塊 | 131ms |
| 8 塊 | 601ms |

**單塊 0.1–3.7 秒,不是毫秒級。** 而且批次越小每塊越慢,
看起來每次 `translate()` 都有固定的啟動成本。

這直接打到 feature.md 開放問題 1(「L0 的中文能不能忍」)旁邊那個沒寫出來的假設:
L0 值不值得當首屏層,取決於它到底多快。在這台機器上,
L0 的優勢從「毫秒 vs 秒」縮到「秒 vs 好幾秒」——
逐塊上畫與預翻能救回體感,但「使用者從不面對空窗」這個承諾在這裡不成立。

這一項現在有數字了(`l0-done` 的 `ms` / `perUnit`),
兩週 A/B 時應該把它列進判準 —— §2.2 原本只列了「首屏疊層出現時間」,
沒有分開量 L0 本身。

## AO. 跳過 sr-only 之後,疊層改成蓋掉整張圖

AL 段把 sr-only 的 `<span>` 跳過。下一版的回報是:**卡片的圖不見了,
變成譯文;hover 才把圖秀回來。**

我只是把問題往上搬了一層。那個 span 的父層是覆蓋整張卡片的 stretched link:

```html
<a class="clickable_link w-inline-block" href="...">   ← rect = 整張卡
  <span class="u-sr-only">Bringing the cybersecurity…</span>
</a>
```

`walk` 先遞迴子節點、再評估自己。span 被跳過之後子孫沒產生任何單元,
於是 `<a>` 自己被評估 —— 它的文字就是那句 sr-only(76 字,不算 UI 標籤),
rect 是整張卡。一個蓋住整張圖的譯文盒子。

**跳過一個元素不等於讓它的文字消失。** 修法是把 sr-only 登記進 walk 的
context,`ownText()` 計算祖先文字時扣掉它們。walk 是先子後父,
所以父層評估時集合已經填好。`<a>` 的可見文字於是是空的,不成為單元。

## AP. 儀表把排隊算成延遲,於是「L0 慢」的結論是錯的

AN 段用 `perUnit` 下了「L0 每塊 0.1–3.7 秒」的結論。下一份 log 更誇張:

```
l0-done {asked:1, ms:20662, perUnit:20662}
l0-done {asked:1, ms:21485, perUnit:21485}
...
l0-done {asked:4, ms:1781,  perUnit:445}
```

同一台機器、同一個 API,單塊從 20 秒到 445 毫秒。**那 20 秒不是 API,是排隊。**

`ms` 量的是 `runL0` 從開始到結束的牆鐘時間,而 AJ 段把預翻範圍拉到 1500px
之後,多輪 `intake` 同時擠在同一個 8 格併發池裡 ——
一個區塊要等前面十幾個翻完才輪到它,那段等待被算進了「它的延遲」。

**儀表把排隊算成延遲,就會得出「API 慢到不能用」這種錯誤結論。**
AN 段那張表要打折看:它混了兩件事。

改成分開量:

- `batchMs`:整批牆鐘時間(含排隊)
- `call.avgMs` / `call.maxMs`:`translate()` 本身的延遲
- `call.avgWaitMs`:平均被排隊吃掉多久
- `call.queued`:當下還有多少在等

順帶修掉排隊本身的問題:佇列改成**依優先度插隊**。
使用者捲到新的一屏時,那些區塊會插到預翻進去的遠處區塊前面 ——
預翻範圍拉大之後這件事變得必要,否則新看到的段落要排在幾十個
離螢幕很遠的區塊後面。

## AQ. L0 的併發要看機器 —— 而我上一次是量錯之後調錯方向

把排隊與呼叫分開量之後,數字很乾淨:

```
call: {avgMs: 6245,  avgWaitMs: 1227, maxMs: 16014}
call: {avgMs: 11936, avgWaitMs: 3682, maxMs: 25019}
```

**排隊只佔 1–5 秒,`translate()` 本身要 6–12 秒。**
所以 AJ 段「瓶頸是等待,不是 CPU,所以把併發從 4 提到 8」的推論是錯的:

| 併發 | translate() 本身 |
|---|---|
| 4 | 0.8–3.7 秒 |
| 8 | 6–12 秒(最高 25) |

**on-device 模型共用同一份計算資源**,八個一起跑只是讓每個都變慢。
吞吐量差不多,但**單塊延遲翻倍** —— 而使用者的體感是「我正在看的那塊
什麼時候好」,那是延遲不是吞吐。我優化錯了指標。

同一份程式在 Windows 桌機上可以一口氣翻完整頁,在低階 Chromebook 上
每塊要好幾秒。所以併發不能是常數:

- 起始值 = `clamp(hardwareConcurrency / 2, 2, 8)`
- 每 6 次呼叫檢討:平均 > 3 秒降一級(下限 2),< 0.6 秒升一級(上限 8)
- 降下來時,多出來的正在跑的請求跑完就好,不再補新的

這也讓優先度插隊真正生效:併發低 → 佔用的槽少 → 新看到的區塊更快輪到。

**「L0 是毫秒級」的正確版本**:在夠快的機器上是,在這台 Chromebook 上不是。
feature.md §1 的承諾要加上機器條件,而 §2.2 的 A/B 判準應該把
`call.avgMs` 列進去 —— 它決定 L0 到底是「首屏層」還是「額度用完的降級」。

## AR. gemma 偶爾回空陣列:重送一次

log 裡的紅字大多是這個:

```
batch-parsed {"failures":["u14 missing-id"], "got":0, "rawHead":"[]\n```"}
```

`rawHead` 顯示模型回了一個**包在 markdown 圍籬裡的空陣列**。
那不是缺句,是這一次沒產出;重送通常就有了。

所以整批 `got === 0` 且還沒重試過時,**同一批重送一次**。

這不違反 §5.4「不要用縮小 chunk 再戰解決缺句」——
那條講的是把 batch 切小去追缺句,病根在 id 紀律。
這裡不切小、不改協定,只是同一批再送一次,屬於 §7.3 的重試範疇。
上限一次,避免無人看管的重試迴圈(§8 的事故公式)。

另外 log 裡的 `duplicate-id` 是模型回了兩筆相同 id;
§6.4 第一層只取第一筆、丟掉多的,那一塊的提示線轉警示色。
兩者都是 id 紀律**正常運作**的樣子 —— 紅色代表「這塊我不敢給你」,
不是擴充壞了。

## AS. hover 到紅色的區塊 → 自動重排一次

原本失敗只有一條救援路徑:popup 的「翻譯這一頁」/ <kbd>Alt+Shift+R</kbd>,
它會把**整頁**的失敗區塊全部重來。

但使用者發現某塊翻不出來的時機幾乎一定是「把滑鼠移過去看原文」的那一刻。
那時候要他移開滑鼠、開 popup、按一個會重送整頁的按鈕,顯然不對。

所以 hover 本身變成重試入口:

- 停留 400ms 才算數 —— 滑鼠掃過一整片紅線不該送出一堆請求(L1 是要錢的)
- 每塊最多兩次 —— 真正壞掉的頁面重試也救不了,別把帳單燒在同一塊上
- 已經有 L0 譯文的(`l1-failed`)**直接重排 L1**,不再等 §4.2 的 1.5 秒停留門檻:
  使用者的滑鼠就停在上面,那個條件早就滿足了
- 連 L0 都沒有的(`failed` / `l0-failed`)退回 `pending`,走 `intake()` 的正常流程

判斷邏輯抽成 `upgrade.ts` 的 `hoverRetryReady()`,和其他純規則一樣有測試。

順帶把 HUD 完成訊息改成「失敗 N · 滑到紅線上重試」——
沒有人會自己猜到 hover 可以救。

## AT. 封測預設:progressive + free

feature.md §2.1 要 `single` 當對照組,理由是兩週 A/B。
實測下來 progressive 明顯好用(首屏 13970ms → 1474ms),
而封測的人不是來當對照組的,他們是來用的。

- `defaultPipeline: 'progressive'` —— L0 打底 + L1 升級
- `defaultTier: 'free'` —— 第一頁就產生帳單是最糟的封測體驗

對照組改成「需要時自己在 popup 切」。

## AU. docs/manual.html 跟著 dist 一起打包

封測要發 zip 給不看 README 的人,所以說明書是 HTML、放在 `dist/manual.html`,
解開就能點開讀;popup 與設定頁各有一個連結進去。
內容以「怎麼讀畫面」為主 —— 提示線四種樣子、HUD 四種訊息、
以及紅了要怎麼辦(hover 或 Alt+Shift+R),那是回報品質的關鍵。

## AV. 來源語言看字集,不看 `<html lang>`

問題:「目前只有英文嗎?日文韓文呢?」

盤點下來,三層各自的狀況不一樣:

| | 日文 | 韓文 |
|---|---|---|
| L1(Gemini / Gemma) | 本來就行 —— system prompt 從頭到尾沒提過英文,只說「翻成繁體中文」 | 同左 |
| 候選判定 | 假名比例 > 5% → 不是目標語言 → 翻(§3.2 早就處理了) | 諺文既不是漢字也不是假名 → 漢字比例 ≈ 0 → 翻 |
| L0(Translator API) | **壞的** | **壞的** |

L0 壞在 `pageSourceLang()` 只讀 `<html lang>`,讀不到就退回設定值 `en`。
而 Translator API 的 `sourceLanguage` 是**宣告**不是偵測:
拿 en→zh 的 translator 去翻日文,它不會報錯,只會安靜地吐回原文或亂碼。
樣板留下來的 `lang="en"` 在日韓網站上很常見,所以這不是邊角案例。

改成**字集優先**(`lang.ts` 的 `sniffScript` / `resolveSourceLang`):

- 諺文 > 10% → `ko`;假名 > 5% → `ja`;漢字 > 30% → `zh`
- 判得出來就**不採信** `<html lang>`
- 判不出來(整頁拉丁字母)時,宣告若是 ja / ko / zh 也一併不採信 ——
  那多半是整站語言設定,不是這一頁的內容;此時才用設定的預設值
- 取樣用 TreeWalker 跳過 `<script>` / `<style>`:一頁的 inline script
  動輒上萬個拉丁字元,用 `body.textContent` 會把日文頁面稀釋成「拉丁」

第二個洞是逐塊判定的盲點:**日文標題常常是純漢字**(「東京都知事選挙」)。
`looksLikeTargetLang()` 逐塊看是「漢字 100% → 已是中文 → 跳過」,
於是日文站的標題全部不翻。語言是整頁的性質,不是每一塊各自的性質,
所以 `detect.ts` 多了一個 `setPageScript()`,start() 時定案一次;
整頁是 ja / ko 時,漢字堆一律當作要翻。

L0 沒有該語言對的語言包時 `create()` 會丟 `NotSupportedError`,
整批 `l0-failed` → dwell 之後仍由 L1 接手,不會整頁空白。

## AW. 加翻層:UI 標籤不覆蓋,改成旁邊的貼片

完整設計在 `docs/plan-annotation.md`;這裡只記與既有決定衝突的部分。

**推翻了什麼。** §AH(`isUiLabel`)的結論是「24 字以內的互動元素文字一律不翻」。
那個結論到今天仍然對 —— 但只對了一半:**用疊翻去蓋 UI 標籤會壞**,
不代表**那些字不該被翻**。使用者最需要看懂的往往就是 `Rollback` 旁邊那顆按鈕。

所以 `isUiLabel()` 從排除條件升級成分類器,判定規則一字不改
(那個 24 字門檻是在真頁面上調出來的,不在同一次改動裡動兩件事),
命中的改走另一種畫法。

**為什麼不能蓋。** 兩個獨立的理由,任一個都足以否決:

1. 幾何 —— 譯文比原文短(`Contact sales` 13 字 → 「聯絡業務」4 字)。
   盒子畫成原文寬度就吃掉項目之間的間隔(導覽列的間隔就是留白),
   畫成譯文寬度原文就從右邊露出來。內文沒這個問題,因為內文右邊沒有東西。
2. §2.2 不透明是硬規則 —— 所以「淡淡的疊上去」**不能**用 alpha 實作。
   兩層字疊在一起是糊的,不是淡的。「淡」重新定義成視覺重量低:
   小字級、低彩度、貼著但不壓著、而且**只在被指名時出現**。

**穿透讓放置策略可以放鬆。** 疊層是 `pointer-events: none`,
所以貼片就算蓋到隔壁的按鈕,使用者照樣點得到那顆按鈕。
要避免的是視覺遮擋,不是功能遮擋 —— 這一條讓 `place()` 不必去算
「哪些鄰居不能碰」,只要顧視窗邊界與其他貼片就好。

**label 單元刻意不放進 `units`。** 那個集合被 flush、幾何、提示線、
遮擋檢查等十幾條路徑吃著,每條都要加一個 kind 判斷,漏一條就是 bug。
但**要放進 `unitById`** —— L1 的結果與快取靠 id 回來,那條路必須共用,
否則等於把 §6.4 的 id 三層防線再實作一次。

**貼片用 `position: fixed`,捲動時直接關掉。**
刻意不走疊翻那套 document 座標 + 捲動自我修正:貼片是暫態的,
不需要跟著捲;不跟著捲就沒有 build 14 那種「JS 慢合成器一幀 → 抖動」的問題。
節點本身是 shadow root 裡與 `.layer` 平行的兄弟,
理由和 HUD 一樣(fixed 在被 transform 的祖先裡會失效)。

**§4.3 在貼片上同樣成立。** 貼片開著時 L1 不換字,掛在 `pendingSwap`,
關掉才套用。貼片只有幾個字、讀完不到半秒,在使用者眼皮下換掉
就是那條規則講的事。

**成本由注意力決定。** 沒停留過的標籤一毛不花;停留 600ms 才送 L1,
而且送的是**整組**(最近的 nav / ul / [role=menu] …)——
一次 batch 12 個短字串比 12 次單筆便宜得多,而且滑到第二個時已經有了。
上限每頁 200 個標籤。

**掃描要增量。** `findLabels()` 對每個互動元素都要問 computed style,
而 `scan()` 在動態頁面上跑得很勤。所以 `seen` 判斷放在最前面,
先跳過已知的再做任何樣式查詢;跨掃描的文字去重另外用一個 Set
(單次呼叫內的去重擋不住「桌機版導覽列先掃到、行動版複本後來才出現」)。

**放置策略是純函式,而且是為圖片準備的。** `annotate.ts` 的 `place()`
吃的是「錨點矩形 + 正規化子矩形」,不是「元素」——
圖片裡的一塊字就是一個帶 `sub: [x, y, w, h]` 的錨點,
放置模式從 `chip`(旁邊)換成 `patch`(原位),其他完全相同。
視窗矮到幾何上無解時(標籤 + 間距 + 貼片高於視窗)兩邊都會蓋到標籤,
那時取蓋得比較少的一邊 —— 這是幾何限制,不是策略問題。

## AX. 去重要做在翻譯層,不是偵測層

回報:「もっと詳しく / 詳細を見る 這種的只會翻一個,但不會延用在其他的」,
以及日文站上「お問い合わせ」「周辺の宿」hover 沒反應。

兩件事是同一個 bug,而且是我上一輪自己加的。

§AW 為了擋掉「隱藏的行動版導覽列複本」,在 `findLabels()` 裡對重複文字去重:
同樣的文字只留第一個元素。實際頁面上那個假設立刻破掉:

- 卡片牆上十二張卡都寫「詳細を見る」—— 十二個都要能 hover,不是只有第一張
- 「お問い合わせ」在導覽列與段落標題各出現一次 —— 使用者指的往往是後者,
  而後者被跳過了,看起來就是「這一塊怎麼都不翻」

**位置錯了。** 去重的目的是省 API 呼叫,不是省單元。所以:

- 偵測層**不去重**:每個元素都有自己的單元,所以都能 hover、都能顯示貼片
- 送出層去重(`annotate.ts` 的 `dedupeByText`):同一段文字只送第一個
- 回來之後散給所有同文字的單元(`labelMemo` + `rememberLabel`)

L0 那一側本來就有以文字為 key 的快取,所以重複文字的 L0 成本一直是零。

## AY. hover 兜底:指到什麼就翻什麼

同一份回報裡還有「有些 mouse over 後也不會翻」。

掃描出來的 label 只涵蓋**互動元素**,但使用者的心智模型是
「我指到什麼就翻什麼」。落在縫裡的東西太多了:段落標題被十幾條選取規則
的某一條擋掉、容器判定不算段落、或那一塊根本不在互動元素裡。
與其一條條猜是哪一條規則擋的,不如讓 hover 本身變成兜底 ——

`adhocLabelAt()`:從事件目標往上找**自己就有文字**的最近祖先(最多 6 層),
沒有被內文區塊接手、不是容器、240 字以內、不是目標語言 → 當場建單元、當場翻。

上限 240 字是分界:再長就是段落,那是疊翻的守備範圍,
塞進貼片只會變成一面牆。

成本控制沿用同一套:hover 才建、L0 免費、停留 600ms 才送 L1、
同文字只送一次。看過但不合格的元素記進 WeakSet,
mouseover 在導覽列上會反覆打到同一批元素,不記就會一直重跑 `ownText`。

## AZ. 選取也算「指到」

使用者的原話:「如果是選起來的文字 也算 mouse over 然後加翻」。

這是兜底的兜底:hover 找的是**元素**,而使用者想知道的可能是一句話的一半、
或跨越好幾個元素的一段。選取是最明確的「我要這一段」的表達。

所以選取的貼片:

- **不等 180ms**,選完就出(明確動作不需要停留門檻)
- **不受「只在 Alt 時顯示」限制**(同上)
- 錨點跟著 `Range` 走,不是元素 —— 因此 `Unit` 之外多了一個
  `anchorOverride` WeakMap,而不是在 `Unit` 上開一個只有選取會用的欄位
- hover 到別處**不會**關掉它;要點一下取消選取才消失(選取本身是持續的意圖)

`selectionchange` 在拖曳過程中會連續觸發,所以 250ms debounce,等手放開再說。

全部只在**本網域已啟用**時成立:所有監聽器都在 `start()` 掛、`stop()` 拆,
沒啟用的頁面和一般網頁完全一樣。

## BA. 「跑完了」的判準錯了,所以狀態列永遠不會說完成

回報:「如果真的跑完了 HUD 應該寫完成然後消失之類的」。

兩個獨立的 bug,缺一個都不會出現這個症狀。

**其一:busy 的判準是「整頁還有 pending 的區塊」。**
但 progressive 只預翻視窗上下各 1500px —— 長文章底下永遠有一堆還沒輪到的區塊,
於是 `pending > 0` 恆真,狀態列永遠停在「待翻 N」。

**沒捲到的區塊不是「在等」,是「還沒要」。** 判準改成三態
(`upgrade.ts` 的 `translationPhase`,有測試):

- `busy` —— 有 L1 請求在飛、畫面上還有沒翻好的、或 L0 還有呼叫在跑
- `screen-done` —— 這一屏好了,頁面下面還有沒輪到的
- `all-done` —— 整頁都處理完了

「已經開口要了」的區塊即使在畫面外也算在跑(`probed`),
否則送出與回來之間會閃一次「完成」。L0 那一側新增 `busy()` ——
L0 不經過 `l1Queued`,只看計數看不出它還在跑。

`screen-done` 顯示「這一屏完成,捲動繼續翻」而不是「完成」:
下面還有沒翻的時候說完成是騙人的,而使用者需要知道那是
「捲下去會繼續」而不是「漏掉了」。

**其二:`setHud()` 每次呼叫都重設淡出計時器。**
`updateHud()` 被每一次 flush、每一批結果、每一次 hover 呼叫 ——
於是就算真的顯示了「完成」,它也**永遠不會淡出**,因為一直被同樣的字
重新點亮。加上「內容沒變就什麼都不做」的判斷之後,3.2 秒淡出才真的會發生。

這一條的教訓和 §Y(儀表把排隊算成延遲)是同一種:
**狀態顯示的 bug 會被誤讀成功能的 bug**。使用者看到「待翻 40」不會想到
那是判準寫錯,只會覺得翻譯卡住了。

## BB. 預設不自動翻,而且「翻這一頁」不會跟著換頁走

回報:「在啟用的情況下,在同一頁點超連結跳轉後會開始自動翻譯新的內容。
如果要加個開關,預設是不要自動翻譯,要 user 按了才翻譯 ——
除非他開了自動翻譯。目前大多數的競品都是自動翻,但我沒有要每頁都翻,
也不是這樣燒 token 的。」

兩件事。

**其一:`autoTranslate` 預設從 `true` 改成 `false`。**
這推翻 Phase 1 PRD 的預設,理由是使用者的成本模型和競品不一樣:
競品用自己的額度換使用率,這個專案是自己付帳單的自用工具。

意圖因此分成四層,每一層都要自己表達:

| 動作 | 意思 |
|---|---|
| 啟用(Alt+T) | 這個網域我要用 Kasanemu |
| 翻譯這一頁(Alt+Shift+R) | 現在翻整頁 |
| 滑過去 / 選起來 | 我要知道**這一小塊** |
| 每一頁都自動翻(預設關) | 競品那種行為 |

**滑過去與選取的加翻不受這個開關影響。** 指到什麼就翻什麼本身就是明確的
動作,而且一次只有一小塊 —— 把它一起關掉等於把「不燒 token」誤解成
「什麼都不能問」。

**其二:SPA 換頁時 `manualArmed` 沒有重置。**
整頁重新載入沒有這個問題(content script 是新的),但 SPA 換路由時
content script 不重載,於是上一頁按下的 `manualArmed` 一路帶到新頁面。
**使用者按的是「翻這一頁」,不是「從今以後每一頁」。**

換頁偵測改用 `location.href` 而不是 page key:page key 只到 pathname
(那是給 §8 成本計數用的,粒度刻意粗),但 `?page=2` 的分頁與 hash 路由
都是新內容。同時補上 `popstate` / `hashchange` 監聽 ——
上一頁 / 下一頁不一定改動 DOM,MutationObserver 打不到。

換頁時一併清掉:上一頁的貼片、label 單元與譯文 memo、`lastProblem`、
首屏計時。那些都是「這一頁」的狀態。

## BC. 收折的 `<details>` 會爆版,分享按鈕不該被翻

同一份回報的兩件事,成因完全不同。

### 收折的 `<details>`

`<details>` 展開 / 收折**只是屬性變動**,而 MutationObserver 只看
`childList` 與 `characterData` —— 完全打不到。於是使用者收折一個問答,
底下所有內容整片上移,疊層留在舊座標,答案的譯文疊到別人的標題上。
「原本收折的沒展開就會爆掉」就是這個。

兩層修法:

1. `toggle` 事件(capture — 它不冒泡)→ `relayout()` + 重掃。
   不只是 flush:收合元件展開時可能有內容**第一次**被算進版面,
   那些要重新掃描才會變成單元。
2. **來源元素沒有繪製面積就不畫**,寫在 flush 的寫入階段。
   這一條不受 `occlusionCheck` 開關控制、也不受可見區與 80 筆上限限制 ——
   那個檢查是啟發式的「有沒有被祖先裁掉」,這一條是
   「原文根本不存在於版面上」。收折的問答、隱藏的分頁都靠它兜底。

### 分享按鈕

`isUiLabel()` 用 `textContent` 量長度,但無障礙寫法會把長標籤藏起來:

```html
<a><span hidden>Share on Facebook (Opens in new window)</span><span>Facebook</span></a>
```

`textContent` 是 47 字 → 超過 24 → **不算 UI 標籤** → 變成內文單元 →
疊層把「分享至 Facebo…」蓋在分享列上。而畫面上其實只有「Facebook」8 個字。

**長度要量看得見的文字。** `isUiLabel()` 改吃 `walk()` 沿路收集的 srOnly 集合;
同時 `walk()` 遇到 `isInvisible` 的元素now也登記進那個集合 ——
先前只是 `return false`,於是 `display:none` 的文字仍然算進祖先的長度。
(sr-only 早就這樣處理了,`display:none` 漏了,理由一模一樣。)

改完之後整條分享列自動變成 UI 標籤(`isUiLabel` 的第二個分支:
文字全部來自互動子孫),不再有疊層。

另外加了兩件事:

- 排除清單多收 `.robots-nocontent`(搜尋引擎的「這不是內容」標準訊號,
  回報的 DOM 裡就有)與幾個公認的分享外掛前綴。刻意**不用**
  `[class*="share"]` 那種寬鬆比對 —— 會誤傷 `.shared-post`。
- **排除清單先前只有內文單元遵守**,加翻層與臨時加翻完全沒看它 ——
  於是 `.notranslate` / `translate="no"` 裡的連結照樣 hover 得到譯文。
  三條路徑現在都檢查 `closest(EXCLUDE_SELECTOR)`。

## BD. Gmail:內層捲動追不上,以及應用程式外殼被當成內文

### 疊層在滑

視窗捲動時瀏覽器自己搬疊層(document 座標),**零延遲**。
但 Gmail 是在 `<div>` 裡面捲的:document 根本沒動,疊層留在原地,
原文從底下滑走 —— 只能由 JS 追,而 **JS 永遠慢合成器一幀**。
這和 build 14 的抖動是同一件事,只是反過來。

追不上就別追:**捲的當下先藏起來,停下來重新量好再出現**。
錯位的疊層比暫時看原文更糟 —— 這和「貼片捲動時直接關掉」是同一個判斷。

三個細節:

- 只藏**這個容器裡的**單元,不是整層:輪播捲一下不該讓整頁疊層閃一次
- 每一輪捲動只標記一次(`innerSettleTimer === 0` 才做)——
  scroll 事件一秒幾十次,不然 O(單元數) 的迴圈會跑上百次
- 停下來之後**直接進 flush**,不走 `scheduleFlush()` 的 120ms debounce ——
  那 120ms 會被使用者看成「疊層慢半拍」
- 用獨立的 `.stale` class,不跟 `.covered` 打架:那個是遮擋判定,這個是暫時失效

### 「Mail / Chat / Meet / Labels」被翻

兩個獨立的成因,各補一條規則。

**其一:`EXCLUDE_TAGS` 只認標籤,不認 role。**
NAV / HEADER / FOOTER / ASIDE 早就排除了,但 Gmail 這種單頁應用不用那些標籤,
它用 `<div role="navigation">`。新增 `CHROME_SELECTOR`,收 ARIA 地標與
工具列角色(navigation / banner / contentinfo / complementary /
toolbar / menubar / menu / tablist / search / tooltip)。

**和 `EXCLUDE_SELECTOR` 的差別很重要:這一層只擋疊翻,不擋加翻。**
選單項目本來就是使用者可能想知道的東西(§AY 的原話:
「有些是 menu 或是 link 可能想知道」),所以滑上去、選起來仍然翻得到。
**不該被蓋掉的是版面,不是資訊。**

**其二:`<div role="heading">Mail</div>`。**
真正的文章用 `<h1>`–`<h6>`;把 role 掛在 div / span 上幾乎只出現在自繪的 UI。
所以「非 heading 標籤 + `role="heading"` + 24 字以內」視為 UI 標籤。
這一條不依賴祖先是不是地標,所以就算 Gmail 沒有把左欄包在
`role="navigation"` 裡也擋得住。誤判的代價只是「要滑上去才看得到譯文」,
不是看不到。

## BE. 不變式:不顯示已知錯位的疊層

build 28 之後回報「Gmail layer 滑動還是有」而且「也會破版」,附圖顯示
不透明的盒子畫在空白處與別人的內容上。

build 28 只處理了「捲動中」這一種情況,而且**賭 scroll 事件收得到**。
應用程式外殼不一定會給你那個事件:自訂捲動、虛擬清單、shadow DOM。
賭錯的代價是疊層停在錯的座標上不動 —— 那正是附圖的樣子。

所以改成一條**不變式**:

> 只要座標已知是錯的,疊層就不顯示。

三個地方兌現它:

1. `scrollSync()`(每個捲動 frame 的哨兵探測)
2. `auditPositions()`(定時稽核)
3. 內層容器捲動的 60ms 沉澱

位移分兩級,這一條是為了不製造新問題:

- **> 2px** —— 只是沒對齊,直接重排(`flushNow()`,繞過 120ms debounce)
- **> 12px** —— 已經蓋在別人的內容上,**先全部藏起來**再重排

分級是必要的:parallax / sticky 頁面會有長期的小幅漂移,
一律藏起來會變成整頁閃爍 —— 那是用一個 bug 換另一個。

另外兩件事:

**應用程式外殼開一輪快檢。** `documentElement.scrollHeight <= clientHeight`
就是「document 本身不捲」,那種頁面的捲動全在內層容器裡。
與其賭事件收得到,不如直接量:每 250ms 驗一次座標(只驗座標,
不做遮擋檢查 —— 那個貴,而且不會因為捲動改變結論)。

**原點檢查。** host 是 `documentElement` 的絕對定位子元素,正常情況下
(0,0) 就是文件原點。但應用程式外殼可能把 `<html>` / `<body>` 變成定位或
transform 的容器,那時整層會平移一段**固定**距離 ——
每一塊都錯同樣的量,看起來就像「疊層整片跑掉」。

§R / §X / §AA 三輪都在找這個東西,當時的做法是「把原點拿掉再說」,
然後又整個 revert。這次把它變成一個明確的、會寫進 log 的檢查
(`origin-offset`),並且用 `.layer` 的 transform 修正。

**這不是 build 14 的做法。** 那個是每個捲動 frame 用 JS 追 `scrollY`,
追不上就抖。這裡修的是**靜態**誤差:只在版面變動時重算一次,
不隨捲動改變,所以不會抖。

## BF. 一個 bug,兩個症狀:沒被畫出來的元素被撐成貼在視窗左上角的盒子

回報:「收折也還是壞的」,附圖顯示答案的譯文全部堆在問題標題上;
以及前一輪 Gmail 的「ARK • Disrupt」疊層跑到畫面最上方。

**這兩件事是同一個 bug**,而且我前兩輪都修錯了地方
(去追捲動事件、去追 toggle 事件)。病根在 `coverRect()`:

```
getBoundingClientRect()   → 0×0 @ (0,0)      ← 現在沒被畫出來
scrollHeight / scrollWidth → 上一次的尺寸     ← 佈局狀態被保留了
```

`coverRect` 的「內容比 border-box 大就撐開」那一段(為了蓋住緊排標題
露出來的半個 g,§的老問題)於是把 0×0 撐成 W×H,而座標還是 (0,0)——
換算成 document 座標就是 **(scrollX, scrollY),也就是視窗的左上角**。
一整批這種疊層就全部堆在那裡,蓋掉真正在那個位置的內容。

而 `setCovered(u, rect.width < 1 || rect.height < 1)` 那道兜底也因此失效:
寬高**不是**零。

製造這個狀態的是 `content-visibility`:

- `content-visibility: hidden` —— 收折的 `<details>`(現代 Chrome 的 UA 樣式)
- `content-visibility: auto` —— Gmail 對離開畫面的區塊做的效能優化

兩者都是「佈局跳過,但尺寸留著,好讓它快速恢復」。
逐條看 computed style 抓不到:它**不改 display,也不改 visibility**。

修法兩層:

1. `coverRect()`:**沒有任何 client rect = 沒被畫出來**,一律回零矩形,
   不看 scrollWidth / scrollHeight。
2. flush 的兜底改用 `el.checkVisibility({ contentVisibilityAuto: true })` ——
   一次回答 display:none、visibility:hidden、以及 content-visibility 被跳過。

順手把 `coverRect` 拆成 `src/content/cover.ts`,只有 type import,所以測得到。
這條規則已經出過兩次事(第一次是量測與驗證用不同公式造成無限重排,
第二次是這個),它值得自己一個檔案。

**教訓**:前兩輪我從症狀出發(「疊層在滑」→ 追捲動;「收折壞掉」→ 追 toggle),
兩次都在事件層打轉。真正該問的是**「這個座標是怎麼算出來的」**——
一問就發現 0×0 的元素被撐成了一個有面積的盒子。
BE 那條不變式(不顯示已知錯位的疊層)仍然有價值,但它是安全網,不是修復。

## BG. 所有量測都說謊時,只有 DOM 說實話

使用者的觀察一句話就把三輪的錯誤方向講完了:
**「打開跟關起來的 element 看起來長的一樣」**。

診斷 log 證實了這件事的嚴重程度 —— build 30 在 stratechery 上跑完整輪:

```
disclosure-toggle   0 筆     ← toggle 事件根本沒進來
position-drift      0 筆     ← 座標稽核認為一切正常
origin-offset       0 筆     ← 原點沒問題
inner-scroll        0 筆     ← 不是內層捲動
```

**沒有任何一個偵測機制認為出事了。** 而畫面上疊層堆在一起。

原因是現代 Chrome 用 `content-visibility: hidden` 收折 `<details>`,
而那會**保留佈局狀態**:

| 量法 | 收折時回傳 |
|---|---|
| `getBoundingClientRect()` | **展開時的位置與大小**(不是零) |
| `getClientRects()` | 一樣有東西(不是空的) |
| `getComputedStyle().display` | `block` |
| `getComputedStyle().visibility` | `visible` |
| DOM 屬性 / class | 完全沒變 |

所以 §BF 的修法(沒有 client rect 就回零)打不到 —— 它有 client rect;
座標稽核也抓不到漂移 —— 前後量到的值一致,只是**一致地錯**。

**前三輪我一直在問「量到的值對不對」,但每一種量法都回同一個錯的值。**
這是這個專案到目前為止最貴的一個教訓:當所有觀測互相印證時,
不代表觀測是對的,可能只是它們共用同一個錯誤的來源。

唯一誠實的來源是 DOM 結構本身:

```ts
export function hiddenByDisclosure(el: Element): boolean {
  let child: Element = el;
  for (let p = el.parentElement; p; child = p, p = p.parentElement) {
    if (p.tagName === 'DETAILS' && !p.hasAttribute('open') && child.tagName !== 'SUMMARY') {
      return true;
    }
  }
  return false;
}
```

這不是啟發式,是規格定義的行為:沒帶 `open` 的 `<details>`,
除了 `<summary>` 以外的內容不顯示。

用在三個地方:

1. `walk()` —— 收折的 `<details>` 只走它的 `<summary>`,內容不建立單元
2. flush 的 `isRendered()` —— 已經存在的單元(展開時建立、後來被收折)藏起來
3. 成本閘門(`intake` 與 `dwellTick`)—— 收折的內容不送 L0 也不送 L1。
   這裡**只用 DOM 檢查**,不用 `checkVisibility()`:後者會觸發 layout,
   而這兩條路每 300ms 跑一次

**另外:`toggle` 事件不可靠。** log 裡零筆。頁面自己的 JS 直接改 `open`
屬性時不會派發那個事件。所以 MutationObserver 加上
`attributeFilter: ['open', 'hidden', 'aria-expanded', 'aria-hidden']` ——
只有這幾個名字會觸發,成本可控,而且順便涵蓋自繪的 accordion。

## BH. 背景取不到時,依文字亮度挑一個(不要固定用淺色底)

回報:「ARK 的選色也有點怪怪的,不是選藍底嗎?」附圖是深藍底的橫幅上
冒出一塊淺藍色方塊配橘字。

那是 §4.1 的降級路徑:`resolveBackground()` 遇到 `background-image` 就回
`risk: true`(底下是圖,不知道那塊像素是什麼顏色),於是套用標註樣式 ——
固定的淺藍底 + 褐字。

那條規則的理由是「不要猜」。但**固定用淺色底本身就是一種猜**,
而且是最糟的那種:它假設整個網頁世界是淺色的。深色橫幅、深色模式、
彩色卡片上全部猜錯。

**文字顏色是我們確定知道的東西,而它必然與背景有對比。**
白字 → 底一定是深的;深字 → 底一定是淺的。所以取不到背景時,
依 `color` 的亮度挑一個對比底(`backgroundForText()`)。
這個推論比「假設頁面是淺色」可靠得多。

標註樣式保留給它真正該在的地方:使用者明確勾選的 `forceAnnotation`,
以及按住 Alt 的掃視。

## BI. Gmail 的第二輪:log 說了三件事

build 30 在 Gmail 上的診斷 log:

```
inner-scroll     每 0.5 秒一筆,units 10–13    ← 內層捲動偵測有效
position-drift   dy 最大 1440                  ← 座標稽核有效
origin-offset    0 筆                          ← 原點沒問題
scan {"found":0} **每秒兩次**                  ← 純浪費
```

前三件是好消息:BD / BE 的機制都在動。第四件是新發現的問題。

**掃描節流。** 應用程式的 DOM 一直在動,每一次變動都觸發一次全樹 walk +
getComputedStyle。掃描是為了「發現新內容」,那件事不需要 60fps ——
兩次掃描之間至少隔 400ms。重新量測(flush 的其餘部分)才需要即時,
所以**只節流掃描,不節流 flush**。被節流掉的掃描會補一次延後的 flush,
不然安靜的頁面會永遠等不到。

## BJ. `role="heading"` 掛在 inline 元素上時,祖先會撿走它的文字

回報:Gmail 左欄的「Labels」還是被翻成「標籤」。

§BD 已經加了「非 heading 標籤 + `role="heading"` + 24 字以內 = UI 標籤」,
但那條檢查在 `isUiLabel()` 裡,而 `isUiLabel()` **只在元素「像 block」時
才會被問到**。Gmail 的寫法是:

```html
<div class="aAw"><span role="heading">Labels</span><div role="button"/></div>
```

inline 的 `<span>` 在 blockish 判斷就 `return false` 了,於是外層的 `<div>`
撿走「Labels」變成翻譯單元。

修法和 sr-only 一模一樣:認出來之後**登記到 srOnly 集合**再 return,
讓祖先扣掉它的文字。只是 return false 永遠只是把問題往上搬一層 ——
這個坑在這個檔案裡已經踩過兩次(sr-only 的 stretched link、
分享按鈕的 `<span hidden>`),這是第三次。

## BK. 藏起來是對的,每個 frame 又放出來是錯的

build 32 的診斷 log 終於把機制完整攤開。一次甩動捲動的原始紀錄:

```
01:32:38.440  inner-scroll  units 59
01:32:38.457  scroll-drift  dy=3    u21
01:32:38.491  scroll-drift  dy=113  u21
01:32:38.524  scroll-drift  dy=259  u20
01:32:38.557  scroll-drift  dy=386  u17
01:32:38.591  scroll-drift  dy=427  u12
01:32:38.624  scroll-drift  dy=323  u8
01:32:38.658  scroll-drift  dy=93   u2
```

**每 33ms(一個 frame)一筆。** 每一筆都走完
「偵測到漂移 → 全部藏起來 → 重新量 → 再顯示」,而下一個 frame 又漂了 ——
甩動時一個 frame 可以捲 400px。

所以疊層每 16ms 出現一次,**每次都晚一幀**。這就是「滑動」的體感,
而且是我自己做出來的:BE 那條不變式(不顯示已知錯位的疊層)沒錯,
錯在 flush 每次都無條件把 `.stale` 清掉,等於每個 frame 又放出來一次。

**藏起來是對的,每個 frame 又放出來是錯的。**

改成:內層捲動期間 `innerScrollActive = true`,而

- flush 用 `layer.setStale(u, innerScrollActive)` —— 捲動期間一直藏著
- `scrollSync()` 在捲動期間直接 return —— 已經藏起來了,不必每個 frame
  再量 59 個單元的 rect,結論永遠是「還在動」
- 60ms 沒有新的捲動事件 → `innerScrollActive = false` + 量一次 + 一次顯示

行為變成:**捲動 → 疊層消失(看得到原文)→ 停下來 → 一次到位。**
這正是 BD 當初設計的樣子,只是被「每次 flush 都放出來」抵銷掉了。

## BL. 掃不到東西就退

同一份 log 的第二件事:

```
01:32:42.9 → 01:32:51.5   scan {"found":0}  ×18,每 500ms 一次
單元數從頭到尾都是 59
```

BI 加的 400ms 節流有生效,但 400ms 對「一直為了自己的理由變動 DOM」的
應用程式來說還是太密。掃描是為了發現新內容;**連續掃不到就代表這一頁
的內容穩定了**,所以退避:400 → 800 → 1600 → 3000ms 封頂。

一旦真的掃到新東西就立刻回到 400ms —— 無限捲動的頁面要能馬上跟上。
換頁、手動按翻譯、停用重啟也都重設。

`scan` 的診斷多印一個 `gapMs`,下次看 log 就知道退到哪一階。

## BM. 打了四輪地鼠之後:換成一個判準

build 33 的 log 顯示 BK 的修法只解決了一半。`inner-scroll` 確實變成
一次捲動一筆了,但 `position-drift` 仍然一秒兩三筆、dy 最大 **4255**,
而每一筆都跑完「藏起來 → 量 → 放出來」。那就是閃爍。

原因很簡單也很難堪:**有三條路各自決定要不要把疊層放出來**——
捲動事件、座標稽核、內層沉澱。只要有一條在還在動的時候決定「好了」,
使用者就看到一次錯位。我修了三輪,每一輪都只修其中一條。

log 還揭露一個我沒想到的情況:`inner-scroll {"units":0}` ——
Gmail 有巢狀捲動容器,**捲的那一個不一定是我們追蹤的單元的祖先**,
於是「只藏這個容器裡的單元」什麼都沒藏到。

改成一個概念:

```ts
const MOTION_SETTLE_MS = 200;
let lastMotionAt = -1e9;
function settled(): boolean { return performance.now() - lastMotionAt >= MOTION_SETTLE_MS; }
```

任何一種「內容在動」的訊號(內層捲動事件、哨兵漂移、稽核漂移)
都只做一件事:**蓋上時間戳**。而疊層的顯示只有一個判準:`settled()`。
誰偵測到的不重要,偵測到幾次也不重要。

- `flush()` → `layer.setStale(u, !settled())`
- `scrollSync()` / `auditPositions()` → `if (!settled()) return`
  (還在動的時候量到的一定是漂移,而處置已經做了)
- 靜下來時由一個 timer 量一次、**一次**顯示

**教訓**:同一個決策散在三個地方,就等於有三個地方會做錯。
這在這個專案裡不是第一次 —— §BF 的量測公式、§AX 的去重位置都是同一種病:
**把一個判斷放在錯的層級,然後在每個出錯的地方各補一次。**
