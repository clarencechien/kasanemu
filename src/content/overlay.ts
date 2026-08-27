import type { DisplayMode, Settings } from '../shared/types';
import type { PlacedBlock } from './imagegeo';
import { SINGLE_LINE_CHARS } from '../shared/imageblocks';
import { fontFaceCss, fontStack } from './fonts';
import { annotBg, annotFg, hintColor } from './styleprobe';
import { LETTER_SPACING_EM, activeText, effectiveFontSize, type Unit } from './unit';
import { place, type ViewRect } from './annotate';
import { hintClassFor } from './upgrade';

/**
 * §3.3 疊層掛在單一 document 層級的容器上。
 * 絕對不可插進來源元素的容器內:祖先的 overflow: hidden、z-index
 * stacking context、transform 都會破壞定位。
 * §11.1 容器用 closed shadow DOM,樣式不受頁面 CSS 影響。
 */
export const HOST_ID = 'kasanemu-root';

/** feature.md §4.5 過場刻意短。越明顯的動畫越吸引注意,替換應該低調。 */
const SWAP_MS = 80;

export const LAYER_CSS = `
:host { all: initial; }
.layer {
  position: absolute;
  inset: 0;
  /* §2.2 硬性要求:疊層一旦接收 hover 就會無限閃爍。此限制不可協商。 */
  pointer-events: none;
  /*
   * **不要**在這裡放 2147483000。
   *
   * 那個值屬於 host(#kasanemu-root),它負責把整個疊層放到頁面最上層。
   * shadow root **裡面**是另一個世界,只需要決定我們自己這幾個節點的先後。
   * 先前這裡也放了 2147483000,於是貼片的 z-index: 5 永遠贏不了 ——
   * 回報的「tip 還是被蓋在 layer 下」就是這個,而我上一輪只加了貼片的
   * z-index、沒看這一行。
   */
  z-index: 0;
}
.box, .ghost {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: normal;
  line-break: strict;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  letter-spacing: ${LETTER_SPACING_EM}em;
  background: var(--ksnm-bg);
  color: var(--ksnm-fg);
  font-family: var(--ksnm-ff);
  font-size: var(--ksnm-size);
  font-weight: var(--ksnm-weight);
  font-style: var(--ksnm-style);
  line-height: var(--ksnm-lh);
  text-align: var(--ksnm-align);
  direction: var(--ksnm-dir);
  padding: var(--ksnm-pad);
  border-radius: var(--ksnm-radius);
  left: var(--ksnm-x);
  top: var(--ksnm-y);
  width: var(--ksnm-w);
  /* §3.3 min-height 解掉「疊一半、原文尾巴露出來」 */
  min-height: var(--ksnm-h);
  /* 被固定頁首 / 頁尾蓋住的部分要跟著原文一起消失,見 applyChromeClip */
  clip-path: var(--ksnm-clip, none);
  opacity: 0;
  transition: opacity 130ms ease;
}
/* §4.4 單行元素允許橫向溢出,不加入字級分組 (D15) */
.box.single, .ghost.single {
  width: max-content;
  min-width: var(--ksnm-w);
  max-width: none;
  white-space: nowrap;
}
/* §2.1 全開:顯示譯文,滑過的區塊淡出露出原文 */
.layer.mode-full .box { opacity: 1; }
.layer.mode-full .box.hovered { opacity: 0; }
/* §2.1 點閱:疊層預設隱藏,滑過才顯示 */
.layer.mode-peek .box { opacity: 0; }
.layer.mode-peek .box.hovered { opacity: 1; }
/*
 * feature.md §4.5 cross-fade:舊譯文的複本疊在上面淡出,
 * 新譯文已經在下面就位。幾何完全相同,所以看起來只是字換掉。
 */
.ghost {
  opacity: 1;
  transition: opacity ${SWAP_MS}ms linear;
  z-index: 1;
}
.ghost.out { opacity: 0; }
/* §4.6 標註樣式:fallback、按住 Alt 掃視、或 options 指定 */
.layer.alt-scan .box,
.box.annotate {
  background: var(--ksnm-annot-bg);
  color: var(--ksnm-annot-fg);
  font-family: var(--ksnm-annot-ff);
  font-weight: 400;
  font-size: var(--ksnm-annot-size);
  border-radius: 5px;
}
.layer.alt-scan .box { opacity: 1; }
/*
 * 全部收起來(按住 Alt,hold 不是 toggle —— 見 keys.ts)。
 *
 * 和「點閱模式」不一樣:點閱是滑過才顯示,這個是**整層完全不在**,
 * 連提示線都收掉,像沒裝這個擴充一樣。用在「這一頁我想直接讀原文」。
 *
 * 刻意不停止翻譯:譯文留在記憶體裡,再按一次立刻全部回來,不必重翻。
 */
.layer.hidden-all { display: none; }
/* 來源元素其實看不見(被裁切、隱藏的重複 DOM)→ 疊層也不該出現 */
.box.covered, .hint.covered { display: none; }
/*
 * 內層容器正在捲動 —— 疊層在 document 座標,不會跟著動。
 *
 * 視窗捲動時瀏覽器自己搬疊層,零延遲;但 Gmail 這種在 <div> 裡面捲的
 * 應用程式,document 根本沒動,只能由 JS 追 —— 而 JS 永遠慢合成器一幀。
 * 追不上就會「疊層在滑」。
 *
 * 所以捲的當下**先藏起來**(看得到原文),停下來重新量好再出現。
 * 這和貼片捲動時直接關掉是同一個判斷:錯位的疊層比暫時看原文更糟。
 * 用獨立的 class,不跟 covered 打架 —— 那個是遮擋判定,這個是暫時失效。
 */
.box.stale, .hint.stale { visibility: hidden; }
/*
 * §4.7 提示線是唯一表明「這是譯文」的記號;hover 時保留。
 * feature.md §5.1 / D22:並且以虛實與顏色表明階層 ——
 * 這是安全需求,不是美觀選項。L0 打底會讓 L1 的失敗變隱形。
 */
.hint {
  position: absolute;
  left: var(--ksnm-hx);
  top: var(--ksnm-hy);
  width: 2px;
  height: var(--ksnm-hh);
  border-radius: 1px;
  opacity: 0.4;
  background: var(--ksnm-hint);
  /* 跟盒子一樣要被固定頁首裁掉 —— 之前只裁盒子,線照樣畫在 header 上 */
  clip-path: var(--ksnm-clip, none);
}
/* l1:頁面連結色,實線(Phase 1 樣式) */
.hint.l1 { opacity: 0.4; background: var(--ksnm-hint); }
/* l0:頁面連結色,虛線,更淡 —— 掃一眼就知道整頁還停在 L0 */
.hint.l0 {
  opacity: 0.25;
  background: repeating-linear-gradient(
    to bottom,
    var(--ksnm-hint) 0 3px,
    transparent 3px 6px
  );
}
/* l1-failed:警示色,實線(有 L0 可讀,但升級管線死了) */
.hint.warn { opacity: 0.85; background: var(--ksnm-warn); }
/* failed:警示色,虛線(連原文都只能自己看) */
.hint.warn.dashed {
  background: repeating-linear-gradient(
    to bottom,
    var(--ksnm-warn) 0 3px,
    transparent 3px 6px
  );
}
/*
 * 加翻貼片(docs/plan-annotation.md §4.3)。
 *
 * position: fixed,所以它是 shadow root 裡與 .layer 平行的兄弟節點,
 * 不能待在 .layer 裡面 —— .layer 帶 clip-path,而 build 14 已經用
 * 「HUD 在被 transform 的祖先裡就不再相對視窗定位」付過一次學費。
 *
 * 背景一律不透明(§2.2)。「淡」是靠小字級、低彩度、以及**只在被指名時出現**,
 * 不是靠 alpha —— 字疊字是糊的,不是淡的。
 */
.chip {
  position: fixed;
  left: var(--ksnm-cx);
  top: var(--ksnm-cy);
  /* 選取一整段註解時會有十行左右,窄一點的欄位會變成很高的柱子 */
  max-width: 26em;
  max-height: 60vh;
  overflow: hidden;
  box-sizing: border-box;
  margin: 0;
  padding: 3px 9px 3px 10px;
  border: 1px solid var(--ksnm-chip-line);
  border-radius: 5px;
  background: var(--ksnm-chip-bg);
  color: var(--ksnm-chip-fg);
  font-family: var(--ksnm-chip-ff);
  font-size: var(--ksnm-chip-size);
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: ${LETTER_SPACING_EM}em;
  text-align: left;
  direction: ltr;
  white-space: normal;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  /*
   * 貼片是「指名要看的東西」,一定要在最上面。
   *
   * 先前沒給 z-index,靠的是 shadow root 裡的 DOM 順序(.layer 在前、
   * 貼片在後)—— 而 .layer 一旦因為原點修正拿到 transform 就變成
   * 堆疊脈絡,順序就不保證了。回報的「tip 被蓋到」就是這樣。
   * 明寫比依賴順序可靠。
   */
  z-index: 5;
}
.chip.show { opacity: 1; }
/* 左緣階層條:沿用提示線的語彙,L0 斜紋、L1 實線、失敗警示色 */
.chip::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 2px;
  border-radius: 2px;
  background: var(--ksnm-chip-bar);
}
.chip.l0::before {
  background: repeating-linear-gradient(
    to bottom,
    var(--ksnm-chip-bar) 0 3px,
    transparent 3px 6px
  );
}
.chip.warn::before { background: #c0392b; }
/*
 * 可按的貼片(只有圖片 cue)。
 *
 * 看起來要像**按鈕**:整層其他東西一律不吃滑鼠事件,所以「這個可以點」
 * 沒有任何上下文可以推論 —— 只能靠自己長得不一樣。
 */
.chip.act {
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
  padding: 4px 11px 4px 12px;
  border-color: rgba(255, 74, 20, .55);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .22), inset 0 1px 0 rgba(255, 255, 255, .18);
}
.chip.act:hover {
  filter: brightness(1.25);
  border-color: #FF4A14;
  transform: translateY(-1px);
}
/* 兩層都失敗:顯示原文,但要看得出來這是「翻不出來」而不是譯文 */
.chip.warn { font-style: italic; }
@media (prefers-reduced-motion: reduce) {
  .chip { transition: none; }
}
/*
 * 頁內狀態列。使用者的原話:「翻譯中還是沒翻譯沒有明確的 status」。
 * 疊層本身看起來一樣,分不出「還在等」與「已經死了」,所以狀態要自己講。
 * pointer-events: none —— 與疊層同一條規則,不可攔截 hover。
 */
.hud {
  position: fixed;
  z-index: 4;
  left: 12px;
  bottom: 12px;
  pointer-events: none;
  background: rgba(16, 21, 27, 0.92);
  color: #e6edf3;
  font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.01em;
  padding: 6px 10px;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 200ms ease;
  max-width: 60vw;
}
.hud.show { opacity: 0.92; }
.hud.busy::before { content: '⋯ '; }
.hud.warn { background: #7a2318; color: #ffe8e3; }
.hud.warn::before { content: '✗ '; }
.panel {
  position: fixed;
  z-index: 6;
  right: 12px;
  bottom: 12px;
  width: 520px;
  max-width: calc(100vw - 24px);
  max-height: 52vh;
  overflow: auto;
  pointer-events: auto;
  background: #10151b;
  color: #e6edf3;
  font: 12px/1.5 ui-monospace, monospace;
  padding: 10px 12px;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
/* 除錯:把疊層盒子的邊界畫出來,一眼看出蓋到哪裡 */
.layer.outline .box { outline: 1px solid rgba(255, 80, 80, 0.9); outline-offset: 0; }
.layer.outline .box::after {
  content: attr(data-geom);
  position: absolute;
  right: 0;
  bottom: -14px;
  font: 10px/1 ui-monospace, monospace;
  color: #ff5050;
  background: #000;
  padding: 1px 3px;
}
.panel h4 { margin: 0 0 6px; font-size: 12px; }
.panel table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.panel td, .panel th { vertical-align: top; padding: 3px 4px; border-top: 1px solid #263039; }
.panel th { text-align: left; color: #7f95a8; font-weight: 400; border-top: 0; }
.panel .s { color: #9db4c8; }
.panel .l0 { color: #9fd0a8; }
.panel .l1 { color: #ffe0a3; }
@media (prefers-reduced-motion: reduce) {
  .box, .ghost { transition: none; }
}

/* ═══════════════════════════════════ 圖片加註(docs/plan-images.md §2.1) */
/*
 * 加註,不是重繪。
 *
 * v0.1 的做法是取樣背景色畫不透明貼片,兩個死穴:配色永遠有例外(破版),
 * 小字縮到 11px 以下必糊。改走 sukemu 的 acetate —— 毛玻璃把原文壓暗退後,
 * 譯文帶白色光暈浮在其上。不用知道背景色、不裁切原圖、譯文長一點就長一點,
 * 因為使用者知道底下是原圖,移開滑鼠就還他。
 *
 * 疊在 document 座標裡(和內文疊層同一層),由瀏覽器自己跟著捲 ——
 * 不是 fixed + JS 追 scrollY,那條路 build 14 付過學費了。
 */
.imgwrap {
  position: absolute;
  left: var(--ksnm-ix);
  top: var(--ksnm-iy);
  width: var(--ksnm-iw);
  height: var(--ksnm-ih);
  opacity: 0;
  transition: opacity .22s ease;
  contain: layout style;
  /* 貼片可以長出自己的框,但**不可以長出圖片** —— 邊界在這一層 */
  overflow: hidden;
}
.imgwrap.show { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .imgwrap { transition: none; } }

.iblk {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  /*
   * **不裁切**:譯文的貼片是自己撐開的,短標籤會橫向長出框外
   * (§3.2「譯文超框:允許超出 box」)。真正的邊界是圖片本身,
   * 由 .imgwrap 的 overflow 管。
   */
  overflow: visible;
}
/*
 * veil = **毛玻璃**,不是壓平;**沒有邊**;而且**不住在自己的塊裡**。
 *
 * 走過四版,每一版都留下數字(docs/plan-images.md §13-7):
 *
 * - 抄來的 brightness(1.16):方向寫死,深底白字上原文殘留 9.7:1,
 *   等於沒蓋(§DH)。
 * - 換成 contrast(.2) 收斂:量得過(殘留 1.6:1),但把整塊壓成一片
 *   不透明亮帶 —— 收斂的代價是**底下那張圖也一起沒了**,
 *   而「你知道底下是原圖」正是這個設計的前提(§DJ-2)。
 * - 重模糊:破壞筆劃、不動明度。原文退場,而看得出底下是深色圖表還是
 *   白底截圖 —— 那就是毛玻璃感。代價是玻璃場的亮度不可預測,
 *   所以譯文不站在上面,它自己帶底。
 * - 拿掉方框(§DQ):前三版都是圓角矩形加邊框加陰影,
 *   一個帶邊框陰影的圓角矩形讀起來永遠是**貼在圖上的另一個物件**。
 *
 * **玻璃是一整層,不是每塊各自一片(§DR-1)。** 以前 veil 是 .iblk 的
 * 子元素,於是繪製順序 = 塊的順序:第二塊的灰玻璃畫在第一塊的譯文
 * **上面**。密集的圖上到處是「灰底蓋到白底」。現在所有的 veil 排在
 * 所有的 .iblk 前面 —— 玻璃永遠在下,字永遠在上,不管有幾塊、誰先誰後。
 *
 * 它因此需要自己的座標(JS 寫 left/top/width/height,外擴 VEIL_PAD),
 * 而不能再靠 inset: -8px 相對於父塊。
 */
.iveil {
  position: absolute;
  /* 外擴距離。JS 那邊的 VEIL_PAD 要跟這個一致 —— 它決定框畫多大 */
  --ksnm-pad: 26px;
  /*
   * 羽毛 = **兩道線性漸層相交**,不是一個橢圓(§DR-2)。
   *
   * 橢圓不認框的形狀:一個 480x120 的長標籤,橢圓的濃核只蓋得到中間,
   * 兩端的原文露出來(實測殘留 3.1 → 3.7,差點撞到 4 的門檻)。
   * 兩軸各自淡出、相交出來的是一個**四邊都軟的長方形** —— 跟著框長,
   * 而四個角因為兩軸相乘會更淡,所以還是沒有角。
   *
   * 用絕對長度不用百分比:羽毛的寬度是一個**視覺量**,不該因為框大小而變。
   * 全濃的位置正好落在原文框的邊上,所以整段淡出都發生在原文之外。
   */
  --ksnm-feather:
    linear-gradient(to right,
      transparent 0,
      rgba(0, 0, 0, .20) calc(var(--ksnm-pad) * .42),
      rgba(0, 0, 0, .68) calc(var(--ksnm-pad) * .76),
      #000 var(--ksnm-pad),
      #000 calc(100% - var(--ksnm-pad)),
      rgba(0, 0, 0, .68) calc(100% - var(--ksnm-pad) * .76),
      rgba(0, 0, 0, .20) calc(100% - var(--ksnm-pad) * .42),
      transparent 100%),
    linear-gradient(to bottom,
      transparent 0,
      rgba(0, 0, 0, .20) calc(var(--ksnm-pad) * .42),
      rgba(0, 0, 0, .68) calc(var(--ksnm-pad) * .76),
      #000 var(--ksnm-pad),
      #000 calc(100% - var(--ksnm-pad)),
      rgba(0, 0, 0, .68) calc(100% - var(--ksnm-pad) * .76),
      rgba(0, 0, 0, .20) calc(100% - var(--ksnm-pad) * .42),
      transparent 100%);
  backdrop-filter: blur(13px) saturate(.55);
  -webkit-backdrop-filter: blur(13px) saturate(.55);
  /* 中性灰:不推暖也不推冷,套在任何顏色的圖上都不會多一層色偏 */
  background: rgba(138, 140, 145, calc(var(--ksnm-veil, .30) * .50));
  mask-image: var(--ksnm-feather);
  mask-composite: intersect;
  -webkit-mask-image: var(--ksnm-feather);
  -webkit-mask-composite: source-in;
}
/*
 * 版面信心低:以前是換邊框顏色,而現在沒有邊框了。
 * 改成把膜染成警示色 —— 一樣在說「這一塊要自己看原圖」,
 * 但用的是同一種語彙(密度與色調),不是再加一個物件回來。
 */
.iveil.low {
  background: rgba(170, 94, 62, calc(var(--ksnm-veil, .30) * .90));
}
.iblk .itx {
  position: relative;
  /*
   * **不設上限、不折行**:貼片的寬度由字決定,所以短標籤往橫向長,
   * 不會折成「不適 / 用」那樣兩行(使用者原話:「如果真的太小
   * 應該加長 label 不要折字」)。長句才由 .wrap 打開折行。
   */
  max-width: none;
  line-height: 1.24;
  font-weight: 700;
  color: #8E2605;
  white-space: nowrap;
}
/*
 * 譯文底下的那片白 —— 羽化的,沒有硬邊,大到和霧接得上,
 * 而且**它自己也是一層**(§DT)。
 *
 * 白色本身拿不掉,那是量出來的(§13-7):玻璃保留明度,所以深色圖表上的
 * 玻璃場還是深的,深墨橘站上去只有 1.8:1;把膜濃到不像玻璃也只有 4.3:1。
 *
 * 三輪修掉了它的三個問題:
 *
 * - §DP-1「像 OK 繃」:不透明圓角貼片加陰影是**另一個物件**。
 *   同一片白模糊掉,對比一模一樣而邊界消失。
 * - §DR-2「還是看得到一條帶子」:量出來霧的外緣已經看不見了(1.02:1),
 *   看到的是**密度的階梯**。把白羽放大到和霧的濃核重疊,四階變成一條坡。
 * - §DT「白底蓋到字」:它以前是 .itx 的偽元素,所以**跟著自己那一塊走**
 *   —— 下一塊的白暈畫在上一塊的字上面。現在是自己的元素、自己的一層。
 *
 * 尺寸要量:貼片的寬度由字決定(這正是「不折字」的前提),
 * 所以排版之後才知道它多大。padding 用 em —— 字大羽毛就大,一致。
 */
.iplate {
  position: absolute;
  border-radius: 6px;
  background: rgba(255, 252, 247, .95);
  filter: blur(11px);
}
.iblk .itx.wrap {
  white-space: normal;
  word-break: break-word;
}
.iblk.vert .itx { writing-mode: vertical-rl; white-space: nowrap; }

/*
 * **編號錨點、錨點貼片、放大檢視的側邊清單都退場了(§DW)。**
 *
 * 它們解的是「字太小疊不下」,而那個問題在網頁上其實不存在:
 * 圖是別人排好版的,字小的那些多半也不重要。使用者的話是
 * 「這樣標註幾乎是退場了 需要標註的 應該是另一個題目 像 sukemu 的題目」——
 * 拍照翻譯才是錨點的主場,那是另一個產品。
 *
 * 現在整張圖只有一種語彙:疊字。放不下的塊留給放大檢視,
 * 那裡畫布大,同一份譯文放得下更多。
 */
.zoom {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 12, .9);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: none;
  align-items: center;
  justify-content: center;
  /*
   * **整層唯一會吃滑鼠事件的東西**(chip 之外的第二個例外)。
   *
   * 理由很窄:黑窗開著的時候使用者的意圖百分之百是「讀這張圖」,
   * 點到底下的頁面只會是意外。關掉它就立刻回到 pointer-events: none。
   */
  pointer-events: auto;
}
.zoom.show { display: flex; }
.zoom .zimg {
  position: relative;
  flex: 0 0 auto;
  max-width: calc(100vw - 60px);
  max-height: calc(100vh - 60px);
}
.zoom .zimg img { display: block; width: 100%; height: 100%; object-fit: contain; }

/*
 * 按住 Alt 看原圖 —— **掀起來,不是關掉**。
 *
 * 位移 + 縮放 + 模糊的「掀」是 sukemu handoff §7 的照抄項
 * (translateY(-1.6%) scale(1.03) blur(4px)),而它一直沒做。
 * 瞬間消失讀起來像「壞了」,掀起來讀起來像「我把它拿開了一下」——
 * 差別在於使用者知不知道它還在。
 */
.zoom .zimg .iblk,
.zoom .zimg .iveil,
.zoom .zimg .iplate {
  transition: opacity .16s ease, transform .16s ease, filter .16s ease;
}
.zoom.lift .zimg .iblk,
.zoom.lift .zimg .iveil,
.zoom.lift .zimg .iplate {
  opacity: 0;
  transform: translateY(-1.6%) scale(1.03);
  filter: blur(4px);
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .zoom .zimg .iblk,
  .zoom .zimg .iveil,
  .zoom .zimg .iplate { transition: none; }
  .zoom.lift .zimg .iblk,
  .zoom.lift .zimg .iveil,
  .zoom.lift .zimg .iplate { transform: none; filter: none; }
}
.zoom .zhint {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 14px;
  text-align: center;
  font-size: 11px;
  color: #8fa0b0;
}
`;

