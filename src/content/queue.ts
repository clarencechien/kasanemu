/**
 * 依優先度出隊的併發閘門。抽成獨立檔案是為了可測試 ——
 * 它沒有任何相依,所以測試不必把整個 L0Engine(以及 Translator API)搬進來。
 *
 * 這裡只有一個非顯而易見的設計:**優先度在出隊時才計算**。
 *
 * 舊版是入隊時算好一個數字,再插進排序好的陣列。在慢機器上這是災難性的:
 * ClickHouse 那篇 268 個區塊的長文,一開場佇列就有 179 個在排,
 * 每個呼叫 2.4 秒、併發 2 —— 整條佇列要跑五分鐘。使用者往下捲之後,
 * 他正在看的段落**是在他捲到之前就入隊的**,帶著「離視窗中心很遠」的舊順序,
 * 老老實實排在第 150 位。診斷 log 的 avgWaitMs 65 秒就是這樣來的,
 * 而使用者看到的是「有些翻有些不翻」「連 L0 都不動了」。
 *
 * 存下 thunk、出隊時才問「你現在離視窗多遠」,捲動就會自動重排整條佇列。
 * 每完成一次呼叫做一次 O(n) 掃描(n < 300),相對於 2.4 秒的呼叫是零成本。
 */
export class SlotPool {
  /** 併發上限。L0Engine 會依實測延遲上下調,所以是可寫的 */
  limit: number;

  private inFlight = 0;
  private queue: Array<{ priority: () => number; go: () => void }> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(priority: number | (() => number)): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve();
    }
    const pri = typeof priority === 'function' ? priority : (): number => priority;
    return new Promise<void>((resolve) => {
      this.queue.push({
        priority: pri,
        go: () => {
          this.inFlight++;
          resolve();
        },
      });
    });
  }

  release(): void {
    this.inFlight--;
    // 併發降下來時,多出來的正在跑的請求跑完就好,不再補新的
    if (this.inFlight >= this.limit) return;
    if (this.queue.length === 0) return;
    let at = 0;
    let best = this.queue[0]!.priority();
    for (let i = 1; i < this.queue.length; i++) {
      const p = this.queue[i]!.priority();
      if (p < best) {
        best = p;
        at = i;
      }
    }
    this.queue.splice(at, 1)[0]!.go();
  }

  /** 還沒開跑的數量。intake 用它決定要不要繼續往前預翻 */
  get depth(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.inFlight > 0 || this.queue.length > 0;
  }

  clear(): void {
    this.queue = [];
    this.inFlight = 0;
  }
}
