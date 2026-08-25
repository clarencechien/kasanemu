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

## BN. 破版:疊層要跟著容器一起被裁

BM 之後捲動不再滑動(log 裡 `position-drift` 從一秒兩三筆掉到
**整段 3.5 分鐘只有 1 筆**),剩下的是破版 —— 附圖裡譯文浮在 Gmail 的
搜尋列、工具列、Reply 按鈕上面。

使用者直接講出了正解:「破版有辦法量 inner 的上下嗎?可以保守一點。」

**對,而且該量的不只上下,是四邊,而且不只一層。**

這是「疊在頁面外面」的最後一個代價:內容捲出捲動容器時,**頁面會把它裁掉**,
而我們的疊層在 z-index 2147483000,不受任何祖先的 `overflow` 影響 ——
於是畫到完全無關的地方。

修法和 §「跑到 header」完全一樣,連機制都共用:算出可見矩形,
用 `clip-path: inset()` 裁掉。`setClip()` 從兩個參數(上下)擴成四個。

三個細節:

- **可見矩形 = 固定頁首帶 ∩ 每一層 `overflow != visible` 的祖先**。
  Gmail 有巢狀捲動容器,所以要一路交集上去。
- **裁切祖先只找一次就快取**(`clippersOf`)。結構不會因為捲動而改變,
  只有 relayout 才重算 —— 否則是 59 個單元 × 十幾層 getComputedStyle。
- **保守的方向是寧可多裁**:交集為空就整塊不見,不留半條邊。
  原文完全看不到的時候,譯文露出一條邊比整塊消失更容易被當成 bug。

`clipInsets()` 抽進 `cover.ts`(只有 type import),四支測試蓋住
「裁上緣」「四邊都裁」「完全看不到」「完全看得到」。

`checkOcclusion()` 的「整個落在裁切框外就藏起來」保留 ——
現在多半是冗餘的,但它另外還擋掉輪播的重複 DOM,那不是裁切問題。

## BO. 三件事,其中兩件是同一個上限

### 「選了也沒有翻」

功能有實作(§AZ),但 hover 與選取**兩條路共用同一個 240 字上限**,
而回報的那段 Note 是 400 字 —— 兩條路都在同一個地方被靜靜擋掉。
使用者看到的是「這功能沒做」。

上限提到 500(26em 寬、13px 的貼片大約十行,可以讀),
而且**被擋掉要留下痕跡**:`selection-skipped` 會寫 why 與字數。
靜靜地什麼都不做是這一輪最貴的錯 —— 它讓一個能用的功能看起來不存在。

### 那段 Note 為什麼從來沒被翻過

Gmail 在每個含圖片的 `<p>` 裡塞一個下載按鈕:

```html
<p><img 圖表><div class="a6S">…<div role="tooltip" aria-hidden="true">Download</div></div><span>Note: …</span></p>
```

`hasContainerChild()` 用 `textContent` 判斷「這個 block 子孫有沒有文字」,
而 `textContent` 把 aria-hidden 的 tooltip 一起吃進來 →
判定那個 `<p>` 是容器 → 整段註解不建立單元。

更糟的是 `ownText()` **也**沒有扣掉排除清單,所以 `div.a6S` 自己變成一個
內容是「Download」的翻譯單元。

**這是 sr-only 那個坑的第四次**(stretched link、`<span hidden>`、
inline `role="heading"`、現在是 aria-hidden 的 tooltip),而每一次的教訓
都一樣:**認出來還不夠,祖先也要扣掉。** 這次直接修在 `ownText()` 裡,
`hasContainerChild()` 改用它 —— 一個來源,不再各自實作一次。

### 圖文混排

修好上面之後那個 `<p>` 會變成單元 —— 而它的 bounding box 包含整張圖表,
不透明的疊層會把圖蓋掉。§3.5 只處理了**浮動**圖片,不浮動的一樣會被蓋。

新增 `hasMediaChild()`:底下有面積 ≥ 20×20 的 img / video / canvas / svg
就不建立單元。行內小圖示不受影響。那段 Note 因此改由 hover / 選取取得 ——
這正是加翻層存在的理由。

### 下面超出的部分

`chromeBand()` 只在**畫面正中央**取一次樣。而 Gmail 的 Reply / Forward 列
只佔左半邊,正中央那一點打到的是它右邊的空白 → 量到 0 → 不裁。

改成取樣 25% / 50% / 75% 三個 x,取最大的帶。
同時 `clip-to-container` 的診斷多印 `noClipper` ——
如果那個數字很大,代表我根本沒找到捲動容器,而不是「裁了但不夠」。

## BP. 兩個收尾的小東西

### 貼片被蓋到

貼片是 shadow root 裡與 `.layer` 平行的兄弟,先前**沒有給 z-index**,
靠的是 DOM 順序(`.layer` 在前、貼片在後)。

而 `.layer` 一旦因為原點修正拿到 `transform`(§BE),就變成一個堆疊脈絡,
順序就不再保證。使用者的原話:「tip 的 layer 應該要高於其他 layer」——
對,而且明寫比依賴順序可靠。

`.chip: 5` / `.hud: 4` / `.panel: 6`,全部寫死。

### 下半部疊到 Reply / Forward

`clip-to-container` 的診斷這次很有用:`noClipper: 0` ——
**捲動容器有找到,而且有在裁**(clipped 1–4)。所以不是「找不到容器」,
是「容器的範圍本身就不對」。

原因:Gmail 的 Reply / Forward 列**蓋在**郵件窗格的底部,而窗格的矩形
延伸到它底下。裁到容器邊界完全正確,只是那個邊界在 Reply 列的**後面**。

`chromeBand()` 也打不到它 —— 那是量視窗底邊的,而 Reply 列釘的是
**窗格**底邊,不是視窗底邊。

所以加一次探測:盒子已經碰到容器底邊的單元(通常零到兩個),
用 `elementFromPoint` 問頁面「這個位置現在畫的是什麼」。
打到的東西如果和這個單元無關(既不是祖先也不是子孫),那就是蓋在上面的別人,
把可見範圍收到它的上緣。

疊層的 `pointer-events: none` 在這裡第三次派上用場:命中測試打不到我們自己。

兩個守衛避免 build 15 那種「用命中測試把正確的疊層藏掉」重演:
只認**橫跨大半個容器**、而且**貼著底邊**的東西,而且只對碰到底邊的單元做。
角落一顆小按鈕不會把整塊譯文裁掉。

## BQ. 貼片被蓋到:z-index 加在對的元素上,但比錯的對象

上一輪加了 `.chip { z-index: 5 }` 就交差了 —— 而 `.layer` 那一行寫著:

```css
.layer { z-index: 2147483000; }
```

**5 永遠贏不了 2147483000。** 我加了新的 z-index,卻沒看它要跟誰比。

那個 2147483000 一開始就放錯地方了:它屬於 **host**(`#kasanemu-root`),
負責把整個疊層放到頁面最上層。shadow root **裡面**是另一個世界,
只需要決定我們自己那幾個節點的先後 —— 而在裡面放一個天花板值,
等於讓後來任何一個節點都排不到它前面。

改成 `.layer: 0` / `.hud: 4` / `.chip: 5` / `.panel: 6`。

(順帶踩到一個 TypeScript 的坑:CSS 寫在 template literal 裡,
註解中的反引號會把字串提前關掉。)

## BR. 容器底邊留餘裕

使用者的原話:「下半部可以再加寬一下,就算最下面有一些內容沒 show layer,
只要畫面中間有就可以了。」

這是對的取捨,而且值得寫下來當原則:**容器底邊附近本來就常有陰影、漸層、
釘住的按鈕列,量得再準也只是勉強擦邊。少蓋一點沒人會發現,多蓋一點整頁
就髒了。**

所以被容器限制住時,底邊再往上收 32px(釘住的橫列也一樣)。

**只在真的被容器限制住時才收。** 一般頁面(視窗捲動)的底邊是視窗本身,
那裡的疊層是合法的、而且下面還有內容 —— 一律收 32px 會在每一頁的底部
切出一條看得見的線。這個 `bounded` 旗標就是為了分開這兩種情況。

## BS. 重畫會洗掉執行期狀態

回報:「Gmail 中 mouse over 只能 show 一下原文,馬上就蓋回去了」。

`paint()` 用整個 `className` 重指派:

```ts
box.className = `box${single}${annot}`;
```

而 `hovered`(正在看原文)、`covered`(來源看不見)、`stale`(座標還在動)
是**執行期狀態**,不是重畫的產物。重指派把三個都清掉了。

`covered` 與 `stale` 在 flush 迴圈裡緊接著被重設,所以沒事;
**只有 `hovered` 沒有人補**。而 hover 狀態只在 `mouseover` 事件時設定 ——
滑鼠不動就不會再有事件,所以它一去不回。

為什麼只有 Gmail 看得出來:那裡 flush 一直在跑(裁切更新、DOM 變動)。
一般網頁滑鼠停著的時候 flush 很少,所以這個 bug 藏了很久。

修法:`paint()` 保留這三個 class,而不是靠別人補回來。

## BT. Alt+Shift+H:整層收起來

回報:「目前有熱鍵是全拿掉 layer 嗎?」

有 `Alt+Shift+T` 的點閱模式,但那是「滑過才顯示」,不是「拿掉」。
新增 `Alt+Shift+H`:整層 `display: none`,連提示線都收,像沒裝這個擴充一樣。

