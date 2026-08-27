/**
 * 視覺請求的**問法** —— prompt 本身,不碰網路。
 *
 * 從 `vision.ts` 拆出來的理由很實際:那個檔案 import 了 gemini/protocol,
 * 整條相依鏈在 `node --experimental-strip-types` 下載不進來,於是
 * **prompt 這件純字串的事沒有任何單元測試**。而 prompt 正是規則住的地方
 * (詞表要壓過規則 2、逾時要改問法),規則沒測試就會漂走。
 */

import type { Term } from '../shared/glossary';

/**
 * 座標**順著模型的訓練慣例要 0–1000**,不要求 0–100。
 *
 * sukemu 要 0–100,lite 檔照樣回 0–1000(`adr/0001` 破法 1)——
 * 與其和訓練慣例對抗再靠防呆救回來,不如一開始就要它習慣的那個。
 * 防呆(`normalizeBoxes`)照樣裝著:順著要也不代表它一定照給。
 */
const VISION_PROMPT = [
  '你是圖片文字翻譯器。找出圖中所有可讀的文字區塊,回傳 JSON 陣列。',
  '每個元素:',
  '  box_2d:[ymin, xmin, ymax, xmax],0–1000 正規化座標',
  '  text:圖上的原文',
  '  zh:譯文',
  '  c:這一塊的定位信心 0–1',
  '  v:直排(由上往下寫)才給 true,否則省略',
  '  kind:等寬字體 / 程式碼片段給 "code",否則省略',
  '規則:',
  '1. 同一行、同一段的字合併成一個區塊;分屬不同版面位置的不要合併。',
  '2. 專有名詞(產品名、公司名、人名)保持原樣不翻。',
  '3. kind 是 "code" 的區塊,zh 直接填原文 —— 程式碼不翻。',
  '4. 看不清楚的區塊照樣回報,把 c 調低,不要略過。',
  '5. 圖上沒有任何文字時回傳空陣列。',
  '只回傳 JSON,不要說明。',
].join('\n');

/**
 * 只問最顯眼的幾塊 —— 逾時的出路(`docs/deviations.md` §DS-2)。
 *
 * 逾時不是隨機的:實測輸出一塊要 ~2.3 秒,100 秒的時限等於 43 塊。
 * 整頁截圖(使用者踩到的那張是 claude.com 的用例牆)輕鬆超過,
 * 所以同一份請求再送一次只會再等 100 秒 —— 使用者已經替我們驗過了,
 * Alt+click 升級之後照樣逾時。
 *
 * 重試因此要**問得比較少**。挑「最大的」而不是「前 N 個」,
 * 因為字級就是版面自己標好的重要性:整頁截圖上真正要讀的是標題和大字,
 * 而使用者自己說過「像這張圖 可能只有標題需要翻」。
 */
export const BRIEF_BLOCKS = 12;

const BRIEF_RULES = [
  `這張圖的字很多,只回傳**最顯眼的 ${BRIEF_BLOCKS} 塊以內**:`,
  '  · 依字級由大到小挑,標題、大標、卡片上的大字優先',
  '  · 正文段落、註腳、圖例、選單、頁尾一律略過',
  '  · 挑不到那麼多就回傳實際有的,不要湊數',
].join('\n');

export function visionPrompt(
  targetLang: string,
  glossary: readonly Term[] = [],
  brief = false,
): string {
  const langName = targetLang === 'zh-TW' ? '繁體中文(台灣用語)' : targetLang;
  const base =
    `${VISION_PROMPT}\n目標語言:${langName}。` + (brief ? `\n${BRIEF_RULES}` : '');
  if (glossary.length === 0) return base;
  /*
   * 圖片上**只有路徑 B**(`docs/plan-images.md` §8)。
   *
   * 文字管線的佔位符前提是「我們能在送出前改寫來源」—— 圖片做不到,
   * 模型看到的是像素。所以詞表在這裡是請求,不是保證,手冊寫明了這件事。
   */
  const lines = glossary.map((t) => `  ${t.from} → ${t.to ?? t.from}`).join('\n');
  /*
   * **詞表要明講它蓋過規則 2。**
   *
   * 量測(§13-5)顯示:加了詞表之後 `Storage size → 儲存容量` 與
   * `smaller → 更精簡` 兩檔都照做,但 `Elasticsearch → 彈性搜尋`
   * 兩檔都不照 —— 因為規則 2 寫著「專有名詞保持原樣不翻」,
   * 而模型認為那條比詞表大。
   *
   * 它沒有做錯,是**我們的 prompt 自相矛盾**。使用者把產品名寫進詞表
   * 並給了譯法,那就是明確的「我要翻它」;規則 2 是預設值,不是禁令。
   */
  return (
    `${base}\n詞表(圖上遇到左邊的詞,譯文一律採用右邊的說法。` +
    `**這條優先於上面的規則 2** —— 詞表裡的專有名詞要照詞表翻):\n${lines}`
  );
}
