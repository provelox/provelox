import { describe, expect, it } from 'vitest';
import { agoLabel, fillOf, RANGES, sparkline } from '@/lib/usage';

describe('usage', () => {
  it('says how full a reading is, only when there is a limit', () => {
    expect(fillOf(50, 200)).toBe(0.25);
    expect(fillOf(300, 200)).toBe(1);
    expect(fillOf(10, null)).toBeNull();
    expect(fillOf(10, 0)).toBeNull();
  });

  it('draws a line across the box, and nothing from fewer than two readings', () => {
    expect(sparkline([1], 100, 20)).toBe('');
    const p = sparkline([0, 10], 100, 20);
    expect(p).toBe('0.0,20.0 100.0,0.0');
    // a flat series stays on the floor instead of dividing by nothing
    expect(sparkline([0, 0, 0], 100, 20)).toBe('0.0,20.0 50.0,20.0 100.0,20.0');
  });

  it('names the ranges and says how far back they reach', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['15m', '1h', '6h', '24h']);
    expect(agoLabel(15)).toBe('15m ago');
    expect(agoLabel(60)).toBe('1h ago');
    expect(agoLabel(1440)).toBe('24h ago');
  });
});
