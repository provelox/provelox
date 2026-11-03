import { describe, expect, it } from 'vitest';
import { upgradeTarget } from '@/lib/upgrade';
import type { ImageUpdate } from '@/lib/image-updates';

const upd = (over: Partial<ImageUpdate>): ImageUpdate => ({
  app: 'a',
  image: 'x',
  tag: '1',
  latest: null,
  rebuilt: false,
  checkedAt: null,
  error: null,
  ...over,
});

describe('upgradeTarget', () => {
  it('swaps the tag for the newer one, keeping the registry and port', () => {
    expect(
      upgradeTarget(
        'localhost:5001/acme/api:20261030-013800',
        upd({ latest: { tag: '20261030-013846', kind: 'newer' } }),
      ),
    ).toBe('localhost:5001/acme/api:20261030-013846');
    expect(
      upgradeTarget(
        'mysql:8.4',
        upd({ latest: { tag: '9.1', kind: 'major' } }),
      ),
    ).toBe('mysql:9.1');
  });
  it('redeploys the same image when only the build changed', () => {
    expect(upgradeTarget('acme/web:1.2', upd({ rebuilt: true }))).toBe(
      'acme/web:1.2',
    );
  });
  it('does nothing for a digest-pinned image, no image, or no update', () => {
    const l = upd({ latest: { tag: '2', kind: 'major' } });
    expect(upgradeTarget('acme/web@sha256:' + 'a'.repeat(64), l)).toBeNull();
    expect(upgradeTarget(undefined, l)).toBeNull();
    expect(upgradeTarget('acme/web:1', upd({}))).toBeNull();
    expect(upgradeTarget('acme/web:1', undefined)).toBeNull();
  });
});
