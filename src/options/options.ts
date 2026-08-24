import type { ToWorker } from '../shared/messages';
import { TIERS, TIER_ORDER, type Tier } from '../shared/models';
import type { Settings } from '../shared/types';

interface ModelCheck {
  at: number;
  available: string[] | null;
  problems: Array<{ tier: string; modelId: string; issue: 'missing' | 'blocked' }>;
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

function ask<T>(msg: ToWorker): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

let settings: Settings;
let savedTimer = 0;

function flashSaved(): void {
  const el = $('#saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => el.classList.remove('show'), 900);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await ask<Settings>({ type: 'set-settings', patch });
  flashSaved();
}

/** 三檔的模型 ID、配額、價表。配額與價表都不寫死,options 可覆寫 (§7.2 / §8.2) */
function renderTiers(): void {
  const wrap = $('#tiers');
  wrap.innerHTML = '';
  for (const tier of TIER_ORDER) {
    const base = TIERS[tier];
    const q = settings.quota[tier] ?? {};
    const p = settings.price[tier] ?? {};
    const div = document.createElement('div');
    div.className = 'tier';
    div.innerHTML = `
      <h3>${tier}</h3>
      <div class="meta">${base.note} · batch ${base.batchUnits} 塊 / ${base.batchTokens} token</div>
      <label>模型 ID<input type="text" data-tier="${tier}" data-f="modelId" value="${
        settings.modelIds[tier] ?? base.modelId
      }" /></label>
      <div class="grid">
        <label>RPM<input type="number" data-tier="${tier}" data-f="rpm" value="${q.rpm ?? base.rpm}" /></label>
        <label>TPM<input type="number" data-tier="${tier}" data-f="tpm" value="${q.tpm ?? base.tpm}" /></label>
        <label>RPD<input type="number" data-tier="${tier}" data-f="rpd" value="${q.rpd ?? base.rpd}" /></label>
        <label>輸入 $/M<input type="number" step="0.01" data-tier="${tier}" data-f="inPrice" value="${
          p.inPrice ?? base.inPrice
        }" /></label>
        <label>輸出 $/M<input type="number" step="0.01" data-tier="${tier}" data-f="outPrice" value="${
          p.outPrice ?? base.outPrice
        }" /></label>
      </div>`;
    wrap.appendChild(div);
  }
  for (const input of wrap.querySelectorAll<HTMLInputElement>('input[data-tier]')) {
    input.addEventListener('change', () => {
      const tier = input.dataset['tier'] as Tier;
      const field = input.dataset['f']!;
      if (field === 'modelId') {
        void save({ modelIds: { ...settings.modelIds, [tier]: input.value.trim() } });
        return;
      }
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      if (field === 'inPrice' || field === 'outPrice') {
        void save({ price: { ...settings.price, [tier]: { ...settings.price[tier], [field]: n } } });
      } else {
        void save({ quota: { ...settings.quota, [tier]: { ...settings.quota[tier], [field]: n } } });
      }
    });
  }
}

function renderSimpleFields(): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]')) {
    const key = el.dataset['k'] as keyof Settings;
    const value = settings[key];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value ?? '');
    el.addEventListener('change', () => {
      let next: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') next = el.checked;
      else if (el.dataset['num'] !== undefined) next = Number(el.value);
      else next = el.value;
      void save({ [key]: next } as Partial<Settings>);
    });
  }
}

function renderCheck(check: ModelCheck | undefined): void {
  const out = $('#model-check');
  if (!check) {
    out.textContent = '尚未驗證。';
    return;
  }
  const when = new Date(check.at).toLocaleString();
  const lines: string[] = [];
  if (check.available === null) lines.push('拿不到模型清單(沒有 key 或請求失敗),ID 未驗證。');
  for (const p of check.problems) {
    lines.push(
      p.issue === 'blocked'
        ? `${p.tier}: ${p.modelId} 在排除清單上(3.6 系列有 batch 內 id 對滑)`
        : `${p.tier}: ${p.modelId} 不在可用清單上`,
    );
  }
  if (check.problems.length === 0 && check.available) lines.push('三檔的模型 ID 都存在。');
  out.textContent = `${when}\n${lines.join('\n')}`;
  out.classList.toggle('bad', check.problems.length > 0);
  const bad = new Set(check.problems.map((p) => p.tier));
  for (const input of document.querySelectorAll<HTMLInputElement>('input[data-f="modelId"]')) {
    input.classList.toggle('bad', bad.has(input.dataset['tier'] ?? ''));
  }
}

async function main(): Promise<void> {
  settings = await ask<Settings>({ type: 'get-settings' });
  renderSimpleFields();
  renderTiers();
  const stored = await chrome.storage.local.get('modelCheck');
  renderCheck(stored['modelCheck'] as ModelCheck | undefined);

  $('#validate').addEventListener('click', async () => {
    $('#model-check').textContent = '驗證中…';
    renderCheck(await ask<ModelCheck>({ type: 'validate-models' }));
  });

  $('#clear-cache').addEventListener('click', async () => {
    await ask({ type: 'clear-cache' });
    flashSaved();
  });
}

void main();
