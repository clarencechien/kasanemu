import type { PageStats, ToContent, ToWorker } from '../shared/messages';
import { TIERS, type Tier } from '../shared/models';
import type { DomainState, Pipeline, PipelineSpend, Settings, SpendDay } from '../shared/types';
import { clearDiag, readDiag, setDiagScope } from '../shared/diag';
import { buildReport, type ReportInput } from '../shared/report';
import { L0Engine, translatorSupported } from '../content/l0';
import { toTranslatorTarget } from '../content/lang';

interface Totals {
  todayUsd: number;
  monthUsd: number;
  today: SpendDay;
  monthTokens: { prompt: number; output: number; thoughts: number };
  monthByPipeline: Partial<Record<Pipeline, PipelineSpend>>;
  degraded?: string;
}

setDiagScope('popup');

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function ask<T>(msg: ToWorker): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

let host = '';
let tabId = -1;
let state: DomainState;
let settings: Settings;
let stats: PageStats | null = null;

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** feature.md §5.2 popup 直接向 content script 問本頁的階層統計 */
async function fetchStats(): Promise<PageStats | null> {
  if (tabId < 0) return null;
  try {
    // frameId: 0 = 只問最上層 frame。不指定的話訊息會廣播到分頁裡每一個
    // frame,誰先回誰算 —— 診斷報告的表頭曾經整段來自某個 iframe 裡
    // 還卡在啟動中的實例(總 0 區塊、實際生效 single)。
    return (await chrome.tabs.sendMessage(tabId, { type: 'get-page-stats' }, {
      frameId: 0,
    })) as PageStats;
  } catch {
    return null; // 這一頁沒有 content script(擴充頁、chrome:// 之類)
  }
}

function renderState(): void {
  const toggle = $<HTMLButtonElement>('toggle');
  toggle.textContent = state.enabled ? '已啟用' : '啟用';
  toggle.classList.toggle('on', state.enabled);
  const mode = $<HTMLButtonElement>('mode');
  mode.textContent = state.mode === 'full' ? '全開' : '點閱';
  mode.disabled = !state.enabled;
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=tier]')) {
    el.checked = el.value === state.tier;
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=pipeline]')) {
    el.checked = el.value === state.pipeline;
  }
  $('tier-note').textContent = `${TIERS[state.tier].modelId} — ${TIERS[state.tier].note}`;
  $('translate-note').textContent = settings.autoTranslate
    ? 'Alt+R;也用來重試失敗的區塊'
    : 'Alt+R;每一頁都要按一次';
  $<HTMLInputElement>('auto').checked = settings.autoTranslate;
  $('auto-note').textContent = settings.autoTranslate
    ? '進站與換頁都會自動整頁翻 —— 會持續產生 API 花費'
    : '啟用只是「這個網域我要用」;要翻是另一個動作。換頁後也要再按一次。';
}

/** feature.md §6:不支援時要明確告知,不是靜靜地什麼都沒發生 */
function renderL0(): void {
  const el = $('l0-status');
  const btn = $<HTMLButtonElement>('l0-download');
  const supported = stats?.l0.supported ?? translatorSupported();
  if (!supported) {
    el.textContent = 'L0 不可用:這個環境沒有 Translator API(需桌機版 Chrome 138+)';
    btn.classList.add('hidden');
    return;
  }
  if (!stats) {
    el.textContent = 'L0:這一頁沒有 content script';
    btn.classList.add('hidden');
    return;
  }
  const { state: s, sourceLang, detail } = stats.l0;
  const pair = `${sourceLang} → ${toTranslatorTarget(settings.targetLang)}`;
  const label: Record<string, string> = {
    idle: `L0 ${pair}:尚未建立`,
    ready: `L0 ${pair}:就緒`,
    'needs-gesture': `L0 ${pair}:需要下載語言包`,
    downloading: `L0 ${pair}:${detail}`,
    unsupported: `L0 ${pair}:${detail || '這台機器沒有這個語言對'}`,
    failed: `L0 ${pair}:${detail}`,
  };
  el.textContent = label[s] ?? `L0 ${pair}:${s}`;
  // §3.2 規則 2:downloadable 的 create() 需要 user gesture,所以按鈕在這裡
  btn.classList.toggle('hidden', !(s === 'needs-gesture' || s === 'idle' || s === 'failed'));
  if (stats.effective !== stats.pipeline) {
    el.textContent += `(已退回 ${stats.effective})`;
  }
}

