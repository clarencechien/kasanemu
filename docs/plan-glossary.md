# 詞表(glossary)規格 v0.1

> 狀態:**規格,未實作。** 動手前先跑 §7 的實驗。
> 相關:`docs/lessons.md` §15、`feature.md` §3.4、PRD §6.4。

## 1. 現況與問題

現在只有 `Settings.noTranslateTerms: string[]` —— **全域一份、而且只能「不翻」**。

它的實作是 `content/mask.ts` 的**私用區佔位符**:送出前把命中的詞換成
`` 之類的 PUA 字元,收到譯文再換回來;佔位符掉了就整筆判失敗。

兩個缺口:

1. **沒有「A 譯成 B」。** 想把 `attention` 固定譯成「注意力機制」做不到。
2. **沒有作用域。** 技術站要保護的 `Go` / `Rust` / `Swift`,在新聞站上
   應該照常翻成「去」「鏽」「迅速」。一份全域清單無法同時滿足兩邊。

## 2. 這個問題的關鍵:有兩條路,對模型的要求天差地遠

**這是整份規格最重要的一段,也是「26b/31b 能不能做詞表」的答案。**

### 路徑 A:佔位符(deterministic)

```
原文   The attention mechanism scales quadratically.
       ↓ mask:命中詞 → PUA
送出   The  mechanism scales quadratically.
       ↓ 模型翻譯(它根本沒看到那個詞)
回來    機制的複雜度是平方級的。
       ↓ restore:PUA → 目標字串
成品   注意力機制 機制的複雜度是平方級的。
```

**模型完全不參與**。`` 對模型是一個不認識的字元,它會原樣搬運。
所以:

- **26b / 31b / flash / flash-lite 全部可用。**
- **L0(Chrome Translator API)也可用** —— 它連 prompt 都沒有,
  但佔位符照樣搬得過去。這一點很重要:停在 L0 的區塊也要遵守詞表。
- 「不翻」= 目標字串等於原字串,和「譯成 B」是**同一個機制**,
  只差 restore 時填什麼。

代價:**周邊語法不會跟著調整**。模型看到的是一個名詞佔位符,
它翻出來的句子是圍著那個佔位符長的。上面的例子就露餡了 ——
` 機制` 換回來變成「注意力機制 機制」,因為原文的 `mechanism`
仍然被翻了一次。

→ **緩解:詞表的來源詞要涵蓋整個名詞片語**(登記 `attention mechanism`
而不是 `attention`)。這一條要寫進設定頁的說明。

### 路徑 B:prompt 詞表(靠模型)

在 system prompt 後面加一段:

```
9. 詞表(遇到左邊的詞,譯文一律用右邊的說法):
   attention mechanism → 注意力機制
   embedding → 嵌入向量
   Go → Go(不譯)
```

模型自己決定在句子裡怎麼安放,所以**語法是通順的**,也處理得了
大小寫變化、複數、所有格。

代價:**要模型聽話**。小模型會出現三種失敗:忽略詞表、只用一半、
把詞表本身當成要翻譯的內容輸出。而且詞表越長越糟(佔 prompt、
稀釋前面七條 id 紀律的規則 —— 對 free 檔那是**不能動的東西**)。

### 結論

| | 路徑 A 佔位符 | 路徑 B prompt |
| --- | --- | --- |
| 26b / 31b | ✅ | ❓ 要實測(§7) |
| flash-lite | ✅ | 大概可以 |
| flash | ✅ | 可以 |
| L0 Translator API | ✅ | ✗ 沒有 prompt |
| 語法通順 | ✗ 名詞片語要自己登記完整 | ✅ |
| id 紀律的風險 | 無 | 有(佔 prompt、稀釋規則) |
| 失敗會不會沉默 | ✗ 佔位符掉了 = 整筆失敗,看得見 | ✅ 會沉默 |

**所以預設走 A,B 是加分項。** 這也回答了「要不要加開關」:

> **要,但不是「小模型不給用詞表」。** 詞表對所有檔位都生效(路徑 A);
> 開關控制的是**要不要額外把詞表塞進 prompt**(路徑 B),
> 而它的預設值由檔位決定,不是由使用者猜。

