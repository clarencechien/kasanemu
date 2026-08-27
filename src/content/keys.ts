/**
 * 按鍵 → 該做什麼。**純函式,一份定義**(§EB)。
 *
 * 這個檔案存在的理由是一個 bug:放大檢視開著時,`onKeyDown` 除了 Esc
 * 全部提前 return —— Alt 根本走不到收層的程式碼,而黑窗自己印著
 * 「按住 Alt 看原圖」。probe 驗過 `setHiddenAll` 會把加註掀開,
 * 但它是直接呼叫 layer 驗的 —— 驗了機制,沒驗按鍵這條路。
 * 使用者在 Windows 和 Chromebook 上都按不出來,一句話定位:
 * 「是不是被外面的 alt 吃掉了」。
 *
 * 決策抽出來就測得到:wiring(index.ts)只剩 switch,不再有自己的判斷。
 */

/** 左 Alt 是 `'Alt'`,Windows 的右 Alt 是 `'AltGraph'` —— 對我們是同一顆鍵 */
export function isAltKey(key: string): boolean {
  return key === 'Alt' || key === 'AltGraph';
}

export interface KeyCtx {
  /** 放大檢視(黑窗)開著嗎 */
  zoomOpen: boolean;
  /** 整層已經收起來了嗎(Alt 按住中) */
  hiddenAll: boolean;
}

export type KeyDownAct =
  /** Esc 關掉放大檢視 —— 全螢幕的東西開著,Esc 的意圖百分之百是關它 */
  | 'close-zoom'
  /** 按住 Alt:收文字疊層 + 收圖片加註 + 收 chip */
  | 'hide'
  /**
   * 按住 Alt,但放大檢視開著:只掀加註(`setHiddenAll` 會替黑窗掛 lift),
   * **不收黑窗、不動行內** —— 使用者要的是「看原圖」不是「離開」。
   */
  | 'hide-keep-zoom'
  /** Alt 之後來了別的鍵 = 和弦,不是「我想看原文」—— 放回去 */
  | 'restore'
  | 'none';

export function keyDownAct(key: string, shift: boolean, ctx: KeyCtx): KeyDownAct {
  // Alt 的判斷在 zoom 守門**前面** —— 順序反過來就是 §EB 的事故
  if (isAltKey(key) && !shift && !ctx.hiddenAll) {
    return ctx.zoomOpen ? 'hide-keep-zoom' : 'hide';
  }
  if (ctx.zoomOpen) return key === 'Escape' ? 'close-zoom' : 'none';
  if (ctx.hiddenAll && !isAltKey(key)) return 'restore';
  return 'none';
}

export function keyUpAct(key: string, ctx: KeyCtx): 'restore' | 'none' {
  return isAltKey(key) && ctx.hiddenAll ? 'restore' : 'none';
}
