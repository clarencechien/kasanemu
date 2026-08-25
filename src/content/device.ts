/**
 * 機器畫像。
 *
 * 使用者的問題:「Chromebook 跟 Win11 都是 Intel 12 代的 U CPU,
 * 為什麼 L0 速度差那麼多?」——「12 代 U」涵蓋 i3-1215U(2P+4E)到
 * i7-1265U(2P+8E),而且同一顆 CPU 在被動散熱的 Chromebook 與有風扇的
 * 筆電上,持續功耗可以差兩倍以上。光看型號回答不了。
 *
 * 所以量。這個檔案沒有執行期相依,好測。
 */

export interface DeviceProfile {
  /** 邏輯執行緒數(P-core + E-core 的總和) */
  threads: number;
  /** 瀏覽器回報的記憶體級距(GB);Chrome 上限是 8,所以 8 代表「8 或更多」 */
  memoryGB: number;
  /** 單執行緒微基準的耗時(ms)—— **越小越快** */
  cpuMs: number;
  platform: string;
}

/**
 * 固定工作量、量時間。
 *
 * 反過來(固定時間、數圈數)會被時脈調節與省電模式騙:
 * 前幾毫秒 CPU 還在低頻,量到的是升頻曲線不是效能。
 * 三百萬次整數乘加在現代 CPU 上大約 5–20ms,短到不影響首屏,
 * 長到蓋得過排程雜訊。
 */
export function cpuBenchmark(iterations = 3_000_000): number {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < iterations; i++) x = (x + Math.imul(i, 2654435761)) >>> 0;
  // 用掉結果,免得被 JIT 當成死碼消掉
  if (x === 42) console.debug('');
  return Math.round(performance.now() - t0);
}

export function deviceProfile(): DeviceProfile {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    threads: nav.hardwareConcurrency || 0,
    memoryGB: nav.deviceMemory ?? 0,
    cpuMs: cpuBenchmark(),
    platform: nav.platform || '',
  };
}