## 3. 資料模型

```ts
/** 一條詞:to 省略 = 不翻(等同舊的 noTranslateTerms) */
export interface Term {
  from: string;
  to?: string;
  /** 大小寫敏感。預設 false;縮寫(API / IT / GO)要開 */
  cs?: boolean;
}

export interface Glossary {
  /** 顯示用的名字,例如「技術」「財經」 */
  name: string;
  terms: Term[];
}

interface Settings {
  /** 具名詞表。key 是穩定 id,不是 name(改名不該讓網域對應失效) */
  glossaries: Record<string, Glossary>;
  /** 一律生效,不需要掛 */
  globalGlossary: string[];       // ← 舊的 noTranslateTerms 遷移到這裡
  /** host pattern → 詞表 id[]。pattern 支援前綴 `*.` */
  glossaryBinding: Record<string, string[]>;
  /** 路徑 B:把詞表也寫進 prompt。'auto' = 依檔位決定(見 §5) */
  glossaryPrompt: 'auto' | 'on' | 'off';
}
```

**為什麼是 pattern → 詞表,不是 domain → 詞表**:

使用者的原問題是「應該 by domain name 嗎,還是再加個 meta 分類」。
答案是後者,理由是**複用**:`kubernetes.io`、`qiita.com`、`zenn.dev`、
`某人的 blog` 要保護的是同一批術語。逐一 by domain name 等於同一份清單
抄 N 遍,而且新網域永遠是空的。

具名詞表 + 綁定的話,新網域只要掛上「技術」就有全套。

一個網域可以掛多份(`*.github.io` → `["技術", "自家專案"]`),
解析結果是**聯集**。

### 解析

```ts
resolveGlossary(host, settings): Term[]
```

1. `globalGlossary` 的每一項轉成 `{from, to: undefined}`。
2. 所有 pattern 命中 host 的詞表,依序串接。
3. **依 `from` 長度由長到短排序**(`mask()` 已經這樣做了,
   但這裡是合併後的順序,要重排)—— 否則 `attention` 會先吃掉
   `attention mechanism`。
4. 同一個 `from` 出現兩次:**後面的贏**(具體的詞表覆蓋全域)。

## 4. 兩條路徑的實作

### 4.1 路徑 A(必做)

`mask()` 現在的簽名是 `mask(src, protect: string[])`,restore 時填回**原字串**。
改成接受 `Term[]`,restore 時填 `to ?? from`:

```ts
export function mask(src: string, protect: readonly Term[]): Masked
```

- `protectedFragments(el, terms)` 一併改成回傳 `Term[]`:
  行內 `code` / `translate="no"` 那些仍然是 `{from: t}`(不翻)。
- **L0 走同一條路**(`content/index.ts` 兩個呼叫點已經共用 `mask`),
  所以停在 L0 的區塊自動遵守詞表 —— 不需要額外工作。

### 4.2 路徑 B(加分)

`systemPrompt(targetLang, glossary?)` 多接一段:

- **只放有 `to` 的詞**(沒有 `to` 的已經被佔位符處理掉了,
  再寫進 prompt 只是浪費 token 又稀釋規則)。
- **上限 30 條 / 600 字**,超過就截斷並在 diag 記一筆
  `glossary-truncated`。理由:free 檔的 `batchTokens` 只有 2000,
  詞表不能把 batch 擠掉。
- 路徑 B 開著的時候,**路徑 A 對同一個詞就不做**(兩條同時做會變成
  「模型翻好了,restore 再蓋一次」)。決策要在一個地方做,不能兩份(§lessons 1)。

## 5. 開關與預設

```ts
function glossaryPromptEnabled(mode, spec: TierSpec): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return spec.glossaryPrompt === true;   // 'auto'
}
```

`TierSpec` 加一個能力旗標:

| 檔位 | modelId | `glossaryPrompt` 預設 |
| --- | --- | --- |
| quality | gemini-3.5-flash | `true` |
| balanced | gemini-3.5-flash-lite | `true` |
| free | gemma-4-31b-it | **`false`,除非 §7 的實驗過了** |

