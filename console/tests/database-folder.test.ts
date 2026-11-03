import { describe, expect, it } from 'vitest';
import {
  canRestoreFromServer,
  databaseExportUrl,
  databaseRestoreFromUrl,
  dumpProblem,
  isDumpFileName,
} from '@/lib/database-backup';
import {
  filesOfKind,
  importKind,
  isImportFileName,
  isVolumeFileName,
  type ImportsListing,
} from '@/lib/volume-import';

describe('saving a dump on the server, and restoring from a file there', () => {
  it('builds the address that saves a dump in the folder, with or without every database', () => {
    expect(databaseExportUrl('db', false)).toBe('/api/databases/db/export');
    expect(databaseExportUrl('db', true)).toBe(
      '/api/databases/db/export?all=1',
    );
    expect(databaseExportUrl('a/b', false)).toBe('/api/databases/a%2Fb/export');
  });

  it('builds the address that restores from a file in the folder: no body, replacing carries the app name', () => {
    expect(databaseRestoreFromUrl('db', 'db-1.dump', false)).toBe(
      '/api/databases/db/restore?from=db-1.dump',
    );
    expect(databaseRestoreFromUrl('db', 'db-1.dump', true)).toBe(
      '/api/databases/db/restore?from=db-1.dump&clean=1&confirm=db',
    );
    expect(databaseRestoreFromUrl('db', 'a b.sql', false)).toBe(
      '/api/databases/db/restore?from=a%20b.sql',
    );
  });

  it.each(['db-20261102-010203.dump', 'x.sql', 'x.sql.gz', 'A1_b-2.sql.gz'])(
    '%s is a dump file name',
    (n) => expect(isDumpFileName(n)).toBe(true),
  );

  it.each([
    // a volume archive is not a dump
    'shop-data.tar.gz',
    'a.tgz',
    // paths, traversal, hidden, wrong endings
    '../x.dump',
    'a/b.sql',
    '.hidden.dump',
    'a..b.sql',
    'x.txt',
    'x.DUMP',
    'x.dump.exe',
    'a b.sql',
    '',
  ])('%j is not a dump file name', (n) =>
    expect(isDumpFileName(n)).toBe(false),
  );

  it('Restore needs a chosen, non-empty dump, and for replace the exact app name', () => {
    const f = { name: 'db-1.dump', sizeBytes: 10 };
    const base = { replace: false, typed: '', appName: 'db' };
    expect(canRestoreFromServer({ ...base, file: null })).toBe(false);
    expect(canRestoreFromServer({ ...base, file: f })).toBe(true);
    expect(
      canRestoreFromServer({ ...base, file: { ...f, sizeBytes: 0 } }),
    ).toBe(false);
    // a volume archive is never restorable into a database
    expect(
      canRestoreFromServer({
        ...base,
        file: { name: 'vol.tar.gz', sizeBytes: 10 },
      }),
    ).toBe(false);
    expect(canRestoreFromServer({ ...base, file: f, replace: true })).toBe(
      false,
    );
    expect(
      canRestoreFromServer({ ...base, file: f, replace: true, typed: 'DB' }),
    ).toBe(false);
    expect(
      canRestoreFromServer({ ...base, file: f, replace: true, typed: 'db' }),
    ).toBe(true);
  });

  it('says why an empty dump cannot be restored', () => {
    expect(dumpProblem({ sizeBytes: 0 })).toMatch(/empty/);
    expect(dumpProblem({ sizeBytes: 1 })).toBeNull();
  });
});

describe('importKind: which files are for a volume and which for a database', () => {
  it.each([
    ['shop-data-20261102-210509.tar.gz', 'volume'],
    ['a.tgz', 'volume'],
    ['db-20261102-010203.dump', 'database'],
    ['x.sql', 'database'],
    ['x.sql.gz', 'database'],
    // an archive of a dump is an archive: the last ending decides
    ['db.dump.tar.gz', 'volume'],
  ] as const)('%s is for a %s', (n, kind) => expect(importKind(n)).toBe(kind));

  it.each(['a.zip', '../x.dump', '.x.sql', 'a/b.tgz', 'x.TAR.GZ', ''])(
    '%j is for neither',
    (n) => expect(importKind(n)).toBeNull(),
  );

  it('a volume restore takes only archives, and deleting takes either kind', () => {
    expect(isVolumeFileName('a.tar.gz')).toBe(true);
    expect(isVolumeFileName('a.dump')).toBe(false);
    expect(isImportFileName('a.dump')).toBe(true);
    expect(isImportFileName('a.tar.gz')).toBe(true);
    expect(isImportFileName('a.txt')).toBe(false);
  });
});

describe('filesOfKind', () => {
  const at = '2026-11-02T00:00:00.000Z';
  const listing: ImportsListing = {
    dir: '/d',
    freeBytes: null,
    files: [
      {
        name: 'v.tar.gz',
        sizeBytes: 1,
        modifiedAt: at,
        gzip: true,
        kind: 'volume',
      },
      {
        name: 'd.dump',
        sizeBytes: 1,
        modifiedAt: at,
        gzip: false,
        kind: 'database',
      },
      {
        name: 'e.sql.gz',
        sizeBytes: 1,
        modifiedAt: at,
        gzip: true,
        kind: 'database',
      },
      // from an instance that does not say what a file is for: the name decides
      { name: 'old.tgz', sizeBytes: 1, modifiedAt: at, gzip: true },
    ],
  };
  it('keeps each kind in its own list', () => {
    expect(filesOfKind(listing, 'volume').map((f) => f.name)).toEqual([
      'v.tar.gz',
      'old.tgz',
    ]);
    expect(filesOfKind(listing, 'database').map((f) => f.name)).toEqual([
      'd.dump',
      'e.sql.gz',
    ]);
    expect(filesOfKind(null, 'database')).toEqual([]);
  });
});
