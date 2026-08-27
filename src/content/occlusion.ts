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
/**
 * 這一層祖先**真的會裁切內容**嗎。
 *
 * 「overflow 不是 visible」只是必要條件 —— 把 overflow 傳播給視窗的那一層
 * (`overflowGoesToViewport`)自己一格都不裁。**這條判斷在這個檔案之外
 * 不可以再寫第二份**:§DV 修了 `clipReason()` 的那一份,而 `index.ts` 的
 * `clippers()` 裡還有一份沒跟著修 —— 於是同一個站、同一個症狀第三次回來
 * (§DZ):body 只有一個視窗高,捲過第一屏之後它的矩形整個在視窗上面,
 * 每一塊譯文都被「裁到 body 的範圍內」裁成零。
 * `tests/style.test.ts` 有一條 grep 守著這件事。
 */
export function clipsContent(el: Element): boolean {
  if (overflowGoesToViewport(el)) return false;
  const cs = getComputedStyle(el);
  return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
}

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
    if (!clipsContent(p)) continue;
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

/**
 * 找出視窗上下緣被 position: fixed / sticky 的頁面元素佔掉多少。
 *
 * 為什麼需要:原文捲到固定頁首**底下**會被蓋住,而我們的疊層 z-index 是
 * 2147483000,畫在頁首**上面** —— 位置完全正確,卻浮在頁首上。
 * 使用者一路回報的「跑到 header」就是這個,不是幾何錯位
 * (診斷 log 裡 position-drift 是零筆,座標一直都對)。
 *
 * 疊層的 pointer-events: none 在這裡第二次派上用場:
 * elementFromPoint 打不到我們自己,回來的一定是頁面的東西。
 */
export function chromeBand(y: number, top: boolean): number {
  return chromeBandDetail(y, top).band;
}

/**
 * 要算「門面」,至少要橫跨畫面的這個比例。
 *
 * **黏著的側欄不是門面**(§DY)。thenewstack.io 的 `div.sidebar-column`
 * 是 `position: sticky`、486px 高、只佔畫面寬的 **25%** ——
 * 而我們在畫面寬 25% / 50% / 75% 三點取樣、取最大的帶,
 * 75% 那一點正好落在它身上,於是**半個視窗被當成頁尾裁掉**。
 *
 * 三點取樣本身是對的:Gmail 的 Reply / Forward 列只佔左半邊,
 * 只在正中央取一次會漏掉。少的是「它有多寬」——
 * 門面橫跨畫面(Gmail 那條約半個畫面),側欄只佔一條(四分之一到三分之一)。
 * 0.45 取在中間,兩邊都留了餘裕。
 *
 * `pinnedBottom()` 早就有同一個判斷(`r.width >= 框寬的一半`),
 * 只是當時只用在容器底邊,沒有用在視窗門面上。
 */
export const CHROME_MIN_SPAN = 0.45;

/** 一組門面資訊 —— 稽核要問「是哪一個元素」,執行時只要數字 */
export interface BandDetail {
  band: number;
  /** 咬到上限了嗎 —— 上限是視窗的一半 */
  clamped: boolean;
  by: Element | null;
  raw: number;
}

export function chromeBandDetail(y: number, top: boolean): BandDetail {
  /*
   * 取樣三個 x,取最大的帶。
   *
   * 原本只在正中央取一次 —— 而 Gmail 的 Reply / Forward 列只佔左半邊,
   * 正中央那一點打到的是它右邊的空白。回報的「下面超出的部分」
   * 就是這樣漏掉的:整條列明明釘在那裡,我們卻量到 0。
   */
  let band = 0;
  let by: Element | null = null;
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = Math.round(window.innerWidth * ratio);
    const hit = document.elementFromPoint(x, y);
    for (let el: Element | null = hit; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      // 透明的覆蓋層不會擋住文字,不要當成頁首
      if (Number(cs.opacity) === 0 || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      // 黏著的欄不是門面(§DY)—— 門面橫跨畫面,側欄只佔一條
      if (r.width < window.innerWidth * CHROME_MIN_SPAN) break;
      const b = top ? r.bottom : window.innerHeight - r.top;
      if (b > band) {
        band = b;
        by = el;
      }
      break;
    }
  }
  const cap = window.innerHeight / 2;
  return { band: Math.max(0, Math.min(band, cap)), clamped: band > cap, by, raw: band };
}
