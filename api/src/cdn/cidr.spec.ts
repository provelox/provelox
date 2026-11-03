import { normalizeCidr, parseCidrList } from './cidr';

describe('normalizeCidr', () => {
  it('accepts IPv4 and IPv6 ranges and single addresses', () => {
    expect(normalizeCidr('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normalizeCidr(' 2001:db8::/32 ')).toBe('2001:db8::/32');
    expect(normalizeCidr('203.0.113.7')).toBe('203.0.113.7/32');
    expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });
  it('rejects anything else', () => {
    for (const bad of [
      '',
      'nope',
      '1.2.3.4/33',
      '1.2.3.4/x',
      '::1/129',
      '1.2.3/24',
      '1.2.3.4/8/9',
    ])
      expect(normalizeCidr(bad)).toBeNull();
  });
});

describe('parseCidrList', () => {
  it('reads lines, commas, comments and a JSON array', () => {
    expect(
      parseCidrList('1.1.1.0/24\n# comment\n2.2.2.0/24, 3.3.3.3 # tail\n'),
    ).toEqual(['1.1.1.0/24', '2.2.2.0/24', '3.3.3.3/32']);
    expect(parseCidrList('["1.1.1.0/24","1.1.1.0/24"]')).toEqual([
      '1.1.1.0/24',
    ]);
  });
  it('fails loudly on a line that is not a range', () => {
    expect(() => parseCidrList('1.1.1.0/24\n<html>')).toThrow(
      /not an IP range/,
    );
  });
});
