import type { PageStats } from './messages';
import type { DomainState, Settings } from './types';
import type { DiagEvent } from './diag';

/**
 * 把診斷資料組成一段可以直接貼出來的 Markdown。
 *
 * 硬性規則:**API key 絕對不進去**,只留長度與前後各兩碼,
 * 足以判斷「是不是貼錯了」但貼出去不會外洩。
 */
export interface ReportInput {
  version: string;
  url: string;
  userAgent: string;
  settings: Settings;
  domain: DomainState | null;
  stats: PageStats | null;
  modelCheck: unknown;
  events: DiagEvent[];
  now: number;
}

export function maskKey(key: string): string {
  if (!key) return '(未設定)';
  if (key.length <= 8) return `(長度 ${key.length})`;
  return `${key.slice(0, 2)}…${key.slice(-2)}(長度 ${key.length})`;
}

/** 設定裡只有這些對除錯有用;其餘(尤其 key)不進報告 */
function settingsDigest(s: Settings): Record<string, unknown> {
  return {
    apiKey: maskKey(s.apiKey),
    targetLang: s.targetLang,
    defaultTier: s.defaultTier,
    defaultPipeline: s.defaultPipeline,
    modelIds: s.modelIds,
    autoTranslate: s.autoTranslate,
    upgradeDwellMs: s.upgradeDwellMs,
    l0SourceLang: s.l0SourceLang,
    cacheMode: s.cacheMode,
    weightOffset: s.weightOffset,
    overlayBleedPx: s.overlayBleedPx,
    hintLine: s.hintLine,
    forceAnnotation: s.forceAnnotation,
    globalDailyTWD: s.globalDailyTWD,
    pageTokenCap: s.pageTokenCap,
    noTranslateTerms: s.noTranslateTerms.length,
  };
}

function fence(label: string, value: unknown): string {
  return `**${label}**\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

export function buildReport(i: ReportInput): string {
  const t = (at: number) => new Date(at).toISOString().slice(11, 23);
  const lines: string[] = [];
  lines.push(`# Kasanemu 診斷 ${new Date(i.now).toISOString()}`);
  lines.push('');
  // build number 與 sha 是判斷「這個 bug 修過了沒」的第一手資訊
  lines.push(`- 版本:${i.version}`);
  lines.push(`- 頁面:${i.url}`);
  lines.push(`- UA:${i.userAgent}`);
  lines.push('');

  if (i.stats) {
    const c = i.stats.counts;
    lines.push('## 本頁');
    lines.push('');
    lines.push(`- 管線:${i.stats.pipeline}(實際生效 ${i.stats.effective})`);
    lines.push(
      `- 區塊:總 ${i.stats.total} · L0 ${c.l0} · L1 ${c.l1} · 待翻 ${c.pending} · ` +
        `L0 失敗 ${c['l0-failed']} · L1 失敗 ${c['l1-failed']} · 失敗 ${c.failed} · 跳過 ${c.skipped}`,
    );
    lines.push(`- 首屏:${i.stats.firstPaintMs}ms · 替換 ${i.stats.swapsTotal}(離屏 ${i.stats.swapsOffscreen})`);
    lines.push(
      `- L0:${i.stats.l0.state} · ${i.stats.l0.sourceLang} · ` +
        `supported=${i.stats.l0.supported} · ${i.stats.l0.detail || '—'}`,
    );
    const t = i.stats.l0Timing;
    if (t && t.calls > 0) {
      lines.push(
        `- L0 延遲:呼叫 ${t.calls} 次 · 平均 ${t.avgMs}ms · 最高 ${t.maxMs}ms · ` +
          `排隊 ${t.avgWaitMs}ms · 併發 ${t.concurrency}`,
      );
    }
    const d = i.stats.device;
    if (d) {
      // 「同樣是 12 代 U」不是可比的資訊,這三個數字才是
      lines.push(
        `- 機器:${d.threads} 執行緒 · 記憶體 ${d.memoryGB || '?'}GB · ` +
          `CPU 微基準 ${d.cpuMs}ms(越小越快)· ${d.platform}`,
      );
    }
    if (i.stats.motion) {
      const m = i.stats.motion;
      lines.push(
        `- 捲動策略:${m.stability} → ${m.guard ? '捲動時先藏' : '一直顯示'}` +
          `(appShell=${m.appShell} 內層捲動=${m.innerScroll} 釘住的單元 ${m.pinned})`,
      );
    }
    const bad = i.stats.unparsedColors ?? [];
    if (bad.length > 0) lines.push(`- **顏色解析失敗 ${bad.length} 種**:${bad.join(' · ')}`);
    if (i.stats.stalled) lines.push(`- **停滯 ${Math.round(i.stats.stalledMs / 1000)} 秒:L1 一個都沒回來**`);
    lines.push('');
  } else {
    lines.push('## 本頁\n\n(這一頁沒有 content script,或擴充未啟用)\n');
  }

  lines.push(fence('網域狀態', i.domain));
  lines.push(fence('設定(已遮蔽 key)', settingsDigest(i.settings)));
  lines.push(fence('模型 ID 驗證', i.modelCheck ?? '(尚未驗證)'));

  lines.push('## 事件');
  lines.push('');
  if (i.events.length === 0) {
    lines.push('(沒有記錄。重現一次問題再匯出。)');
  } else {
    lines.push('```');
    for (const e of i.events) {
      const mark = e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : ' ';
      const data = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
      lines.push(`${t(e.at)} ${mark} [${e.scope}] ${e.msg}${data}`);
    }
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}