**刻意不停止翻譯。** `Alt+T` 停用網域也能達到目的,但那會把整頁的成果丟掉 ——
想再看譯文就得重翻一次,而且 L1 要重新花錢。收起來只是不畫,
譯文留在記憶體裡,再按一次立刻全部回來。

狀態列會講「疊層已收起 —— Alt+Shift+H 放回來」,不然按下去像壞掉。

## BU. Alt 與 Alt+Shift+H 對調

回報:「Alt+Shift+H 放回來,跟 Alt 互換一下,Alt 好按多了」。

對,而且理由比「好按」更硬:**這兩件事的使用頻率差一個數量級。**

| 動作 | 多久做一次 | 原本的鍵 | 現在 |
|---|---|---|---|
| 瞄一眼原文 | 每分鐘 | Alt+Shift+H | **按住 Alt** |
| 掃視哪些區塊被翻了 | 偶爾除錯 | 按住 Alt | Alt+Shift+H |

**常用的動作該配最好按的鍵。** 這是我一開始就該想到的 ——
§2.1 的標註掃視是寫 PRD 時想像的用法,而「按住看原文」是真的在用的時候
每分鐘都要的動作。

還有一個形式上的理由:「按住看原文、放開回來」本來就該是 **hold**;
「切換掃視模式」本來就該是 **toggle**。對調之後兩者各自回到對的形式。

一個 hold 專屬的坑:**切走視窗時收不到 keyup**,Alt 會卡在按住的狀態,
疊層就再也回不來了。`blur` 一併重設。

## BV. 深色頁面上的白色疊層:半透明背景不是「找到了」

**症狀**:ClickHouse 部落格(近黑色版面)上,疊層是白底配淺灰字,等於看不見。
使用者的原話是「選色錯誤了」。

`resolveBackground()` 沿 parent chain 找第一個 `alpha > 0.05` 的 background-color,
找到就以**全不透明**畫出去。而那個頁面的卡片寫的是

```css
background-color: rgba(255, 255, 255, 0.1);
```

疊在 `rgb(19, 19, 18)` 的版面上,畫面是深灰;程式看到 alpha 0.1 大於門檻,
判定「找到不透明色了」,交出純白。

錯的不是門檻,是**把半透明層當成答案**。它是答案的一部分:要一路收集到
真正不透明的那一層(或 UA canvas),再把收集到的層由遠而近合成回去,
才是畫面上實際的顏色。0.05 這個門檻本身也消失了 —— 有了合成,
任何 alpha 都有正確的處理方式,不需要「多透明才算數」的猜測。

同一個病灶還有第二處:`.box.annotate` 的淺藍底 + 褐字是寫死的。
標註樣式需要自己的識別沒錯,但「有識別」不等於「只有一套」。
改成兩套配色,依來源文字的亮度擇一(亮字必然配深底,反之亦然),
和 §BM 的 `backgroundForText()` 同一條推論。

## BW. 「連 L0 都不動了」:優先度不能在入隊時定案

**症狀**:268 個區塊的長文,Chromebook。診斷 log 顯示 `avgWaitMs` 65 秒、
佇列一開場就有 179 個在排。使用者往下捲,看到「有些不翻 有些翻」,
問「對到 TPM 連 L0 都不動了?」

先排除那個 TPM:429 發生在 03:02:38,而佇列 179 深是 03:02:13 的事 ——
**時間順序證明它們無關**,L1 的節流沒有、也不可能影響本機的 L0。
把兩件同時看到的壞事連起來是很自然的推測,但診斷 log 的時間戳就是用來
否定這種推測的。

真正的原因有三個,都在同一條佇列上:

1. **優先度是入隊時算的。** 一開場整頁進料,每個區塊帶著「離視窗中心多遠」
   的**當時**數值插進排序好的陣列。使用者捲到中段之後,他正在看的段落
   是在他捲過去之前入隊的,帶著舊順序排在第 150 位。每個呼叫 2.4 秒、
   併發 2 —— 那是幾分鐘。改成存 thunk、**出隊時才算**,捲動就自動重排整條佇列。
   (抽成 `queue.ts` 的 `SlotPool`,因為它值得被測試。)

2. **預翻沒有上限。** 存貨 179 個等於五分鐘的量;預翻的用意是
   「使用者捲到的時候已經翻好了」,排在 179 個後面的東西不管怎樣都不會準時到,
   只是把 CPU 佔住。加上 `L0_QUEUE_CAP`,但**上限只管預翻,看得見的一律照收** ——
   上限管的是存貨,不是需求。

3. **失敗重試沒有上限。** log 裡 `l0-done {"asked":6,"batchMs":0,…,"failed":6}`
   每 900ms 一筆而 `calls` 完全不動 —— 一次 API 都沒打就全部失敗。
   那是佔位符被翻掉的區塊:`masked.restore()` 對同一段文字永遠回 null,
   而 L0 的譯文有快取,所以重試連網路都不用走就直接失敗。永動機。
   加 `L0_MAX_TRIES`,試三次交給 L1;使用者親手 hover 重試時歸零。

三件事的共同點:**佇列裡的順序是一個會過期的判斷**,而過期的判斷比沒有判斷更糟 ——
它看起來還在運作。

## BX. 目次一半翻一半不翻:清單要整份判定

24 字門檻分辨 UI 標籤與內容,逐項套用。ClickHouse 的目次裡
「Introduction」12 字、「Count aggregations in ClickHouse and Elasticsearch」49 字,
於是同一份 `<ul>` 裡短的變成要 hover 的貼片、長的變成常駐疊層。
使用者看到的就是「有些不翻 有些翻」。

門檻沒有錯,錯在把清單當成一堆互不相干的項目。清單是一個整體:
裡面只要有一項長到明顯是內容,整份就是內容。反過來,Gmail 左欄與
一般網站的選單每一項都短,結論不變 —— 這條規則只在混合長度時才生效,
而混合長度正是「這不是選單」的證據。

三項以下不算數:樣本太小,不足以推翻長度門檻。

## BY. 顏色不是字串:別用正規表示式追 CSS 的顏色語法

§BV 修完合成之後,使用者回報「還是白色啊」。同一頁、同一個症狀,
但根因完全不同 —— 而且螢幕截圖裡就有答案:**標題是對的,內文是白的**。
差別不在版面,在顏色的寫法。

ClickHouse 用 Tailwind v4,它會為廣色域螢幕多輸出一份 `lab()`:

```css
.rich-text-light { --heading-color: #fff; --paragraph-color: #dfdfdf; }
@supports (color: lab(0% 0 0)) {
  .rich-text-light { --paragraph-color: lab(88.8292% 0 -.0000119209); }
}
```

標題留在 `#fff`,內文變成 `lab(...)`。`parseColor()` 的正規表示式只認得
`rgb()` / `rgba()`,於是內文的 `color` 解析失敗 →
`lightText()` 回 false → 判定「這是淺色頁面」→ 挑白底,
配上頁面自己的淺灰字,整段看不見。標題因為還是 `#fff` 所以正常。

三件事值得記下來:

1. **`getComputedStyle()` 不保證回 `rgb()`。** `lab` / `oklab` / `oklch` /
   `color()` / `color-mix()` / 相對顏色都會原樣保留,而且清單還會再長。
   用正規表示式追這個清單是一場追不完的比賽。瀏覽器本來就會算 —— 問它就好:
   1×1 canvas 畫一次、讀一個像素,任何它認得的顏色都變成 sRGB。
   (rgb/rgba 保留快路徑,慢路徑的結果記在 Map 裡;一頁的相異顏色是個位數。)

2. **解析失敗必須留下痕跡。** 舊的 `parseColor()` 回 null 之後,
   上層安安靜靜地走 fallback,畫面照畫、只是選錯色。沒有任何 log、
   沒有任何計數 —— 只能等使用者截圖。這和 §BD「靜靜地什麼都不做,
   會讓一個能用的功能看起來不存在」是同一個病:
   **沉默的降級等於沒有診斷。** 現在解析不了的字串會列進診斷報告。

3. **node 的測試看不到這一段。** canvas、CSS 串接、computed value 都要真瀏覽器。
   於是加了 `scripts/probe-colors.mjs`:用 Playwright 開一份 fixture,
   對每個元素跑 `probeStyle()`,斷言「深色頁面不得挑淺底」。
   §BV 與 §BY 兩次災情各對應 fixture 裡的一列。
   playwright 不列為 devDependency(太大,只有這支用得到),沒裝就跳過。

## BZ. 用真的瀏覽器問頁面,不要用截圖猜

顏色修好之後,使用者一次回報了四個「翻一半」的形狀。前三輪都是靠截圖
與 log 推測,錯了兩次。這一輪換個做法:把使用者附的 MHTML 攤平成單檔 HTML,
用 Playwright 開起來、把 `detect.ts` 打包成 IIFE 注入,直接問頁面
「這些元素現在會產生什麼單元?」

答案十分鐘就出來,而且四個症狀分成四個互不相干的根因 ——
其中兩個和我原本的猜測完全不同。**能問就不要猜。**

(注入要用 `addInitScript`:`file://` 與 MHTML 的 CSP 會擋掉 `addScriptTag`。
另外 esbuild 的 `--global-name` 產生的是 `var D = …`,在 init script 的
函式作用域裡不是全域,要補 `--footer:js='globalThis.D=D;'`。)

