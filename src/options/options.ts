import type { ToWorker } from '../shared/messages';
import { TIERS, TIER_ORDER, type Tier } from '../shared/models';
import type { Settings } from '../shared/types';
import type { CacheDump } from '../worker/cache';
import {
  formatTerms,
  parseTerms,
  type Glossary,
  type Term,
} from '../shared/glossary';

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

/**
 * 詞表(`docs/plan-glossary.md`)。三個 textarea:全域、具名、綁定。
 *
 * 具名詞表用 `=== 名字` 分段。用文字而不是一堆增刪按鈕,是因為
 * 這種東西的實際維護方式是**貼進去、整段改** —— 一次改一條的 UI
 * 在真的要整理五十個術語時反而礙事。
 */
function bindGlossary(): void {
  const g = document.querySelector<HTMLTextAreaElement>('#global-glossary');
  const named = document.querySelector<HTMLTextAreaElement>('#glossaries');
  const bind = document.querySelector<HTMLTextAreaElement>('#glossary-binding');
  if (!g || !named || !bind) return;

  g.value = formatTerms(settings.globalGlossary);
  named.value = formatGlossaries(settings.glossaries);
  bind.value = formatBinding(settings.glossaries, settings.glossaryBinding);

  g.addEventListener('change', () => void save({ globalGlossary: parseTerms(g.value) }));
  const saveNamed = (): void => {
    const glossaries = parseGlossaries(named.value);
    void save({
      glossaries,
      // 綁定寫的是名字,存的是 id —— 詞表改名時綁定要跟著走,所以一起重算
      glossaryBinding: parseBinding(bind.value, glossaries),
    });
  };
  named.addEventListener('change', saveNamed);
  bind.addEventListener('change', saveNamed);
}

/** `=== 名字` 起一份新的;id 由名字推導,穩定且看得懂 */
function parseGlossaries(text: string): Record<string, Glossary> {
  const out: Record<string, Glossary> = {};
  let name = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (name === '') return;
    out[idOf(name)] = { name, terms: parseTerms(buf.join('\n')) };
    buf = [];
  };
  for (const line of text.split('\n')) {
    const m = /^\s*===\s*(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1] ?? '';
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function formatGlossaries(gs: Record<string, Glossary>): string {
  return Object.values(gs)
    .map((g) => `=== ${g.name}\n${formatTerms(g.terms)}`)
    .join('\n\n');
}

function idOf(name: string): string {
  return `g:${name.trim().toLowerCase()}`;
}

/** 綁定的 UI 是名字,存的是 id */
function parseBinding(text: string, gs: Record<string, Glossary>): Record<string, string[]> {
  const byName = new Map(Object.entries(gs).map(([id, g]) => [g.name.trim(), id]));
  const out: Record<string, string[]> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^(.*?)\s*(?:→|->)\s*(.*)$/.exec(line);
    if (!m) continue;
    const pattern = (m[1] ?? '').trim();
    const ids = (m[2] ?? '')
      .split(/[,、]/)
      .map((n) => byName.get(n.trim()))
      .filter((x): x is string => x !== undefined);
    if (pattern.length > 0 && ids.length > 0) out[pattern] = ids;
  }
  return out;
}

function formatBinding(
  gs: Record<string, Glossary>,
  binding: Record<string, string[]>,
): string {
  return Object.entries(binding)
    .map(([pattern, ids]) => {
      const names = ids.map((id) => gs[id]?.name).filter((n): n is string => n !== undefined);
      return names.length > 0 ? `${pattern} → ${names.join(', ')}` : '';
    })
    .filter((l) => l.length > 0)
    .join('\n');
}

interface GlossaryDump {
  v: 1;
  at: number;
  globalGlossary: Term[];
  glossaries: Record<string, Glossary>;
  glossaryBinding: Record<string, string[]>;
}