/**
 * 玻璃往原文框外擴幾 px。
 *
 * 羽化之後邊緣的玻璃是薄的,所以要往外站遠一點,讓**淡出發生在原文之外**
 * —— 否則收尾收在字上,字的邊緣會半糊不糊。
 *
 * 這個數字和 .iveil 的 --ksnm-pad 是同一件事的兩半:JS 決定框畫多大,
 * CSS 決定羽毛在框裡怎麼收。**兩邊要一起改**,render-veil.mjs 會對帳。
 *
 * 掃過 3 / 8 / 12 / 18 / 26:原文殘留 3.3 / 3.2 / 2.9 / 2.8 / 2.6。
 * 早期停在 8 是因為方框太遠會溢到隔壁的圖形;換成兩軸相交的羽毛之後
 * 濃的核心只有中間那塊,才敢一路放到 26(§DR-2)。
 */
export const VEIL_PAD = 26;

/**
 * 白貼片往字外面撐多少(em,乘上那一塊的字級)。
 *
 * 用 em 不用 px:字大羽毛就大,一整張圖上看起來才是同一種東西。
 * 這兩個數字以前寫在 CSS 的 `inset: -.34em -.62em` 裡,
 * 搬出來是因為現在要在 JS 裡算座標 —— 只能有一份。
 */
