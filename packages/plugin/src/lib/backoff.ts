export function nextDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}
