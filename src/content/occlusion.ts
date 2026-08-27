/**
 * 疊層該不該藏起來 —— **原文看不到的地方,譯文也不該看得到**。
 *
 * 從 `index.ts` 抽出來的理由:這是一條很短的幾何規則,而它踩過兩次雷,
 * 兩次都只有在**真的瀏覽器**裡才看得出來(§CE 的 stretched link、
 * §DV 的 overflow 傳播)。抽出來 probe 才載得動它 —— 整個 index.ts
 * 一載進去就會開始跑翻譯。
 */

/**
 * 這一層的 overflow **是不是被傳播到視窗去了**。
 *
 * CSS 的規則:視窗的 overflow 取自 `<html>`;`<html>` 是 `visible` 的話
 * 改取自 `<body>`,而**被取走的那一個自己當作 `visible`**。
 *
 * `getComputedStyle` 回報的是**計算值**,不是使用值 —— 所以一個
 * `body { overflow-x: hidden }`(拿來擋橫向捲軸,到處都是)的站,
 * 這裡會讀到 `hidden/auto`,而 body 其實一格都沒裁。
 *
 * 使用者回報「內文都沒翻 只翻了 title」就是這個(§DV):thenewstack.io 的
 * body 是 `overflow-x: hidden` 而且高度剛好是一個視窗,於是**首屏以下的
 * 每一段都被判成「掉出 body 外面」**,譯文全部藏起來。同一份診斷說
 * 63 塊裡 60 塊拿到了 L1 譯文、零失敗 —— 兩邊都沒說謊。
 */
export function overflowGoesToViewport(el: Element): boolean {
  if (el === document.documentElement) return true;
  if (el !== document.body) return false;
  const html = getComputedStyle(document.documentElement);
  return html.overflowX === 'visible' && html.overflowY === 'visible';
}

/**
 * 元素是不是被某個祖先的 `overflow: hidden` 整個裁掉了。
 *
 * 這是「看不見的重複 DOM」的成因:輪播的另一份、隱藏的行動版選單。
 * 頁面把它裁掉了,而我們的疊層在最上層不受任何裁切,於是浮在無關的位置。
 *
 * build 15 用 `elementFromPoint` 做這件事,結果**把正確的疊層藏掉了** ——
 * 卡片常有一個絕對定位的 stretched link 蓋住整張卡,它既不是標題的祖先
 * 也不是子孫,命中測試就判成「被蓋住」。幾何判定沒有這個問題:
 * 只問「這個元素的矩形有沒有落在裁切框外面」,不管誰蓋在上面。
 *
 * 可捲動的容器**照樣算**:現在看不見就是看不見,使用者把它捲進來之後
 * 下一輪稽核會再把疊層放出來。
 */
/** 被誰裁掉的 —— `null` 代表沒有 */
export interface ClipReason {
  /** 裁掉它的那一層 */
  by: Element;
  /** 'self-zero' 自己是 0x0;'parent-zero' 那一層是 0x0;'outside' 掉出去了 */
  kind: 'self-zero' | 'parent-zero' | 'outside';
}

/**
 * 和 `clippedAway` 是同一支,只是**說得出是哪一層**。
 *
 * 分成兩個名字而不是兩份實作:執行時只要一個布林值,而稽核
 * (`scripts/audit-occlusion.mjs`)要的是「為什麼」。抄成兩份的話,
 * 稽核就會開始回答另一個問題,然後兩邊各說一套(§22-bis)。
 */
export function clipReason(el: Element): ClipReason | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { by: el, kind: 'self-zero' };
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    // 傳播到視窗去的那一層自己不裁(§DV)
    if (overflowGoesToViewport(p)) continue;
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    if (pr.width < 1 || pr.height < 1) return { by: p, kind: 'parent-zero' };
    const outside =
      r.right <= pr.left + 1 || r.left >= pr.right - 1 || r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1;
    if (outside) return { by: p, kind: 'outside' };
  }
  return null;
}

export function clippedAway(el: Element): boolean {
  return clipReason(el) !== null;
}
