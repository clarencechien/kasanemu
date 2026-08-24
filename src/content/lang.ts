/**
 * feature.md 實作註記:Translator API 要求明確的 sourceLanguage,
 * 而 Phase 1 §3.2 只判斷「是不是已經是中文」,沒有語言偵測。
 * 這裡是那個缺口的最小補法 —— 沒有執行期依賴,可以單獨測。
 */

const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 只在這麼多字裡取樣就夠判斷字集了 */
const SAMPLE_CHARS = 3000;

/**
 * 用**實際文字的字集**判斷語言,而不是相信 `<html lang>`。
 *
 * `<html lang>` 有兩種常見的壞法:根本沒寫,或是樣板留下來的 `en`。
 * 對 L1 無所謂(那是 LLM,自己看得出來),但對 L0 是致命的 ——
 * Translator API 的 sourceLanguage 是**宣告**不是偵測,
 * 拿 en→zh 的 translator 去翻日文,結果是原樣吐回或亂碼,
 * 而且不會報錯,只會安靜地產出垃圾。
 *
 * 只認得字集分得開的那幾種:假名 → 日文,諺文 → 韓文,漢字 → 中文。
 * 拉丁字母分不出英文 / 法文 / 德文,回 null 表示「沒有證據」。
 */
export function sniffScript(sample: string): 'ja' | 'ko' | 'zh' | null {
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let visible = 0;
  for (const ch of sample) {
    if (/\s/.test(ch)) continue;
    visible++;
    if (KANA.test(ch)) kana++;
    else if (HANGUL.test(ch)) hangul++;
    else if (HAN.test(ch)) han++;
  }
  if (visible < 20) return null;
  if (hangul / visible > 0.1) return 'ko';
  // 日文的漢字比假名多是常態,所以假名門檻要低
  if (kana / visible > 0.05) return 'ja';
  if (han / visible > 0.3) return 'zh';
  return null;
}

/** 字集分得出來的語言。宣告是這幾種之一、但畫面上是拉丁字母時,宣告不可信。 */
const SNIFFABLE = new Set(['ja', 'ko', 'zh']);

/**
 * 決定 L0 的 sourceLanguage。
 *
 * 取樣有證據時**取樣說了算**;沒有證據(整頁拉丁字母)時,
 * 宣告若是 ja / ko / zh 就一併不採信 —— 那多半是樣板或整站語言設定,
 * 不是這一頁的內容。
 */
export function resolveSourceLang(declaredRaw: string, sample: string, fallback: string): string {
  const declared = normalizeSourceLang(declaredRaw, '');
  const sniffed = sniffScript(sample);
  if (sniffed !== null) return sniffed;
  if (declared === '' || SNIFFABLE.has(declared)) return fallback;
  return declared;
}

/** 取 <html lang> 與畫面文字,決定 L0 的來源語言 */
export function pageSourceLang(fallback: string, sample = sampleVisibleText()): string {
  const raw = document.documentElement.getAttribute('lang') ?? '';
  return resolveSourceLang(raw, sample, fallback);
}

/**
 * 取一段畫面上的文字當樣本。
 *
 * 不用 `body.textContent` —— 那會把 `<script>` 裡的 JavaScript 也算進去,
 * 一頁的 inline script 動輒上萬個拉丁字元,足以把日文頁面稀釋成「拉丁」。
 */
export function sampleVisibleText(root: Node = document.body ?? document.documentElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  let len = 0;
  let node = walker.nextNode();
  while (node && len < SAMPLE_CHARS) {
    const t = node.nodeValue ?? '';
    if (t.trim().length > 0) {
      parts.push(t);
      len += t.length;
    }
    node = walker.nextNode();
  }
  return parts.join(' ').slice(0, SAMPLE_CHARS);
}

export function normalizeSourceLang(raw: string, fallback: string): string {
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(base) ? base : fallback;
}

/** targetLang 是 BCP-47 的 zh-TW,Translator API 用的是 script subtag */
export function toTranslatorTarget(targetLang: string): string {
  const t = targetLang.trim().toLowerCase();
  if (t === 'zh-hans' || t === 'zh-cn' || t === 'zh-sg' || t === 'zh') return t === 'zh' ? 'zh-Hant' : 'zh-Hans';
  if (t.startsWith('zh')) return 'zh-Hant';
  return targetLang;
}
