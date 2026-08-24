# 打包字型

這個目錄的 `.woff2` 是產生物,不進版控。重建:

```bash
pip install fonttools brotli
npm run fonts            # sans / Big5 前 3000 字 / 783 KB
npm run fonts -- --level=full --serif   # 5954 字 + 襯線體 / 3.73 MB
```

來源是 Google Fonts 的 Noto Sans TC / Noto Serif TC variable font,
授權 SIL Open Font License 1.1(隨 google/fonts repo 的 `ofl/` 目錄)。
散布這個擴充時要一併帶上 OFL 授權條文。

實測數字與取捨見 `docs/fonts.md`。沒有這些檔案時擴充仍然可用,
譯文會落到系統中文字型(跨站外觀就不一致了,見 §4.2 / D06)。
