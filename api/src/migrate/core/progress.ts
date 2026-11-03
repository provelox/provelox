/** "1m 05s", "12s": how long something has been going, for a line that says it is still at it. */
export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Runs something long and says every so often that it is still going. A copy of a large volume prints nothing for
 * many minutes, which looks like a hang (and an idle connection can be dropped): a line every few seconds shows it is
 * alive, and how long it has been.
 */
export async function withHeartbeat<T>(
  work: Promise<T>,
  say: (line: string) => void,
  label: string,
  { everyMs = 15_000, now = Date.now } = {},
): Promise<T> {
  const started = now();
  const timer = setInterval(
    () => say(`${label} (${elapsed(now() - started)})`),
    everyMs,
  );
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
