import type { Unit } from './unit';

/*
 * 只有 type import —— 和 cover.ts 同一條規矩:這個檔案要能在 node 的
 * 測試裡直接載入,而值的 import 會拖進一整條相依鏈。
 * `activeText()` 只是一個 `??`,抄過來比拖進來便宜。
 */
const activeText = (u: Unit): string | undefined => u.l1Text ?? u.l0Text;

/**
 * 把「疊好的樣子」存成一個 HTML 檔。
 *
 * 這件事只有在**不改動頁面 DOM** 這個前提下才有意思:我們從來沒有把譯文
 * 寫進頁面,所以匯出不能只是「存檔」—— 要另外組一份。
 *
 * 做法是複製整棵 DOM,在複本上把每個單元的原文包成 `.ksnm-src`、
 * 旁邊補一個 `.ksnm-tx` 裝譯文,再用 CSS 決定哪一個顯示。
 * 原文的行內標籤(連結、行內 code)一個都沒動 —— 這比「把 textContent
 * 換掉」保真得多,而且 hover / 按住 Alt 看原文的行為完全一樣,
 * 只是改由三行 CSS 兌現,不需要任何 JS 疊層。
 *
 * **頁面自己的 `<script>` 一律拿掉。** 存下來的檔案再跑一次框架的
 * hydration,第一件事就是把我們插進去的節點洗掉 —— 那是靜態快照,
 * 不需要也不能有互動。
 */

/** 從 root 起算的 childNode 索引路徑。複本的樹形一樣,所以路徑通用。 */
export function pathOf(node: Node, root: Node): number[] | null {
  const path: number[] = [];
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const parent: Node | null = cur.parentNode;
    if (!parent) return null;
    const at = Array.prototype.indexOf.call(parent.childNodes, cur);
    if (at < 0) return null;
    path.unshift(at);
    cur = parent;
  }
  return cur === root ? path : null;
}

