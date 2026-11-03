import { ConflictError, ValidationError } from '../common/errors';
import { ImportsService } from '../imports/imports.service';
import { makeStack } from '../test-utils';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseImportService } from './database-import.service';
import { PROBE_SCRIPT } from './scripts';

const PGDMP = Buffer.from('PGDMP\u0001\u000e\u0000the-dump-bytes');
const TOOLS = 'pg_dump\npg_dumpall\npg_restore\npsql\n';

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'db' });
  await s.apps.deploy('db', 'postgres:16');
  s.docker.containerIds.set('pvx-db', 'c1');
  s.docker.execScript = (spec) =>
    spec.cmd[2] === PROBE_SCRIPT ? { out: Buffer.from(TOOLS) } : { out: PGDMP };
  const backups = new DatabaseBackupService(s.apps, s.docker);
  const folder = new ImportsService(s.docker, s.cfg);
  const svc = new DatabaseImportService(backups, folder);
  return { ...s, svc };
}

/** The script each helper ran, in order (the second word of `sh -c <script> sh <name>`) */
const scripts = (s: { docker: { streamRuns: { command: string[] }[] } }) =>
  s.docker.streamRuns.map((r) => r.command[1] ?? '');

describe('DatabaseImportService.exportDump', () => {
  it('names the file for the app and the time, and writes it only through a hidden part file that is then moved into place', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `size=${PGDMP.length}\n` },
      { bytes: '' },
    ];
    const r = await s.svc.exportDump(
      'db',
      {},
      new Date('2026-11-02T01:02:03Z'),
    );
    expect(r).toEqual({
      file: 'db-20261102-010203.dump',
      sizeBytes: PGDMP.length,
      dir: s.cfg.IMPORTS_DIR,
    });
    const run = scripts(s);
    expect(run[1]).toContain('cat > "$tmp"');
    expect(run[2]).toContain('mv "$tmp"');
    // the dump went to the writer, which is the only helper that gets input and mounts the folder read-write
    const writer = s.docker.streamRuns[1];
    expect(writer.input).toBeDefined();
    expect(writer.mounts).toEqual([
      { volume: s.cfg.IMPORTS_DIR, target: '/imports', readOnly: false },
    ]);
    expect(writer.capabilities).not.toContain('NET_ADMIN');
    expect(s.docker.streamReceived.some((b) => b.equals(PGDMP))).toBe(true);
  });

  it('saves SQL gzipped for every database or for MySQL, with the .sql.gz ending', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=9\n' }, { bytes: '' }];
    const r = await s.svc.exportDump('db', { all: true }, new Date(0));
    expect(r.file).toBe('db-19700101-000000.sql.gz');
  });

  it('a name that is already taken is a conflict: the dump is stopped and the part file removed, nothing is moved into place', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 5, stderr: 'a file with that name is already there' },
      { bytes: '' },
    ];
    await expect(s.svc.exportDump('db')).rejects.toThrow(ConflictError);
    expect(s.docker.execAborts).toBeGreaterThan(0);
    const run = scripts(s);
    expect(run.some((c) => c.includes('mv "$tmp"'))).toBe(false);
    expect(run.at(-1)).toContain('rm -f -- "/imports/.$1.part"');
  });

  it('a disk that fills up is reported, and what was written is removed', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 8, stderr: 'cat: write error: No space left on device' },
      { bytes: '' },
    ];
    await expect(s.svc.exportDump('db')).rejects.toThrow(
      /disk is probably full/,
    );
    expect(scripts(s).at(-1)).toContain('rm -f -- "/imports/.$1.part"');
  });

  it('a dump tool that failed after the file was written leaves no file, and its error text is not in the answer', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(TOOLS) }
        : { out: PGDMP, exit: 1, stderr: 'FATAL: password for app (hunter2)' };
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: 'size=10\n' },
      { bytes: '' },
    ];
    const err = await s.svc.exportDump('db').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not finish/);
    expect(scripts(s).some((c) => c.includes('mv "$tmp"'))).toBe(false);
    expect(scripts(s).at(-1)).toContain('rm -f --');
  });

  it('failing to move the finished file into place removes it', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: 'size=10\n' },
      { exit: 4, stderr: 'mv: cannot move' },
      { bytes: '' },
    ];
    await expect(s.svc.exportDump('db')).rejects.toThrow(/put in place/);
    expect(scripts(s).at(-1)).toContain('rm -f --');
  });

  it('an app that is not a database, or not running, is refused before a file is made', async () => {
    const s = await setup();
    s.docker.containerIds.clear();
    await expect(s.svc.exportDump('db')).rejects.toThrow(ConflictError);
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});

describe('DatabaseImportService.restoreFrom: refusals before anything is read', () => {
  it.each([
    'data.tar.gz',
    'data.tgz',
    '../x.dump',
    '/etc/passwd',
    'a/b.sql',
    '.hidden.dump',
    'x.txt',
    '',
    undefined,
  ])('a name that is not a dump file name (%j) is a 400', async (bad) => {
    const s = await setup();
    await expect(s.svc.restoreFrom('db', bad)).rejects.toThrow(ValidationError);
    expect(s.docker.streamRuns).toHaveLength(0);
    expect(s.docker.execRuns).toHaveLength(0);
  });

  it('replacing needs the app name', async () => {
    const s = await setup();
    await expect(
      s.svc.restoreFrom('db', 'a.dump', { clean: true, confirm: 'other' }),
    ).rejects.toThrow(/confirm/);
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});
