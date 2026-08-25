import type { Term } from '../shared/glossary';

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
  /** 每個佔位符還原成什麼,依佔位符順序 */
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
 * 全部取代。大小寫不敏感時在小寫化的副本上找位置,但**切原字串** ——
 * 不能拿小寫化的結果當輸出,那會把句子裡其他字的大小寫一起改掉。
 */
function replaceAll(text: string, from: string, to: string, cs: boolean): string {
  if (cs) return text.split(from).join(to);
  const hay = text.toLowerCase();
  const needle = from.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at) + to;
    i = at + from.length;
  }
}

/**
 * 以佔位符保護 / 替換 `protect` 裡的詞。
 *
 * 長的先換,否則短片段會先把長片段切碎(同時保護 "Chrome" 與 "Chrome OS")。
 *
 * **「不翻」與「譯成 B」是同一個機制**,只差 restore 時填什麼:
 * `to` 省略就填回原字串(舊的 noTranslateTerms 行為),
 * 有 `to` 就填目標字串。模型從頭到尾沒看到那個詞,所以這條路
 * 對所有檔位、甚至對沒有 prompt 的 L0 都成立(`plan-glossary.md` §2)。
 */
export function mask(src: string, protect: readonly Term[]): Masked {
  const seen = new Set<string>();
  const wanted: Term[] = [];
  for (const t of protect) {
    const from = t.from.trim();
    if (from.length === 0) continue;
    const key = `${t.cs === true ? 'S' : 'i'} ${from.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ ...t, from });
  }
  wanted.sort((a, b) => b.from.length - a.from.length);

  const tokens: string[] = [];
  let text = src;

  if (!hasPua(src)) {
    for (const t of wanted) {
      if (tokens.length >= PUA_END - PUA_START) break;
      const cs = t.cs === true;
      const hit = cs ? text.includes(t.from) : text.toLowerCase().includes(t.from.toLowerCase());
      if (!hit) continue;
      const ph = placeholder(tokens.length);
      text = replaceAll(text, t.from, ph, cs);
      // 還原成目標字串;沒有 to 就是原字串(= 不翻)
      tokens.push(t.to ?? t.from);
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
export function protectedFragments(el: Element, terms: readonly Term[]): Term[] {
  const out: Term[] = [];
  // translate="no" / .notranslate 是「留在句子裡但不要翻」,
  // 與行內 code 同一類問題,所以走同一條佔位符路徑
  for (const node of el.querySelectorAll(
    'code,kbd,samp,var,tt,abbr[title],[translate="no"],.notranslate',
  )) {
    const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    // 這些是「原樣保留」,永遠大小寫敏感 —— 程式碼片段不能被當成同一個詞
    if (t.length > 0) out.push({ from: t, cs: true });
  }
  return [...out, ...terms];
}