### BZ-1. 巢狀清單要看整棵樹

§BX 的「整份清單一起判定」只看了自己那一層。目次的子清單常常每一項都短
(Summary / Storage size / Aggregation performance),於是上半部翻了、
縮排進去的三項沒翻。它們是同一份目次的一部分,判斷也該是同一個 ——
往上走到最外層的 `<ul>` 再判定。

### BZ-2. 容器自己那一行字

```html
<li><a>Benchmark results</a><ul><li><a>Summary</a></li>…</ul></li>
```

`<li>` 的子清單產生了單元 → `walk()` 回 true → **`<li>` 自己那一行字
沒有任何人認領**。既不是內文也不是貼片,滑上去也沒反應。

不能拿 `<li>` 當單元(它的 bounding box 蓋住整個子清單),但可以拿 `<a>`——
幾何剛好,語意也對。條件放得很緊:容器自己的文字(扣掉區塊子節點的)
要恰好等於某一個**沒有容器子孫的**非區塊子元素的文字。

那個「沒有容器子孫」的條件是踩到才加的:`<a><h3>卡片標題</h3></a>` 會變成
兩層疊層,`<tbody>` / `<tr>` 會把整張表收成一個單元 —— 它們不在
CONTAINER_TAGS 裡(那是「像段落的容器」的清單)。
**用「有沒有容器子孫」判斷,比繼續往標籤清單裡塞標籤可靠。**

### BZ-3. 圖片自己佔一行,就不必整段放棄

```html
<p>文字…<span class="relative flex w-full"><img …></span></p>
```

`hasMediaChild()` 看到大圖就整段跳過,而 ClickHouse 的部落格每張圖都這樣寫,
於是圖多的文章一半不翻。使用者的原話:「看起來文字跟著圖的 就不會翻」。

可是這種版面上文字與圖片是**上下分開**的。三個條件都成立時記下界線,
疊層蓋到那裡為止:只有一處媒體、它在頭或尾、它自己佔一行。
三個條件缺一個就會蓋到圖 —— 真正的行內圖片(混在文字行裡)照舊整段跳過。

`coverRect()` 用中心點判斷圖在上或在下,不另存欄位:兩個矩形都在手上,
多存一個布林值只是多一個會過期的狀態。

### BZ-4. `overflow: hidden` 的兩種用途

「翻了沒蓋完全」—— 引文的疊層只蓋到一半,最後兩行原文露出來。
看起來像翻譯或幾何的問題,其實兩者都不是:

```
BLOCKQUOTE  overflow: hidden  height 167  scrollHeight 167
```

`overflow: hidden` 在這裡是**裁切**用的(讓左側 `::before` 的色條不超出圓角),
內容一格都不會動。而 §BR 的 `CONTAINER_SAFETY_PX = 72` 是為 Gmail 那種
**捲動窗格**加的:內容會滑出邊界,底邊附近不可信。

同一個 CSS 屬性,兩種相反的意義。分辨的方法不是看 `overflow` 的值,
是看內容有沒有超出可視區(`scrollHeight > clientHeight`)。而且只要問
**限制底邊的那一個**容器,不是每一層 —— 一個 frame 一次屬性讀取。

### BZ-5. 加翻層的例外

BZ-1 讓內容清單的短連結交給內文層,但右側那份浮動目次是 `position: sticky`,
而 §3.5 的內文層對 sticky 子樹是整棵跳過的。兩條規則一疊,它從
「滑上去看得到」變成「什麼都沒有」。

**讓路給一個永遠不會來的東西,比原本更糟。** 加上例外:祖先有 sticky / fixed
時,加翻層照收。

### BZ-6. 瀏覽器裡的驗收腳本

`scripts/probe-detect.mjs`(與 §BY 的 `probe-colors.mjs` 同一套路)。
jsdom 沒有 layout,`getBoundingClientRect` 一律回 0 —— 所有跟
「這張圖多大」「這個元素自己佔不佔一行」有關的規則在單元測試裡
**根本不會被觸發**。BZ-3 就是這樣漏掉的。fixture 裡每一列都對應一次災情。

## CA. 「有些翻有些不翻」的第三種寫法:證據放錯地方

同一個症狀已經修過兩次(§BX 逐項套門檻、§BZ-1 只看自己那一層),
第三次的形狀是:

```html
<li><p><strong>Query ①</strong> — 這是對整個資料集的全資料掃描…</p>
    <ul><li><a>ClickHouse SQL query</a></li>…</ul></li>
```

段落翻了,底下三個連結沒翻。因為 `inContentList()` 量的是
**清單項目裡的連結**有多長 —— 而這三個連結分別是 20 / 23 / 24 字,
全部壓在門檻底下。

長度的證據在**項目**上,不在連結上。改成量項目自己那一行
(`listItemText()`,刻意扣掉巢狀子清單 —— 不然
`<li>Products<ul><li>Cloud</li><li>Local</li></ul></li>` 這種下拉選單
會被加總成「很長」而誤判成內容)。

三次修同一個症狀,每次都以為是最後一次。共同的教訓是:
**這條規則要回答的是「這份清單是不是內容」,那就得量最能代表清單的東西。**
前兩次量錯了層級,這次量錯了對象。

## CB. `<nav>` 的待遇比 `[role="navigation"]` 差

「右邊的 table of contents 完全沒翻」。我以為是 §3.5 的 sticky 規則,
用 `explainCandidate()` 一問,答案是:

```
祖先 <nav> 在排除清單上
```

`NAV / HEADER / FOOTER / ASIDE` 在 `EXCLUDE_TAGS` 裡是**整棵子樹排除**,
而它們的 ARIA 版本(`[role="navigation"]` 等)在 `CHROME_SELECTOR` 裡
只擋常駐疊層、hover 照翻。同一份導覽,用 `<nav>` 寫的待遇比用
`<div role="navigation">` 寫的差 —— 沒有任何道理。

改成同一級待遇,而且加上和 §CA 同一條的判斷:裡面有目次型的清單就是內容,
不是外殼。文章的目次常常就放在 `<nav>` 或 `<aside>` 裡。

## CC. sticky 不必整棵放棄

§3.5 的「sticky / fixed 的元素及其子樹整棵跳過」寫在**「動就先藏起來」
那套機制存在之前**。現在內層捲動已經是「markAllStale → 靜下來再一次量、
一次顯示」,釘住的元素是同一類問題,用同一個答案就好:

標記 `pinned`,捲動期間只藏這幾個(一般段落在 document 座標裡不會因為
捲動而移動,照常留在畫面上),停下來再放回去。

不追著每一幀跑,是因為 build 14 的教訓:JS 比合成器慢一格,追著跑會抖。

**藏起來容易,記得放回來才是重點** —— flush 不會因為「捲動停了」被排程,
所以要自己排一個計時器,否則浮動目次會在第一次捲動之後永遠藏著。

## CD. 目次一半黃字一半白字:class 一樣,我們問的元素不一樣

`<li><a>Introduction</a></li>` 的墨水顏色是 `<a>` 的(目次是黃字),
但單元建在 `<li>` 上 —— 照 `<li>` 的 computed color 畫就變成白字。
而包著子清單那一項的單元剛好落在 `<a>` 上(§BZ-2),於是**一份目次裡
兩種顏色**。

修法:文字整段裝在單一子元素裡的時候,往下問到那一層為止
(有直接文字節點就停 —— 段落裡夾一個連結時主色仍然是段落的)。

**只取顏色。** padding / border / 圓角要留給單元自己那個盒子:
`<a class="block py-1">` 有上下內距而它的 `<li>` 沒有,混用會讓譯文位移。
「樣式從來源推導」是一條規則,但「來源」是畫出那些字的元素,
不一定是我們掛單元的元素。

## CE. 為 Gmail 加的規則,在長文上是純粹的干擾

「捲動時先藏起來,停下來再顯示」是 §BJ 為 Gmail 解「破版」加的,而且是對的:
那種頁面的捲動發生在內層容器裡,疊層畫在 document 座標上不會跟著動,
不透明的盒子就畫到別人的內容上。

問題是那條規則**全站生效**。一般長文的段落在 document 座標裡根本不會因為
捲動而移動,藏了又顯示只換來閃爍 —— 使用者的原話是
「在非 gmail 的長文中 就會有一直閃的感覺」。

使用者提的是白名單(「有 gmail 等 domain 才開」)。白名單會有用,但列不完,
而且會漏掉每一個沒列到的網站。真正要問的不是「這是哪個網站」,
是**「這一頁的座標會不會跑」**,而那件事有直接的證據:

  - `appShell`:`document.documentElement` 的 scrollHeight ≈ clientHeight,
    也就是 document 自己不捲 —— 捲動一定發生在內層容器裡
  - `innerScroll`:這一頁**實際收到過**內層容器的捲動事件

第二個尤其乾淨:一般文章一輩子收不到那種事件,而任何用內層捲動的網站
在使用者第一次捲動時就自己招了。**行為比身分可靠,而且不必維護清單。**

設定三檔:`auto`(預設,上面那套)、`always`(一律不藏,「我不在意偶爾
不對齊,不要閃」)、`strict`(舊行為)。

