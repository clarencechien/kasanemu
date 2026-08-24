/**
 * feature.md §3.4 L0 的過濾前處理。
 *
 * Translator API 沒有 system prompt,不能像 L1 那樣「請保留專有名詞」,
 * 所以送出前自己把不該翻的片段換成佔位符,翻完再還原。
 *
 * 開放問題 3 建議用私用區字元而不是 `__CODE_1__`:後者是英文單字加底線,
 * TranslateKit 有可能翻掉它、拆開它、或搬動它的位置。
 * 這裡每個佔位符是**單一** PUA 字元(U+E000 起),
 * 沒有字母、沒有分隔符、不可能被斷詞切開。
 */
const PUA_START = 0xe000;
const PUA_END = 0xf8ff;

export interface Masked {
  /** 送去翻譯的文字 */
  text: string;
  /** 被保護的片段,依佔位符順序 */
  tokens: string[];
  /**
   * 把譯文裡的佔位符換回原文片段。
   * 佔位符遺失(被翻掉、被吃掉)時回 null —— 寧可讓這個區塊算 L0 失敗、
   * 提示線變色,也不要交出一份看起來正常但少了程式碼的譯文。
   */
  restore(translated: string): string | null;
}

function placeholder(i: number): string {
  return String.fromCodePoint(PUA_START + i);
}

/** 來源文字本來就含 PUA 字元的話,佔位符會撞上,這種區塊直接不做保護 */
export function hasPua(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= PUA_START && c <= PUA_END) return true;
  }
  return false;
}

/**
 * 以佔位符保護 `protect` 裡的片段。
 * 長的先換,否則短片段會先把長片段切碎(例如同時保護 "Chrome" 與 "Chrome OS")。
 */
export function mask(src: string, protect: readonly string[]): Masked {
  const wanted = [...new Set(protect.map((s) => s.trim()).filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  const tokens: string[] = [];
  let text = src;

  if (!hasPua(src)) {
    for (const frag of wanted) {
      if (tokens.length >= PUA_END - PUA_START) break;
      if (!text.includes(frag)) continue;
      const ph = placeholder(tokens.length);
      text = text.split(frag).join(ph);
      tokens.push(frag);
    }
  }

  return {
    text,
    tokens,
    restore(translated: string): string | null {
      let out = translated;
      for (let i = 0; i < tokens.length; i++) {
        const ph = placeholder(i);
        if (!out.includes(ph)) return null; // 佔位符遺失
        out = out.split(ph).join(tokens[i]!);
      }
      return out;
    },
  };
}

/**
 * 一個翻譯單元裡不該被翻的片段:
 * 行內 code / kbd / samp / var(Phase 1 §3.1 只擋掉獨立的 code / pre 區塊,
 * 段落中的行內 code 還在),加上使用者維護的不翻清單。
 */
export function protectedFragments(el: Element, terms: readonly string[]): string[] {
  const out: string[] = [];
  // translate="no" / .notranslate 是「留在句子裡但不要翻」,
  // 與行內 code 同一類問題,所以走同一條佔位符路徑
  for (const node of el.querySelectorAll(
    'code,kbd,samp,var,tt,abbr[title],[translate="no"],.notranslate',
  )) {
    const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > 0) out.push(t);
  }
  const src = (el.textContent ?? '').replace(/\s+/g, ' ');
  for (const term of terms) {
    if (term.trim().length > 0 && src.includes(term)) out.push(term);
  }
  return out;
}
