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
  const contentH = spills ? (el.scrollHeight || 0) + bt + bb : 0;
  const contentW = spills ? (el.scrollWidth || 0) + bl + br : 0;
  return {
    rect: {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: Math.max(r.width, contentW),
      height: Math.max(r.height, contentH),
    },
    overflows: contentH > r.height + 1 || contentW > r.width + 1,
  };
}