/**
 * 詞表的匯出匯入。**和快取那組分開**,因為兩者的價值不一樣:
 * 快取弄丟了再花一次錢就回得來,詞表弄丟了只能重打。
 */
function bindGlossaryIO(): void {
  const note = document.querySelector<HTMLElement>('#glossary-note');
  const file = document.querySelector<HTMLInputElement>('#glossary-file');
  const exportBtn = document.querySelector<HTMLButtonElement>('#export-glossary');
  const importBtn = document.querySelector<HTMLButtonElement>('#import-glossary');
  if (!note || !file || !exportBtn || !importBtn) return;

  exportBtn.addEventListener('click', () => {
    const dump: GlossaryDump = {
      v: 1,
      at: Date.now(),
      globalGlossary: settings.globalGlossary,
      glossaries: settings.glossaries,
      glossaryBinding: settings.glossaryBinding,
    };
    const json = JSON.stringify(dump, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `kasanemu-glossary-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const n = Object.keys(dump.glossaries).length;
    note.textContent = `已匯出:全域 ${dump.globalGlossary.length} 條 · 具名 ${n} 份`;
  });

  importBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = ''; // 同一個檔連續匯入兩次也要觸發 change
    if (!f) return;
    void (async () => {
      let dump: GlossaryDump;
      try {
        dump = JSON.parse(await f.text()) as GlossaryDump;
        if (dump.v !== 1) throw new Error('版本不符');
      } catch {
        note.textContent = '讀不懂這個檔 —— 需要匯出時產生的 .json';
        return;
      }
      /*
       * **同名的以檔案為準,本機獨有的保留。**
       * 快取那邊是「只補不覆蓋」,理由是現有的譯文不會比較差;
       * 詞表相反 —— 還原備份時你要的就是檔案裡的那個版本。
       */
      const glossaries = { ...settings.glossaries, ...(dump.glossaries ?? {}) };
      await save({
        globalGlossary: dump.globalGlossary ?? settings.globalGlossary,
        glossaries,
        glossaryBinding: { ...settings.glossaryBinding, ...(dump.glossaryBinding ?? {}) },
      });
      bindGlossary(); // 三個 textarea 重畫
      note.textContent =
        `已匯入:全域 ${settings.globalGlossary.length} 條 · 具名 ${Object.keys(glossaries).length} 份`;
    })();
  });
}

async function main(): Promise<void> {
  settings = await ask<Settings>({ type: 'get-settings' });
  renderSimpleFields();
  bindGlossary();
  bindGlossaryIO();
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

  $('#export-cache').addEventListener('click', () => void exportCache());
  $('#import-cache').addEventListener('click', () => $('#cache-file').click());
  $('#cache-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 同一個檔連續匯入兩次也要觸發 change
    if (file) void importCache(file);
  });
}

/** 快取匯出:檔名帶日期,匯回來的時候看得出是哪一份 */
async function exportCache(): Promise<void> {
  const note = $('#cache-note');
  note.textContent = '匯出中…';
  const dump = await ask<CacheDump>({ type: 'export-cache' });
  const json = JSON.stringify(dump);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kasanemu-cache-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  note.textContent = `已匯出 ${dump.count} 筆(${(json.length / 1024 / 1024).toFixed(2)} MB)`;
}

async function importCache(file: File): Promise<void> {
  const note = $('#cache-note');
  note.textContent = '匯入中…';
  let dump: unknown;
  try {
    dump = JSON.parse(await file.text());
  } catch {
    note.textContent = '讀不懂這個檔 —— 需要匯出時產生的 .json';
    return;
  }
  const res = await ask<{ added?: number; skipped?: number; error?: string }>({
    type: 'import-cache',
    dump,
  });
  if (res.error !== undefined) {
    note.textContent = `匯入失敗:${res.error}`;
    return;
  }
  note.textContent = `已匯入 ${res.added ?? 0} 筆,略過 ${res.skipped ?? 0} 筆(本來就有)`;
  flashSaved();
}

void main();
