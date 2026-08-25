/**
 * 圖片加註的區塊邏輯 —— 純函式,content 與 worker 共用同一份判斷。
 *
 * 和 `glossary.ts` 同一個理由:兩邊各寫一份就會分岔(`docs/lessons.md` §1)。
 * 這裡不碰 DOM、不碰 chrome API,所以 node:test 驗得動。
 *
 * 規格:`docs/plan-images.md` §4。
 */

/** 模型回傳的一塊文字。座標是 [ymin, xmin, ymax, xmax],0–1000 正規化 */
export interface ImageBlock {
  box: [number, number, number, number];
  /** 原文 */
  text: string;
  /** 譯文 */
  zh: string;
  /** 版面信心 0–1,低於 LOW_CONFIDENCE 標「待複核」 */
  c: number;
  /** 直排文字,前端以 writing-mode: vertical-rl 呈現 */
  v?: boolean;
  /** 等寬 / 程式碼樣式的字:不加註,原樣留著 */
  kind?: 'text' | 'code';
}

/** 版面信心門檻(沿用 sukemu 的值與語彙) */
export const LOW_CONFIDENCE = 0.9;

/** 座標空間的上界。prompt 要 0–1000,是 Gemini 空間標註的訓練慣例 */
export const BOX_SCALE = 1000;

/**
 * 中文在幾 px 以下就讀不動了。
 *
 * 這不是猜的:驗證台把三個模型的真實輸出畫成加註,兩張圖各拉一次
 * (`docs/plan-images.md` §7)。11px 是「還讀得出來」與「一團墨」的分界,
 * 低於它的區塊改走編號錨點(§2.3)—— 硬塞進去只是把噪音畫在圖上。
 */
export const MIN_PATCH_FONT_PX = 11;

/** 加註字級的上限:再大就比原圖的字還醒目,喧賓奪主 */
export const MAX_PATCH_FONT_PX = 40;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * 模型回的座標**不一定照規格**。
 *
 * sukemu 在照片上實測過:prompt 要 0–100,lite 檔回 0–1000(訓練慣例),
 * 也見過像素與 0–1 小數(`sukemu/docs/adr/0001` 破法 1)。我們順著慣例
 * 要 0–1000,但「模型會照規格」這件事**不能當前提** —— 直接把超界的值
 * 夾住會把框撐成滿版,整張圖蓋上一片橘。
 *
 * 從數值範圍推回原始規格再換算。`nw`/`nh` 是送出去那張點陣圖的尺寸,
 * 只有像素模式用得到。
 *
 * 回傳的 `spec` 不是 null 就代表模型沒照規格 —— 呼叫端記一筆 diag,
 * 換模型時那行 log 就是證據。
 */
export function normalizeBoxes<T extends { box: [number, number, number, number] }>(
  raw: readonly T[],
  nw?: number,
  nh?: number,
): { blocks: T[]; spec: string | null } {
  let extent = 0;
  for (const b of raw) {
    const [y0, x0, y1, x1] = b.box ?? [0, 0, 0, 0];
    extent = Math.max(extent, num(y0), num(x0), num(y1), num(x1));
  }

  let scaleX = 1;
  let scaleY = 1;
  let spec: string | null = null;
  /*
   * 像素模式**只在超過 0–1000 上界時認得出來**。
   *
   * 一張 1580×530 的圖,y 的像素值最大就是 530 —— 和合規的 0–1000 座標
   * 長得一模一樣,無從分辨。這是規格本身的死角,不是判斷寫得不好:
   * 選 0–1000 當契約(順著模型的訓練慣例)就要接受它和小圖的像素重疊。
   * 實務上會出事的是大圖,而大圖的像素值一定超過 1000。
   */
  if (extent > BOX_SCALE * 1.05) {
    if (nw && nh) {
      // 兩軸的比例不同,所以要分開算 —— 用同一個比例會把框壓扁
      scaleX = BOX_SCALE / nw;
      scaleY = BOX_SCALE / nh;
      spec = 'px';
    }
  } else if (extent > 0 && extent <= 1.2) {
    scaleX = BOX_SCALE;
    scaleY = BOX_SCALE;
    spec = '0-1';
  } else if (extent > 1.2 && extent <= 120) {
    // 0–100 百分比(sukemu 的規格;有些模型會沿用)
    scaleX = 10;
    scaleY = 10;
    spec = '0-100';
  }

  const blocks = raw.map((b) => {
    const [y0, x0, y1, x1] = b.box ?? [0, 0, 0, 0];
    const top = clamp(num(y0) * scaleY, 0, BOX_SCALE);
    const left = clamp(num(x0) * scaleX, 0, BOX_SCALE);
    const bottom = clamp(num(y1) * scaleY, 0, BOX_SCALE);
    const right = clamp(num(x1) * scaleX, 0, BOX_SCALE);
    // 模型偶爾會把兩角寫反,排序比丟掉好
    return {
      ...b,
      box: [
        Math.min(top, bottom),
        Math.min(left, right),
        Math.max(top, bottom),
        Math.max(left, right),
      ] as [number, number, number, number],
    };
  });
  return { blocks, spec };
}

