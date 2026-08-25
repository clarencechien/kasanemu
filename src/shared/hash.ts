/** 快取 key (§9)。maxChars 以 16 字為一級分桶,避免每個像素寬度各存一份。 */
export function maxCharsBucket(maxChars: number): number {
  return Math.max(1, Math.floor(maxChars / 16));
}

/**
 * @param glossary 這一筆**實際命中**的詞表指紋(`glossaryFingerprint`)。
 *   空字串 = 沒命中,key 與「沒有詞表功能」時完全相同 ——
 *   既有的快取不會因為多了這個功能就整批作廢。
 *
 *   少了這個參數的話:改完詞表,舊譯文還在快取裡,看起來像「設了沒生效」
 *   (`docs/plan-glossary.md` §6,`docs/lessons.md` §2 那一類沉默的失敗)。
 */
export async function cacheKey(
  src: string,
  targetLang: string,
  modelId: string,
  maxChars: number,
  glossary = '',
): Promise<string> {
  const raw =
    `${src}|${targetLang}|${modelId}|${maxCharsBucket(maxChars)}` +
    (glossary === '' ? '' : `|g:${glossary}`);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
