/**
 * 這是不是一個 PWA(安裝成 app 的網站)視窗(§ED)。
 *
 * 為什麼要排除:網域狀態存在 `chrome.storage.local`,而**同一個 profile
 * 的 PWA 視窗和瀏覽器分頁共用它** —— 在瀏覽器啟用過的網域,同網域的
 * PWA 一開就自動啟動,hover 的免費 L0 就翻起來了。而 PWA 視窗**沒有
 * 擴充功能工具列**,popup 按不到 —— 使用者連關的地方都沒有。
 * 使用者的原話:「未啟用時會去翻譯 pwa 的內容,mouse over 就翻譯了」。
 *
 * 判斷靠 `display-mode`:瀏覽器分頁是 `browser`,安裝的 PWA 視窗是
 * manifest 指定的 standalone / minimal-ui / window-controls-overlay。
 *
 * **刻意不算 `fullscreen`**:普通分頁按 F11 或影片全螢幕時
 * `(display-mode: fullscreen)` 也會成立 —— 把全螢幕看影片的人的翻譯
 * 靜悄悄關掉,比漏掉極少數 display: fullscreen 的 PWA(遊戲那類)更糟。
 */
export const APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'window-controls-overlay'] as const;

export function isAppWindow(
  matches: (query: string) => boolean = (q) => window.matchMedia(q).matches,
): boolean {
  return APP_DISPLAY_MODES.some((m) => matches(`(display-mode: ${m})`));
}
