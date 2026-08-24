# 字型 subset 實測(PRD 開放問題 2)

工具鏈:`scripts/fetch-fonts.mjs` → `python -m fontTools.subset` → woff2。
來源是 google/fonts 的 `NotoSansTC[wght].ttf` / `NotoSerifTC[wght].ttf`
(variable,300–700 一檔搞定,OFL 1.1)。

## 字集怎麼來的

不依賴外部字表:Big5 第一階(0xA440–0xC67E)本身就是「常用字」的定義,
用 Python 的 codecs 就地展開得到 5401 個漢字,再加

- ASCII、Latin-1 supplement
- general punctuation、CJK 標點、全形符號、CJK 相容形式
- 注音符號(技術文件偶爾出現)

合計 5954 個字元(`--level=full`),或前 3000 漢字版本 3553 個字元(`--level=core`)。

## 實測體積

| 檔 | 字元數 | woff2 |
|---|---|---|
| KsnmSansTC | 5954 | **1609 KB** |
| KsnmSerifTC | 5954 | **2210 KB** |
| KsnmSansTC | 3553 | **783 KB** |
| KsnmSerifTC | 3553 | **1044 KB** |

## 結論

PRD §4.2 的「目標單檔 < 300 KB」在 CJK variable font 上做不到。
壓縮後大約每字 250–350 bytes,300 KB 只夠 ~1000 字,而 1000 字的中文
會在正常網頁上漏字(豆腐塊)。Google Fonts 自家的 CJK woff2 之所以切成
上百個 unicode-range 分片,就是同一個物理限制。

三個選項,現在選的是 (a):

- **(a) 縮字集 + 只打包 sans。** 783 KB,在 §10.2 的 1.5 MB 預算內。
  襯線站台落到系統的 Songti TC / PMingLiU —— 跨站一致性在襯線那一小塊放棄。
  這是預設。
- **(b) 放寬體積預算。** 兩檔 full = 3.73 MB。自用、不上架、不經過 Chrome Web Store
  的下載,體積成本其實只有磁碟。要跨站完全一致就選這個:
  `npm run fonts -- --level=full --serif`。
- **(c) unicode-range 分片按需載入。** 覆蓋率與體積都最好,但要寫分片邏輯
  與 `@font-face` 產生器,而且 shadow DOM 內的字型載入時序會多一個變數。
  Phase 1 不做。

## 漏字的行為

`src/content/fonts.ts` 的 stack 尾端永遠留系統中文字型:

```
'KsnmSansTC', <來源 stack>, "PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif
```

subset 沒收到的字會由系統字型補上,不會出現豆腐塊,代價是那幾個字的字形
與周圍不一致。`assets/fonts/` 整個目錄不存在時(沒跑過 `npm run fonts`),
`probePackagedFonts()` 會偵測到並整站退回系統字型,不會留一頁破圖。

## 重建

```bash
pip install fonttools brotli
npm run fonts                            # 預設:sans + 3000 字
npm run fonts -- --level=full --serif    # 完整
```

woff2 是產生物,不進版控。散布擴充時要一併帶上 OFL 授權條文。
