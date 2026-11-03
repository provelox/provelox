import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESTORE_CAPABILITIES } from '../apps/volume-restore.service';
import { ValidationError } from '../common/errors';
import { loadConfig } from '../config/config';
import { DockerodeAdapter } from '../docker/dockerode.adapter';
import {
  EXPORT_SCRIPT,
  REPLACE_FROM_SCRIPT,
  RESTORE_FROM_SCRIPT,
} from './imports';
import { ImportsService } from './imports.service';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1 (it starts containers). The import folder is a temporary
 * folder made here and removed at the end, never /var/lib/provelox. Saves a volume into the folder through the real
 * helpers, lists it, restores it into another volume, and compares the two trees. Throwaway volumes only.
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const IMAGE = process.env.DOCKER_INTEGRATION_IMAGE ?? 'busybox:latest';
const SRC = `pvx-itest-imp-src-${process.pid}`;
const DST = `pvx-itest-imp-dst-${process.pid}`;
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' });
/** Everything about a volume's tree that a database cares about: names, kinds, modes, owners, sizes, content, links */
const tree = (volume: string) =>
  docker(
    'run',
    '--rm',
    '-v',
    `${volume}:/data:ro`,
    IMAGE,
    'sh',
    '-c',
    `cd /data && find . | sort | while read f; do if [ -L "$f" ]; then echo "$f link $(readlink "$f")"; elif [ -f "$f" ]; then echo "$f file $(stat -c '%a %u:%g %s' "$f") $(md5sum < "$f")"; else echo "$f dir $(stat -c '%a %u:%g' "$f")"; fi; done`,
  );

