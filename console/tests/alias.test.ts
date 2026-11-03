import { describe, expect, it } from 'vitest';
import { aliasProblem } from '@/lib/alias';

describe('aliasProblem', () => {
  it('accepts a CapRover-style name', () => {
    expect(
      aliasProblem('srv-captain--shop-admin', [], 'shop-admin'),
    ).toBeNull();
  });
  it('refuses what the API would', () => {
    expect(aliasProblem('', [], 'a')).toMatch(/Type a name/);
    expect(aliasProblem('Bad Name', [], 'a')).toMatch(/lowercase/);
    expect(aliasProblem('-x', [], 'a')).toMatch(/lowercase/);
    expect(aliasProblem('a', [], 'a')).toMatch(/own name/);
    expect(aliasProblem('x', ['x'], 'a')).toMatch(/already there/);
    expect(
      aliasProblem(
        'y',
        Array.from({ length: 10 }, (_, i) => `n${i}`),
        'a',
      ),
    ).toMatch(/At most 10/);
  });
});
