import type { ToWorker } from '../shared/messages';
import { getDomainState, getSettings, resolveTier, setDomainState, setSettings } from '../shared/settings';
import { TIER_ORDER, isBlockedModel } from '../shared/models';
import { setDebug, warn } from '../shared/log';
import { listModels } from './gemini';
import { drain, dropPage, dropTab, enqueue } from './scheduler';
import { totals } from './budget';
import * as cache from './cache';

/** §5.2 模型 ID 必須驗證。不存在的 ID 直接在 options 標紅,不要等執行時才 400。 */
export interface ModelCheck {
  at: number;
  available: string[] | null;
  problems: Array<{ tier: string; modelId: string; issue: 'missing' | 'blocked' }>;
}

async function validateModels(): Promise<ModelCheck> {
  const settings = await getSettings();
  const available = settings.apiKey ? await listModels(settings.apiKey) : null;
  const problems: ModelCheck['problems'] = [];
  for (const tier of TIER_ORDER) {
    const spec = resolveTier(tier, settings);
    if (isBlockedModel(spec.modelId)) {
      // §5.5 3.6 系列有 batch 內 id 對滑,不採用
      problems.push({ tier, modelId: spec.modelId, issue: 'blocked' });
      continue;
    }
    if (available && !available.includes(spec.modelId)) {
      problems.push({ tier, modelId: spec.modelId, issue: 'missing' });
    }
  }
  const check: ModelCheck = { at: Date.now(), available, problems };
  await chrome.storage.local.set({ modelCheck: check });
  return check;
}

chrome.runtime.onMessage.addListener((raw: ToWorker, sender, reply) => {
  void (async () => {
    const tabId = sender.tab?.id ?? -1;
    try {
      switch (raw?.type) {
        case 'get-settings': {
          const s = await getSettings();
          setDebug(s.debug);
          reply(s);
          break;
        }
        case 'set-settings': {
          reply(await setSettings(raw.patch));
          break;
        }
        case 'get-domain-state': {
          reply(await getDomainState(raw.host));
          break;
        }
        case 'set-domain-state': {
          reply(await setDomainState(raw.host, raw.patch));
          break;
        }
        case 'enqueue': {
          if (tabId >= 0) await enqueue(tabId, raw.pageKey, raw.tier, raw.units);
          reply({ ok: true });
          break;
        }
        case 'drop-page': {
          if (tabId >= 0) await dropPage(tabId, raw.pageKey);
          reply({ ok: true });
          break;
        }
        case 'get-spend': {
          reply(await totals());
          break;
        }
        case 'validate-models': {
          reply(await validateModels());
          break;
        }
        case 'clear-cache': {
          await cache.clearAll();
          reply({ ok: true });
          break;
        }
        default:
          reply({ ok: false });
      }
    } catch (e) {
      warn('message handler failed', raw?.type, e);
      reply({ ok: false, error: String(e) });
    }
  })();
  return true; // 非同步回覆
});

/** §2.1 快捷鍵。用 commands API 而不是 content script 的 keydown,焦點在輸入框時也有效。 */
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-enabled' && command !== 'toggle-mode') return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'command', command }).catch(() => undefined);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'drain') void drain();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void dropTab(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  void validateModels();
  void drain();
});

chrome.runtime.onInstalled.addListener(() => {
  void validateModels();
});
