import { describe, expect, it } from 'vitest';
import {
  describeDns,
  dnsRecordsFor,
  isRootDomain,
  recordName,
  zoneOf,
} from '@/lib/dns-records';

describe('zoneOf, isRootDomain and recordName', () => {
  it.each([
    ['loxti.com', 'loxti.com', '@', true],
    ['api.loxti.com', 'loxti.com', 'api', false],
    ['admin.eu.fleetstry.com', 'fleetstry.com', 'admin.eu', false],
    ['acme.co.uk', 'acme.co.uk', '@', true],
    ['shop.acme.co.uk', 'acme.co.uk', 'shop', false],
    ['API.Loxti.COM', 'loxti.com', 'api', false],
  ])('%s', (host, zone, name, root) => {
    expect(zoneOf(host)).toBe(zone);
    expect(recordName(host)).toBe(name);
    expect(isRootDomain(host)).toBe(root);
  });
});

describe('dnsRecordsFor', () => {
  const target = 'storefront.apps.example.com';

  it('gives a subdomain a CNAME to the default address, and address records as the alternative', () => {
    const { primary, alternative } = dnsRecordsFor({
      host: 'api.loxti.com',
      target,
      addresses: ['2001:db8::1', '203.0.113.7'],
    });
    expect(primary).toEqual([
      expect.objectContaining({
        type: 'CNAME',
        name: 'api',
        host: 'api.loxti.com',
        value: target,
      }),
    ]);
    // IPv4 first, then IPv6
    expect(alternative.map((r) => [r.type, r.value])).toEqual([
      ['A', '203.0.113.7'],
      ['AAAA', '2001:db8::1'],
    ]);
  });

  it('gives a root domain address records, since a CNAME cannot sit there', () => {
    const { primary, alternative } = dnsRecordsFor({
      host: 'loxti.com',
      target,
      addresses: ['203.0.113.7'],
    });
    expect(primary.map((r) => [r.type, r.name, r.value])).toEqual([
      ['A', '@', '203.0.113.7'],
    ]);
    expect(alternative).toEqual([]);
  });

  it('still says what to create for a root domain before the server address is known', () => {
    const { primary } = dnsRecordsFor({
      host: 'loxti.com',
      target,
      addresses: [],
    });
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatchObject({ type: 'A', name: '@' });
  });

  it('treats a two-part ending as a root domain', () => {
    expect(
      dnsRecordsFor({ host: 'acme.co.uk', target, addresses: ['203.0.113.7'] })
        .primary[0].type,
    ).toBe('A');
    expect(
      dnsRecordsFor({ host: 'shop.acme.co.uk', target, addresses: [] })
        .primary[0],
    ).toMatchObject({ type: 'CNAME', name: 'shop' });
  });
});

describe('describeDns', () => {
  const s = (
    state: 'match' | 'elsewhere' | 'none' | 'unknown',
    addresses: string[] = [],
  ) => ({
    state,
    addresses,
    expected: ['203.0.113.7'],
  });
  it('says each state in words, with how worried to be', () => {
    expect(describeDns('a.test', s('match'))).toMatchObject({ tone: 'ok' });
    expect(describeDns('a.test', s('none'))).toMatchObject({ tone: 'warn' });
    const elsewhere = describeDns('a.test', s('elsewhere', ['9.9.9.9']));
    expect(elsewhere.tone).toBe('warn');
    expect(elsewhere.text).toContain('9.9.9.9');
    expect(describeDns('a.test', s('unknown'))).toMatchObject({
      tone: 'muted',
    });
  });
});