設定頁三選一:`依檔位自動(建議)` / `一律開` / `一律關`,
旁邊寫明白:「關掉不代表詞表失效 —— 詞表一律以佔位符生效,
這個開關只決定要不要額外請模型配合。」

## 6. 快取(容易漏掉的那一條)

**詞表的 hash 必須進快取 key。**

`cache.keyFor(src, lang, modelId, maxChars)` → 多一個 `glossaryHash`。

沒有這一條的話:改完詞表,舊譯文還在快取裡,看起來像「設了沒生效」——
而那正是 `docs/lessons.md` §2 那一類**沉默的失敗**。

hash 取**解析後**的 `Term[]`(排序後 JSON)的 `hash.ts` 短雜湊。
只算**這一筆真的命中的**詞,不是整份詞表 —— 否則加一個無關的詞
會讓整站的快取失效。

## 7. 動手前先跑的實驗(§lessons「先跑這個實驗」)

`scripts/probe-gemma.mjs` 加一組 `--glossary` 模式,回答:

> gemma-4-31b-it / gemma-3-26b-it 塞了詞表之後:
> 1. **遵循率**:該用詞表說法的地方,有幾成真的用了?
> 2. **副作用**:id 紀律的通過率有沒有下降?(這是關鍵 ——
>    寧可沒有詞表,也不能讓 echo 對位變差)
> 3. **詞表洩漏**:模型會不會把 `→` 那幾行當成要翻譯的內容輸出?

```bash
GEMINI_API_KEY=... node scripts/probe-gemma.mjs --glossary --runs=3
GEMINI_API_KEY=... node scripts/probe-gemma.mjs --glossary --model=gemma-3-26b-it
GEMINI_API_KEY=... node scripts/probe-gemma.mjs --glossary --model=gemini-3.5-flash-lite
```

**通過條件**:遵循率 ≥ 80%,而且 id 紀律通過率**與不帶詞表時相同**。
沒過就把該檔的 `glossaryPrompt` 留在 `false` —— 使用者仍然有路徑 A,
只是名詞片語要自己登記完整。

## 8. UI

**設定頁**:

- 詞表清單(新增 / 改名 / 刪除),每份一個 textarea,一行一條:
  ```
  attention mechanism → 注意力機制
  embedding → 嵌入向量
  Go                              # 沒有 → 就是「不翻」
  API!                            # 結尾 ! = 大小寫敏感
  ```
- 綁定表:一行一條 `pattern → 詞表名, 詞表名`。
- 全域詞表(舊的 `noTranslateTerms` 遷移過來)。
- 路徑 B 的三選一開關 + 上面那句說明。

**popup**:目前網域命中了哪幾份詞表、共幾條(一行就好)。
沒有這一行的話,「我明明設了」與「pattern 沒對上」看起來一模一樣。

**診斷報告**:命中的詞表名、生效的詞數、路徑 B 開或關、
`glossary-truncated` 有沒有發生。

## 9. 遷移

`noTranslateTerms` 直接讀進 `globalGlossary`,舊設定不會壞。
`Settings` 的讀取端保留一輪相容(讀到舊 key 就搬過去),下一版再拿掉。

## 10. 不做的事

- **不做自動術語抽取**(從頁面猜哪些是術語)。猜錯的代價是譯文被改壞,
  而使用者不會知道為什麼。
- **不做跨裝置同步**。`chrome.storage.local`,和其他設定一致;
  要搬用既有的匯出 / 匯入。
- **不做 regex**。使用者的原話是詞表,不是規則引擎;
  regex 會讓「為什麼這個詞被改了」變成無法回答的問題。
- **不在 L0 走路徑 B**（它沒有 prompt)。

## 11. 實作順序

1. §7 的實驗 —— **先跑,結果決定 free 檔的預設。**
2. 資料模型 + `resolveGlossary()`(純函式,測試先寫)。
3. `mask()` 改吃 `Term[]`,restore 填 `to ?? from`;既有測試要全過。
4. 快取 key 加 glossaryHash。
5. 設定頁 UI + 遷移。
6. 路徑 B(`systemPrompt` 帶詞表)+ 檔位開關。
7. popup 與診斷報告的可見性。