export const PLATE_PAD_X = 0.62;
export const PLATE_PAD_Y = 0.34;

/**
 * 量出每一段譯文實際占多大,補一層白貼片墊在**所有**譯文下面(§DT)。
 *
 * 為什麼要量:貼片的寬度由字決定(這正是「短標籤不折字」的前提),
 * 排版之前算不出來。所以順序是「先把字放進去 → 量 → 把貼片插到字前面」。
 *
 * 為什麼是插到前面而不是給 z-index:和玻璃同一個理由(§DR-1)——
 * `.zoom.lift` 會給每個 `.iblk` 小於 1 的 opacity,那 160ms 之內
 * 每一塊都是自己的堆疊脈絡,z-index 當場失效。**DOM 順序不挑時機。**
 *
 * 讀寫分開:先把所有的 rect 量完再開始插,不要邊量邊插 ——
 * 每插一個就重新排版一次的話,一張 50 塊的圖會排 50 次。
 */
export function paintPlates(container: HTMLElement): void {
  const base = container.getBoundingClientRect();
  const specs: { x: number; y: number; w: number; h: number }[] = [];
  for (const tx of container.querySelectorAll('.itx')) {
    const r = tx.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const fs = parseFloat(getComputedStyle(tx).fontSize) || 14;
    const px = fs * PLATE_PAD_X;
    const py = fs * PLATE_PAD_Y;
    specs.push({
      x: r.left - base.left - px,
      y: r.top - base.top - py,
      w: r.width + px * 2,
      h: r.height + py * 2,
    });
  }
  const first = container.querySelector('.iblk');
  for (const s of specs) {
    const el = document.createElement('span');
    el.className = 'iplate';
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    el.style.width = `${s.w}px`;
    el.style.height = `${s.h}px`;
    container.insertBefore(el, first);
  }
}

