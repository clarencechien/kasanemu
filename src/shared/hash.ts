/** 快取 key (§9)。maxChars 以 16 字為一級分桶,避免每個像素寬度各存一份。 */
export function maxCharsBucket(maxChars: number): number {
  return Math.max(1, Math.floor(maxChars / 16));
}

export async function cacheKey(
  src: string,
  targetLang: string,
  modelId: string,
  maxChars: number,
): Promise<string> {
  const raw = `${src}|${targetLang}|${modelId}|${maxCharsBucket(maxChars)}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
