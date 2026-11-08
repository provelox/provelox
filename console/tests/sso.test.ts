import { describe, expect, it } from 'vitest';
import { parseList, publicMailDomains, splitWho, ssoId } from '../src/lib/sso';

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

describe('publicMailDomains', () => {
  it('finds the providers anyone can open an account with, ignoring case', () => {
    expect(
      publicMailDomains(['corp.com', 'Gmail.com', 'outlook.com', 'yahoo.com']),
    ).toEqual(['Gmail.com', 'outlook.com', 'yahoo.com']);
  });

  it('leaves company domains alone, and does not match a lookalike', () => {
    expect(publicMailDomains(['gmail.co', 'mygmail.com', 'floms.com'])).toEqual(
      [],
    );
  });
});