順帶把「藏起來」的觸發點也收乾淨了:座標錯得離譜時原本一律
`markAllStale() + noteMotion()`,但在長文上那通常只是一張圖載完把後面推走 ——
量一次就對了,`flushNow()` 當幀重畫到正確位置,藏 200ms 只換來一次閃爍。
現在只有守衛開著時才藏。

pinned 單元(§CC)是另一回事,不受這條影響:它們的 document 座標**確實**
在任何頁面上都會隨捲動改變,只有明講 `always` 時才不藏。

## CF. 放寬了誰能成為單元,就要重新檢查誰在拿單元當量尺

使用者:「47 版的文章翻不完,HUD 不見了,是不是死掉了?」

診斷 log 的第一行就說了它沒死:`待翻 0`,373 塊全部處理完。
但 log 裡有一整片這個:

```
scroll-drift {"dx":0,"dy":5884,"id":"u1"}
scroll-drift {"dx":0,"dy":-2461,"id":"u1"}
```

那些數字不是漂移,**是捲動距離本身**。

`scrollSync()` 每一幀挑「第一個看得見的單元」當哨兵,量它的 document 座標
有沒有變,用來偵測「內容自己在動」。而 §CC 讓 sticky 子樹開始產生單元之後,
`u1` 變成 `<header class="sticky top-0">` 裡的按鈕 —— 釘住的元素在 document
座標裡**本來就會隨捲動移動**,移動量正好是捲動距離。於是每一幀都判定
「漂移了」,每一幀 `flushNow()` 重量 373 個單元。頁面因此又卡又慢。

教訓不是「sticky 不該產生單元」,是:**放寬了誰能成為單元,就要重新檢查
誰在拿單元當量尺**。哨兵現在跳過 pinned 單元,`auditPositions()` 也是 ——
它們的位移是預期的,不是壞掉的證據。

### CF-1. 走捷徑的路徑要自己補上主路徑的每一道關卡

順著查下去發現 `u1` 根本不該存在:它是 `<button>`,而 `<button>` 在
`EXCLUDE_TAGS` 裡,`walk()` 早就跳過了。是 §BZ-2 的 `captureInlineText()`
從父層把它撿回來的 —— 那條捷徑只檢查了「文字對不對得上」,
沒有走 walk() 一路上的排除清單。

站台的頂部導覽因此變成六個內文單元。補上 EXCLUDE_TAGS / EXCLUDE_SELECTOR /
CHROME_SELECTOR 三道關卡。

### CF-2. 例外要窄:mega menu 幾乎一定有長項目

§CB 的「地標裡面有目次型清單就當內容」對 `<header>` 是災難:
站台頁首的 mega menu 幾乎一定有一項超過 24 字(產品說明),
於是**每一個有 mega menu 的網站**,整個頁首都會被當成內容。

目次會出現在 `<nav>` / `<aside>`,不會出現在 `<header>` / `<footer>`。
例外只給前者。修完之後同一頁的單元從 375 掉到 306 —— 那 69 個
本來就不該在那裡。

### CF-3. 沒說完成,就等於說了沒完成

HUD 在有失敗時只講「滑到紅線上重試」,把「跑完了」整個吞掉:

```ts
const tail = failed > 0 ? ' · 滑到紅線上重試' : ` · ${done}`;
```

於是使用者看到一條警示狀態列、幾秒後消失,而且從頭到尾沒人告訴他
整頁其實翻完了。他的結論很合理:死掉了。

兩處都改:失敗時一樣說「完成」,而且 **warn 級的狀態列不自動淡出**。
淡出的是資訊,留下的是待辦 —— 「有 15 塊失敗,滑上去可以重試」是還沒
解決的事,它一淡出畫面上就沒有任何東西告訴使用者發生過什麼。
它會在最後一塊重試成功時自己變回 idle 然後淡出:**自己會清乾淨的東西
才有資格常駐。**

## CG. 快取預設站錯邊

使用者:「每個網站翻好的不是先存 local 嗎?怎麼按翻譯這一頁真的重來重翻?」

三段式快取(記憶體 / `chrome.storage.session` / IndexedDB)一直都在,
而且「翻譯這一頁」只會重試失敗的區塊,不會重翻已經好的。
問題出在**預設值是 `session`** —— 瀏覽器一關就清空,重新載入擴充功能也清空。

這個工具的重點之一就是不要重複花錢,而快取的成本只是磁碟(而且有 LRU 上限)。
預設值應該站在「不要再付一次錢」那邊。改成 `persistent`。

順帶把它變得看得見:診斷報告多一行「快取:命中 N 塊 · 模式 X」。
**使用者會懷疑快取沒作用,是因為快取從來不出聲。**

## CH. 同一張表兩種行為:UI 標籤那條規則的理由是幾何,不是語意

ClickHouse 的圖表表格,表頭 `<th>Storage size</th>` 翻了,同一張表的

```html
<td><a href="#…">Link</a><span class="flex"><img …></span></td>
```

沒翻。差別在 `isUiLabel()` 的最後一條:**文字全部來自互動子孫 → 這是連結列**。
`<th>` 裡沒有連結,所以是內容;`<td>` 的文字整段在 `<a>` 裡,所以是標籤。

規則本身沒錯,錯在忘了它的**理由**。那條規則是為幾何服務的:譯文比原文短,
蓋在緊湊的導覽列上要嘛吃掉項目間距、要嘛讓原文從右邊露出來。
而 `mediaSplit` 的存在本身就證明這裡不是那種版面 —— 圖片自己佔一行,
表示文字也自己佔一行,蓋上去很安全。

所以:**有 mediaSplit 就不套 UI 標籤規則**。這比「表格儲存格例外」好,
因為它引用的是規則原本的理由,不是又一個標籤清單。

### CH-1. 預算要跟著文字走,不是跟著節點走

同一條規則裡的 `total.length > UI_LABEL_MAX_CHARS * actives.length`:
那個儲存格裡還有一顆放大按鈕,名稱在 `aria-label` 上、畫面一個字都沒有。
它讓預算憑空多了 24 字,自己卻一個字都沒貢獻。改成只算**看得見文字的**
互動子孫。

### CH-2. 會說謊的儀表比沒有儀表更糟

查這件事的時候先問了 `explainCandidate()`,它回:

> 符合所有規則 —— 應該會成為翻譯單元

而實際上是被 `isUiLabel()` 擋掉的 —— 那支工具**根本沒模擬那一關**,
也沒模擬 `hasMediaChild`。它讓人往錯的方向找了一輪。
兩關都補進去了。診斷工具與真實邏輯分岔,是這個專案第三次踩到的形狀
(§AS 的量測公式、§BY 的沉默降級,現在是這個):
**只要判斷邏輯有兩份,它們就會分岔。**

### CH-3. 「已經處理過」要往上找

儲存格變成單元之後,那個 `<a>Link</a>` 仍然被加翻層收走 —— 因為
`scanLabels()` 的去重只比對元素本身,而單元建在 `<td>` 上。
同一段文字於是既有常駐疊層、又有 hover 貼片,還多送一次 API。

這不只影響表格:段落裡夾一個短連結時,單元建在 `<p>` 上,那個連結
一樣會多一份貼片 —— **這個 bug 一直都在,只是這次才被看見。**
去重改成沿 parent chain 往上找。

## CI. 一次問完整頁,而不是一次修一個截圖

使用者:「這個測試 loop 太長了,你不能先以這個當 case,先看哪些沒解出來的
才會沒翻,先完整跑完一輪嗎?」

對,而且這是這一整段對話最重要的一句話。前面的節奏是
「截圖 → 修一個形狀 → 再截圖」,而同一頁上往往**同時**卡著五種不同的原因,
所以一輪只能解一個。

`scripts/audit-coverage.mjs`:整頁掃過每一個看得見的文字節點,問
「有沒有被任何疊層或貼片接手」,沒有的話用 `explainCandidate()` 問原因,
**依原因分組**印出來。第一次跑就長這樣:

```
單元 320 · 貼片 30 · 沒人接手的文字 162 段
── 65 段 · 祖先 <div> 不可見(收起來的 mega menu)
── 63 段 · 符合所有規則 —— 應該會成為翻譯單元      ← 儀表在說謊
── 12 段 · 圖文混排且圖片沒有自己佔一行            ← 真的漏
── 9  段 · 祖先 <button> 在排除清單上
── 8  段 · 祖先 <pre> 在排除清單上
── 5  段 · 底下還有帶文字的 block                  ← 真的漏
```

十分鐘就把「哪些是設計如此、哪些是 bug」分乾淨了。

### CI-1. 儀表又說謊了一次

那 63 段全在 `<footer>` 與 `<header>` 裡 —— `explainCandidate()` 沒有模擬
`isAppChrome()`,所以把外殼回報成「應該會成為翻譯單元」。補上之後
它們正確地歸到「祖先是應用程式外殼」。**第四次了**(§AS / §BY / §CH-2 / 這次):
只要判斷邏輯有兩份,它們就會分岔。

### CI-2. 換錨點:有些文字根本沒有元素可以掛

剩下兩組真的漏,而它們是同一個問題的兩張臉:

```html
<div class="rich-text">
  <div>…表格…</div>
  ClickHouse requires 12 times less disk space than Elasticsearch…
</div>

<p>文字…<span class="flex"><img></span>As discussed, ESQL currently…</p>
```

第一種的文字**沒有任何元素包著**(markdown 轉出來的鬆散文字節點),
第二種被中間的圖片切成兩段。兩種都不可能用一個元素矩形蓋住,
而在此之前整個系統的前提是「一個單元 = 一個元素」。

