import { describe, expect, it } from 'vitest';
import { cdnId, parseRanges, rangesSummary, type CdnProvider } from '@/lib/cdn';

describe('parseRanges', () => {
  it('reads lines, commas and comments, without repeats', () => {
    expect(
      parseRanges(
        '1.1.1.0/24\n# a comment\n2001:db8::/32, 1.1.1.0/24  3.3.3.3',
      ),
    ).toEqual({
      ok: true,
      ranges: ['1.1.1.0/24', '2001:db8::/32', '3.3.3.3'],
    });
  });
  it('says what is wrong', () => {
    expect(parseRanges('  \n# nothing')).toMatchObject({ ok: false });
    expect(parseRanges('1.1.1.0/24\nhello')).toEqual({
      ok: false,
      error: '"hello" is not an address range, like 203.0.113.0/24.',
    });
  });
});

describe('cdnId', () => {
  it('makes an id out of a name', () => {
    expect(cdnId('Acme CDN (EU)')).toBe('acme-cdn-eu');
    expect(cdnId('  --Bunny.net-- ')).toBe('bunny-net');
    expect(cdnId('!!!')).toBe('');
    expect(cdnId('x'.repeat(40)).length).toBe(32);
  });
});

describe('rangesSummary', () => {
  const p = (o: Partial<CdnProvider>): CdnProvider => ({
    id: 'x',
    label: 'X',
    builtin: true,
    clientIpHeader: null,
    source: 'https://x',
    ranges: 49,
    fetchedAt: null,
    error: null,
    apps: [],
    ...o,
  });
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('uses the singular for one range', () => {
    expect(rangesSummary(p({ ranges: 1, source: null }), now)).toBe(
      '1 address range, listed by hand',
    );
  });
  it('says how fresh the ranges are', () => {
    expect(rangesSummary(p({ ranges: 0 }), now)).toBe(
      'The address ranges are fetched when you save',
    );
    expect(rangesSummary(p({ ranges: 0, source: null }), now)).toBe(
      'No address ranges',
    );
    expect(rangesSummary(p({ source: null }), now)).toBe(
      '49 address ranges, listed by hand',
    );
    expect(rangesSummary(p({ fetchedAt: '2026-01-01T09:00:00Z' }), now)).toBe(
      '49 address ranges, refreshed 3 h ago',
    );
    expect(rangesSummary(p({ fetchedAt: '2026-01-01T11:59:40Z' }), now)).toBe(
      '49 address ranges, refreshed just now',
    );
  });
});
