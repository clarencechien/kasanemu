import type { DocRect, Unit } from './unit';

/**
 * 疊層該蓋住的範圍,document 座標。
 *
 * 自己一個檔案、只有 type import:這一條規則出過兩次事
 * (一次是量測與驗證用了不同公式造成無限重排,一次是把沒被畫出來的元素
 * 撐成一個貼在視窗左上角的盒子),而它需要的只有 getComputedStyle 與 window,
 * 拆出來就測得到。
 *
 * **量測與驗證必須用同一個函式**:measureUnit 存的是取過 max 的高度,
 * 而 auditPositions 若拿原始的 border-box 去比,那 62 個「內容比盒子高」的
 * 區塊會永遠被判定成漂移 → 重排 → 再判定,每 600ms 空轉一次。
 * (實際發生過:診斷 log 被 dh≈7.5 / dx=0 / dy=0 的 position-drift 洗版。)
 */
const EMPTY: DocRect = { left: 0, top: 0, width: 0, height: 0 };

export function coverRect(unit: Unit): { rect: DocRect; overflows: boolean } {
  /*
   * 錨點是一段 Range 的時候,元素矩形完全不能用 —— 那個 `<p>` 或
   * `<div>` 還裝著表格、圖片、另外半段文字。問 Range 拿到的才是
   * 「這一段字實際佔的位置」。
   *
   * 也不做 scrollHeight 撐開:那是整個元素的內容高度,對一段文字沒有意義。
   */
  if (unit.range) {
    const rects = unit.range.getClientRects();
    if (rects.length === 0) return { rect: EMPTY, overflows: false };
    const r = unit.range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { rect: EMPTY, overflows: false };
    return {
      rect: {
        left: r.left + window.scrollX,
        top: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      },
      overflows: false,
    };
  }
  const el = unit.el as HTMLElement;
  /*
   * **沒有任何 client rect = 現在根本沒被畫出來**,一律回零。
   *
   * 這是「收折的 <details> 疊層堆到左上角」與「Gmail 的抬頭疊層跑到最上面」
   * 的共同病根,而且是同一個 bug:
   *
   *   getBoundingClientRect() → 0×0 @ (0,0)   ← 沒被畫出來
   *   scrollHeight / scrollWidth → **上一次的尺寸**  ← 佈局狀態被保留了
   *
   * 下面那段「內容比盒子大就撐開」於是把 0×0 撐成 W×H,座標卻還是 (0,0)
   * —— 換算成 document 座標就是 (scrollX, scrollY),也就是**視窗的左上角**。
   * 一整批這樣的疊層就全部堆在那裡,蓋掉真正在那個位置的內容。
   *
   * `content-visibility: hidden`(收折的 <details>)與 `content-visibility: auto`
   * (Gmail 對離開畫面的內容做的效能優化)都會製造這個狀態:
   * 佈局被跳過,但尺寸留著,好讓它能快速恢復。
   */
  if (el.getClientRects().length === 0) return { rect: EMPTY, overflows: false };
  const r = el.getBoundingClientRect();
  const [bt, br, bb, bl] = unit.style.border;
  /*
   * 原文的內容可能比自己的 border-box 大:固定 height + overflow: visible,
   * 或子元素有負 margin。照 border-box 蓋就會漏(標題底下露出半個 g)。
   *
   * **但只有 overflow: visible 才算。** 元素自己有裁切時,溢出的內容
   * 根本沒被畫出來,拿 scrollWidth 去撐大盒子只會蓋到旁邊的東西 ——
   * sr-only 的 1×1 元素配上 nowrap 長句,scrollWidth 是整句話的寬度,
   * 就是這樣長出一條橫跨整張卡的疊層。
   */
  const cs = getComputedStyle(el);
  const spills = cs.overflowX === 'visible' && cs.overflowY === 'visible';
  /*
   * 段落裡自己佔一行的圖片:疊層在圖片的邊界收住。
   *
   * 少了這一段,`<p>文字…<span class="flex"><img></span></p>` 只有兩條路 ——
   * 整段不翻(舊版),或是一塊不透明疊層把圖蓋掉。兩個都不對:
   * 文字與圖片在版面上本來就是上下分開的,照著分就好。
   *
   * 圖在上或在下用中心點判斷,不另外存欄位:兩個矩形都在手上,
   * 多存一個布林值只是多一個會過期的狀態。
   */
  let top = r.top;
  // r.height 而不是 r.bottom:同一個矩形的兩種說法,但假的 rect(測試、
  // 某些 polyfill)只保證有 height
  let bottom = r.top + r.height;
  if (unit.mediaSplit) {
    const m = unit.mediaSplit.getBoundingClientRect();
    if (m.width > 0 && m.height > 0) {
      const mid = m.top + m.height / 2;
      if (mid > r.top + r.height / 2) bottom = Math.min(bottom, m.top);
      else top = Math.max(top, m.top + m.height);
    }
  }
  const boxH = Math.max(0, bottom - top);
  // 有裁到就不再用 scrollHeight 撐開 —— 那個高度含圖片,撐開等於白裁
  const trimmed = boxH < r.height - 1;
  const contentH = spills && !trimmed ? (el.scrollHeight || 0) + bt + bb : 0;
  const contentW = spills ? (el.scrollWidth || 0) + bl + br : 0;
  return {
    rect: {
      left: r.left + window.scrollX,
      top: top + window.scrollY,
      width: Math.max(r.width, contentW),
      height: Math.max(boxH, contentH),
    },
    overflows: (!trimmed && contentH > r.height + 1) || contentW > r.width + 1,
  };
}


/**
 * 這個容器**真的會捲**嗎?
 *
 * `overflow: hidden` 有兩種完全不同的用途,而它們對疊層的意義相反:
 *
 *  - **捲動窗格**(Gmail 的郵件清單):內容會滑出邊界,底邊附近不可信,
 *    所以那裡要留一大塊保守餘裕,寧可少蓋。
 *  - **純粹的裁切**(ClickHouse 的 blockquote 用 overflow:hidden
 *    讓左側 ::before 的色條不超出圓角):內容一格都不會動。
 *
 * 對後者留餘裕是純粹的損失 —— 引文最後兩行的疊層被切掉、原文露出來,
 * 看起來就是使用者說的「翻了沒蓋完全」。而它甚至不是翻譯的問題。
 *
 * 分辨的方法不是看 overflow 的值,是看**內容有沒有超出可視區**。
 */
export function scrolls(el: {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}): boolean {
  return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
}

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * 疊層要裁掉多少才不會超出可見範圍。回傳 clip-path inset 的四個值。
 *
 * `rect` 是疊層畫在哪(視窗座標),`vis` 是「可以畫在哪」——
 * 固定頁首吃掉的、內層捲動容器裁掉的,都已經交集進去了。
 *
 * 交集為空時回傳「整塊裁掉」而不是負值或半條邊:原文完全看不到的時候,
 * 譯文露出一條邊比整塊不見更難看,而且更容易被誤認成 bug。
 */
export function clipInsets(rect: Box, vis: Box): Box {
  const h = rect.bottom - rect.top;
  const w = rect.right - rect.left;
  const top = Math.max(0, vis.top - rect.top);
  const left = Math.max(0, vis.left - rect.left);
  const bottom = Math.max(0, rect.bottom - vis.bottom);
  const right = Math.max(0, rect.right - vis.right);
  if (top + bottom >= h || left + right >= w) return { top: h, right: 0, bottom: 0, left: 0 };
  return { top, right, bottom, left };
}
