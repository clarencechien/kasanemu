# 驗收(PRD §12)

自動化測試蓋得到選取規則與 id 紀律(`npm test`,28 個)。
幾何與視覺沒有自動化的辦法 —— 疊層對不對只有眼睛看得出來,
所以這裡是每次改動後照著跑一遍的清單。

## 先跑本地 fixture

`tests/fixtures/layout.html` 把難處集中在一頁,不用連網、不用等真站台改版:

```bash
npm run build
# chrome://extensions 載入 dist/,然後開:
#   file:///…/kasanemu/tests/fixtures/layout.html
```

裡面刻意放了:sticky 工具列、nav / footer、長標題、同角色不同長度的段落組、
Georgia 襯線區塊、justify、環繞浮動圖的段落、`pre`/`code`、表格、
大量短 `li`、`column-count`、自帶背景的卡片、漸層背景、深色區塊、
以及三顆按鈕(動態新增 / 移除 / 假 SPA 換路由)。

file:// 需要在擴充的詳細資料頁打開「允許存取檔案網址」。

## 固定測試站台(§12.1)

fixture 過了以後,再跑這七類真站台:

1. 一般新聞長文(段落為主)
2. 技術文件(含 `code` 區塊、側邊導覽、表格)
3. GitHub README
4. 排版花俏的產品行銷頁(大字、卡片、非標準版面)
5. 論壇 / 討論串(大量短區塊)
6. 深色主題網站
7. 一個重度 SPA(捲動載入 + 換路由)

## 通過條件(§12.2)

- [ ] 沒有任何原文從疊層底下露出(`min-height` 這條在長譯文時最容易破)
- [ ] 同一排版角色的字級完全一致(同 `font-size` 分組必須共用同一級距)
- [ ] `code` / `pre` 區塊未被翻譯
- [ ] 導覽、按鈕、頁尾未被翻譯
- [ ] 捲動流暢,無可感知的卡頓(疊層在 document 座標系,捲動不該重算)
- [ ] SPA 換路由後疊層正確重建,無殘留
- [ ] 深色網站的疊層背景與文字色正確
- [ ] 429 時有可見的降級提示,不靜默失敗(popup 與 console 都要看得到)
- [ ] 全開 → hover → 移開,無閃爍(閃爍就是 `pointer-events` 破了)

## 另外要看的幾件事

- [ ] 按住 `Alt` 全部切標註樣式,放開還原
- [ ] 失敗的區塊提示線是虛線,且 console 有一行 warn(§6.5)
- [ ] popup 的 thoughts 欄位是 **0**(不是 0 就代表 thinking 沒關掉)
- [ ] 設定頁的模型 ID 驗證會把不存在的 ID 標紅(§5.2)
- [ ] 日預算用完後,quality / balanced 停止呼叫、free 仍可用(§8)
- [ ] 重新錨定一次(改視窗寬度)後,每頁 token 計數**沒有歸零**(§8 第 3 層)
- [ ] `prefers-reduced-motion: reduce` 下疊層直接切換,不轉場
- [ ] 快取:同一頁重新載入,首屏疊層 < 150ms 出現(§10.2)

## 效能怎麼量

Performance 面板錄一段捲動:

- 捲動期間不該有 `Recalculate Style` / `Layout` 的密集長條
- 改視窗寬度觸發的單次重新錨定,主執行緒佔用目標 < 16ms(500 區塊)
- 若看到 layout thrashing,先確認量測走的是 `canvas.measureText`
  (`src/content/measure.ts`),不是逐塊讀 `scrollHeight`