答案是換錨點:用 `Range` 圈住那一段,幾何問 `range.getClientRects()`。
區塊子節點是天然的分隔線 —— 兩段之間必然換行,所以每一段的矩形都是完整的幾行。

代價是 `unitByEl` 從一對一變成一對多(`WeakMap<Element, Unit[]>`),
連帶要處理:同一批掃描裡同一個元素會出現好幾次、IntersectionObserver
要更新每一段、hover 要用指標位置挑中正確的那一段。

三個必要的守衛,每一個都是踩到才加的:

1. **這段文字有主人了嗎。** `<a><h3>卡片標題</h3></a>` 的 `<a>` 是行內的,
   整個會被收成一段 run,可是那段文字早就由 `<h3>` 蓋著了。
   單元一律建在容器上,所以「這段裡有容器」就等於「有主人」。
2. **這段裡夾著大圖嗎。** `<p><img><span>說明</span></p>` 的圖是真的行內圖片,
   矩形一定壓到它 —— 那種整段放棄的舊行為是對的。
3. **長度要一段一段量。** `inlineOwnText()` 把五段鬆散文字接成一條 3000 字的
   字串,於是 `text.length > MAX_UNIT_CHARS` 直接 return,連 Range 的路都沒走到。
   **把整體拿去量,擋掉的是每一個個體。**

### CI-3. `mediaSplitOf` 只看 children,看不見文字節點

`<p>文字<span class="flex"><img></span>文字</p>` 的**元素**子節點只有那個 span,
所以「它是第一個也是最後一個」成立,程式判定圖片靠在邊上 ——
而畫面上它正夾在兩段文字中間。改成走 `childNodes`:
**文字節點沒有元素身分,但它在版面上占位;量版面就不能只看元素。**

### CI-4. 底線寫進 probe

`scripts/probe-detect.mjs` 加了一條總是成立的斷言:**任何單元的疊層矩形
都不可以壓到圖片上**。而且它呼叫的是 production 的 `coverRect()`,
不是在腳本裡另外寫一份 —— 第一次寫的時候我拿元素的 border-box 去比,
立刻誤報三筆。連驗收腳本都會踩到「兩份邏輯」這個坑。

跑完一輪之後,那一頁的內文區 **100% 有人接手**,剩下的 137 段全部是
設計如此:收起來的下拉選單(不可見)、頁首頁尾(外殼,滑上去仍然翻得到)、
`<button>` 與 `<pre>`(排除清單)。

## CJ. 匯出快取:譯文不該綁在安裝上

使用者:「匯出匯入 cache,這樣就可以不用在移掉 ext 或昇版時一切都重來。」

三段式快取本來就在,但它活在擴充功能的儲存空間裡 —— 重新載入清掉 session,
重灌連 IndexedDB 都沒了。而譯文是**花錢換來的**,它的壽命不該由安裝決定。

格式是 `{ v, at, count, records: [[key, 譯文, 最後使用時間], …] }`,
用陣列不用物件,體積差一半。

匯入**只補不覆蓋**。key 是「原文 + 目標語言 + 模型 ID + 長度分桶」的雜湊,
同一把 key 代表同一段原文在同一個模型下的譯文 —— 現有那份不會比較差,
而覆蓋會把「剛剛才翻好、還熱著的」換成檔案裡的舊資料。

## CK. 匯出疊好的頁面:因為沒改過 DOM,所以不能只是「另存新檔」

使用者:「匯出已經翻好的 html,試著匯出疊好的成品,一樣可以用 alt or
mouse over 看原文。」

這個需求把整個專案的核心限制照了一次:**譯文從來沒有寫進頁面**,
所以「存檔」存到的只有原文。要匯出就得另外組一份。

做法是複製整棵 DOM,在複本上把每個單元的原文包成 `.ksnm-src`、
旁邊補一個 `.ksnm-tx` 裝譯文,再用 CSS 決定顯示哪一個:

```css
.ksnm { display: contents; }
.ksnm > .ksnm-src { display: none; }
.ksnm:hover > .ksnm-src, html.ksnm-peek .ksnm > .ksnm-src { display: contents; }
```

`display: contents` 是這裡的關鍵:包裝用的兩層 `<span>` **不產生盒子**,
所以原文的排版一個像素都不會因為多了它們而改變。而「滑過去看原文」
在這裡只是一條 `:hover` 規則 —— 不需要疊層、不需要幾何、不需要 JS。
唯一的 JS 是三行按住 Alt 的 class 切換。

原文的行內標籤(連結、行內 code)一個都沒動。這比「把 textContent 換掉」
保真得多,而且**保留了原文的可讀性**:hover 出來的是原本那一段,不是純文字。

三個必要的細節:

1. **頁面自己的 `<script>` 一律拿掉。** 存下來的檔案再跑一次框架的 hydration,
   第一件事就是把我們插進去的節點洗掉。
2. **`<base href>` 要插在 `<head>` 的最前面。** 它只影響後面的 URL,
   少了它整頁的相對路徑 CSS 與圖片全部失效。
3. **範圍錨點要由後往前套用。** Range 是用 childNode 索引定位的,
   而包裝會改變同一個父層底下的索引。

錨點的對應用「從 documentElement 起算的 childNode 索引路徑」——
複本的樹形和本體一樣,所以同一條路徑兩邊通用。文字節點也有路徑,
這正好接住 §CI-2 那些沒有元素可掛的鬆散文字。

### CK-1. `display: contents` 的元素量不到

第一版的驗收腳本拿 `getClientRects().length > 0` 判斷「看不看得到」,
結果按住 Alt 時原文與譯文**兩邊都回 0** —— 因為 `display: contents`
的元素不產生盒子。看起來像功能壞了,其實是尺子不對。

改成問 `innerText`:**要驗「使用者看不看得到」,就要量畫面上的文字,
不是量盒子。** 這和 §BY 的教訓同一句話的另一面。

## CL. 「一直卡在 missing-id 不會再翻了」—— 兩個各自獨立的錯覺

診斷 log 的第一行照例先否定了症狀:`總 328 · L1 319 · 待翻 0 · L1 失敗 2`。
328 塊裡 326 塊翻完了。但使用者的感受是真的,而且有兩個來源。

### CL-1. scan 永遠回報 found > 0(build 52 的迴歸)

```
scan {"found":9,"gapMs":400,"total":328}   ← 每 400ms 一筆,total 從不改變
```

`captureRuns()` 沒有 `ctx.seen(el)` 的檢查 —— 元素錨點那條路徑在 `walk()`
裡擋著,而這條捷徑漏了。於是每一次 scan 都重新產生同一批 range 候選;
它們在 index.ts 會被「這個元素上一輪就有單元」濾掉,所以**不會**變成重複的疊層,
但 `found` 永遠大於零,掃描間隔就一直停在最短的 400ms ——
每 0.4 秒對整棵樹跑一次 `getComputedStyle`。

**這是 §CF-1 的第二次:走捷徑的路徑要自己補上主路徑的每一道關卡。**
第一次漏的是排除清單,這次漏的是去重。同一個形狀、同一支函式家族、
相隔兩個 build。

驗收也補進 probe:**第二輪掃描必須找不到任何東西**。這條斷言便宜,
而且它抓的是一整類 bug(任何「掃描不收斂」),不是這一個。

### CL-2. 把「沒升級」算成「失敗」

`l1-failed` 的區塊**有 L0 譯文在畫面上**(那個 tier 只有在 `l0Text` 存在時
才會被指派,見 index.ts)。使用者讀得懂,只是品質停在 L0。

而狀態列把它和 `failed` 加在一起:

```ts
const failed = c.failed + c['l1-failed'];
```

於是 warn 級 —— 而 warn 級在 §CF-3 之後**不自動淡出**。免費檔位偶爾對
某一段吐一次 `[]`,畫面上就掛著一條永遠不會消失的紅色橫幅,說「失敗 2」。

兩個改動疊在一起才出事:單獨看,「有未解決的事就留著」是對的,
「L1 失敗也算失敗」也說得過去。**留下待辦要留對東西** ——
現在分開數:`失敗 N`(沒有東西可看,warn、常駐)與
`未升級 N`(有 L0 譯文,info、會淡出)。

## CM. fixture 要裝著會弄壞它的東西

「匯出疊好的沒東西」。匯出的檔案裡 `class="ksnm"` 出現 **0 次** ——
一段譯文都沒套上。

```ts
const clone = live.cloneNode(true);
for (const el of clone.querySelectorAll('script')) el.remove();   // ← 先刪
clone.querySelector(`#${hostId}`)?.remove();
for (const p of plan) { ... }                                      // ← 才套用
```

路徑是 **childNode 的索引**,而刪掉一個 `<script>` 會讓它後面所有兄弟節點
往前移一格。一般網頁的 `<head>` 與 `<body>` 裡到處都是 script,
於是幾乎每一條路徑都指到別的節點,`nodeType !== 1` 就被跳過。
順序反過來就好:**先套用,再刪東西**。

真正該檢討的不是這個順序,是**驗收為什麼全綠**:
`scripts/fixtures/detect.html` 一個 `<script>` 都沒有,
而我拿來手動驗的 MHTML 也剛好不含 script(Chrome 存 MHTML 時不保留)。
兩份「真實頁面」都缺了那個唯一會弄壞它的東西。

fixture 裡現在有三個 `<script>`(head 一個、body 開頭一個、中段一個),
而且我把修正暫時退回去確認過:probe 立刻報

```
不合格:
  只套用 0/27 段
  平常看不到譯文
  滑過去看不到原文
