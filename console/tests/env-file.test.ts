import { describe, expect, it } from 'vitest';
import { valueOrFile } from '@/lib/env-file';

const read = (files: Record<string, string>) => (p: string) => {
  if (!(p in files)) throw new Error('ENOENT');
  return files[p];
};

describe('valueOrFile', () => {
  it('uses the plain variable', () => {
    expect(valueOrFile('X', { X: 'v' })).toBe('v');
  });
  it('reads the file named by X_FILE and trims it', () => {
    expect(valueOrFile('X', { X_FILE: '/s' }, read({ '/s': 'secret\n' }))).toBe(
      'secret',
    );
  });
  it('lets the plain variable win over the file', () => {
    expect(
      valueOrFile('X', { X: 'plain', X_FILE: '/s' }, read({ '/s': 'file' })),
    ).toBe('plain');
  });
  it('is undefined when neither is set, or the file is empty', () => {
    expect(valueOrFile('X', {})).toBeUndefined();
    expect(
      valueOrFile('X', { X_FILE: '/s' }, read({ '/s': '  \n' })),
    ).toBeUndefined();
  });
  it('says which file could not be read', () => {
    expect(() => valueOrFile('X', { X_FILE: '/nope' }, read({}))).toThrow(
      'X_FILE points to /nope',
    );
  });
});
