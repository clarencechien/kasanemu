import type { Tier } from '../shared/models';
// 時限彼此有順序,所以住在同一個檔案裡(`shared/imagetiming.ts` 的開頭有那張圖)
import { IMAGE_WATCHDOG_MS, ORPHAN_MS, SLOW_IMAGE_MS } from '../shared/imagetiming.ts';
export { ORPHAN_MS };

/**
 * 圖片請求的排隊 —— 純判斷,不碰 IO。
 *
 * 為什麼**不併進文字佇列**(`docs/plan-images.md` §5):token 量級差兩個
 * 數量級。一張截圖 1200 個輸入 token、輸出 2600 個;一批文字是幾百個。
 * 混在一起排,圖片會把整頁的文字餓死,而且退避的節奏也不一樣。
 *
 * 兩條併發道:
 * - `l0` —— hover 自動觸發,免費檔,**併發 1**。gemma 實測 9–68 秒,
 *   而且和文字 free 檔共用 15 RPM / 12k TPM 的配額;滑鼠掃過十張圖
 *   不能變成十個併發請求。
 * - `l1` —— 使用者 Alt+click 明確點名,併發 2。人親手點的動作要優先,
 *   不能排在自動來的那堆後面(`docs/lessons.md` §7)。
 */

export interface ImageJob {
  /** 圖片 URL,同時是同一張圖的去重鍵 */
  url: string;
  pageKey: string;
  tabId: number;
  lane: 'l0' | 'l1';
  /** 這個網域選的檔位。和文字一樣由 content 帶進來,worker 不另外查一次 */
  tier: Tier;
  at: number;
  attempts: number;
  /**
   * 這筆工作**已經被派出去跑過**的時間點。
   *
   * 有這個欄位才分得出兩種「久」:
   *
   * - 沒有 `startedAt` 而且很舊 = **使用者早就捲過去了**,收掉(省配額)。
   * - 有 `startedAt` 但不在 in-flight 裡 = **worker 在半路被回收了**,
   *   這是孤兒 —— 使用者還在等,要**重新派工**,不是收掉。
   *
   * 使用者回報「滑開再回來重試 都沒有成功過」就是這裡分不出來:
   * log 上兩次都是 `ageMs: 61000`,那是 alarm(被 Chrome 夾到 60 秒)
   * 醒來時看到一筆跑了一分鐘的 gemma 工作,套上「掃過就走」那條 10 秒的
   * 規則把它殺了(`docs/deviations.md` §DJ)。
   */
  startedAt?: number;
  /**
   * 只問最顯眼的幾塊(`docs/deviations.md` §DS-2)。
   *
   * 使用者點了逾時的重試才會是 true。它**進 jobKey 之外的欄位**——
   * 同一張圖的完整版與大字版是同一筆工作的兩種問法,不是兩筆工作。
   */
  brief?: boolean;
}

export const LANE_CONCURRENCY: Record<'l0' | 'l1', number> = { l0: 1, l1: 2 };

/** 每張圖最多重試兩次(`docs/plan-images.md` §3.1) */
export const IMAGE_MAX_ATTEMPTS = 2;

/**
 * **還沒開始跑的 l0 最多排幾張**。
 *
 * 這是「滑鼠掃過長文的二十張圖不要排出二十分鐘的隊」那條規則的新形式。
 *
 * 舊的形式是一條碼錶:排隊超過 10 秒就丟。它**結構上不可能成立**——
 * l0 併發是 1,而 gemma 一張要 12–40 秒,所以佇列裡第二張**必定**
 * 在輪到自己之前就滿 10 秒。使用者一次滑過幾張圖,除了第一張以外
 * 全部被丟掉,而他看到的是「等太久已取消」,只好一直點重試
 * (原話:「一次太多張會一直過時 平均試了三次才成功」,§DU)。
 *
 * 病根是**碼錶量錯了東西**:排隊時間量的是「前面還有幾張」,
 * 而規則想問的是「使用者還想不想看」。那兩件事在併發 1 的佇列裡沒有關係。
 *
 * 用張數就沒有這個問題:排幾張是使用者自己決定的(他滑過幾張圖),
 * 而排多久是我們決定的。超過上限時**丟最舊的** —— 掃過去的時候,
 * 最後停下來的那幾張才是他在看的。
 *
 * 上限**推出來而不是拍出來**:排到最後一張還沒輪到、content 的看門狗
 * 就已經先說「沒有回應」的話,那個名額本來就是空的。
 * 所以上限 = 看門狗 ÷ 一張慢的大概要多久(180 ÷ 45 = 4)。
 */
export const PENDING_L0_MAX = Math.floor(IMAGE_WATCHDOG_MS / SLOW_IMAGE_MS);


export function jobKey(j: Pick<ImageJob, 'url' | 'lane'>): string {
  return `${j.lane}:${j.url}`;
}

/**
 * 加入新工作。同一張圖已經在排了就不重複加 ——
 * 但 **l1 可以蓋過同一張圖的 l0**:使用者點了升級,那張圖的免費請求
 * 就沒有意義了,留著只是浪費配額。
 */