function renderPageTiers(): void {
  const el = $('page-tiers');
  const warn = $('page-warn');
  if (!stats) {
    el.textContent = '—';
    warn.textContent = '';
    return;
  }
  const c = stats.counts;
  const first = stats.firstPaintMs >= 0 ? `${stats.firstPaintMs}ms` : '—';
  el.textContent =
    `L0 ${c.l0} · L1 ${c.l1} · 失敗 ${c.failed + c['l1-failed']} · ` +
    `待譯 ${c.pending + c['l0-failed']} · 跳過 ${c.skipped}\n首屏 ${first}` +
    (stats.swapsTotal > 0 ? ` · 替換 ${stats.swapsTotal}(離屏 ${stats.swapsOffscreen})` : '');
  // feature.md §5.2:L1 = 0 且佇列非空超過 10 秒就要明確警示,不要靜靜地不動
  if (stats.stalled) {
    warn.textContent = `L1 一個都沒回來,已等 ${Math.round(
      stats.stalledMs / 1000,
    )} 秒 —— 升級管線可能死了(key、預算、模型 ID、429)`;
  } else if (c.l1 === 0 && c.l0 > 0 && stats.effective === 'progressive') {
    warn.textContent = '整頁還停在 L0(提示線全是虛線)';
  } else {
    warn.textContent = '';
  }
}

function fmtTwd(usd: number): string {
  return `NT$${(usd * (settings.usdToTwd || 32)).toFixed(2)}`;
}

function renderSpend(t: Totals): void {
  $('today-twd').textContent = fmtTwd(t.todayUsd);
  $('today-usd').textContent = `$${t.todayUsd.toFixed(4)}`;
  $('month-twd').textContent = fmtTwd(t.monthUsd);
  $('month-usd').textContent = `$${t.monthUsd.toFixed(4)}`;
  $('tk-prompt-d').textContent = t.today.promptTokens.toLocaleString();
  $('tk-output-d').textContent = t.today.outputTokens.toLocaleString();
  $('tk-thoughts-d').textContent = t.today.thoughtsTokens.toLocaleString();
  $('tk-prompt-m').textContent = t.monthTokens.prompt.toLocaleString();
  $('tk-output-m').textContent = t.monthTokens.output.toLocaleString();
  $('tk-thoughts-m').textContent = t.monthTokens.thoughts.toLocaleString();

  // feature.md §2.2:按模式分開累計,兩週 A/B 才有數字可比
  const body = $('by-pipeline').querySelector('tbody')!;
  body.textContent = '';
  const rows: Array<[Pipeline, PipelineSpend | undefined]> = [
    ['single', t.monthByPipeline.single],
    ['progressive', t.monthByPipeline.progressive],
    ['l0-only', t.monthByPipeline['l0-only']],
  ];
  for (const [name, v] of rows) {
    const tr = document.createElement('tr');
    const tokens = v ? v.promptTokens + v.outputTokens + v.thoughtsTokens : 0;
    tr.innerHTML =
      `<td>${name}</td><td>${tokens.toLocaleString()}</td>` +
      `<td>${v ? fmtTwd(v.usd) : 'NT$0.00'}</td>`;
    body.appendChild(tr);
  }

  const twdToday = t.todayUsd * (settings.usdToTwd || 32);
  const left = settings.globalDailyTWD - twdToday;
  const parts = [`日預算剩 NT$${left.toFixed(2)} / NT$${settings.globalDailyTWD}`];
  if (t.monthTokens.thoughts > 0) parts.push('thoughts 不是 0,thinking 沒關掉');
  if (left <= 0) parts.push('已停止所有付費呼叫');
  if (t.degraded) parts.push('保險絲計數器降級中(放行並警示)');
  if (!settings.apiKey) parts.push('尚未設定 API key');
  $('fuse').textContent = parts.join(' · ');
}

