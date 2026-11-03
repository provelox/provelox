import { describe, expect, it } from 'vitest';
import {
  canRestore,
  looksLikeArchiveName,
  restoreError,
  volumeRestoreUrl,
} from '@/lib/volume-download';

describe('volumeRestoreUrl', () => {
  it('has no replace unless asked, and carries the confirmation when it is', () => {
    expect(volumeRestoreUrl('db-track', 'data', null)).toBe(
      '/api/volumes/db-track/data/restore',
    );
    expect(volumeRestoreUrl('db-track', 'data', { confirm: 'db-track' })).toBe(
      '/api/volumes/db-track/data/restore?replace=1&confirm=db-track',
    );
  });
  it('encodes what is put in the address', () => {
    expect(volumeRestoreUrl('a b', 'd/x', { confirm: 'a&b' })).toBe(
      '/api/volumes/a%20b/d%2Fx/restore?replace=1&confirm=a%26b',
    );
  });
});

describe('looksLikeArchiveName', () => {
  it.each(['a.tar.gz', 'A.TAR.GZ', 'x-data-2026.tgz'])('accepts %s', (n) => {
    expect(looksLikeArchiveName(n)).toBe(true);
  });
  it.each(['a.zip', 'a.tar', 'a.gz', 'tgz', 'a.tar.gz.exe'])(
    'refuses %s',
    (n) => {
      expect(looksLikeArchiveName(n)).toBe(false);
    },
  );
});

describe('canRestore', () => {
  const base = { file: true, replace: false, typed: '', appName: 'files' };
  it('needs a file', () => {
    expect(canRestore(base)).toBe(true);
    expect(canRestore({ ...base, file: false })).toBe(false);
  });
  it('needs, to replace, the exact name of the app', () => {
    expect(canRestore({ ...base, replace: true })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: 'file' })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: 'Files' })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: 'files' })).toBe(true);
  });
});

describe('restoreError', () => {
  it('reads the message however the answer is shaped', () => {
    expect(restoreError({ error: 'plain' }, 409)).toBe('plain');
    expect(restoreError({ error: { message: 'nested' } }, 409)).toBe('nested');
    expect(restoreError(null, 401)).toMatch(/Sign in again/);
    expect(restoreError({}, 500)).toBe('The restore failed (500).');
  });
});
