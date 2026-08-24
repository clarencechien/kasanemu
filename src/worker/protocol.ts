import type { UnitFailure, UnitRequest, UnitResult } from '../shared/types';

/** 粗估 token 數,只用來卡 batch 的輸入軟上限 (§5.4),寧可高估 */
const CJK_RANGE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (CJK_RANGE.test(ch)) cjk++;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.2 + other / 3.4) + 4;
}

export function echoOf(src: string): string {
  return [...src].slice(0, 8).join('');
}

const SYSTEM_PROMPT = [
  '你是網頁翻譯引擎。輸入是一個 JSON array,每筆是一個獨立的網頁區塊。',
  '規則:',
  '1. 只輸出 JSON array,不要 markdown 圍籬、不要說明文字。',
  '2. 每筆輸出 {"id","echo","t"} 三個鍵。id 必須與輸入完全相同,不得重編、不得合併、不得改順序。',
  '3. echo = 該筆輸入 src 的前 8 個字元,原樣照抄,不翻譯、不修正。',
  '4. t = 譯文。譯文長度請控制在該筆的 maxChars 個字以內;maxChars 是上限不是目標,不要為了湊字數而膨脹。',
  '5. role 表示排版角色:heading 用標題語域(簡短、不加句號)、cell 用表格語域(極簡)、meta 用註記語域、body/list 用正文語域。',
  '6. 專有名詞、程式碼片段、URL、版本號原樣保留。',
  '7. 輸入有幾筆就輸出幾筆,不得漏、不得多。',
].join('\n');

export function systemPrompt(targetLang: string): string {
  const langName = targetLang === 'zh-TW' ? '繁體中文(台灣用語)' : targetLang;
  return `${SYSTEM_PROMPT}\n8. 目標語言:${langName}。`;
}

export function userPayload(units: UnitRequest[]): string {
  return JSON.stringify(
    units.map((u) => ({ id: u.id, src: u.src, maxChars: u.maxChars, role: u.role })),
  );
}

/** 回應 schema。Gemma 走 Gemini API 時不一定支援,呼叫端要能降級 (開放問題 3) */
export const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      echo: { type: 'STRING' },
      t: { type: 'STRING' },
    },
    required: ['id', 'echo', 't'],
  },
} as const;

/**
 * §6.6 JSON 截斷修復。deterministic 的尾部修復:
 * 補齊未閉合的括號並丟棄最後一筆不完整項目。
 * 修復後仍必須通過 §6.4 的三層檢查。
 */
export function repairJsonArray(raw: string): unknown[] | null {
  let text = raw.trim();
  // 模型有時仍會包 markdown 圍籬
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('[');
  if (start < 0) return null;
  text = text.slice(start);
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    /* 往下走尾部修復 */
  }

  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastComplete = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      // 深度回到 1 表示剛剛關掉一個 array 內的物件
      if (depth === 1 && c === '}') lastComplete = i;
    }
  }
  if (lastComplete < 0) return null;
  const patched = `${text.slice(0, lastComplete + 1)}]`;
  try {
    const parsed: unknown = JSON.parse(patched);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ParseOutcome {
  results: UnitResult[];
  failures: UnitFailure[];
  /** 用於 debug 面板與 log 的統計 */
  stats: { got: number; kept: number; echoMismatch: number; unknown: number; dupe: number; missing: number };
}

/**
 * §6.4 id 紀律三層防線。模型輸出視為敵意輸入。
 * 第一層:結構檢查(範圍、去重、缺漏)
 * 第二層:原文回聲對位(對不上就丟棄該筆,不要嘗試修復)
 * 第三層在 content script 的 debug 面板(抽樣人工比對)
 */
export function parseBatch(raw: string, sent: UnitRequest[], truncated: boolean): ParseOutcome {
  const bySent = new Map(sent.map((u) => [u.id, u]));
  const results: UnitResult[] = [];
  const failures: UnitFailure[] = [];
  const seen = new Set<string>();
  const stats = { got: 0, kept: 0, echoMismatch: 0, unknown: 0, dupe: 0, missing: 0 };

  const arr = repairJsonArray(raw);
  if (!arr) {
    for (const u of sent) failures.push({ id: u.id, reason: truncated ? 'truncated' : 'api-error', detail: 'JSON 無法解析' });
    stats.missing = sent.length;
    return { results, failures, stats };
  }

  for (const item of arr) {
    stats.got++;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : '';
    const t = typeof rec['t'] === 'string' ? rec['t'] : '';
    const echo = typeof rec['echo'] === 'string' ? rec['echo'] : '';
    const src = bySent.get(id);
    if (!src) {
      stats.unknown++;
      continue; // 多出來的 id,直接丟
    }
    if (seen.has(id)) {
      stats.dupe++;
      failures.push({ id, reason: 'duplicate-id' });
      continue;
    }
    seen.add(id);
    if (!t.trim()) {
      failures.push({ id, reason: 'empty' });
      continue;
    }
    const want = echoOf(src.src);
    if (!echoMatches(echo, want)) {
      stats.echoMismatch++;
      failures.push({ id, reason: 'echo-mismatch', detail: `want ${JSON.stringify(want)} got ${JSON.stringify(echo)}` });
      continue;
    }
    results.push({ id, t: t.trim() });
    stats.kept++;
  }

  for (const u of sent) {
    if (seen.has(u.id)) continue;
    stats.missing++;
    failures.push({ id: u.id, reason: truncated ? 'truncated' : 'missing-id' });
  }
  return { results, failures, stats };
}

/**
 * §6.4 第二層防線的比對用正規化。
 *
 * 放寬的只有「同一句話的不同寫法」:空白、全形/半形(NFKC)、大小寫、
 * 以及模型愛自作主張的引號與破折號。**沒有**放寬到失去偵測力 ——
 * batch 內 id 對滑時,echo 來自完全不同的句子,正規化後照樣對不上。
 *
 * 起因:實際跑 claude.com/blog 時出現一批 echo-mismatch,
 * 而那些譯文其實是對的。誤殺會讓區塊變成失敗(提示線警示色),
 * 比放寬這幾種等價寫法更糟。
 */
export function normalizeEcho(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 模型有時候回的 echo 短一截(數到第 8 個字的方式不同,尤其有 emoji
 * 或組合字時)。互為前綴且長度夠([...4 個字元])就算過。
 */
export function echoMatches(got: string, want: string): boolean {
  const a = normalizeEcho(got);
  const b = normalizeEcho(want);
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 4 && long.startsWith(short);
}