/** §6.5 / §12.2 降級與失敗必須看得見,不能只留在 console */
async function renderNotice(): Promise<void> {
  const got = await chrome.storage.session.get('lastNotice');
  const n = got['lastNotice'] as { level: string; text: string; at: number } | undefined;
  const el = $('notice');
  if (!n || Date.now() - n.at > 10 * 60_000) {
    el.textContent = '';
    return;
  }
  const mark = n.level === 'error' ? '✗' : '!';
  el.textContent = `${mark} ${new Date(n.at).toLocaleTimeString()} ${n.text}`;
}

async function refresh(): Promise<void> {
  settings = await ask<Settings>({ type: 'get-settings' });
  state = await ask<DomainState>({ type: 'get-domain-state', host });
  stats = await fetchStats();
  renderState();
  renderL0();
  renderPageTiers();
  renderSpend(await ask<Totals>({ type: 'get-spend' }));
  await renderNotice();
}

/**
 * feature.md §3.2 規則 2 + 規則 3:語言包下載必須發生在 user gesture 裡,
 * 而且要有進度回報,否則使用者以為卡住。
 * 這是整個 feature 唯一必須待在 popup 的一段邏輯。
 */
async function downloadL0(): Promise<void> {
  const btn = $<HTMLButtonElement>('l0-download');
  const el = $('l0-status');
  const src = stats?.l0.sourceLang ?? settings.l0SourceLang;
  const engine = new L0Engine(src, toTranslatorTarget(settings.targetLang));
  btn.disabled = true;
  const tick = window.setInterval(() => {
    el.textContent = engine.detail || '下載中…';
  }, 200);
  const ok = await engine.ensure(true);
  clearInterval(tick);
  btn.disabled = false;
  el.textContent = ok ? `L0 ${src} → ${toTranslatorTarget(settings.targetLang)}:就緒` : engine.detail;
  if (ok) {
    btn.classList.add('hidden');
    // 語言包是瀏覽器層級的資源,下載完就叫頁面重試卡住的區塊
    if (tabId >= 0) {
      await chrome.tabs
        .sendMessage(tabId, { type: 'l0-ready' }, { frameId: 0 })
        .catch(() => undefined);
    }
    window.setTimeout(() => void refresh(), 400);
  }
  engine.destroy();
}

/**
 * 一鍵匯出可以直接貼出來的診斷報告。
 * API key 只留長度與前後兩碼;原文與譯文一律截斷到 60 字。
 */
/** worker 那一側的佇列深度。問不到就是 null —— 報告會把它寫成「問不到」 */
async function askWorkerQueue(): Promise<ReportInput['workerQueue']> {
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'page-status',
      pageKey: stats?.pageKey ?? '',
    } satisfies ToWorker);
    return (r as ReportInput['workerQueue']) ?? null;
  } catch {
    return null;
  }
}

async function exportLog(): Promise<void> {
  const note = $('export-note');
  const tab = await activeTab();
  const stored = await chrome.storage.local.get('modelCheck');
  const md = buildReport({
    version:
      chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version,
    url: tab?.url ?? '(unknown)',
    userAgent: navigator.userAgent,
    settings,
    domain: state ?? null,
    stats,
    modelCheck: stored['modelCheck'],
    workerQueue: await askWorkerQueue(),
    events: await readDiag(),
    now: Date.now(),
  });

  let copied = false;
  try {
    await navigator.clipboard.writeText(md);
    copied = true;
  } catch {
    /* 沒有剪貼簿權限就只給檔案 */
  }

  // 存檔:popup 關掉之後剪貼簿還在,但有檔案比較不會弄丟
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kasanemu-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  const kb = (md.length / 1024).toFixed(1);
  note.textContent = copied ? `已複製到剪貼簿並下載(${kb} KB)` : `已下載(${kb} KB);剪貼簿被擋了`;
}

