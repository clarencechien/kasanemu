/**
 * feature.md 實作註記:Translator API 要求明確的 sourceLanguage,
 * 而 Phase 1 §3.2 只判斷「是不是已經是中文」,沒有語言偵測。
 * 這裡是那個缺口的最小補法 —— 沒有執行期依賴,可以單獨測。
 */

/** 取 <html lang> 的主語言碼;拿不到就用設定的預設值 */
export function pageSourceLang(fallback: string): string {
  const raw = document.documentElement.getAttribute('lang') ?? '';
  return normalizeSourceLang(raw, fallback);
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