run('The import folder (real Docker)', () => {
  // made in beforeAll, not here: a skipped suite still runs this body, and must not leave a folder behind
  let folder = '';
  const adapter = new DockerodeAdapter(
    loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
  );
  let imports: ImportsService;
  const NAME = 'src-20261102-210509.tar.gz';
  const restore = (volume: string, script: string, name: string) =>
    imports.run(
      {
        entrypoint: ['sh'],
        command: ['-c', script, 'sh', name],
        mounts: [
          { volume, target: '/data', readOnly: false },
          imports.mount(true),
        ],
        capabilities: RESTORE_CAPABILITIES,
      },
      'restore',
    );
  const helpers = () =>
    docker(
      'ps',
      '-a',
      '--filter',
      'label=io.provelox.helper=import',
      '-q',
    ).trim();

  beforeAll(() => {
    // realpath: on macOS the temporary folder is a link, and Docker needs the real path to share it
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'pvx-imp-')));
    imports = new ImportsService(
      adapter,
      loadConfig({
        JWT_SECRET: 'x'.repeat(40),
        IMPORTS_DIR: folder,
        HELPER_IMAGE: IMAGE,
      }),
    );
    docker('volume', 'create', SRC);
    docker('volume', 'create', DST);
    docker(
      'run',
      '--rm',
      '-v',
      `${SRC}:/data`,
      IMAGE,
      'sh',
      '-c',
      [
        'mkdir -p /data/a/b /data/pgdata/base',
        'echo hello > /data/a/b/c.txt',
        'echo secret > /data/private.key',
        'chown 999:999 /data/private.key',
        'chmod 600 /data/private.key',
        // a database's private folder: owned by another user, closed to everyone else
        'echo page > /data/pgdata/base/1',
        'chown -R 999:999 /data/pgdata',
        'chmod 700 /data/pgdata /data/pgdata/base',
        'ln -s a/b/c.txt /data/link',
        'dd if=/dev/urandom of=/data/big.bin bs=1M count=30 2>/dev/null',
      ].join(' && '),
    );
  }, 120_000);

  afterAll(() => {
    for (const v of [SRC, DST])
      try {
        docker('volume', 'rm', '-f', v);
      } catch {
        // gone already
      }
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('saves a volume into the folder, lists it, and leaves no half-written file', async () => {
    const r = await imports.exportVolume(SRC, NAME);
    expect(r.sizeBytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(statSync(join(folder, NAME)).size).toBe(r.sizeBytes);
    expect(readdirSync(folder).filter((n) => n.endsWith('.part'))).toEqual([]);
    const l = await imports.list();
    expect(l.dir).toBe(folder);
    expect(l.files.map((f) => f.name)).toEqual([NAME]);
    expect(l.files[0]).toMatchObject({ sizeBytes: r.sizeBytes, gzip: true });
    expect(l.freeBytes).toBeGreaterThan(0);
    // an existing name is never overwritten
    await expect(imports.exportVolume(SRC, NAME)).rejects.toThrow(/already/);
    expect(statSync(join(folder, NAME)).size).toBe(r.sizeBytes);
    expect(helpers()).toBe('');
  }, 180_000);

  it('restores it into an empty volume exactly: names, content, modes, owners and links', async () => {
    const r = await restore(DST, RESTORE_FROM_SCRIPT, NAME);
    expect(r.exitCode).toBe(0);
    expect(tree(DST)).toBe(tree(SRC));
    expect(tree(DST)).toMatch(/private\.key file 600 999:999/);
    expect(tree(DST)).toMatch(/\.\/pgdata dir 700 999:999/);
    expect(helpers()).toBe('');
  }, 180_000);

  it('replace empties the volume first and leaves exactly the archive', async () => {
    docker(
      'run',
      '--rm',
      '-v',
      `${DST}:/data`,
      IMAGE,
      'sh',
      '-c',
      'echo old > /data/old.txt && mkdir -p /data/olddir && echo x > /data/olddir/y',
    );
    expect(tree(DST)).toContain('./old.txt');
    const r = await restore(DST, REPLACE_FROM_SCRIPT, NAME);
    expect(r.exitCode).toBe(0);
    expect(tree(DST)).not.toContain('old.txt');
    expect(tree(DST)).not.toContain('olddir');
    expect(tree(DST)).toBe(tree(SRC));
  }, 180_000);

  it('does not list a link or a folder named like an archive, and marks a file that is not gzip', async () => {
    symlinkSync('/etc/hostname', join(folder, 'link.tar.gz'));
    mkdirSync(join(folder, 'dir.tar.gz'));
    writeFileSync(join(folder, 'plain.tar.gz'), 'this is not gzip');
    writeFileSync(join(folder, 'note.txt'), 'hello');
    writeFileSync(join(folder, '.hidden.tar.gz'), 'x');
    const l = await imports.list();
    expect(l.files.map((f) => f.name).sort()).toEqual(['plain.tar.gz', NAME]);
    expect(l.files.find((f) => f.name === 'plain.tar.gz')?.gzip).toBe(false);
    // and asking for them by name is a 404 (not in the listing), never a read
    await expect(imports.find('link.tar.gz')).rejects.toThrow(/no file/);
    await expect(imports.find('dir.tar.gz')).rejects.toThrow(/no file/);
  }, 120_000);

  it('refuses names that are paths, in the API and again inside the helper script', async () => {
    for (const bad of ['../x.tar.gz', '/etc/hostname', 'a/b.tar.gz'])
      await expect(imports.find(bad)).rejects.toThrow(ValidationError);
    // the script alone, handed a path: refused with exit 3 before anything is read or changed
    const before = tree(DST);
    for (const bad of ['../../etc/hostname', '/etc/hostname', '.hidden', ''])
      for (const script of [RESTORE_FROM_SCRIPT, REPLACE_FROM_SCRIPT]) {
        const r = await restore(DST, script, bad);
        expect(r.exitCode).toBe(3);
      }
    expect(tree(DST)).toBe(before);
  }, 120_000);

  it('a file that is not gzip is refused and leaves the volume as it was, even when replacing', async () => {
    const before = tree(DST);
    for (const script of [RESTORE_FROM_SCRIPT, REPLACE_FROM_SCRIPT]) {
      const r = await restore(DST, script, 'plain.tar.gz');
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/not a gzip archive/);
    }
    // a link is not a file either, whatever it points to
    const l = await restore(DST, REPLACE_FROM_SCRIPT, 'link.tar.gz');
    expect(l.exitCode).toBe(3);
    expect(tree(DST)).toBe(before);
  }, 120_000);

  it('mounts the folder read-only for a restore: the helper cannot change it', async () => {
    const r = await imports.run(
      {
        entrypoint: ['sh'],
        command: ['-c', 'touch /imports/new 2>&1; echo exit=$?'],
        mounts: [imports.mount(true)],
      },
      'try to write',
    );
    expect(r.stdout).toMatch(/Read-only file system/);
    expect(existsSync(join(folder, 'new'))).toBe(false);
  }, 60_000);

  it('removes only a plain file, after the name is confirmed', async () => {
    await expect(imports.remove('plain.tar.gz', 'other')).rejects.toThrow(
      ValidationError,
    );
    await imports.remove('plain.tar.gz', 'plain.tar.gz');
    expect(existsSync(join(folder, 'plain.tar.gz'))).toBe(false);
    // the target of the link was never touched, and the link is not removable through the API
    await expect(imports.remove('link.tar.gz', 'link.tar.gz')).rejects.toThrow(
      /no file/,
    );
    expect(lstatSync(join(folder, 'link.tar.gz')).isSymbolicLink()).toBe(true);
    expect(helpers()).toBe('');
  }, 120_000);

  it('a copy that fails half way is not kept: not the final file, not the hidden one, and it is not called complete', () => {
    // the folder is a 100 KB memory disk, so tar runs out of room while writing a 30 MB volume. busybox's tar says exit 1
    // for that, which on its own would look like "some files changed": the script has to notice the cut-short archive.
    const out = docker(
      'run',
      '--rm',
      '-v',
      `${SRC}:/data:ro`,
      '-e',
      `S=${EXPORT_SCRIPT}`,
      '--mount',
      'type=tmpfs,destination=/imports,tmpfs-size=100k',
      IMAGE,
      'sh',
      '-c',
      'sh -c "$S" sh failing.tar.gz 2>/dev/null; echo "rc=$?"; echo "left:[$(ls -A /imports)]"',
    );
    expect(out).toMatch(/rc=8/);
    expect(out).toMatch(/left:\[\]/);
  }, 120_000);
});