/**
 * 把「疊好的樣子」存成 HTML。
 *
 * 譯文從來沒有寫進頁面,所以這不是「另存新檔」—— content script 會在
 * DOM 的複本上把原文與譯文並排放好,再交給這裡下載(見 content/snapshot.ts)。
 */
async function exportPage(): Promise<void> {
  const note = $('page-note');
  if (tabId < 0) {
    note.textContent = '找不到分頁';
    return;
  }
  note.textContent = '組裝中…';
  let res: { html?: string; applied?: number; total?: number; title?: string; error?: string };
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'export-page' } satisfies ToContent);
  } catch {
    note.textContent = '這一頁沒有 content script(或還沒啟用)';
    return;
  }
  if (!res?.html) {
    note.textContent = res?.error ?? '匯出失敗';
    return;
  }
  const url = URL.createObjectURL(new Blob([res.html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  const slug = (res.title ?? 'page').replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 60);
  a.download = `kasanemu-${slug || 'page'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  const mb = (res.html.length / 1024 / 1024).toFixed(2);
  note.textContent =
    `已存 ${res.applied}/${res.total} 段譯文(${mb} MB)· ` +
    '樣式與圖片仍然向原站取用,離線開會只剩文字';
}

async function main(): Promise<void> {
  const tab = await activeTab();
  tabId = tab?.id ?? -1;
  try {
    host = tab?.url ? new URL(tab.url).hostname : '';
  } catch {
    host = '';
  }
  $('host').textContent = host || '(無法作用的頁面)';
  // 每一包都叫 0.1.0 的話,回報問題時沒人知道手上那包含不含某個修正
  const mf = chrome.runtime.getManifest();
  $('version').textContent = mf.version_name ?? mf.version;
  $('version').title = `manifest ${mf.version}`;
  await refresh();

  $('toggle').addEventListener('click', async () => {
    state = await ask<DomainState>({
      type: 'set-domain-state',
      host,
      patch: { enabled: !state.enabled },
    });
    renderState();
  });

  $('mode').addEventListener('click', async () => {
    state = await ask<DomainState>({
      type: 'set-domain-state',
      host,
      patch: { mode: state.mode === 'full' ? 'peek' : 'full' },
    });
    renderState();
  });

  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=tier]')) {
    el.addEventListener('change', async () => {
      state = await ask<DomainState>({
        type: 'set-domain-state',
        host,
        patch: { tier: el.value as Tier },
      });
      renderState();
    });
  }

  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=pipeline]')) {
    el.addEventListener('change', async () => {
      state = await ask<DomainState>({
        type: 'set-domain-state',
        host,
        patch: { pipeline: el.value as Pipeline },
      });
      renderState();
      window.setTimeout(() => void refresh(), 300);
    });
  }

  $('auto').addEventListener('change', async () => {
    const on = $<HTMLInputElement>('auto').checked;
    settings = await ask<Settings>({ type: 'set-settings', patch: { autoTranslate: on } });
    renderState();
    window.setTimeout(() => void refresh(), 300);
  });

  // 使用者要的「啟用之後再按翻譯」。自動翻譯關掉時,這是唯一的入口。
  $('translate').addEventListener('click', async () => {
    if (tabId < 0) return;
    const btn = $<HTMLButtonElement>('translate');
    btn.disabled = true;
    await chrome.tabs
      .sendMessage(tabId, { type: 'command', command: 'translate-page' })
      .catch(() => undefined);
    window.setTimeout(async () => {
      await refresh();
      btn.disabled = false;
    }, 500);
  });

  $('export-log').addEventListener('click', () => void exportLog());
  $('export-page').addEventListener('click', () => void exportPage());
  $('clear-log').addEventListener('click', async () => {
    await clearDiag();
    $('export-note').textContent = '記錄已清空 —— 重現一次問題再匯出';
  });

  $('l0-download').addEventListener('click', () => void downloadL0());

  $('clear-cache').addEventListener('click', async () => {
    await ask({ type: 'clear-cache' });
    $('fuse').textContent = '快取已清空';
  });

  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

void main();
