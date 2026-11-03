import { describe, expect, it } from 'vitest';
import { internalAddresses } from '@/lib/internal-address';

describe('internalAddresses', () => {
  it('is the app name on the container port, with its aliases after it', () => {
    expect(
      internalAddresses({
        appName: 'api',
        aliases: ['old-api'],
        containerHttpPort: 3000,
      }),
    ).toEqual({ port: 3000, shared: ['api', 'old-api'], project: undefined });
  });

  it('assumes port 80 when none is set, like the proxy does', () => {
    expect(internalAddresses({ appName: 'site' }).port).toBe(80);
  });

  it('gives a project service its short name inside the project', () => {
    expect(
      internalAddresses({
        appName: 'shop-db',
        project: 'shop',
        serviceAlias: 'db',
        containerHttpPort: 5432,
      }).project,
    ).toEqual({ name: 'shop', host: 'db' });
  });

  it('adds no project name when it would be the same as the app name', () => {
    expect(
      internalAddresses({
        appName: 'web',
        project: 'shop',
        serviceAlias: 'web',
      }).project,
    ).toBeUndefined();
  });
});
