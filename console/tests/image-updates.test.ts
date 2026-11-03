import { describe, expect, it } from 'vitest';
import {
  updateLabel,
  updateTitle,
  updateTone,
  type ImageUpdate,
} from '@/lib/image-updates';

const base: ImageUpdate = {
  app: 'web',
  image: 'acme/web:1.4.0',
  tag: '1.4.0',
  latest: null,
  rebuilt: false,
  checkedAt: null,
  error: null,
};

describe('image update labels', () => {
  it('says nothing when up to date or unchecked', () => {
    expect(updateLabel(base)).toBeNull();
    expect(updateLabel(undefined)).toBeNull();
  });
  it('names the new version, and explains the size of the step', () => {
    const u = { ...base, latest: { tag: '2.0.0', kind: 'major' as const } };
    expect(updateLabel(u)).toBe('2.0.0');
    expect(updateTitle(u)).toContain('a major update');
    expect(updateTone(u)).toContain('amber');
    expect(
      updateTone({ ...u, latest: { tag: '1.5.0', kind: 'minor' } }),
    ).toContain('sky');
  });
  it('says a rebuilt tag is a new build', () => {
    const u = { ...base, rebuilt: true };
    expect(updateLabel(u)).toBe('new build');
    expect(updateTitle(u)).toContain('different build');
  });
});
