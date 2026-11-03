import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDate,
  formatMachineRam,
  timeAgo,
} from '@/lib/format';

describe('formatBytes', () => {
  it.each([
    [undefined, '—'],
    [null, '—'],
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [10 * 1024 * 1024, '10 MB'],
    [3.5 * 1024 ** 3, '3.5 GB'],
    [5 * 1024 ** 4, '5.0 TB'],
    [5000 * 1024 ** 4, '5000 TB'],
  ])('%s -> %s', (n, out) =>
    expect(formatBytes(n as number | undefined)).toBe(out),
  );
});

describe('formatDate', () => {
  it('shows nothing for missing or invalid values instead of "Invalid Date"', () => {
    for (const v of [undefined, '', 0, 'not a date'])
      expect(formatDate(v as string)).toBe('');
  });
  it('accepts ISO strings and epoch seconds', () => {
    expect(formatDate('2026-10-14T04:25:00Z')).toMatch(/2026|26/);
    expect(formatDate(1_791_000_000)).toBeTruthy();
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('uses coarse relative units', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('3 h ago');
    expect(timeAgo(ago(2 * 86_400_000), now)).toBe('2 d ago');
  });
  it('is empty for missing or invalid input', () => {
    expect(timeAgo(undefined, now)).toBe('');
    expect(timeAgo('nope', now)).toBe('');
  });
});

describe('formatMachineRam', () => {
  const GB = 1024 ** 3;
  it('shows what was bought, not what the kernel leaves', () => {
    expect(formatMachineRam(47.04 * GB)).toBe('48 GB');
    expect(formatMachineRam(15.6 * GB)).toBe('16 GB');
    expect(formatMachineRam(7.7 * GB)).toBe('8 GB');
  });
  it('keeps a size that is not close to a usual one', () => {
    expect(formatMachineRam(20 * GB)).toBe('20 GB');
  });
});
