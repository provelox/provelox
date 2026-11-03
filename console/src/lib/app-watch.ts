import type { AppStatus } from '@/app/(dashboard)/apps/app-row';

/** A status that is on its way somewhere: the page should keep looking until it settles. */
export const isTransitional = (s: AppStatus) =>
  s === 'building' || s === 'starting';

/**
 * How long to wait before looking again: quickly while a deploy is fresh, then calmly for an app that is slow to
 * start, so a tab left open on one that never does is not asking every few seconds.
 */
export function watchDelayMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 2_500;
  if (elapsedMs < 5 * 60_000) return 6_000;
  return 15_000;
}
