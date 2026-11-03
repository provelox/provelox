/** How long to wait before asking again: quick at first, since most restarts take seconds, then easing off. */
export function nextDelayMs(attempt: number): number {
  return Math.min(8000, 1500 + attempt * 500);
}

/** After this long without an answer the screen says it is taking longer than usual and offers what to look at. */
export const SLOW_AFTER_SECONDS = 60;

/** "0:07", "1:05", "12:30": how long the console has been waiting. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
