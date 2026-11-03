import { describe, expect, it } from 'vitest';
import { afterLogin, loginUrl } from '@/lib/after-login';

describe('afterLogin', () => {
  it('goes to a page of an app', () => {
    expect(afterLogin('/apps/db-track/configuration')).toBe(
      '/apps/db-track/configuration',
    );
    expect(afterLogin('/apps/db-track')).toBe('/apps/db-track');
  });
  it.each([
    undefined,
    '',
    '/',
    '//evil.example/apps/x',
    'https://evil.example',
    '/\\evil.example',
    '/apps/../settings',
    '/apps/x/y/z/w',
    '/api/volumes/x/y/download?stop=1',
    '/apps/x?stop=1',
    '/apps/x/configuration#a',
    '/settings',
  ])('falls back to the apps list for %j', (v) => {
    expect(afterLogin(v)).toBe('/apps');
  });
  it('builds a login address that carries where to come back to', () => {
    expect(loginUrl('/apps/db-track/configuration')).toBe(
      '/login?next=%2Fapps%2Fdb-track%2Fconfiguration',
    );
  });
});