```

**一個抓不到已知 bug 的驗收,和沒有驗收是同一件事。**
寫完守衛就把它弄壞一次,是唯一能確定它有在守的方法。

### CM-1. `# fail` 被我自己的 `tail -4` 蓋掉了

順帶發現 `tests/snapshot.test.ts` 從加進去那天起就是**整個檔案載入失敗**
(它從 `./unit` 做了值的 import,而 node 的型別剝離解析不了無副檔名的路徑)。
四個測試一次都沒跑過,而我每次只看 `npm test | tail -4` ——
那四行剛好把 `# fail 1` 切掉了。

改成只 type import(和 cover.ts 同一條規矩),並且以後看 `# pass` / `# fail`。

## CN. 「也沒有顯示完成」:問錯對象的那一句

`translationPhase()` 多問了一句「L0 池裡還有沒有東西在跑」:

```ts
if (s.waiting > 0 || s.nearPending > 0 || s.l0Busy) return 'busy';
```

預翻會把遠處的區塊丟進 L0 佇列,而那些區塊往往在輪到之前就被 L1 升級掉了 ——
呼叫還在排隊,但**沒有任何單元在等它**。stratechery 那一頁 79 塊全部翻完
(待翻 0),狀態列卻一直停在「翻譯中…」。

而且那一句是多餘的:真的在等 L0 的區塊本來就會被算進 `nearPending`
(intake 在送出前就標記了 probed)。**拿掉之後沒有少掉任何資訊。**

判斷「跑完了沒」要看**單元**,不看引擎。引擎忙不忙是它自己的事。

順手把浪費也堵掉:`L0Engine.translate()` 多收一個「輪到它時才問」的
`stillWanted`,排隊期間被 L1 搶先升級的區塊輪到時直接讓出槽位。
慢機器上佇列可以排到一兩百個,這一筆不小。

## CO. 「完成」要說得起

「有些還停在 L0 但顯示完成」。79 塊裡 12 塊是 L0、67 塊是 L1,待翻 0。

程式沒有說謊 —— 沒有任何東西在排隊、也沒有任何請求在飛。但使用者讀到的
「完成」是「這就是最終品質」,而那 12 塊不是。

原因是 §4.2 的停留門檻:一個區塊要在畫面上待滿 1.5 秒才會送去 L1,
純粹捲過去的段落留在 L0。那條規則是對的(它是成本閘門),
**但它留下一個沒有出口的狀態** —— 整頁完成了,其中十二塊只有 L0,
而使用者沒有任何方法說「那幾塊我要好的」。

兩件事一起補:

1. **狀態列講出來**,而且講怎麼要:`… · 完成 · 12 塊只有 L0,Alt+Shift+R 全部升級`。
2. **那顆按鈕真的做得到**。「翻譯這一頁」原本只重試失敗的區塊;
   現在再按一次也會把還停在 L0 的全部送去升級。
   這個動作本來就叫「翻譯這一頁」,而且是使用者親手按的 ——
   讓它把工作做完是最不意外的行為,也不需要新的按鈕或快捷鍵。

一句話:**在說「完成」之前,先確定沒有留下使用者想做卻做不到的事。**

## CP. 「按了沒反應」而 log 裡一行都沒有

使用者:「按翻譯這一頁跟 alt+shift+r 沒啥用,改 alt+r 吧。按『翻譯這一頁』應該要動。」

診斷 log 裡**沒有** §CO 剛加的 `upgrade-all` —— 所以那段程式跑了但集合是空的,
或者根本沒被呼叫。**而我分不出是哪一個**,因為那一行只在有事做的時候才寫。

### CP-1. 使用者親手觸發的動作,一定要留下它做了什麼

先修這個。`translate-page` 現在**每次都寫**一則 diag,包括什麼都沒做的時候:

```json
{"l0":12,"upgrading":0,"alreadyQueued":12,"noRoom":0,"retried":0}
```

缺席可以是「沒被呼叫」也可以是「呼叫了但沒事做」,而這兩個要用完全不同的方法查。
**沉默的成功和沉默的失敗長得一模一樣。**

按鈕也一定要有回音:真的沒事可做時,狀態列會說「沒有可以再升級的區塊」
或「這幾塊已經在升級佇列裡了」,2.5 秒後淡出。

### CP-2. 自動的規則可以保守,使用者親手按的動作不行

最可能的原因也一起修掉了:那 12 塊在收折的 `<details>` 裡(這一頁的 FAQ,
log 裡有十幾筆 `disclosure-toggle`)。停留門檻不理會收折的內容是對的
—— 看不見的東西不必花錢 —— 但我把同一條規則抄進了「翻譯這一頁」,
於是使用者要的是「這一頁」,拿到的是「這一頁我現在看得到的部分」。

順便把 `maxChars === 0` 的補算回來:那個值在 relayout 時會被清成 0
等下一次 flush 重算,剛好卡在中間就會被濾掉。

### CP-3. Alt+R 與「按住 Alt 看原文」

快捷鍵照使用者要的改成 `Alt+R`,但 `Alt` 單獨按住是「暫時收起整層」——
按 Alt+R 時 Alt 會先單獨到達,整層閃一下。

加一條:**收到第二個鍵就把它放回去**。hold 的意圖只有在 Alt 單獨按住時才成立,
Alt 加上別的鍵是和弦,不是「我想看原文」。

## CQ. 「排進佇列了,但沒有變 L1」—— 不追斷點,拆掉「卡住」這個狀態

使用者:「這是什麼昇級 bug,都顯示完成 或是已經在佇列裡 但沒有變 L1,
有打到 TPM Ratelimit 之類的嗎?」

先回答問題:**沒有。** 那份 log 裡沒有 429、沒有 `fuse-blocked`、沒有任何 notice。
五塊 `l1Queued === true` 的區塊按了五次「翻譯這一頁」,五次都回報
`{"alreadyQueued":5,"upgrading":0}` —— 它們既沒有收到譯文,也沒有收到失敗。
**一個沒有出口的狀態。**

### CQ-1. 安靜的斷點不只一個,而且下一個還會有

從 `enqueue` 到區塊變 L1,中間至少有三處會無聲吞掉東西:

| 位置 | 原本的行為 |
| --- | --- |
| `scheduler.ts` `post()` | `chrome.tabs.sendMessage(...).catch(() => {})` —— 而 `runBatch` 結尾**已經把佇列清掉了**,譯文就這樣不見了 |
| `index.ts` 訊息接收 | `if (raw.pageKey !== pageKey) return;` —— 對不上就丟,不留痕跡 |
| service worker 回收 | alarm 沒接回來的話,佇列裡的東西沒有人會再碰 |

我可以一個一個去追。但這是這個專案第五次遇到同一個形狀的問題:
**兩條路徑對同一件事各有一份判斷,其中一份出錯時沒有人會發現。**
追完這三個,第四個還是會有。

### CQ-2. 讓「卡住」變成一個會自己結束的狀態

改成看門狗:`dwellTick`(每 300ms)掃一次,排進去超過 **45 秒**還沒有回音的區塊
—— worker 的 alarm 是 30 秒,45 秒足以讓一次正常的回收 + 重排跑完,
超過就不是慢,是斷了 —— 就

1. **重排一次**。worker 的 `enqueue` 本來就會去重,所以還躺在佇列裡的
   只是被順手踢一下 `drain()`,不會重複計費;
   而如果丟的是**投遞**那一段,譯文早就進了快取,重排會直接快取命中,
   一毛錢都不用再花。
2. 再卡就**標成失敗**:有 L0 就是 `l1-failed`(提示線警示色、hover 可重試),
   沒有就是 `failed`。

上限一次。無人看管的重試迴圈會安靜地一直花錢 —— 這條線和 hover 重試同一個道理。

判斷本身抽成 `upgrade.ts` 的 `stuckPlan()`,純函式、有測試。
`index.ts` 裡不留第二份 —— §CL、§BR 已經教過兩次了。

### CQ-3. 順手把三個沉默補上

看門狗讓症狀消失,但**下一次還是要知道是誰扣著**:

- `post-failed`:譯文送不到 tab 時寫一則 warn(原本是空的 catch)
- `stale-message`:pageKey 對不上而丟掉的結果,寫下丟了幾筆、丟給誰
- `queue-remains` / `enqueued`:worker 佇列的深度從 `dbg` 升成 `diag`,
  這樣匯出的 log 裡兩側的數字可以對起來 —— 內容腳本說「在佇列裡」,
  worker 說「佇列是空的」,那就是投遞掉的。

「翻譯這一頁」也一併認得卡住:那五塊的 `l1Queued` 旗標早就過期了,
使用者親手按的動作不該被它擋下來(`unstuck` 進 diag)。

## CR. 診斷工具自己在說謊

使用者:「清了 cache 再翻一次,還是有 L0,只是換不同點了。」

我打開那份 log,看到五次 `queue-l1` 只有兩次配得到 worker 的 `enqueued`,
差點就把它當成「訊息掉了」的鐵證寫進修正裡。**那個推論是錯的。**

