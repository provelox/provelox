import { describe, expect, it } from 'vitest';
import {
  APP_NAME_RE,
  explainAppName,
  isNewAppNameAllowed,
  suggestAppName,
  collectionForProduct,
  parseHost,
  suggestFromDomain,
} from '@/lib/app-name';

describe('isNewAppNameAllowed (CapRover rule for new apps)', () => {
  it.each(['my-app', 'a', 'app2', 'a-b-c', 'x'.repeat(49)])('accepts %j', (n) =>
    expect(isNewAppNameAllowed(n)).toBe(true),
  );

  it.each([
    '',
    'x'.repeat(50),
    '-app',
    'app-',
    'my--app',
    'My-App',
    'my_app',
    'my.app',
    'my app',
    'provelox',
    'traefik',
    'registry',
  ])('rejects %j', (n) => expect(isNewAppNameAllowed(n)).toBe(false));
});

describe('APP_NAME_RE (lookups stay lenient so older apps keep working)', () => {
  it('still accepts legacy names the new rule rejects', () => {
    expect(APP_NAME_RE.test('x'.repeat(60))).toBe(true);
    expect(APP_NAME_RE.test('old--app-')).toBe(true);
    expect(isNewAppNameAllowed('old--app-')).toBe(false);
  });
  it('still blocks path tricks', () => {
    for (const bad of ['../x', 'a/b', 'A', ''])
      expect(APP_NAME_RE.test(bad)).toBe(false);
  });
});

describe('explainAppName', () => {
  it.each(['', 'my-app', 'a'])('stays quiet for %j', (n) =>
    expect(explainAppName(n)).toBeNull(),
  );

  it('explains dots, the case the UI used to swallow silently', () => {
    expect(explainAppName('other.com')).toMatch(/dots/);
  });
  it.each([
    ['-app', /start and end/],
    ['app-', /start and end/],
    ['my app', /spaces/],
    ['my--app', /two dashes/],
    ['my_app', /lowercase/],
    ['x'.repeat(50), /shorter than 50/],
    ['registry', /reserved/],
    ['traefik', /reserved/],
  ])('explains %j', (n, re) => expect(explainAppName(n)).toMatch(re));

  it('every rejected name gets an explanation', () => {
    for (const n of [
      'a.b',
      'a b',
      '-a',
      'a-',
      'a--b',
      'A',
      'a_b',
      'provelox',
      'x'.repeat(60),
    ]) {
      expect(isNewAppNameAllowed(n)).toBe(false);
      expect(explainAppName(n)).toBeTruthy();
    }
  });
});

describe('suggestAppName', () => {
  it.each([
    ['other.com', 'other-com'],
    ['My Cool_App!', 'my-cool-app'],
    ['--x--', 'x'],
    ['a  --  b', 'a-b'],
    ['', ''],
  ])('%j -> %j', (input, out) => expect(suggestAppName(input)).toBe(out));

  it('only ever suggests names Provelox accepts', () => {
    for (const s of [
      'Other.com',
      'a b c',
      '!!!',
      'x'.repeat(100),
      'provelox',
      'registry',
    ]) {
      const out = suggestAppName(s);
      expect(out === '' || isNewAppNameAllowed(out)).toBe(true);
    }
  });
});

describe('suggestFromDomain', () => {
  it.each([
    ['loxti.com', 'loxti-web'],
    ['app.loxti.com', 'loxti-app'],
    ['api.loxti.com', 'loxti-api'],
    ['admin.fleetstry.com', 'fleetstry-admin'],
    ['search.fleetstry.com', 'fleetstry-search'],
    ['fleetstry.com', 'fleetstry-web'],
    // www is the bare domain; deeper subdomains keep their order
    ['www.loxti.com', 'loxti-web'],
    ['admin.eu.fleetstry.com', 'fleetstry-admin-eu'],
    // a dash in the product does not matter: nothing decodes the name back
    ['api.my-shop.com', 'my-shop-api'],
    // two-label public suffixes
    ['api.acme.co.uk', 'acme-api'],
    ['acme.co.uk', 'acme-web'],
    // what people paste
    ['https://API.loxti.com/login?x=1', 'loxti-api'],
    ['  api.loxti.com:8443 ', 'loxti-api'],
  ])('%s -> %s', (input, name) => {
    expect(suggestFromDomain(input)?.name).toBe(name);
  });

  it('says which part is the product and which the role', () => {
    expect(suggestFromDomain('api.loxti.com')).toMatchObject({
      host: 'api.loxti.com',
      product: 'loxti',
      role: 'api',
    });
  });

  it.each(['', 'storefront', 'my app', 'localhost', '10.0.0.1', 'a..b.com'])(
    'does not take %j for a domain',
    (input) => {
      expect(suggestFromDomain(input)).toBeNull();
    },
  );

  it('gives only names a new app may have', () => {
    const long = `${'a'.repeat(30)}.${'b'.repeat(30)}.com`;
    const s = suggestFromDomain(long);
    expect(s === null || s.name.length < 50).toBe(true);
  });
});

describe('parseHost', () => {
  it('lowercases and strips the scheme, path, port and trailing dot', () => {
    expect(parseHost('HTTPS://Api.Loxti.com.:443/x')).toBe('api.loxti.com');
  });
});

describe('collectionForProduct', () => {
  const cols = [
    { id: 'g_1', name: 'Loxti' },
    { id: 'g_2', name: 'Fleetstry Production' },
    { id: 'g_3', name: 'Fleetstry Staging' },
  ];
  it('finds the one collection named for the product', () => {
    expect(collectionForProduct('loxti', cols)?.id).toBe('g_1');
  });
  it('picks none when it would be a guess', () => {
    expect(collectionForProduct('fleetstry', cols)).toBeNull();
    expect(collectionForProduct('other', cols)).toBeNull();
  });
});