/**
 * 加註的字級。
 *
 * **不能只看框高。** mockup 第一版就是這樣寫的,結果 gemma 把整張小卡
 * 合併成一個高瘦的框(82×70 正規化、30 多個字),字級直接爆成一根巨柱
 * 壓在圖上。
 *
 * 面積項 `√(框面積 / 字數)` 是「這些字要塞進這個框,一個字能分到多大」——
 * 多行合併的框自動縮回去,單行短句不受影響(那時框高才是限制)。
 * 於是**兩個檔位輸出粒度的差異被同一條公式吸收**:gemma 的粗框縮完
 * 過不了門檻就落到錨點,lite 的細框照樣疊字,不必分模型寫規則。
 *
 * 1.35 是中文方塊字加行距的經驗係數,mockup 上調出來的。
 */
export function fontSizeFor(
  boxW: number,
  boxH: number,
  chars: number,
  vertical = false,
): number {
  const n = Math.max(1, chars);
  // 直排:限制字級的是框**寬**,不是框高
  const lineCap = (vertical ? boxW : boxH) * 0.8;
  const areaCap = Math.sqrt((boxW * boxH) / (n * 1.35));
  return Math.min(lineCap, areaCap, MAX_PATCH_FONT_PX);
}

/**
 * 這一塊要疊字,還是落到編號錨點?
 *
 * 唯一的量尺是**這個字在螢幕上有幾個像素高**(`docs/plan-images.md` §2.3)——
 * 所以同一份快取資料在行內縮圖走錨點、在放大檢視走疊字,不必重問模型。
 */
export function patchable(fontPx: number): boolean {
  return fontPx >= MIN_PATCH_FONT_PX;
}

/**
 * 多語並排時,模型會把好幾行的譯文串進同一塊。
 *
 * sukemu 在韓/英/日/中四行並排的菜單上實測到:lite 把四行全串成
 * 「雪濃湯 牛骨湯 雪濃湯 雪濃湯 9,000 韓元」(`adr/0001` 破法 3)。
 * 工程層兜不住這種,但**可以標記出來** —— 譯文長度遠超原文就是訊號,
 * 標成低信心讓使用者知道這一塊要自己看原圖。
 *
 * 倍率不能鬆:**英譯中本來就會縮短**(`Storage size` 12 字 → 「儲存空間大小」
 * 6 字),所以「譯文比原文長」本身已經是訊號。1.6 倍留給縮寫展開
 * (`NDA Review Standards Guide` → 「NDA 審查標準指南」)的空間。
 *
 * 但短原文要放過:`HR` → 「人力資源」是 2 字變 4 字,比例上爆表卻完全正確。
 * 縮寫展開在短標籤上是常態,所以 8 字以下不套這條規則。
 */
export const CONCAT_MIN_CHARS = 8;
export const CONCAT_RATIO = 1.6;

export function looksConcatenated(text: string, zh: string): boolean {
  const src = [...text].length;
  if (src < CONCAT_MIN_CHARS) return false;
  return [...zh].length > src * CONCAT_RATIO;
}

/**
 * 模型輸出 → 可用的區塊。座標防呆 + 串接偵測 + 欄位補齊一次做完。
 *
 * 這是視覺回應唯一的入口:worker 拿到什麼都先過這裡,
 * content 那邊就可以假設欄位齊全、座標在 0–1000 之內。
 */
export function sanitizeBlocks(
  raw: readonly Partial<ImageBlock>[],
  nw?: number,
  nh?: number,
): { blocks: ImageBlock[]; spec: string | null } {
  const shaped = raw
    .filter((b) => Array.isArray(b.box) && b.box.length === 4)
    .map((b) => ({
      box: b.box as [number, number, number, number],
      text: String(b.text ?? ''),
      zh: String(b.zh ?? ''),
      c: clamp(num(b.c ?? 1), 0, 1),
      ...(b.v === true ? { v: true } : {}),
      ...(b.kind === 'code' ? { kind: 'code' as const } : {}),
    }));
  const { blocks, spec } = normalizeBoxes(shaped, nw, nh);
  return {
    blocks: blocks
      .filter((b) => b.box[2] > b.box[0] && b.box[3] > b.box[1])
      .filter((b) => b.zh.length > 0 || b.text.length > 0)
      .map((b) => (looksConcatenated(b.text, b.zh) ? { ...b, c: Math.min(b.c, 0.5) } : b)),
    spec,
  };
}
