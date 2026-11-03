import { describe, expect, it } from 'vitest';
import {
  UPLOAD_REFUSE_BYTES,
  UPLOAD_WARN_BYTES,
  canRestoreFromServer,
  hostForHints,
  importError,
  isImportFileName,
  restoreProblem,
  rsyncBetweenServersCommand,
  rsyncDownCommand,
  rsyncUpCommand,
  shellWord,
  uploadAdvice,
  volumeExportUrl,
  volumeRestoreFromUrl,
  type ImportFile,
} from '@/lib/volume-import';

const file = (over: Partial<ImportFile> = {}): ImportFile => ({
  name: 'shop.tar.gz',
  sizeBytes: 1000,
  modifiedAt: '2026-11-02T00:00:00.000Z',
  gzip: true,
  ...over,
});

describe('uploadAdvice', () => {
  it('is fine up to 200 MB, a warning above that, and refused above 2 GB', () => {
    expect(uploadAdvice(0)).toBe('ok');
    expect(uploadAdvice(UPLOAD_WARN_BYTES)).toBe('ok');
    expect(uploadAdvice(UPLOAD_WARN_BYTES + 1)).toBe('warn');
    expect(uploadAdvice(UPLOAD_REFUSE_BYTES)).toBe('warn');
    expect(uploadAdvice(UPLOAD_REFUSE_BYTES + 1)).toBe('refuse');
    expect(UPLOAD_WARN_BYTES).toBe(200 * 1024 * 1024);
    expect(UPLOAD_REFUSE_BYTES).toBe(2 * 1024 ** 3);
  });
});

describe('hostForHints', () => {
  it('uses the host the console is opened at when it looks like a host', () => {
    expect(hostForHints('console.lax1.infra.floms.net')).toBe(
      'console.lax1.infra.floms.net',
    );
    expect(hostForHints('203.0.113.7')).toBe('203.0.113.7');
  });
  it('gives something to replace when there is none, or it is not a host', () => {
    for (const h of [undefined, null, '', 'a b', 'x;y', '$(id)', '-bad'])
      expect(hostForHints(h)).toBe('<server>');
  });
});

describe('shellWord', () => {
  it('leaves plain words alone and quotes the rest, quotes included', () => {
    expect(shellWord('/var/lib/provelox/imports/')).toBe(
      '/var/lib/provelox/imports/',
    );
    expect(shellWord('my file.tar.gz')).toBe("'my file.tar.gz'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord('a;rm -rf /')).toBe("'a;rm -rf /'");
  });
});

describe('the commands shown to copy', () => {
  it('puts a local file into the folder, with a trailing slash so it lands inside it', () => {
    expect(rsyncUpCommand('srv.example.com', '/var/lib/provelox/imports')).toBe(
      'rsync -avP ./your-file.tar.gz root@srv.example.com:/var/lib/provelox/imports/',
    );
    expect(rsyncUpCommand('h', '/srv/imports/', './a b.tar.gz')).toBe(
      "rsync -avP './a b.tar.gz' root@h:/srv/imports/",
    );
  });

  it('fetches a saved copy from the folder', () => {
    expect(
      rsyncDownCommand(
        'srv.example.com',
        '/var/lib/provelox/imports',
        'shop-data-20261102-210509.tar.gz',
      ),
    ).toBe(
      'rsync -avP root@srv.example.com:/var/lib/provelox/imports/shop-data-20261102-210509.tar.gz ./',
    );
  });

  it('pulls a copy from the old server straight into the new one folder', () => {
    expect(
      rsyncBetweenServersCommand(
        'old.example.com',
        '/var/lib/provelox/imports',
        'a.tar.gz',
      ),
    ).toBe(
      'rsync -avP root@old.example.com:/var/lib/provelox/imports/a.tar.gz /var/lib/provelox/imports/',
    );
  });
});

describe('the addresses the browser calls', () => {
  it('asks for a copy to be saved, with or without stopping the app', () => {
    expect(volumeExportUrl('db-track', 'data', false)).toBe(
      '/api/volumes/db-track/data/export',
    );
    expect(volumeExportUrl('db-track', 'data', true)).toBe(
      '/api/volumes/db-track/data/export?stop=1',
    );
  });

  it('asks for a restore from a file by its name, carrying the confirmation only when replacing', () => {
    expect(volumeRestoreFromUrl('shop', 'data', 'a.tar.gz', null)).toBe(
      '/api/volumes/shop/data/restore?from=a.tar.gz',
    );
    expect(
      volumeRestoreFromUrl('shop', 'data', 'a.tar.gz', { confirm: 'shop' }),
    ).toBe(
      '/api/volumes/shop/data/restore?from=a.tar.gz&replace=1&confirm=shop',
    );
  });

  it('encodes what is put in the address', () => {
    expect(
      volumeRestoreFromUrl('a b', 'd/x', 'f&g.tar.gz', { confirm: 'a&b' }),
    ).toBe(
      '/api/volumes/a%20b/d%2Fx/restore?from=f%26g.tar.gz&replace=1&confirm=a%26b',
    );
  });
});

describe('canRestoreFromServer', () => {
  const base = { replace: false, typed: '', appName: 'shop' };
  it('needs a file, and it has to be gzip', () => {
    expect(canRestoreFromServer({ ...base, file: null })).toBe(false);
    expect(canRestoreFromServer({ ...base, file: file({ gzip: false }) })).toBe(
      false,
    );
    expect(canRestoreFromServer({ ...base, file: file() })).toBe(true);
  });
  it('needs the app name typed exactly to replace', () => {
    for (const typed of ['', 'Shop', 'shop ', 'other'])
      expect(
        canRestoreFromServer({
          file: file(),
          replace: true,
          typed,
          appName: 'shop',
        }),
      ).toBe(false);
    expect(
      canRestoreFromServer({
        file: file(),
        replace: true,
        typed: 'shop',
        appName: 'shop',
      }),
    ).toBe(true);
  });
});

describe('restoreProblem', () => {
  it('is null for a gzip file that fits, or when the free space is not known', () => {
    expect(restoreProblem(file(), 10_000)).toBeNull();
    expect(restoreProblem(file(), 1000)).toBeNull();
    expect(restoreProblem(file(), null)).toBeNull();
  });
  it('says why a file cannot be restored: not gzip, or no room for it', () => {
    expect(restoreProblem(file({ gzip: false }), 10_000)).toMatch(/gzip/);
    expect(restoreProblem(file({ sizeBytes: 5000 }), 100)).toMatch(
      /free space/,
    );
  });
});

describe('importError', () => {
  it('reads a message in either shape, and falls back to the status', () => {
    expect(importError({ error: 'plain' }, 400)).toBe('plain');
    expect(importError({ error: { message: 'nested' } }, 409)).toBe('nested');
    expect(importError(null, 500, 'The restore')).toBe(
      'The restore failed (500).',
    );
    expect(importError(null, 401)).toMatch(/Sign in again/);
  });
});

describe('isImportFileName', () => {
  it('holds to the same pattern as the API', () => {
    for (const ok of ['a.tar.gz', 'shop-data-20261102-210509.tar.gz', 'x.tgz'])
      expect(isImportFileName(ok)).toBe(true);
    for (const bad of [
      '../a.tar.gz',
      '/a.tar.gz',
      'a/b.tar.gz',
      '.a.tar.gz',
      'a..b.tar.gz',
      'a.zip',
      'a.TAR.GZ',
      'a b.tar.gz',
      '',
      `${'a'.repeat(129)}.tar.gz`,
    ])
      expect(isImportFileName(bad)).toBe(false);
  });
});
