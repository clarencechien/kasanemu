import type { DisplayMode, Settings } from '../shared/types';
import { fontFaceCss, fontStack } from './fonts';
import { hintColor } from './styleprobe';
import { LETTER_SPACING_EM, type Unit } from './unit';

/**
 * §3.3 疊層掛在單一 document 層級的容器上。
 * 絕對不可插進來源元素的容器內:祖先的 overflow: hidden、z-index
 * stacking context、transform 都會破壞定位。
 * §11.1 容器用 closed shadow DOM,樣式不受頁面 CSS 影響。
 */
const HOST_ID = 'kasanemu-root';

const LAYER_CSS = `
:host { all: initial; }
.layer {
  position: absolute;
  inset: 0;
  /* §2.2 硬性要求:疊層一旦接收 hover 就會無限閃爍。此限制不可協商。 */
  pointer-events: none;
  z-index: 2147483000;
}
.box {
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
  opacity: 0;
  transition: opacity 130ms ease;
}
/* §4.4 單行元素允許橫向溢出,不加入字級分組 (D15) */
.box.single {
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
/* §4.7 提示線是唯一表明「這是譯文」的記號;hover 時保留 */
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
/* §6.5 失敗必須可見:提示線改為虛線,不得沉默略過 */
.hint.failed {
  background: repeating-linear-gradient(
    to bottom,
    var(--ksnm-hint) 0 3px,
    transparent 3px 6px
  );
  opacity: 0.75;
}
.panel {
  position: fixed;
  right: 12px;
  bottom: 12px;
  width: 380px;
  max-height: 46vh;
  overflow: auto;
  pointer-events: auto;
  background: #10151b;
  color: #e6edf3;
  font: 12px/1.5 ui-monospace, monospace;
  padding: 10px 12px;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.panel h4 { margin: 0 0 6px; font-size: 12px; }
.panel table { width: 100%; border-collapse: collapse; }
.panel td { vertical-align: top; padding: 3px 4px; border-top: 1px solid #263039; }
.panel .s { color: #9db4c8; }
.panel .t { color: #ffe0a3; }
@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
}
`;

export class OverlayLayer {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private layer: HTMLDivElement;
  private panel: HTMLDivElement | null = null;
  private originX = 0;
  private originY = 0;

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
    document.body.appendChild(this.host);
    this.refreshOrigin();
  }

  /**
   * body 可能有 margin / position / transform,host 的實際原點不一定是
   * document (0,0)。每次重排讀一次,之後所有盒子用 document 座標減掉它。
   */
  refreshOrigin(): void {
    const r = this.host.getBoundingClientRect();
    this.originX = r.left + window.scrollX;
    this.originY = r.top + window.scrollY;
  }

  setMode(mode: DisplayMode): void {
    this.layer.classList.toggle('mode-full', mode === 'full');
    this.layer.classList.toggle('mode-peek', mode === 'peek');
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
    if (!unit.translation) return;
    if (!unit.box) {
      unit.box = document.createElement('div');
      this.layer.appendChild(unit.box);
    }
    const s = unit.style;
    const box = unit.box;
    const size = s.fontSizePx * unit.scale;
    const annot = unit.annotation || settings.forceAnnotation;
    box.className = `box${unit.singleLine ? ' single' : ''}${annot ? ' annotate' : ''}`;
    box.textContent = unit.translation;
    const vars: Record<string, string> = {
      '--ksnm-x': `${unit.rect.left - this.originX}px`,
      '--ksnm-y': `${unit.rect.top - this.originY}px`,
      '--ksnm-w': `${unit.rect.width}px`,
      '--ksnm-h': `${unit.rect.height}px`,
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
      '--ksnm-pad': s.padding.map((p) => `${p}px`).join(' '),
      '--ksnm-radius': s.borderRadius,
    };
    for (const [k, v] of Object.entries(vars)) box.style.setProperty(k, v);
    this.paintHint(unit, settings);
  }

  paintHint(unit: Unit, settings: Settings): void {
    const wanted = settings.hintLine && (unit.status === 'done' || unit.status === 'failed');
    if (!wanted) {
      unit.hint?.remove();
      unit.hint = undefined;
      return;
    }
    if (!unit.hint) {
      unit.hint = document.createElement('div');
      this.layer.appendChild(unit.hint);
    }
    const h = unit.hint;
    h.className = `hint${unit.status === 'failed' ? ' failed' : ''}`;
    const top = unit.firstRectTop;
    const height = Math.max(4, unit.rect.top + unit.rect.height - top);
    h.style.setProperty('--ksnm-hx', `${unit.rect.left - this.originX - 8}px`);
    h.style.setProperty('--ksnm-hy', `${top - this.originY}px`);
    h.style.setProperty('--ksnm-hh', `${height}px`);
    h.style.setProperty('--ksnm-hint', hintColor(unit.style.color));
  }

  drop(unit: Unit): void {
    unit.box?.remove();
    unit.hint?.remove();
    unit.box = undefined;
    unit.hint = undefined;
  }

  /** §6.4 第三層防線:抽樣人工比對。自動指標抓不到 id 對滑。 */
  showSample(units: Unit[], stats: string): void {
    if (!this.panel) {
      this.panel = document.createElement('div');
      this.panel.className = 'panel';
      this.layer.appendChild(this.panel);
    }
    const rows = units
      .map(
        (u) =>
          `<tr><td class="s">${u.id}<br>${escapeHtml(u.src.slice(0, 120))}</td>` +
          `<td class="t">${escapeHtml((u.translation ?? '(無)').slice(0, 120))}</td></tr>`,
      )
      .join('');
    this.panel.innerHTML =
      `<h4>Kasanemu debug — ${escapeHtml(stats)}</h4><table>${rows}</table>` +
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
