import { describe, expect, it } from 'vitest';
import {
  canRestore,
  databaseDumpUrl,
  databaseRestoreUrl,
  restoreErrorMessage,
} from '@/lib/database-backup';

describe('database addresses', () => {
  it('builds the dump address, with or without every database', () => {
    expect(databaseDumpUrl('db-track', false)).toBe(
      '/api/databases/db-track/dump',
    );
    expect(databaseDumpUrl('db-track', true)).toBe(
      '/api/databases/db-track/dump?all=1',
    );
  });
  it('builds the restore address; replacing carries the app name to confirm', () => {
    expect(databaseRestoreUrl('db', false)).toBe('/api/databases/db/restore');
    expect(databaseRestoreUrl('db', true)).toBe(
      '/api/databases/db/restore?clean=1&confirm=db',
    );
  });
  it('encodes what is not safe in an address', () => {
    expect(databaseDumpUrl('a/b', false)).toBe('/api/databases/a%2Fb/dump');
  });
});

describe('canRestore', () => {
  const file = { size: 10 };
  const base = { file, replace: false, typed: '', appName: 'db', busy: false };
  it('needs a file that is not empty', () => {
    expect(canRestore({ ...base, file: null })).toBe(false);
    expect(canRestore({ ...base, file: { size: 0 } })).toBe(false);
    expect(canRestore(base)).toBe(true);
  });
  it('is off while something is being sent', () => {
    expect(canRestore({ ...base, busy: true })).toBe(false);
  });
  it('replacing needs the app name typed exactly', () => {
    expect(canRestore({ ...base, replace: true })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: 'DB' })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: 'other' })).toBe(false);
    expect(canRestore({ ...base, replace: true, typed: ' db ' })).toBe(true);
  });
});

describe('restoreErrorMessage', () => {
  it('uses what the API said', () => {
    expect(
      restoreErrorMessage(422, {
        error: { message: 'The restore stopped with exit code 3.' },
      }),
    ).toBe('The restore stopped with exit code 3.');
    expect(restoreErrorMessage(400, { error: 'Not signed in' })).toBe(
      'Not signed in',
    );
  });
  it('says something useful when it said nothing', () => {
    expect(restoreErrorMessage(401, null)).toMatch(/sign/i);
    expect(restoreErrorMessage(403, null)).toMatch(/administrator/);
    expect(restoreErrorMessage(0, null)).toMatch(/interrupted/);
    expect(restoreErrorMessage(500, '<html>')).toMatch(/500/);
  });
});