export function resolvePath(path: readonly number[], root: Node): Node | null {
  let cur: Node = root;
  for (const at of path) {
    const next: Node | undefined = cur.childNodes[at];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

const STYLE = `
/* 疊層在這裡不是絕對定位的盒子,是同一個位置的兩份內容,顯示其中一份。
   .ksnm 與展開後的 .ksnm-src 都用 display:contents,所以原文的排版
   一個像素都不會因為多了這兩層 span 而改變。 */
.ksnm { display: contents; }
.ksnm > .ksnm-src { display: none; }
.ksnm > .ksnm-tx { color: inherit; font: inherit; }
.ksnm:hover > .ksnm-src,
html.ksnm-peek .ksnm > .ksnm-src { display: contents; }
.ksnm:hover > .ksnm-tx,
html.ksnm-peek .ksnm > .ksnm-tx { display: none; }
`;

const SCRIPT = `
// 按住 Alt = 全頁看原文,放開就回來。和擴充功能裡的手勢一致。
var R = document.documentElement;
addEventListener('keydown', function (e) { if (e.key === 'Alt') R.classList.add('ksnm-peek'); });
addEventListener('keyup', function (e) { if (e.key === 'Alt') R.classList.remove('ksnm-peek'); });
addEventListener('blur', function () { R.classList.remove('ksnm-peek'); });
`;

interface Plan {
  /** 元素錨點:路徑指到那個元素;範圍錨點:路徑指到父元素 */
  path: number[];
  /** 範圍錨點才有:要包起來的 childNode 區間 [from, to) */
  from?: number;
  to?: number;
  text: string;
}

/** 先把路徑全部算完再複製 —— 兩件事之間不能讓 DOM 有機會變動 */
function planFor(units: Iterable<Unit>, root: Node): Plan[] {
  const out: Plan[] = [];
  for (const u of units) {
    const text = activeText(u);
    if (text === undefined || u.tier === 'skipped') continue;
    if (u.range) {
      const parent = u.range.startContainer;
      if (parent.nodeType !== 1) continue;
      const path = pathOf(parent, root);
      if (!path) continue;
      out.push({ path, from: u.range.startOffset, to: u.range.endOffset, text });
      continue;
    }
    const path = pathOf(u.el, root);
    if (path) out.push({ path, text });
  }
  /*
   * 由後往前套用。範圍錨點是用 childNode 索引定位的,而包裝會改變
   * 同一個父層底下的索引 —— 從後面做起,前面的索引就還是對的。
   */
  return out.sort((a, b) => {
    for (let i = 0; i < Math.max(a.path.length, b.path.length); i++) {
      const d = (b.path[i] ?? -1) - (a.path[i] ?? -1);
      if (d !== 0) return d;
    }
    return (b.from ?? -1) - (a.from ?? -1);
  });
}

function wrap(doc: Document, moved: Node[], text: string): HTMLElement {
  const box = doc.createElement('span');
  box.className = 'ksnm';
  const src = doc.createElement('span');
  src.className = 'ksnm-src';
  for (const n of moved) src.appendChild(n);
  const tx = doc.createElement('span');
  tx.className = 'ksnm-tx';
  tx.textContent = text;
  box.append(src, tx);
  return box;
}

export function buildSnapshot(opts: {
  units: Iterable<Unit>;
  hostId: string;
  url: string;
  version: string;
}): { html: string; applied: number } {
  const live = document.documentElement;
  const plan = planFor(opts.units, live);
  const clone = live.cloneNode(true) as HTMLElement;
  const doc = document;

  /*
   * **先套用,再刪東西。**
   *
   * 反過來做會全軍覆沒:路徑是 childNode 的索引,而刪掉一個 `<script>`
   * 會讓它後面所有兄弟節點的索引往前移一格。一般網頁的 `<head>` 與
   * `<body>` 裡到處都是 script,於是幾乎每一條路徑都指到別的節點,
   * `nodeType !== 1` 就被跳過 —— 匯出的檔案裡一個譯文都沒有。
   *
   * 而我當初的 fixture **一個 `<script>` 都沒有**,所以驗收全綠。
   * 這是這次真正的教訓:fixture 要裝著會弄壞它的東西。
   */
  let applied = 0;
  for (const p of plan) {
    const node = resolvePath(p.path, clone);
    if (!node || node.nodeType !== 1) continue;
    const el = node as Element;
    if (p.from !== undefined && p.to !== undefined) {
      const kids = Array.from(el.childNodes).slice(p.from, p.to);
      if (kids.length === 0) continue;
      const box = wrap(doc, kids, p.text);
      const at = el.childNodes[p.from] ?? null;
      el.insertBefore(box, at);
    } else {
      if (el.childNodes.length === 0) continue;
      el.appendChild(wrap(doc, Array.from(el.childNodes), p.text));
    }
    applied++;
  }

  // 套用完了才動樹:頁面自己的腳本、我們自己的疊層宿主都不該進到快照裡
  for (const el of Array.from(clone.querySelectorAll('script'))) el.remove();
  clone.querySelector(`#${opts.hostId}`)?.remove();

  const head = clone.querySelector('head') ?? clone.insertBefore(doc.createElement('head'), clone.firstChild);
  /*
   * `<base>` 要放在最前面 —— 它只影響**後面**的 URL。少了這一行,
   * 存下來的檔案會找不到任何相對路徑的 CSS 與圖片,整頁變成純文字。
   */
  if (!head.querySelector('base')) {
    const base = doc.createElement('base');
    base.setAttribute('href', opts.url);
    head.insertBefore(base, head.firstChild);
  }
  const style = doc.createElement('style');
  style.textContent = STYLE;
  head.appendChild(style);
  const script = doc.createElement('script');
  script.textContent = SCRIPT;
  head.appendChild(script);

  const stamp = `<!-- 疊 Kasanemu ${opts.version} · ${opts.url} · ${new Date().toISOString()} -->`;
  return { html: `<!doctype html>\n${stamp}\n${clone.outerHTML}\n`, applied };
}
