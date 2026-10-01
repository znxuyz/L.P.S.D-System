/**
 * 呼吸圖的格位比例。
 *
 * 格位大小 = max(今日佔比, 常態佔比)。回傳實心方塊與虛線框各佔格位面積的比例：
 * - 資金湧入（今日 > 常態）：實心 = 1，虛線框 < 1。
 * - 資金撤出（今日 < 常態）：實心 < 1，虛線框 = 1。
 */
export function breathRatios(share: number, baseShare: number): { slot: number; fill: number; ghost: number } {
  const slot = Math.max(share, baseShare);
  if (slot <= 0) return { slot: 0, fill: 0, ghost: 0 };
  return { slot, fill: share / slot, ghost: baseShare / slot };
}