### CR-1. 兩個 realm 共用一個環狀緩衝

`diag()` 的 flush 是「讀 → 合併 → 寫」,而 content script 與 service worker
是兩個不同的 JS realm,寫同一個 `chrome.storage.session` 的 key:

```
content: get(diag) → [A,B]        worker: get(diag) → [A,B]
content: set([A,B,C,D])
                                  worker: set([A,B,X])     ← C、D 沒了
```

同一個 context 裡也會自己蓋自己(700ms 的 debounce 一多就重疊)。
**匯出的 log 少了什麼,和發生了什麼完全沒有關係。**

修法:每個 scope 一把鑰匙(`diag:content` / `diag:worker` / `diag:popup`),
讀的時候合併排序;同一個 context 裡的 flush 串成 promise chain。
兩邊各自 300 則,不再互相擠掉對方。

### CR-2. 自己的雜訊把自己的訊號擠掉

`clip-to-container` 佔掉了那份 log 300 格裡的 250 格。它的守門條件是
「`clipped` 變了才寫」,而 `clipped` 每次 flush 都在 2↔12 之間跳 ——
等於沒有守門。使用者問「為什麼還有 L0」,能回答的那幾行早就被擠掉了。

真正的訊號是 `noClipper`(大 = 根本沒找到捲動容器),它是穩定的。
改成只有 `noClipper` 變了才進 log,`clipped` 的抖動降級給 `dbg`。

**日誌的容量是有限的,寫進去的每一則都在擠掉別的東西。**

### CR-3. 兩側的佇列並排

`page-status` 這條訊息在協定裡宣告了很久,從來沒有人實作它。現在實作了:
worker 回報佇列深度,報告把它和內容腳本這一側並排:

```
- L1 佇列:頁面認為 5 塊在排隊(最舊 132s)· worker 佇列本頁 0 / 全部 0
  - **兩側對不起來:訊息掉在中間,或譯文送回來時掉了**
```

一個數字看不出東西,兩個數字擺在一起才有對帳的可能。

## CS. `send()` 的註解是假的

```ts
chrome.runtime.sendMessage(msg).catch(() => {
  /* service worker 正在回收,下一次動作會重試 */
});
```

對 `enqueue` 來說**沒有下一次動作**:`queueUpgrade()` 送出的當下就把區塊
標成 `l1Queued = true`,訊息掉了就沒有人會再送一次,那一塊從此停在 L0。

而 MV3 的 service worker 閒置 30 秒就回收,回收與喚醒之間
`chrome.runtime.sendMessage` 會直接 reject —— 這不是罕見狀況,
是**每一頁安靜幾十秒之後的常態**。§CQ 的看門狗會在 45 秒後接手,
但那是止血,不是修好。

現在重試三次(300 / 600ms),三次都失敗才記一筆 `send-failed`。
重試是安全的:`enqueue` 在 worker 端以 id 去重,`reprioritize` 與
`drop-page` 本來就冪等。

## CT. 缺句補一次

`5 個區塊未通過 id 紀律檢查 (missing-id)` —— 那五塊當場變成 `l1-failed`,
唯一的出路是使用者自己滑上去重試。於是每一頁都剩下幾塊沒升級,
而且每次剩的都不一樣:「還是有 L0,只是換不同點了」。

缺的那幾筆原封不動丟回同一個佇列,由排程器和別的區塊重新湊批。
這**不是** §5.4 說的「縮小 chunk 再戰追缺句」:沒有切小、沒有改協定,
和「整批回 0 筆就重送」同一個道理。`attempts` 卡上限,只補一次。

對滑(`echo-swap`)不在此列 —— 那是整批不可信,重送也還是不可信。

## CU. `aria-hidden` 不等於看不見

使用者:「像這個標題沒翻……這看起來是有點搞笑。」

```html
<h1 aria-label="Anthropic's approach to teaching and learning AI">
  <span class="word" aria-hidden="true">Anthropic's</span>
  <span class="word" aria-hidden="true">approach</span> …
```

這是逐字進場動畫的標準寫法:整句話放進 `aria-label` 給螢幕閱讀器,
畫面上真正看得到的每一個字標成 `aria-hidden`,免得讀兩次。
而 `EXCLUDE_SELECTOR` 的第一項就是 `[aria-hidden="true"]` ——
於是**整頁最大的那行字,因為對螢幕閱讀器隱藏,所以對眼睛也不翻了。**

`aria-hidden` 的定義是「對輔助技術隱藏」,Kasanemu 疊的是**眼睛看到的東西**。
兩者不只是不同,常常剛好相反。真正的「看不見」由 CSS 回答,
而那個判斷本來就有(`isInvisible` / sr-only / `getClientRects`)。

新規則:`aria-hidden="true"` **而且畫面上沒有繪製面積**才排除。
Gmail 那個 `<div role="tooltip" aria-hidden="true">Download</div>` 是
display:none 的,照樣擋得住 —— 原本要擋的那一半一個都沒放掉。

fixture 兩個方向都放了(§CM):看得見的逐字標題要翻成**一塊**,
display:none 的提示框不能翻。把規則改回舊版,probe 立刻報
`aria-hidden 逐字標題:整行沒翻`。

## CV. 一塊翻好的字被降級成紅色

使用者:「看起來要多按幾次才行。」

log 終於問得出東西了(§CR 之後),而它一次就指到了:

```
09:25:25 ! batch-parsed {"dupe":1,"failures":["u31 duplicate-id"],"got":5,"kept":4}
09:28:09 ! batch-parsed {"dupe":1,"failures":["u36 duplicate-id"],"got":7,"kept":6}
09:28:32 ! batch-parsed {"dupe":1,"failures":["u50 duplicate-id"],"got":6,"kept":5}
```

三次 `duplicate-id`,三塊區塊。而 `duplicate-id` 記在**第二次**出現的
那一筆上 —— 第一次早就進了 `results`。也就是說**那三塊翻好了**,
只是模型多回了一份。

而 results 與 failures 是兩則訊息,results 先到:

```
post(results)   → u31 拿到譯文,tier = 'l1'
post(failures)  → u31 reason=duplicate-id,tier = 'l1-failed'   ← 冤枉
```

於是提示線變紅,而唯一的出路是使用者滑上去、或者按「翻譯這一頁」。
`translate-page {"retried":2}` 就是這麼來的 ——「要多按幾次」不是錯覺,
**是每一次 duplicate-id 都製造一塊需要手動救援的區塊。**

修法在兩層:
- `parseBatch` 把已經有結果的 id 從 failures 裡濾掉。重覆的 id 仍然
  留在 `stats.dupe`(協定紀律的訊號該看見),但它不是「這塊沒翻到」。
- 內容腳本加一條不變式:**`l1Text` 已經有值的區塊永遠不接受失敗標記**。
  worker 那側已經不會再送了,但這條便宜,而且它防的是下一條路徑。

## CW. 等在後面不是卡住

同一份 log 也抓到 §CQ 的看門狗做多了:

```
09:28:47 ! l1-stuck {"oldestMs":45754,"requeued":1,"stuck":1}
09:28:47   enqueued {"asked":1,"queue":16}      ← worker 佇列裡有 16 塊
```

那一塊「卡了 45 秒」的同一秒,worker 的佇列深度是 16 —— 它一直好好地
排在隊伍裡,只是前面還有十幾塊(那一輪 L1 佇列一度到 46)。重排是個
no-op(worker 端以 id 去重),卻白白花掉那一塊唯一的重試預算:
**下一次它真的掉了,看門狗會直接判它失敗。**

看門狗不必猜:§CR-3 剛做的 `page-status` 現在可以帶 `ids` 回答
「這幾筆還在不在你手上」。逾時之後先問一次 ——

- 在佇列裡 → 塞車,碼表歸零(`l1CheckedAt`)繼續等
- 不在 → 真的不見了,才重排

同一份 log 的第二次就是真的:`enqueued {"asked":1,"queue":1}`
(佇列本來是空的),重排之後 2 秒就回來了。**兩種情況長得一模一樣,
差別只有問一句話。**

順帶把按鈕的回音也講清楚:原本說「這幾塊已經在升級佇列裡了」,
沒說錯,但沒有回答**還要等多久**,所以看起來像沒反應。
改成「這 2 塊在佇列裡,前面還有 14 塊」—— 排隊和當機是兩件事,
使用者看得出差別就不會一直按。

## CX. 36 站稽核:一次看整個常看的網路,而不是一次一張截圖

收關文字階段之前,用台灣讀者常看的美日內容站 + CS 技術站(36 個網址,
`scripts/sites.txt`)跑了一輪批次稽核(`scripts/audit-sites.mjs`):
每站載入、捲一遍、把「沒人接手的可見文字」按 `explainCandidate` 的
原因彙總。§CE 的單頁稽核回答「這一頁哪裡漏了」;這一輪回答的是
**「規則對整個網路成不成立」**。

(環境註:這個沙箱的 egress 會 reset Chromium 的 TLS 指紋,curl 卻通 ——
所以稽核把每個請求都攔下來由 Node fetch 代抓再回填。)

第一輪的結果很難看,而且**最大的一桶指向同一個病根**:

### CX-1. `display: contents` 不是 sr-only(902 段)

