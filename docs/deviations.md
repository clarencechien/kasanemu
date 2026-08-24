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
