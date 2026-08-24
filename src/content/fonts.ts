/**
 * §4.2 字型。必須打包進擴充,不得外連 Google Fonts
 * (洩漏瀏覽紀錄 + 網站 CSP 會擋外部字型)。
 * 字族名稱加專案前綴,避免與頁面自身的 @font-face 衝突。
 */
export const SERIF_FAMILY = 'KsnmSerifTC';
export const SANS_FAMILY = 'KsnmSansTC';

const FILES: Record<string, string> = {
  [SANS_FAMILY]: 'fonts/KsnmSansTC.woff2',
  [SERIF_FAMILY]: 'fonts/KsnmSerifTC.woff2',
};

const packaged: Record<string, boolean> = { [SANS_FAMILY]: false, [SERIF_FAMILY]: false };

/** subset 漏字會顯示豆腐塊,所以 stack 尾端一定要留系統中文字型 (開放問題 2) */
const SYSTEM_SANS = '"PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif';
const SYSTEM_SERIF = '"Songti TC", "Noto Serif CJK TC", "PMingLiU", serif';

export function fontFaceCss(): string {
  const url = (p: string) => chrome.runtime.getURL(p);
  return [
    "@font-face {",
    `  font-family: '${SANS_FAMILY}';`,
    `  src: url('${url(FILES[SANS_FAMILY]!)}') format('woff2-variations');`,
    "  font-weight: 300 700;",
    "  font-display: swap;",
    "}",
    "@font-face {",
    `  font-family: '${SERIF_FAMILY}';`,
    `  src: url('${url(FILES[SERIF_FAMILY]!)}') format('woff2-variations');`,
    "  font-weight: 300 700;",
    "  font-display: swap;",
    "}",
  ].join('\n');
}

/**
 * 字型檔可能還沒 build (scripts/fetch-fonts.mjs 未跑過),
 * 也可能只打包了 sans —— serif 的 subset 體積是 sans 的 1.3 倍,
 * 而 §4.2 的襯線判定只在少數站台命中。
 * 沒打包成功就退回系統字型,不要留一頁豆腐塊。
 */
export async function probePackagedFonts(): Promise<Record<string, boolean>> {
  await Promise.all(
    Object.entries(FILES).map(async ([family, file]) => {
      try {
        const res = await fetch(chrome.runtime.getURL(file));
        packaged[family] = res.ok && (res.headers.get('content-length') ?? '1') !== '0';
      } catch {
        packaged[family] = false;
      }
    }),
  );
  return { ...packaged };
}

export function hasPackagedFont(family: string): boolean {
  return packaged[family] === true;
}

/** §4.2 指定 Noto 讓譯文的中文外觀跨站一致 —— 刻意的「不完全融入」 (D06) */
export function fontStack(isSerif: boolean, sourceStack: string): string {
  const family = isSerif ? SERIF_FAMILY : SANS_FAMILY;
  const head = packaged[family] ? `'${family}', ` : '';
  const tail = isSerif ? SYSTEM_SERIF : SYSTEM_SANS;
  return `${head}${sourceStack}, ${tail}`;
}
