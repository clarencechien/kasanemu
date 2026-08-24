import type { DisplayMode, Settings } from '../shared/types';
import { fontFaceCss, fontStack } from './fonts';
import { hintColor } from './styleprobe';
import { LETTER_SPACING_EM, activeText, effectiveFontSize, type Unit } from './unit';
import { hintClassFor } from './upgrade';

/**
 * §3.3 疊層掛在單一 document 層級的容器上。
 * 絕對不可插進來源元素的容器內:祖先的 overflow: hidden、z-index
 * stacking context、transform 都會破壞定位。
 * §11.1 容器用 closed shadow DOM,樣式不受頁面 CSS 影響。
 */
const HOST_ID = 'kasanemu-root';

/** feature.md §4.5 過場刻意短。越明顯的動畫越吸引注意,替換應該低調。 */
const SWAP_MS = 80;

const LAYER_CSS = `
:host { all: initial; }
.layer {
  position: absolute;
  inset: 0;
  /* §2.2 硬性要求:疊層一旦接收 hover 就會無限閃爍。此限制不可協商。 */
  pointer-events: none;
  z-index: 2147483000;
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
  background: rgba(230, 241, 251, 0.94);
  color: #993C1D;
  font-family: var(--ksnm-annot-ff);
  font-weight: 400;
  font-size: var(--ksnm-annot-size);
  border-radius: 5px;
}
.layer.alt-scan .box { opacity: 1; }
/* 來源元素其實看不見(被裁切、隱藏的重複 DOM)→ 疊層也不該出現 */
.box.covered, .hint.covered { display: none; }
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
 * 頁內狀態列。使用者的原話:「翻譯中還是沒翻譯沒有明確的 status」。
 * 疊層本身看起來一樣,分不出「還在等」與「已經死了」,所以狀態要自己講。
 * pointer-events: none —— 與疊層同一條規則,不可攔截 hover。
 */
.hud {
  position: fixed;
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
`;

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


  setMode(mode: DisplayMode): void {
    this.layer.classList.toggle('mode-full', mode === 'full');
    this.layer.classList.toggle('mode-peek', mode === 'peek');
  }

  setOutline(on: boolean): void {
    this.layer.classList.toggle('outline', on);
  }

  /** 把盒子上下裁掉一段(px);0 / 0 表示不裁 */
  setClip(unit: Unit, top: number, bottom: number): void {
    const box = unit.box;
    if (!box) return;
    const v = top <= 0 && bottom <= 0 ? '' : `inset(${Math.max(0, top)}px 0 ${Math.max(0, bottom)}px 0)`;
    if (box.dataset['clip'] === v) return; // 沒變就不要寫 style
    box.dataset['clip'] = v;
    if (v) box.style.setProperty('--ksnm-clip', v);
    else box.style.removeProperty('--ksnm-clip');
  }

  /** 來源元素看不見時把疊層藏起來(不是刪掉 —— 它可能又出現) */
  setCovered(unit: Unit, covered: boolean): void {
    unit.box?.classList.toggle('covered', covered);
    unit.hint?.classList.toggle('covered', covered);
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
    box.className = `box${unit.singleLine ? ' single' : ''}${annot ? ' annotate' : ''}`;
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
    // 用文字的最後一行底部,不是覆蓋用的 rect.height(那個灌過 scrollHeight)
    const height = Math.max(4, unit.lastRectBottom - top);
    h.style.setProperty('--ksnm-hx', `${unit.rect.left - 8}px`);
    h.style.setProperty('--ksnm-hy', `${top}px`);
    h.style.setProperty('--ksnm-hh', `${height}px`);
    h.style.setProperty('--ksnm-hint', hintColor(unit.style.color));
    h.style.setProperty('--ksnm-warn', '#c0392b');
  }

  private hud: HTMLDivElement | null = null;
  private hudTimer = 0;

  /**
   * 狀態列。`busy` 會持續顯示到下一次更新;`idle` 與 `warn` 顯示幾秒後淡出
   * (warn 停久一點,那是要被看到的)。
   */
  setHud(text: string, level: 'idle' | 'busy' | 'warn'): void {
    if (!this.hud) {
      this.hud = document.createElement('div');
      this.hud.className = 'hud';
      this.root.appendChild(this.hud);
    }
    const el = this.hud;
    el.className = `hud show ${level}`;
    el.textContent = text;
    clearTimeout(this.hudTimer);
    if (level === 'busy') return;
    this.hudTimer = window.setTimeout(
      () => el.classList.remove('show'),
      level === 'warn' ? 8000 : 3000,
    );
  }

  hideHud(): void {
    clearTimeout(this.hudTimer);
    this.hud?.remove();
    this.hud = null;
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
    this.host.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
