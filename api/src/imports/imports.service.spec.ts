import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import {
  DELETE_SCRIPT,
  ENSURE_SCRIPT,
  EXPORT_SCRIPT,
  LIST_SCRIPT,
} from './imports';
import { ImportsService } from './imports.service';

const listing = (...files: string[]) => [...files, 'D\t1024'].join('\n') + '\n';
const F = (name: string, size = 100, mtime = 1_700_000_000, gz = 1) =>
  `F\t${name}\t${size}\t${mtime}\t${gz}`;

function setup() {
  const s = makeStack();
  const imports = new ImportsService(s.docker, s.cfg);
  return { ...s, imports };
}

describe('ImportsService: the folder is only the configured one', () => {
  it('defaults to /var/lib/provelox/imports and mounts exactly that path, never one it is given', async () => {
    const s = setup();
    expect(s.imports.dir).toBe('/var/lib/provelox/imports');
    s.docker.streamPlan = [{ bytes: '' }, { bytes: listing() }];
    await s.imports.list();
    const [ensure, list] = s.docker.streamRuns;
    expect(ensure.mounts).toEqual([
      {
        volume: '/var/lib/provelox/imports',
        target: '/imports',
        readOnly: false,
      },
    ]);
    expect(ensure.command).toEqual(['-c', ENSURE_SCRIPT]);
    // listing: read-only, only to read, labelled as an import helper
    expect(list.mounts).toEqual([
      {
        volume: '/var/lib/provelox/imports',
        target: '/imports',
        readOnly: true,
      },
    ]);
    expect(list.command).toEqual(['-c', LIST_SCRIPT]);
    expect(list.kind).toBe('import');
    expect(list.capabilities).toEqual(['DAC_READ_SEARCH']);
  });

  it('prepares the folder once, not for every call', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: listing() },
      { bytes: listing() },
    ];
    await s.imports.list();
    await s.imports.list();
    expect(s.docker.streamRuns).toHaveLength(3);
  });

  it('refuses a bad IMPORTS_DIR when the config is read', async () => {
    const { loadConfig } = await import('../config/config');
    const base = { JWT_SECRET: 'x'.repeat(40) };
    for (const bad of [
      'relative/dir',
      '/a/../b',
      '/',
      '/has space',
      '/semi;colon',
    ])
      expect(() => loadConfig({ ...base, IMPORTS_DIR: bad })).toThrow();
    expect(
      loadConfig({ ...base, IMPORTS_DIR: '/srv/imports' }).IMPORTS_DIR,
    ).toBe('/srv/imports');
  });
});

describe('ImportsService.list and find', () => {
  it('lists newest first with the free space', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      {
        bytes: listing(
          F('old.tar.gz', 1, 1_600_000_000),
          F('new.tgz', 2, 1_800_000_000),
        ),
      },
    ];
    const l = await s.imports.list();
    expect(l.files.map((f) => f.name)).toEqual(['new.tgz', 'old.tar.gz']);
    expect(l.freeBytes).toBe(1024 * 1024);
  });

  it('says 503 with what the helper said when the folder cannot be read', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 2, stderr: 'the folder is not there' },
    ];
    await expect(s.imports.list()).rejects.toThrow(/the folder is not there/);
  });

  it('says 503 when Docker cannot start the helper', async () => {
    const s = setup();
    s.docker.streamStartError = new Error('no such image');
    await expect(s.imports.list()).rejects.toThrow(/no such image/);
  });

  it('finds a file only by name in what the folder really holds: 400 for a bad name, 404 for one that is not there', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: listing(F('a.tar.gz')) },
      { bytes: listing(F('a.tar.gz')) },
    ];
    expect((await s.imports.find('a.tar.gz')).file.name).toBe('a.tar.gz');
    await expect(s.imports.find('../etc/passwd')).rejects.toThrow(
      ValidationError,
    );
    await expect(s.imports.find('/etc/passwd')).rejects.toThrow(
      ValidationError,
    );
    // a well-formed name that the folder does not hold never reaches a restore
    await expect(s.imports.find('b.tar.gz')).rejects.toThrow(NotFoundError);
    // the bad names were refused before any helper ran
    expect(s.docker.streamRuns).toHaveLength(3);
  });
});

