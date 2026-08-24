import type { ToWorker } from '../shared/messages';
import { TIERS, type Tier } from '../shared/models';
import type { DomainState, Settings } from '../shared/types';

interface Totals {
  todayUsd: number;
  monthUsd: number;
  today: { promptTokens: number; outputTokens: number; thoughtsTokens: number; calls: number };
  monthTokens: { prompt: number; output: number; thoughts: number };
  degraded?: string;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function ask<T>(msg: ToWorker): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

let host = '';
let state: DomainState;
let settings: Settings;

async function activeHost(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return '';
  try {
    return new URL(tab.url).hostname;
  } catch {
    return '';
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
  $('tier-note').textContent = `${TIERS[state.tier].modelId} — ${TIERS[state.tier].note}`;
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
  renderState();
  renderSpend(await ask<Totals>({ type: 'get-spend' }));
  await renderNotice();
}

async function main(): Promise<void> {
  host = await activeHost();
  $('host').textContent = host || '(無法作用的頁面)';
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

  $('clear-cache').addEventListener('click', async () => {
    await ask({ type: 'clear-cache' });
    $('fuse').textContent = '快取已清空';
  });

  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

void main();
