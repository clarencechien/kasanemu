import type { Stability } from '../shared/types';

/**
 * 捲動時要不要先把疊層藏起來。
 *
 * 這一條是為 Gmail 加的:內層容器捲動時,疊層在 document 座標上不會跟著動,
 * 於是不透明的盒子畫到別人的內容上 —— 那才是「破版」。先藏起來、靜下來
 * 再一次量、一次顯示,是唯一穩的做法。
 *
 * 但**同一條規則套在長文上就是純粹的干擾**:一般文章的段落在 document
 * 座標裡根本不會因為捲動而移動,藏了又顯示只換來閃爍。使用者的原話是
 * 「在非 gmail 的長文中 就會有一直閃的感覺」。
 *
 * 所以判準不是網域白名單,是**這一頁的座標會不會跑**:
 *
 *  - `appShell`:document 自己不捲(Gmail / Slack 這種應用程式外殼),
 *    真正的捲動全發生在內層容器裡 —— 一定要藏。
 *  - `innerScroll`:這一頁實際收到過內層容器的捲動事件 —— 證據比推測強,
 *    收到就從此開啟(一般文章一輩子收不到)。
 *
 * 白名單會漏掉沒列進去的網站,而且列不完;這兩個訊號是**行為**,
 * 不是身分,任何網站都適用。
 */
export function motionGuard(p: {
  stability: Stability;
  appShell: boolean;
  innerScroll: boolean;
}): boolean {
  if (p.stability === 'always') return false;
  if (p.stability === 'strict') return true;
  return p.appShell || p.innerScroll;
}

/**
 * 釘住的來源(sticky / fixed)捲動時要不要藏。
 *
 * 這一件和上面那條無關:pinned 單元的 document 座標**確實**會隨捲動改變,
 * 在任何頁面上都是。只有明講「我不在意、一直顯示」時才不藏。
 */
export function hidePinnedWhileScrolling(stability: Stability): boolean {
  return stability !== 'always';
}
