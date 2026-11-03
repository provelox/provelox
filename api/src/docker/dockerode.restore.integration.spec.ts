import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EMPTY_THEN_EXTRACT,
  EXTRACT,
  RESTORE_CAPABILITIES,
} from '../apps/volume-restore.service';
import { loadConfig } from '../config/config';
import { DockerodeAdapter } from './dockerode.adapter';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1 (it pulls and starts containers). Takes a volume's
 * archive through the download helper and puts it into another volume through the restore helper, then compares the two.
 * Throwaway volumes only, removed at the end.
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const IMAGE = process.env.DOCKER_INTEGRATION_IMAGE ?? 'busybox:latest';
const SRC = `pvx-itest-src-${process.pid}`;
const DST = `pvx-itest-dst-${process.pid}`;
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

run('DockerodeAdapter.streamHelper with input: a restore (real Docker)', () => {
  const adapter = new DockerodeAdapter(
    loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), 'pvx-rs-'));
  const archive = join(dir, 'src.tar.gz');
  const download = (volume: string) => ({
    image: IMAGE,
    entrypoint: ['tar'],
    command: ['-c', '-z', '-f', '-', '-C', '/data', '.'],
    mounts: [{ volume, target: '/data', readOnly: true }],
  });
  const restoreSpec = (
    input: NodeJS.ReadableStream,
    replace = false,
    volume = DST,
  ) => ({
    image: IMAGE,
    kind: 'restore' as const,
    entrypoint: replace ? ['sh'] : [EXTRACT[0]],
    command: replace ? ['-c', EMPTY_THEN_EXTRACT] : EXTRACT.slice(1),
    mounts: [{ volume, target: '/data', readOnly: false }],
    capabilities: RESTORE_CAPABILITIES,
    input: input as import('node:stream').Readable,
  });
  const restoreHelpers = () =>
    docker(
      'ps',
      '-a',
      '--filter',
      'label=io.provelox.helper=restore',
      '-q',
    ).trim();
  const restoreInto = async (spec: ReturnType<typeof restoreSpec>) => {
    const h = await adapter.streamHelper(spec);
    h.stdout.resume();
    return h.done;
  };

  beforeAll(async () => {
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
    const h = await adapter.streamHelper(download(SRC));
    await pipeline(h.stdout, createWriteStream(archive));
    expect((await h.done).exitCode).toBe(0);
  }, 180_000);

  afterAll(() => {
    for (const v of [SRC, DST])
      try {
        docker('volume', 'rm', '-f', v);
      } catch {
        // gone already
      }
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores into an empty volume exactly: names, content, modes, owners and links', async () => {
    const r = await restoreInto(restoreSpec(createReadStream(archive)));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const a = tree(SRC);
    const b = tree(DST);
    expect(a).toContain('private.key file 600 999:999');
    expect(a).toContain('./pgdata dir 700 999:999');
    expect(b).toBe(a);
    expect(restoreHelpers()).toBe('');
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
      'echo old > /data/old.txt && mkdir -p /data/oldir && echo x > /data/oldir/.hidden',
    );
    expect(tree(DST)).toContain('./old.txt');
    const r = await restoreInto(restoreSpec(createReadStream(archive), true));
    expect(r.exitCode).toBe(0);
    const b = tree(DST);
    expect(b).not.toContain('old.txt');
    expect(b).not.toContain('.hidden');
    expect(b).toBe(tree(SRC));
  }, 180_000);

  it('rejects an upload that is not gzip and leaves the volume as it was', async () => {
    const before = tree(DST);
    const junk = join(dir, 'junk.bin');
    writeFileSync(junk, 'this is not an archive at all\n'.repeat(500));
    const r = await restoreInto(restoreSpec(createReadStream(junk)));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(tree(DST)).toBe(before);
    expect(restoreHelpers()).toBe('');
  }, 120_000);

  it('cleans up the container when the upload is abandoned half way', async () => {
    const input = new PassThrough();
    // the first 64 KB of a real archive, and then nothing: the sender has gone quiet
    input.write(readFileSync(archive).subarray(0, 65536));
    const h = await adapter.streamHelper(restoreSpec(input));
    h.stdout.resume();
    await new Promise((r) => setTimeout(r, 800));
    expect(restoreHelpers()).not.toBe('');
    await h.abort();
    const r = await h.done;
    expect(r.exitCode).not.toBe(0);
    expect(restoreHelpers()).toBe('');
  }, 120_000);

  it('can write only into the volume: no network and a read-only system', async () => {
    const out = docker(
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      ...RESTORE_CAPABILITIES.flatMap((c) => ['--cap-add', c]),
      '-v',
      `${DST}:/data`,
      IMAGE,
      'sh',
      '-c',
      'touch /etc/x 2>&1; ls /sys/class/net | tr "\\n" " "',
    );
    expect(out).toMatch(/Read-only file system/);
  }, 60_000);
});
