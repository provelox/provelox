import { canonical, fleetHash } from './fleet-hash';

describe('fleetHash', () => {
  it('does not depend on the order of keys', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonical({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(fleetHash({ '502': 'x', '404': 'y' })).toBe(
      fleetHash({ '404': 'y', '502': 'x' }),
    );
  });
  it('changes with the content and is null for nothing', () => {
    expect(fleetHash({ '502': 'x' })).not.toBe(fleetHash({ '502': 'y' }));
    expect(fleetHash('<p>a</p>')).toMatch(/^[0-9a-f]{16}$/);
    expect(fleetHash({})).toBeNull();
    expect(fleetHash('')).toBeNull();
    expect(fleetHash(null)).toBeNull();
    expect(fleetHash(undefined)).toBeNull();
  });
  it('is a fixed value, so the hub can make the same (keep both in step)', () => {
    // the hub's own test holds the same two values
    expect(fleetHash({ '502': '<p>down</p>' })).toBe('c2b84722ea162dfe');
    expect(fleetHash('<p>page</p>')).toBe('6713a9884a95db6e');
  });
});