sr-only 的判定看「有沒有繪製面積」,而 `display: contents` 的元素
**自己沒有盒子**,`getClientRects()` 永遠是空的 —— 但子孫照常渲染。
MDN 的 `<main>`、react.dev 的版面包裝都是這種寫法,於是**整個
`<main>` 被判成螢幕閱讀器專用,子樹整棵剪掉**:MDN 一頁漏 238 段。
§CH 的快照早就踩過同一個坑:量測工具對 `display:contents` 一律說謊。

修完:MDN 漏 53%→9%,4gamer 78%→0%(604 段→3 段)。

### CX-2. 兩邊都 ≤32px 的是圖示,不是圖(384 段)

媒體判定只看面積(≥20×20),而 react.dev 每個標題裡的錨點連結圖示是
24×24 —— 過了門檻,於是**每一個 `<h2>` 都被當成圖文混排**整段跳過。
`isRealMedia`:面積夠**而且**至少一邊 >32px 才算圖。
`mediaSplitOf` 同步換這把尺 —— 兩份判準會分岔(§CL 第五次)。

### CX-3. 行內媒體:放棄的粒度錯了

`<p>文字 <公式> 文字</p>` 舊版整段放棄 —— 維基百科的日常,一段夾三個
行內公式就一個字都不翻。改成照 mediaSplitOf 同一個精神**在媒體節點處
把 run 切開**,前後文字各自成段;再用實測幾何把關:段的聯集矩形
(疊層真正畫的形狀)蓋到媒體就放棄那一段 —— 折行的段會蓋回公式,
這條護欄擋住它。維基一頁 660 漏→419,單元 +66。

### CX-4. `<article>` 裡的 header/footer 是文章的頭尾,不是站台的

Wired 把標題、副標、日期全放在 `<article><header>` 裡 —— 整篇文章
最重要的三行字被當成站台外殼。HTML 規格本來就這樣定義:sectioning
content 裡的 header/footer 屬於那個 section。`closest('article')`
有值就不是外殼。

### CX-5. FORM 從硬排除降到外殼待遇

github.blog 的電子報表單有一段行銷文案,舊規則整個 `<form>` 硬排除,
那段文字連 hover 都翻不到。控件(BUTTON/INPUT/SELECT/TEXTAREA)照舊
硬排除,表單裡的**文字**現在與導覽列同級:不畫疊層,滑上去翻得到。

### CX-6. explain 又少了兩條(第五、六次)

「符合所有規則」那桶裡有 46 段其實在**收折的 `<details>`** 裡、
另有幾百段在被誤判 sr-only 的祖先下 —— explainCandidate 都沒模擬,
於是稽核在喊狼來了。補上這兩條之後,「應該會成為單元」桶 902→3。
同一個教訓的第五次和第六次:**兩份判斷必然分岔,分岔必然說謊。**

### CX-7. 收關數字

36 站全跑完。剩下漏 >15% 的站都逐一驗過原因,不是規則錯:
隱藏的下拉選單與 cookie 對話框(不可見,本來就不該翻)、頁尾/導覽
外殼(hover 可及,設計如此)、擋爬蟲的頁(stackoverflow / stripe 是
Cloudflare 擋掉的 404)、進場動畫 opacity:0(真實使用時 scan 會補掃)。

## CY. queue 收關:review 的結論是「病根不在決策,在寫入」

queue 修了七八次(missing-id 補送、空回應重送、看門狗、對帳),
每次都是使用者踩到才發現。收關 review 找到兩件結構性的事:

### CY-1. 佇列的 read-modify-write 沒有序列化

`enqueue`(訊息)、`reprioritize`(捲動)、`dropPage`(換頁)、
`drain`(排程)各自「load → 改 → save」,之間全是 await 邊界。
交錯的結果是後寫的把先寫的蓋掉:drain 把做完的 batch 移出佇列存檔,
捲動觸發的 reprioritize 拿著**舊版佇列**改完優先序存回去 ——
做完的項目復活,再跑一遍。快取擋住了帳單,擋不住浪費;而且每次
捲動都在賭。§CR 的 diag 互蓋是同一個病。

所有寫入現在走 `mutateQueue(fn)`:單一 promise chain,fn 拿到剛讀的
佇列、回傳新佇列。scheduler 裡不再有裸的 saveQueue。

### CY-2. 決策邏輯抽成 queuelogic.ts,純函式、有測試

切批(同群組、priority 排序、兩個上限、**一筆超限也要送得出去**)、
去重(`appendNew`,看門狗重排的冪等靠它)、退避(`backoffMs`)、
湊批等待(`aggregateWaitMs`,重試的不等)—— 全部抽出來,
一行 chrome API 都沒有,11 條測試把每一條修過的規則釘住。
scheduler.ts 只剩下 IO 與流程。

## CZ. 文章標題本身是永久連結

使用者:「這個沒翻到」——

```html
<h2 class="entry-title"><a href="/2026/autonomy-and-innovation/">Autonomy and Innovation</a></h2>
```

截圖裡整篇內文都翻好了,就標題那一行是英文。

`isUiLabel()` 最後一條規則是「文字**全部**來自互動子孫 → 那是按鈕列」。
它看到的是「一個連結、23 個字、沒超過 24 字門檻」,於是**整篇文章的
標題**被判成 UI 標籤,降級成滑上去才看得到的貼片
(log 裡那則 `adhoc-label {"chars":23,"tag":"H2"}` 就是它)。

這是 stratechery 的寫法,也是**每一個 WordPress 版型**的寫法:
標題本身就是永久連結。

頁面自己用 `<h2>` 宣告了「這是標題」;被連結包著只代表可以點,
不改變它是內容。那條 24 字門檻是為了**自繪的** UI 調出來的
(Gmail 左欄的 Mail / Chat / Labels),而那些用的是
`<div role="heading">` —— 上面那條規則專門收它,兩者不衝突。

所以:**真正的標題標籤(h1–h6)一律不是 UI 標籤。**
應用程式外殼裡的標題(nav / header / footer / aside 底下的)早在
`isAppChrome` 就整棵擋掉了,根本走不到這一條。

fixture 兩個方向都放:永久連結標題要成為 H2 單元,
`<div role="heading">Labels</div>` 照舊不畫疊層。把規則拿掉,
probe 立刻報「永久連結標題:整行沒翻(被判成 UI 標籤)」。

stratechery 這一頁也收進 `scripts/sites.txt` 的回歸集。修完之後
那頁剩下的 31 段全部驗過,沒有一段是規則錯:頁尾的文章卡(外殼,
hover 可及)、分享 widget(`.robots-nocontent`,設計上排除)、
導覽與抬頭。**唯一真正的缺口是一段 1576 字的段落超過
`MAX_UNIT_CHARS = 1000`** —— 那是既有的設計上限(L1 payload 與
疊層幾何),不在這一輪動它,但它現在是靜默的,值得單獨處理。

## DA. 「段落不會有一千字」—— 錯的前提,而且三條路一起關上

使用者:「又一大段沒翻,前面都好好的?」附上的是 stratechery 的引言區塊:
一個貨真價實的 `<p class="wp-block-paragraph">`,**1576 個字,
一個子元素都沒有**。

`MAX_UNIT_CHARS = 1000` 的註解寫著「段落不會這麼長,超過就一定是
容器誤判」。**那個前提是錯的**,而錯的代價被三條路一起放大:

| 路徑 | 上限 | 結果 |
| --- | --- | --- |
| 疊翻(walk) | `MAX_UNIT_CHARS` 1000 | 靜默跳過,連提示線都沒有 |
| hover 貼片 | `ADHOC_MAX_CHARS` 500 | 滑上去也沒反應 |
| 選取貼片 | 同上 500 | log 裡兩則 `selection-skipped {"why":"too-long"}` |

那兩則 `selection-skipped`(627 字、1477 字)是使用者在試 ——
**每一個出口都被同一個錯誤前提關上了。**

### DA-1. 「是不是容器」有結構性的答案,不必用長度猜

`hasContainerChild()` 就是那個答案:底下有沒有帶文字的 block。
它可靠、有測試,而且不會誤傷散文。長度只是最後一道防線,
用來擋**還沒想到的結構** —— 所以門檻要訂在「真實散文絕對到不了」的
地方,不是「大部分段落到不了」。改成 4000 字(≈1000 token,
單筆仍塞得進 free 檔的 batch,靠 §CY 的「第一筆一定收」保證)。

### DA-2. 擋掉要留下痕跡

上一版這條規則完全靜默:那段引言不是失敗、不是跳過,就只是不存在。
現在門檻拉高之後撞到它才真的代表「有個結構我沒想到」,那更該看得見:
`oversizedUnits()` 收樣本,診斷報告直接列出
「**太長被擋掉 N 塊**(疑似容器誤判)」。做法和 `unparsedColors()` 一樣。

### DA-3. 選取和 hover 要分開

hover 是被動的,滑鼠掃過去就觸發,保守是對的。
選取是使用者拉了一段話出來明講「翻這個」—— 那和按「翻譯這一頁」
同一類(§CP-2:自動的規則可以保守,使用者親手做的動作不行)。
拆成 `SELECTION_MAX_CHARS = MAX_UNIT_CHARS`,貼片會很高,
但那是使用者自己要的,比「什麼都沒發生」好。

### DA-4. 收關

37 站重跑,**沒有任何一站再撞到長度上限**。stratechery 那頁 79 單元,
剩下的 30 段全部是外殼與 `.robots-nocontent`(hover 都翻得到)——
內文一段不漏。
