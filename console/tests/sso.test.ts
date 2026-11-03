import { describe, expect, it } from 'vitest';
import { parseList, splitWho, ssoId } from '../src/lib/sso';

describe('splitWho', () => {
  it('separates email addresses from domains', () => {
    expect(
      splitWho(
        'Ada@Example.com\n@corp.com, other.org # comment\n\nada@example.com',
      ),
    ).toEqual({
      emails: ['ada@example.com'],
      domains: ['corp.com', 'other.org'],
    });
  });
  it('is empty for nothing', () => {
    expect(splitWho('  \n# only a comment')).toEqual({
      emails: [],
      domains: [],
    });
    expect(parseList('')).toEqual([]);
  });
});

describe('ssoId', () => {
  it('makes a short id from a name', () => {
    expect(ssoId('Acme Okta (prod)')).toBe('acme-okta-prod');
    expect(ssoId('!!!')).toBe('');
  });
});