describe('ImportsService.remove', () => {
  it('needs the file name sent again, and a file that is there', async () => {
    const s = setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: listing(F('a.tar.gz')) }];
    await expect(s.imports.remove('a.tar.gz', undefined)).rejects.toThrow(
      ValidationError,
    );
    await expect(s.imports.remove('a.tar.gz', 'other.tar.gz')).rejects.toThrow(
      /Confirm by sending the file name/,
    );
    await expect(
      s.imports.remove('../x.tar.gz', '../x.tar.gz'),
    ).rejects.toThrow(ValidationError);
    expect(s.docker.streamRuns).toHaveLength(0);
    await s.imports.remove('a.tar.gz', 'a.tar.gz');
    const del = s.docker.streamRuns[s.docker.streamRuns.length - 1];
    // the name is the argument, the program is fixed text, and only now is the folder mounted for writing
    expect(del.command).toEqual(['-c', DELETE_SCRIPT, 'sh', 'a.tar.gz']);
    expect(del.mounts[0].readOnly).toBe(false);
  });

  it('answers 404 for a file that is not there, and 409 if it stopped being a plain file', async () => {
    const s = setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: listing() }];
    await expect(s.imports.remove('a.tar.gz', 'a.tar.gz')).rejects.toThrow(
      NotFoundError,
    );
    s.docker.streamPlan = [{ bytes: listing(F('a.tar.gz')) }, { exit: 3 }];
    await expect(s.imports.remove('a.tar.gz', 'a.tar.gz')).rejects.toThrow(
      ConflictError,
    );
  });
});

describe('ImportsService.exportVolume', () => {
  it('saves the volume read-only into the folder read-write, and returns the size', async () => {
    const s = setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=4096\n' }];
    const r = await s.imports.exportVolume(
      'pvx-shop-data',
      'shop-data-20261102-210509.tar.gz',
    );
    expect(r).toEqual({ sizeBytes: 4096, note: '' });
    const run = s.docker.streamRuns[1];
    expect(run.command).toEqual([
      '-c',
      EXPORT_SCRIPT,
      'sh',
      'shop-data-20261102-210509.tar.gz',
    ]);
    expect(run.mounts).toEqual([
      { volume: 'pvx-shop-data', target: '/data', readOnly: true },
      {
        volume: '/var/lib/provelox/imports',
        target: '/imports',
        readOnly: false,
      },
    ]);
    expect(run.capabilities).toEqual(['DAC_READ_SEARCH', 'DAC_OVERRIDE']);
  });

  it('is complete when tar only skipped files that changed, and says so', async () => {
    const s = setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=10\n', exit: 1 }];
    const r = await s.imports.exportVolume('pvx-v', 'a.tar.gz');
    expect(r.sizeBytes).toBe(10);
    expect(r.note).toMatch(/changed or vanished/);
  });

  it('fails with what tar said, and a name that is already taken is a 409', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 2, stderr: 'No space left on device' },
    ];
    await expect(s.imports.exportVolume('pvx-v', 'a.tar.gz')).rejects.toThrow(
      /No space left on device/,
    );
    s.docker.streamPlan = [{ exit: 5 }];
    await expect(s.imports.exportVolume('pvx-v', 'a.tar.gz')).rejects.toThrow(
      ConflictError,
    );
  });

  it('does not keep, and says so, a copy that is cut short (a full disk looks like exit 8)', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 8, stderr: 'gzip: short write' },
    ];
    await expect(s.imports.exportVolume('pvx-v', 'a.tar.gz')).rejects.toThrow(
      /cut short.*not kept/s,
    );
  });

  it('refuses a name that is not a plain archive name before any helper runs', async () => {
    const s = setup();
    await expect(
      s.imports.exportVolume('pvx-v', '../x.tar.gz'),
    ).rejects.toThrow(ValidationError);
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});
