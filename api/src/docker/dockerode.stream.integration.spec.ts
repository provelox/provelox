import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../config/config';
import { DockerodeAdapter } from './dockerode.adapter';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1 (it pulls and starts containers), so the normal test run
 * never needs Docker. Uses a throwaway volume, removed at the end.
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const IMAGE = process.env.DOCKER_INTEGRATION_IMAGE ?? 'busybox:latest';
const VOLUME = `pvx-itest-${process.pid}`;
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' });

run('DockerodeAdapter.streamHelper (real Docker)', () => {
  const adapter = new DockerodeAdapter(
    loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), 'pvx-dl-'));
  const spec = (volume = VOLUME, command?: string[]) => ({
    image: IMAGE,
    entrypoint: ['tar'],
    command: command ?? ['-c', '-z', '-f', '-', '-C', '/data', '.'],
    mounts: [{ volume, target: '/data', readOnly: true }],
  });
  const helpers = () =>
    docker(
      'ps',
      '-a',
      '--filter',
      'label=io.provelox.helper=download',
      '-q',
    ).trim();

  beforeAll(() => {
    docker('volume', 'create', VOLUME);
    // a private file owned by another user, a nested tree, a link, and 30 MB that gzip cannot shrink
    docker(
      'run',
      '--rm',
      '-v',
      `${VOLUME}:/data`,
      IMAGE,
      'sh',
      '-c',
      [
        'mkdir -p /data/a/b',
        'echo hello > /data/a/b/c.txt',
        'echo secret > /data/private.key',
        'chown 999:999 /data/private.key',
        'chmod 600 /data/private.key',
        'ln -s a/b/c.txt /data/link',
        'dd if=/dev/urandom of=/data/big.bin bs=1M count=30 2>/dev/null',
      ].join(' && '),
    );
  }, 120_000);

  afterAll(() => {
    try {
      docker('volume', 'rm', '-f', VOLUME);
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams a complete, valid archive, including files only root can read', async () => {
    const h = await adapter.streamHelper(spec());
    const file = join(dir, 'out.tar.gz');
    await pipeline(h.stdout, createWriteStream(file));
    const r = await h.done;
    expect(r).toEqual({ exitCode: 0, stderr: '' });
    const listing = execFileSync('tar', ['-tzvf', file], { encoding: 'utf8' });
    expect(listing).toMatch(/private\.key/);
    expect(listing).toMatch(/a\/b\/c\.txt/);
    expect(listing).toMatch(/link/);
    // extracted, the big file matches byte for byte what is in the volume
    const out = join(dir, 'x');
    execFileSync('mkdir', [out]);
    execFileSync('tar', ['-xzf', file, '-C', out, '--no-same-owner']);
    const inVolume = docker(
      'run',
      '--rm',
      '-v',
      `${VOLUME}:/data:ro`,
      IMAGE,
      'sha256sum',
      '/data/big.bin',
    ).split(' ')[0];
    expect(
      createHash('sha256')
        .update(readFileSync(join(out, 'big.bin')))
        .digest('hex'),
    ).toBe(inVolume);
    expect(readFileSync(join(out, 'a/b/c.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(out, 'private.key'), 'utf8')).toBe('secret\n');
    expect(helpers()).toBe('');
  }, 120_000);

  it('mounts read-only: the helper cannot change the volume', async () => {
    const h = await adapter.streamHelper({
      ...spec(),
      entrypoint: ['sh'],
      command: ['-c', 'touch /data/new 2>&1; echo exit=$?'],
    });
    const chunks: Buffer[] = [];
    for await (const c of h.stdout) chunks.push(c as Buffer);
    await h.done;
    expect(Buffer.concat(chunks).toString()).toMatch(/Read-only file system/);
    const files = docker(
      'run',
      '--rm',
      '-v',
      `${VOLUME}:/data:ro`,
      IMAGE,
      'ls',
      '/data',
    );
    expect(files).not.toMatch(/\bnew\b/);
  }, 60_000);

  it('has no network and no way to write anywhere else', async () => {
    const h = await adapter.streamHelper({
      ...spec(),
      entrypoint: ['sh'],
      command: [
        '-c',
        'ls /sys/class/net | tr "\\n" " "; touch /x 2>&1 | head -1',
      ],
    });
    const chunks: Buffer[] = [];
    for await (const c of h.stdout) chunks.push(c as Buffer);
    await h.done;
    const text = Buffer.concat(chunks).toString();
    // no network card to reach anything with (only the loopback and the kernel's unused tunnel placeholders)
    expect(text).not.toMatch(/eth\d/);
    expect(text).toMatch(/\blo\b/);
    expect(text).toMatch(/Read-only file system/);
  }, 60_000);

  it('reports tar failing, with what it said', async () => {
    const h = await adapter.streamHelper(
      spec(VOLUME, ['-c', '-z', '-f', '-', '-C', '/nope', '.']),
    );
    for await (const _ of h.stdout) {
      // nothing is expected
    }
    const r = await h.done;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/nope/);
    expect(helpers()).toBe('');
  }, 60_000);

  it('stops and cleans up when the reader goes away', async () => {
    const h = await adapter.streamHelper(spec());
    let got = 0;
    for await (const c of h.stdout) {
      got += (c as Buffer).length;
      if (got > 1_000_000) break;
    }
    await h.abort();
    await h.abort();
    const r = await h.done;
    expect(r.exitCode).not.toBe(0);
    expect(helpers()).toBe('');
  }, 60_000);

  it('does not read faster than the reader takes it', async () => {
    const h = await adapter.streamHelper(spec());
    // read nothing for a moment: the helper must be held back by the full pipe, not buffered in the API
    await new Promise((r) => setTimeout(r, 2000));
    expect(h.stdout.readableLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    await h.abort();
    await h.done;
  }, 60_000);

  it('leaves nothing behind in Docker', () => {
    const left = spawnSync('docker', [
      'ps',
      '-a',
      '--filter',
      'label=io.provelox.helper=download',
      '-q',
    ])
      .stdout.toString()
      .trim();
    expect(left).toBe('');
  });
});