/** 一個要畫出來的貼片 */
export interface ChipItem {
  text: string;
  anchor: ViewRect;
  tone: 'l0' | 'l1' | 'warn';
  style: ChipStyle;
  /**
   * 這片貼片可以按。**整層唯一會吃滑鼠事件的東西之一**
   * (另一個是放大檢視,見 `.zoom`)。
   *
   * `docs/plan-annotation.md` §3.4 明訂的例外,而且例外收得很窄:
   * 只有圖片的 cue 用它。理由是 Alt+click 是鍵盤加滑鼠的複合動作,
   * 沒有它的話**觸控裝置與單手操作完全沒有入口**。
   *
   * UI 標籤的貼片**不設這個** —— 那些要維持「蓋到隔壁按鈕也點得到」。
   */
  action?: string;
}

/** 貼片的視覺:全部取自來源元素,讓它看起來像頁面的一部分而不是外掛 UI */
export interface ChipStyle {
  background: string;
  color: string;
  line: string;
  bar: string;
  fontSizePx: number;
}

export class OverlayLayer {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private layer: HTMLDivElement;
  private panel: HTMLDivElement | null = null;

  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    const existing = document.getElementById(HOST_ID);
    existing?.remove();
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    // host 自身的樣式用 inline + !important,頁面 CSS 打不進來
    this.host.setAttribute(
      'style',
      'all: initial !important; position: absolute !important; left: 0 !important; top: 0 !important;' +
        'width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important;' +
        'pointer-events: none !important; z-index: 2147483000 !important;',
    );
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `${fontFaceCss()}\n${LAYER_CSS}`;
    this.layer = document.createElement('div');
    this.layer.className = 'layer mode-full';
    this.root.append(style, this.layer);
    /*
     * 掛在 documentElement 而不是 body:body 常被頁面拿去做別的事
     * (smooth scroll 的 wrapper、開選單時 position: fixed、transform 動畫),
     * 那些都會讓 host 自己跟著跑掉。html 幾乎不會被這樣對待。
     */
    (document.documentElement ?? document.body).appendChild(this.host);
  }

  /**
   * 疊層留在 **document 座標系**,由瀏覽器自己跟著頁面捲。
   *
   * build 14 試過另一條路:host 用 position: fixed,再由 JS 每個捲動 frame
   * 補 translate(-scrollY)。座標是對的,但**瀏覽器的捲動跑在合成器上,
   * JS 永遠慢一幀** —— 疊層跟著抖,原文從縫隙漏出來。
   * 這是「不動版面」的專案裡最不能接受的一種動。
   *
   * 所以位置交還給瀏覽器,JS 只負責兩件它非做不可的事:
   * 遮住被固定頁首蓋住的部分(applyChromeClip),
   * 以及藏掉根本看不見的元素的疊層(occlusion 檢查)。
   */


  /** host 自己現在畫在哪。用來驗證「絕對座標 0,0 真的等於文件原點」 */
  hostRect(): DOMRect {
    return this.host.getBoundingClientRect();
  }

  /**
   * 修正原點誤差。
   *
   * host 是 documentElement 的絕對定位子元素,正常情況下 (0,0) 就是文件原點。
   * 但應用程式外殼可能把 `<html>` / `<body>` 變成定位或 transform 的容器,
   * 那時 (0,0) 不再是文件原點,整層疊層會平移一段固定距離。
   *
   * 這**不是** build 14 那個做法:那是每個捲動 frame 用 JS 追 scrollY
   * (追不上 → 抖動)。這裡修的是**靜態**誤差,只在版面變動時重算一次,
   * 不隨捲動改變,所以不會抖。
   */
  setOrigin(dx: number, dy: number): void {
    this.layer.style.transform = dx === 0 && dy === 0 ? '' : `translate(${dx}px, ${dy}px)`;
  }

  setMode(mode: DisplayMode): void {
    this.layer.classList.toggle('mode-full', mode === 'full');
    this.layer.classList.toggle('mode-peek', mode === 'peek');
  }

  setOutline(on: boolean): void {
    this.layer.classList.toggle('outline', on);
  }

  /** 把盒子上下裁掉一段(px);0 / 0 表示不裁 */
  /** 四邊都要:固定頁首吃掉上下,內層捲動容器四邊都會裁 */
  setClip(unit: Unit, top: number, right: number, bottom: number, left: number): void {
    const t = Math.max(0, top);
    const r = Math.max(0, right);
    const b = Math.max(0, bottom);
    const l = Math.max(0, left);
    const v = t <= 0 && r <= 0 && b <= 0 && l <= 0 ? '' : `inset(${t}px ${r}px ${b}px ${l}px)`;
    for (const el of [unit.box, unit.hint]) {
      if (!el || el.dataset['clip'] === v) continue;
      el.dataset['clip'] = v;
      if (v) el.style.setProperty('--ksnm-clip', v);
      else el.style.removeProperty('--ksnm-clip');
    }
  }

  /** 來源元素看不見時把疊層藏起來(不是刪掉 —— 它可能又出現) */
  /** 內層容器捲動中,座標暫時不可信 —— 藏起來,重新量好再出現 */
  setStale(unit: Unit, stale: boolean): void {
    unit.box?.classList.toggle('stale', stale);
    unit.hint?.classList.toggle('stale', stale);
  }

  setCovered(unit: Unit, covered: boolean): void {
    unit.box?.classList.toggle('covered', covered);
    unit.hint?.classList.toggle('covered', covered);
  }

  setHiddenAll(on: boolean): void {
    this.layer.classList.toggle('hidden-all', on);
    /*
     * **放大檢視是 `.layer` 的兄弟節點,不是它的小孩。**
     *
     * `.zoom` 和 `.chip` 都直接掛在 shadow root 下(理由見 `.zoom` 的註解:
     * 它們是 `position: fixed`,待在帶 clip-path 的 `.layer` 裡會壞掉)。
     * 所以掛在 `.layer` 上的 `hidden-all` 對黑窗裡的加註完全沒有作用 ——
     * 而黑窗自己印著「按住 Alt 看原圖」,那是 UI 給的承諾(§DL)。
     *
     * 這裡不關黑窗,只把加註掀起來:使用者要的是「看原圖」不是「離開」。
     */
    this.zoomBox?.classList.toggle('lift', on);
  }

  setAltScan(on: boolean): void {
    this.layer.classList.toggle('alt-scan', on);
  }

  /** 疊層本身收不到 hover,由來源元素的 hover 反向驅動 */
  setHovered(unit: Unit | null, all: Iterable<Unit>): void {
    for (const u of all) u.box?.classList.remove('hovered');
    unit?.box?.classList.add('hovered');
  }

  paint(unit: Unit, settings: Settings): void {
    const text = activeText(unit);
    if (text === undefined) return;
    if (!unit.box) {
      unit.box = document.createElement('div');
      this.layer.appendChild(unit.box);
    }
    const s = unit.style;
    const box = unit.box;
    const annot = unit.annotation || settings.forceAnnotation;
    /*
     * 狀態 class 不能被重畫洗掉。
     *
     * `hovered`(正在看原文)、`covered`(來源看不見)、`stale`(座標還在動)
     * 是**執行期狀態**,不是重畫的產物。整個 className 重指派會把它們清掉,
     * 而 covered / stale 在 flush 迴圈裡緊接著被重設,只有 hovered 沒有 ——
     * 於是 Gmail 上「滑上去只閃一下原文就蓋回來」:那裡 flush 一直在跑,
     * 而滑鼠不動就不會再有 mouseover 事件把 hovered 加回去。
     * 一般網頁 flush 很少,所以看不出來。
     */
    const keep = (box.className.match(/\b(?:hovered|covered|stale)\b/g) ?? []).join(' ');
    box.className =
      `box${unit.singleLine ? ' single' : ''}${annot ? ' annotate' : ''}` +
      (keep ? ` ${keep}` : '');
    box.textContent = text;
    box.dataset['geom'] =
      `${Math.round(unit.rect.width)}×${Math.round(unit.rect.height)}` +
      ` +${unit.bleed.y}${unit.overflowsBox ? ' overflow' : ''}`;
    this.applyVars(box, unit, effectiveFontSize(unit));
    this.paintHint(unit, settings);
  }

  /**
   * feature.md §4.5 就地替換。
   * 不改變疊層盒子的幾何,只換內容;舊內容以 80ms cross-fade 淡出。
   */
  swap(unit: Unit, settings: Settings): void {
    const text = activeText(unit);
    if (text === undefined) return;
    const box = unit.box;
    if (!box) {
      this.paint(unit, settings);
      return;
    }
    if (box.textContent === text) return;
    if (this.reduceMotion) {
      // prefers-reduced-motion: reduce → 直接切換
      box.textContent = text;
      this.applyVars(box, unit, effectiveFontSize(unit));
      this.paintHint(unit, settings);
      return;
    }
    const ghost = box.cloneNode(true) as HTMLDivElement;
    ghost.className = `ghost${unit.singleLine ? ' single' : ''}`;
    this.layer.appendChild(ghost);
    box.textContent = text;
    this.applyVars(box, unit, effectiveFontSize(unit));
    this.paintHint(unit, settings);
    requestAnimationFrame(() => {
      ghost.classList.add('out');
      setTimeout(() => ghost.remove(), SWAP_MS + 40);
    });
  }

  private applyVars(el: HTMLElement, unit: Unit, size: number): void {
    const s = unit.style;
    // 出血:盒子往四周各撐 bleed,padding 同量補回來,
    // 於是**譯文的位置一格都沒動**,只有背景多蓋了一圈。
    // 這就是「蓋得更準」的做法 —— 對齊靠 padding,遮蔽靠 border-box。
    const bx = unit.bleed?.x ?? 0;
    const by = unit.bleed?.y ?? 0;
    const [pt, pr, pb, pl] = s.padding;
    const vars: Record<string, string> = {
      '--ksnm-x': `${unit.rect.left - bx}px`,
      '--ksnm-y': `${unit.rect.top - by}px`,
      '--ksnm-w': `${unit.rect.width + bx * 2}px`,
      '--ksnm-h': `${unit.rect.height + by * 2}px`,
      '--ksnm-bg': s.background ?? 'rgba(230, 241, 251, 0.94)',
      '--ksnm-fg': s.color,
      '--ksnm-ff': fontStack(s.isSerif, s.sourceStack),
      '--ksnm-annot-ff': fontStack(false, 'sans-serif'),
      // 標註色也要跟著頁面明暗走。寫死的淺藍底 + 褐字在深色頁面上
      // 就是使用者說的「選色錯誤」—— 亮字必然配深底,反之亦然。
      '--ksnm-annot-bg': annotBg(s.color),
      '--ksnm-annot-fg': annotFg(s.color),
      '--ksnm-size': `${size}px`,
      // §4.6 標註樣式字級為來源 −1px,下限 12px
      '--ksnm-annot-size': `${Math.max(12, s.fontSizePx - 1)}px`,
      '--ksnm-weight': String(s.targetWeight),
      '--ksnm-style': s.fontStyle,
      // §4.5 行高直接繼承,不拉伸不壓縮 (D09)
      '--ksnm-lh': `${s.lineHeightPx}px`,
      '--ksnm-align': s.textAlign,
      '--ksnm-dir': s.direction,
      '--ksnm-pad': `${pt + by}px ${pr + bx}px ${pb + by}px ${pl + bx}px`,
      '--ksnm-radius': s.borderRadius,
    };
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  }

  /** feature.md §5.1 提示線的階層色(對照表在 upgrade.ts,有測試蓋住) */
  paintHint(unit: Unit, settings: Settings): void {
    const cls = hintClassFor(unit.tier, settings.hintLine);
    if (cls === null) {
      unit.hint?.remove();
      unit.hint = undefined;
      return;
    }
    if (!unit.hint) {
      unit.hint = document.createElement('div');
      this.layer.appendChild(unit.hint);
    }
    const h = unit.hint;
    h.className = `hint ${cls}`;
    const top = unit.firstRectTop;
    /*
     * 提示線的高度是**譯文**佔多高,不是原文區塊多高。
     * 英文通常比中文長,原文區塊常常高出一截;照原文高度畫,
     * 線就會從譯文末尾繼續往下拖 —— 回報的「線會跑過頭」。
     * 上限仍是原文的最後一行底部,免得譯文溢出時線比區塊還長。
     */
    const source = Math.max(4, unit.lastRectBottom - top);
    const height = unit.textHeight > 0 ? Math.min(source, Math.max(4, unit.textHeight)) : source;
    h.style.setProperty('--ksnm-hx', `${unit.rect.left - 8}px`);
    h.style.setProperty('--ksnm-hy', `${top}px`);
    h.style.setProperty('--ksnm-hh', `${height}px`);
    h.style.setProperty('--ksnm-hint', hintColor(unit.style.color));
    h.style.setProperty('--ksnm-warn', '#c0392b');
  }

  /* ------------------------------------------------------- 加翻貼片 */

  /**
   * 貼片節點池。同時通常只有一個(hover),按住 Alt 掃視時是可見區內的一整批。
   * 每個標籤配一個常駐 DOM 是幾十個節點的浪費 —— 用完就藏起來重複使用。
   */
  private chips: HTMLDivElement[] = [];

  /**
   * 畫出這一批貼片,其餘的藏起來。
   *
   * 兩段式:先把內容放進去(還是 opacity 0)量出實際尺寸,
   * 再交給 annotate.place() 決定位置,最後才 .show。
   * 量之前不可能知道貼片多寬 —— 中文字數與字型都會影響。
   *
   * 依序放置並把已放好的矩形餵給 place(),所以一整條導覽列的貼片
   * 會互相讓開,而不是疊在一起。
   */
  showChips(items: readonly ChipItem[]): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placed: ViewRect[] = [];
    items.forEach((item, i) => {
      const c = this.chipAt(i);
      c.className = `chip ${item.tone}${item.action ? ' act' : ''}`;
      c.textContent = item.text;
      /*
       * 事件掛在**貼片自己身上**,不靠 document 的監聽。
       *
       * 疊層在 closed shadow root 裡,`composedPath()` 不會揭露內部節點,
       * 所以外面的 listener 認不出「使用者點的是哪一片貼片」。
       * 節點是這個類別造的,回呼也由它接 —— 邊界剛好落在該落的地方。
       */
      c.onclick = item.action ? () => this.chipAction?.(item.action!) : null;
      const st = item.style;
      c.style.setProperty('--ksnm-chip-bg', st.background);
      c.style.setProperty('--ksnm-chip-fg', st.color);
      c.style.setProperty('--ksnm-chip-line', st.line);
      c.style.setProperty('--ksnm-chip-bar', st.bar);
      c.style.setProperty('--ksnm-chip-ff', fontStack(false, 'sans-serif'));
      c.style.setProperty('--ksnm-chip-size', `${st.fontSizePx}px`);
      // 先放到左上角量:留在上一次的位置量,貼片在視窗邊緣會被壓窄
      c.style.setProperty('--ksnm-cx', '0px');
      c.style.setProperty('--ksnm-cy', '0px');
      const box = c.getBoundingClientRect();
      const at = place(
        { rect: item.anchor },
        { width: box.width, height: box.height },
        viewport,
        'chip',
        placed,
      );
      placed.push(at);
      c.style.setProperty('--ksnm-cx', `${at.left}px`);
      c.style.setProperty('--ksnm-cy', `${at.top}px`);
      c.classList.add('show');
    });
    for (let i = items.length; i < this.chips.length; i++) {
      this.chips[i]!.classList.remove('show');
    }
  }

  private chipAction: ((action: string) => void) | null = null;

  onChipAction(cb: (action: string) => void): void {
    this.chipAction = cb;
  }

  private chipAt(i: number): HTMLDivElement {
    let c = this.chips[i];
    if (!c) {
      c = document.createElement('div');
      c.className = 'chip';
      this.root.appendChild(c);
      this.chips[i] = c;
    }
    return c;
  }

  hideChips(): void {
    for (const c of this.chips) c.classList.remove('show');
  }

  chipsVisible(): boolean {
    return this.chips.some((c) => c.classList.contains('show'));
  }

  private hud: HTMLDivElement | null = null;
  private hudTimer = 0;
  private hudText = '';
  private hudLevel = '';

  /**
   * 狀態列。`busy` 會持續顯示到下一次更新;`idle` 與 `warn` 顯示幾秒後淡出
   * (warn 停久一點,那是要被看到的)。
   */
  setHud(text: string, level: 'idle' | 'busy' | 'warn'): void {
    /*
     * 內容沒變就什麼都不做。
     *
     * updateHud() 被每一次 flush、每一批結果、每一次 hover 呼叫,
     * 而這裡原本每次都重設淡出計時器 —— 於是「完成」的狀態列
     * **永遠不會淡出**,因為它一直被同樣的字重新點亮。
     * 常駐的狀態列是噪音,而這個 bug 讓它變成常駐的。
     */
    if (this.hudText === text && this.hudLevel === level) return;
    this.hudText = text;
    this.hudLevel = level;
    if (!this.hud) {
      this.hud = document.createElement('div');
      this.hud.className = 'hud';
      this.root.appendChild(this.hud);
    }
    const el = this.hud;
    el.className = `hud show ${level}`;
    el.textContent = text;
    clearTimeout(this.hudTimer);
    /*
     * **淡出的是資訊,留下的是待辦。**
     *
     * 「完成」是講完就沒事了,該淡出 —— 常駐的狀態列是噪音。
     * 但「有 15 塊失敗,滑上去可以重試」是還沒解決的事,它一淡出,
     * 畫面上就沒有任何東西告訴使用者發生過什麼,也沒有東西告訴他
     * 怎麼救。使用者的原話是「HUD 不見了 是不是死掉了」。
     *
     * 所以 warn 不自動淡出。它會在最後一塊被重試成功時自己變成
     * idle 然後淡出 —— 自己會清乾淨的東西才有資格常駐。
     * (按住 Alt 收起整層時它一樣會不見;完全不想要就在設定關掉狀態列。)
     */
    if (level === 'busy' || level === 'warn') return;
    this.hudTimer = window.setTimeout(() => el.classList.remove('show'), 3200);
  }


  /* ═══════════════════════════════════════════ 圖片加註(plan-images §3.2) */

  private imgWrap: HTMLDivElement | null = null;
  private zoomBox: HTMLDivElement | null = null;

  /** 疊膜強度。0 = 完全不壓暗,0.6 = 很重。設定頁的滑桿寫進來 */
  setVeilStrength(v: number): void {
    this.layer.style.setProperty('--ksnm-veil', String(Math.max(0, Math.min(0.6, v))));
  }

  /**
   * 把一張圖的加註畫上去。
   *
   * `rect` 是**文件座標** —— 和內文疊層同一個座標系,所以捲動由瀏覽器負責,
   * JS 不追。`placed` 已經是圖片本地的 px(見 imagegeo.placeBlocks)。
   */
  showImage(rect: { left: number; top: number; width: number; height: number },
            placed: readonly PlacedBlock[]): void {
    const w = this.imgWrap ?? this.makeImgWrap();
    w.style.setProperty('--ksnm-ix', `${rect.left}px`);
    w.style.setProperty('--ksnm-iy', `${rect.top}px`);
    w.style.setProperty('--ksnm-iw', `${rect.width}px`);
    w.style.setProperty('--ksnm-ih', `${rect.height}px`);
    w.replaceChildren(...this.blockNodes(placed));
    // 字放進去了才量得到它多寬 —— 貼片是第三層,插在字前面(§DT)
    paintPlates(w);
    w.classList.add('show');
  }

  hideImage(): void {
    this.imgWrap?.classList.remove('show');
  }

  imageVisible(): boolean {
    return this.imgWrap?.classList.contains('show') === true;
  }

    private makeImgWrap(): HTMLDivElement {
    const w = document.createElement('div');
    w.className = 'imgwrap';
    this.layer.appendChild(w);
    this.imgWrap = w;
    return w;
  }

  /**
   * 一張圖的所有節點,**分三趟**:玻璃 → 白貼片 → 字。
   *
   * 順序就是繪製順序(這一層裡沒有人動 z-index),所以三趟等於
   * 「字在最上層,只能被字蓋到」——使用者寫下的那條不變式(§DT)。
   * 貼片那一趟量得到字才畫得出來,所以由 `paintPlates()` 在插進去之後補。
   *
   * 以前這裡還要分「疊字還是錨點」。錨點退場之後(§DW)只剩一種語彙,
   * 而那正是「一下有疊字 一下註解 不太統一」那個回報的終點。
   */
  private blockNodes(placed: readonly PlacedBlock[]): HTMLElement[] {
    return [...placed.map((p) => this.veilNode(p)), ...placed.map((p) => this.blockNode(p))];
  }

  /** 玻璃:自己的座標,往四周外擴 VEIL_PAD 讓淡出發生在原文之外 */
  private veilNode(p: PlacedBlock): HTMLElement {
    const v = document.createElement('span');
    v.className = `iveil${p.low ? ' low' : ''}`;
    v.style.left = `${p.x - VEIL_PAD}px`;
    v.style.top = `${p.y - VEIL_PAD}px`;
    v.style.width = `${p.w + VEIL_PAD * 2}px`;
    v.style.height = `${p.h + VEIL_PAD * 2}px`;
    return v;
  }

  private blockNode(p: PlacedBlock): HTMLElement {
    const box = document.createElement('div');
    box.className = `iblk${p.low ? ' low' : ''}${p.vertical ? ' vert' : ''}`;
    box.style.left = `${p.x}px`;
    box.style.top = `${p.y}px`;
    box.style.width = `${p.w}px`;
    box.style.height = `${p.h}px`;
    box.style.fontSize = `${p.fontPx}px`;
    box.style.fontFamily = fontStack(false, 'sans-serif');
    const tx = document.createElement('span');
    // 短標籤一行到底(不折字);長句才允許折行
    tx.className = `itx${[...p.zh].length > SINGLE_LINE_CHARS ? ' wrap' : ''}`;
    tx.textContent = p.zh;
    box.append(tx);
    return box;
  }

  /**
   * 放大檢視(§3.3)。
   *
   * 站方有自己的 lightbox 時不出這個入口 —— 跟著站方走,加註靠同 src
   * 重錨定跟過去。這裡是給**沒有 lightbox 的站**用的:claude.com 那篇的
   * 2042px 截圖行內只顯示 565px,連英文讀者都得另開分頁。
   */
  showZoom(src: string, natural: { w: number; h: number }): HTMLDivElement {
    const z = this.zoomBox ?? this.makeZoom();
    const holder = z.querySelector('.zimg') as HTMLDivElement;
    const img = holder.querySelector('img') as HTMLImageElement;
    if (img.src !== src) img.src = src;
    // 等比放大到視窗允許的最大尺寸;實際幾何等 img 載入後由呼叫端量
    const maxW = window.innerWidth - 60;
    const maxH = window.innerHeight - 60;
    const scale = Math.min(maxW / natural.w, maxH / natural.h);
    holder.style.width = `${Math.round(natural.w * scale)}px`;
    holder.style.height = `${Math.round(natural.h * scale)}px`;
    z.classList.add('show');
    return holder;
  }

  /** 放大檢視裡的加註常駐(進黑窗就是「我要讀字」) */
  setZoomBlocks(placed: readonly PlacedBlock[]): void {
    const z = this.zoomBox;
    const holder = z?.querySelector('.zimg');
    if (!z || !holder) return;
    for (const old of holder.querySelectorAll('.iblk, .iveil, .iplate')) old.remove();
    for (const n of this.blockNodes(placed)) holder.appendChild(n);
    paintPlates(holder as HTMLElement);
  }

  hideZoom(): void {
    this.zoomBox?.classList.remove('show', 'lift');
  }

  /** 放大檢視裡的圖現在畫成多大(視窗變化後重算加註要用) */
  zoomSize(): { w: number; h: number } | null {
    const holder = this.zoomBox?.querySelector('.zimg');
    if (!holder) return null;
    const r = holder.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  private zoomDismiss: (() => void) | null = null;

  /** 點黑處關閉。事件掛在層自己身上(shadow root 外面認不出它) */
  onZoomDismiss(cb: () => void): void {
    this.zoomDismiss = cb;
  }

  zoomVisible(): boolean {
    return this.zoomBox?.classList.contains('show') === true;
  }

  private makeZoom(): HTMLDivElement {
    const z = document.createElement('div');
    z.className = 'zoom';
    const holder = document.createElement('div');
    holder.className = 'zimg';
    holder.appendChild(document.createElement('img'));
    const hint = document.createElement('div');
    hint.className = 'zhint';
    // 編號退場了(§DW),文案跟著走;滑鼠是 Alt 的同義手勢(§EB)
    hint.textContent = 'Esc 或點黑處關閉 · 按住滑鼠或 Alt 看原圖';
    z.append(holder, hint);
    z.addEventListener('click', (e) => {
      // 只有點在圖以外的黑處才關;點到圖上是想看清楚,不是想離開
      if (e.target === z) this.zoomDismiss?.();
    });
    /*
     * **按住滑鼠左鍵 = 按住 Alt**(§EB)。
     *
     * 「看一眼原圖」是黑窗裡最常做的動作,而 Alt 在 ChromeOS 上是
     * 系統鍵、在 Windows 上會去碰瀏覽器選單 —— 手邊本來就握著的滑鼠
     * 更可靠。只掛在圖上:按住黑處再放開會觸發上面那條「點黑處關閉」,
     * 兩個手勢不能疊在同一塊地方。
     *
     * `preventDefault` 擋的是瀏覽器自己的圖片拖曳 —— 按住不動想看原圖,
     * 手抖一下就變成拖出一個半透明的殘影。
     */
    const liftOff = () => z.classList.remove('lift');
    holder.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      z.classList.add('lift');
    });
    z.addEventListener('mouseup', liftOff);
    z.addEventListener('mouseleave', liftOff);
    // .zoom 是 fixed,和 .chip 同理由:不能待在帶 clip-path 的 .layer 裡
    this.root.appendChild(z);
    this.zoomBox = z;
    return z;
  }

  hideHud(): void {
    clearTimeout(this.hudTimer);
    this.hud?.remove();
    this.hud = null;
    // 節點沒了,快取的字也要跟著清掉,否則下一次同樣的字會被當成「沒變」
    this.hudText = '';
    this.hudLevel = '';
  }

  drop(unit: Unit): void {
    unit.box?.remove();
    unit.hint?.remove();
    unit.box = undefined;
    unit.hint = undefined;
  }

  /**
   * §6.4 第三層防線:抽樣人工比對。自動指標抓不到 id 對滑。
   * feature.md §5.3:並列原文 / L0 / L1 —— 這是判斷「L1 值不值得那些錢」
   * 的唯一可靠辦法。如果 L1 只是把 L0 換成同義句,l0-only 就是正確答案。
   */
  showSample(units: Unit[], stats: string): void {
    if (!this.panel) {
      this.panel = document.createElement('div');
      this.panel.className = 'panel';
      this.root.appendChild(this.panel);
    }
    const cut = (s: string | undefined) => escapeHtml((s ?? '—').slice(0, 160));
    const rows = units
      .map(
        (u) =>
          `<tr><td class="s">${u.id}<br>${cut(u.src)}</td>` +
          `<td class="l0">${cut(u.l0Text)}</td>` +
          `<td class="l1">${cut(u.l1Text)}</td></tr>`,
      )
      .join('');
    this.panel.innerHTML =
      `<h4>Kasanemu debug — ${escapeHtml(stats)}</h4>` +
      `<table><thead><tr><th>原文</th><th>L0</th><th>L1</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="s">Alt+Shift+D 關閉;一致 ≠ 正確,穩定地錯也是一種高一致。</p>`;
  }

  hideSample(): void {
    this.panel?.remove();
    this.panel = null;
  }

  hasSample(): boolean {
    return this.panel !== null;
  }

  destroy(): void {
    this.chips = [];
    this.host.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
