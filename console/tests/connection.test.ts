import { describe, expect, it } from 'vitest';
import { address, MASK, maskSecrets } from '@/lib/connection';
import type { ProjectVariable } from '@/lib/types';

const v = (over: Partial<ProjectVariable>): ProjectVariable => ({
  key: 'K',
  label: 'K',
  kind: 'text',
  value: 'x',
  where: null,
  ...over,
});

describe('maskSecrets', () => {
  it('hides secrets, encoded as they sit in the URL, and leaves the rest', () => {
    const url = 'postgresql://app:p%40ss%2Fword@db:5432/shop';
    const out = maskSecrets(url, [
      v({ key: 'U', value: 'app' }),
      v({ key: 'P', kind: 'secret', value: 'p@ss/word' }),
    ]);
    expect(out).toBe(`postgresql://app:${MASK}@db:5432/shop`);
  });

  it('does nothing for a secret that is not known', () => {
    expect(
      maskSecrets('redis://x@h:1', [v({ kind: 'secret', value: null })]),
    ).toBe('redis://x@h:1');
  });
});

describe('address', () => {
  const c = {
    host: 'cache-redis',
    hostInProject: 'redis',
    port: 6379,
    url: null,
    urlTemplate: null,
  };
  it('gives host and port for apps and for the project’s own services', () => {
    expect(address(c, 'apps')).toBe('cache-redis:6379');
    expect(address(c, 'project')).toBe('redis:6379');
    expect(address({ ...c, port: null }, 'apps')).toBe('cache-redis');
  });
});