export function addJob(queue: readonly ImageJob[], job: ImageJob): ImageJob[] {
  const dupe = queue.some((j) => j.url === job.url && j.lane === job.lane);
  if (dupe) return [...queue];
  if (job.lane === 'l1') {
    // 同一張圖待處理的 l0 直接丟掉(已經送出去的攔不住,那是另一回事)
    return [...queue.filter((j) => !(j.url === job.url && j.lane === 'l0')), job];
  }
  /*
   * l0 的待處理有上限,超過就**擠掉最舊的那一張**(§DU)。
   *
   * 擠掉最舊而不是拒絕最新:掃過一長串圖的時候,最後停下來的那幾張
   * 才是使用者在看的。`startedAt` 有值的不算「待處理」——
   * 它跑過了,是孤兒,那條路歸 nextJobs 管。
   */
  const next = [...queue, job];
  const pending = next.filter((j) => j.lane === 'l0' && j.startedAt === undefined);
  if (pending.length <= PENDING_L0_MAX) return next;
  const evict = new Set(
    [...pending].sort((a, b) => a.at - b.at).slice(0, pending.length - PENDING_L0_MAX).map(jobKey),
  );
  return next.filter((j) => !evict.has(jobKey(j)));
}

/**
 * 下一批要跑的工作。
 *
 * `inFlight` 是**正在跑的工作的 key**,不是計數。
 *
 * 用 key 而不是計數是修出來的:工作只有**完成才會從佇列移除**,所以
 * 執行中的工作一直在佇列裡。上一版只比對數量,於是
 * `now - j.at > 10 秒` 這條把**正在跑的工作當成過期丟掉** ——
 * 而 gemma 實測要 17–70 秒,等於每一張免費檔的圖跑到一半都會被自己殺掉,
 * 然後 log 上留下一句騙人的 `image-stale`。
 *
 * 有了 key 就同時解決兩件事:執行中的不會被重複派工,也不會被判過期。
 */
export function nextJobs(
  queue: readonly ImageJob[],
  inFlight: ReadonlySet<string>,
  now: number,
): { run: ImageJob[]; drop: ImageJob[] } {
  const idle = queue.filter((j) => !inFlight.has(jobKey(j)));
  /*
   * **只有沒在跑的**才可能被收掉,而「沒在跑」有兩種:
   *
   * - 從來沒派出去過 → 「掃過就走」那條線(l0 十秒)管它。
   * - 派出去過但不在 in-flight → worker 被回收留下的**孤兒**。
   *   使用者還在等,所以**重派**,不收 —— 除非重派太多次或實在太舊。
   */
  const orphan = idle.filter(
    (j) => j.startedAt !== undefined && j.attempts < IMAGE_MAX_ATTEMPTS && now - j.at <= ORPHAN_MS,
  );
  const orphanKeys = new Set(orphan.map(jobKey));
  /*
   * **沒派出去過的不看年齡**(§DU)。
   *
   * 它等多久取決於前面還有幾張,和使用者想不想看沒有關係 ——
   * 併發 1 加上一張 12–40 秒,任何一條碼錶都會把第二張以後全部誤殺。
   * 「不要排出二十分鐘的隊」那條改由 `addJob` 的張數上限管。
   *
   * 年齡只用來收**派出去過但回不來的**:孤兒重派兩次還是沒消息,
   * 或者已經舊到那個分頁多半早就關了。
   */
  const drop = idle.filter((j) => {
    if (orphanKeys.has(jobKey(j))) return false;
    if (j.startedAt !== undefined) {
      // 派出去過:重派上限用完,或舊到那個分頁多半早就關了
      return now - j.at > ORPHAN_MS || j.attempts >= IMAGE_MAX_ATTEMPTS;
    }
    /*
     * 從沒派出去過:**只有一條線,而且是看門狗**。
     *
     * 活過看門狗代表 content 早就跟使用者說「沒有回應」了 —— 沒有人在等它。
     * 而且不收的話還會反咬一口:使用者點「重試」會被 addJob 當成重複請求
     * 擋掉,於是那張圖再也翻不出來(§DU)。
     */
    return now - j.at > IMAGE_WATCHDOG_MS;
  });
  const dropped = new Set(drop.map(jobKey));
  const alive = idle.filter((j) => !dropped.has(jobKey(j)));

  const running: Record<'l0' | 'l1', number> = { l0: 0, l1: 0 };
  for (const j of queue) if (inFlight.has(jobKey(j))) running[j.lane]++;

  const run: ImageJob[] = [];
  for (const lane of ['l1', 'l0'] as const) {
    const slots = LANE_CONCURRENCY[lane] - running[lane];
    if (slots <= 0) continue;
    // 孤兒排在前面:使用者已經等過一輪了,不該再排到新來的後面
    const mine = alive.filter((j) => j.lane === lane);
    mine.sort((a, b) => Number(b.startedAt !== undefined) - Number(a.startedAt !== undefined));
    run.push(...mine.slice(0, slots));
  }
  return { run, drop };
}

export function removeJobs(queue: readonly ImageJob[], done: readonly ImageJob[]): ImageJob[] {
  const gone = new Set(done.map(jobKey));
  return queue.filter((j) => !gone.has(jobKey(j)));
}

export function dropPageJobs(queue: readonly ImageJob[], tabId: number, pageKey: string): ImageJob[] {
  return queue.filter((j) => !(j.tabId === tabId && j.pageKey === pageKey));
}
