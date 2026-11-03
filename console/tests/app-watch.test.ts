import { describe, expect, it } from 'vitest';
import { isTransitional, watchDelayMs } from '../src/lib/app-watch';

describe('isTransitional', () => {
  it('is true while an app is deploying or starting, and false once it has settled', () => {
    expect(isTransitional('building')).toBe(true);
    expect(isTransitional('starting')).toBe(true);
    for (const s of ['running', 'stopped', 'failed', 'unhealthy'] as const)
      expect(isTransitional(s)).toBe(false);
  });
});

describe('watchDelayMs', () => {
  it('looks often at first, then calmly', () => {
    expect(watchDelayMs(0)).toBe(2_500);
    expect(watchDelayMs(59_000)).toBe(2_500);
    expect(watchDelayMs(61_000)).toBe(6_000);
    expect(watchDelayMs(10 * 60_000)).toBe(15_000);
  });
});
