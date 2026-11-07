import { execFileSync } from 'node:child_process';
import { loadConfig } from '../config/config';
import { DockerodeAdapter } from './dockerode.adapter';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1. A helper run from an image that declares a VOLUME
 * (as the Provelox image does for /data) must not leave an anonymous volume behind, whether the helper mounts that
 * path or not. Throwaway image and volumes only.
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const IMAGE = `pvx-itest-volume-${process.pid}:latest`;
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' }).trim();
const anonymousVolumes = () =>
  docker('volume', 'ls', '-q', '-f', 'dangling=true')
    .split('\n')
    .filter((v) => /^[0-9a-f]{64}$/.test(v));

run('helpers do not leave anonymous volumes (real Docker)', () => {
  const adapter = new DockerodeAdapter(
    loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
  );

  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-'], {
      input: 'FROM busybox:latest\nVOLUME /data\n',
      encoding: 'utf8',
    });
  });

  afterAll(() => {
    try {
      docker('rmi', '-f', IMAGE);
    } catch {
      // already gone
    }
  });

  it('runHelper that mounts nothing creates and keeps no volume', async () => {
    const before = anonymousVolumes().length;
    const r = await adapter.runHelper({
      image: IMAGE,
      command: ['sh', '-c', 'echo ok'],
      mounts: [],
    });
    expect(r.exitCode).toBe(0);
    expect(anonymousVolumes().length).toBe(before);
  });

  it('runHelper repeated: still no growth', async () => {
    const before = anonymousVolumes().length;
    for (let i = 0; i < 3; i++)
      await adapter.runHelper({
        image: IMAGE,
        command: ['sh', '-c', 'echo ok'],
        mounts: [],
      });
    expect(anonymousVolumes().length).toBe(before);
  });

  it('a helper that mounts its own /data uses that volume, not an anonymous one', async () => {
    const named = `pvx-itest-named-${process.pid}`;
    docker('volume', 'create', named);
    try {
      const before = anonymousVolumes().length;
      const r = await adapter.runHelper({
        image: IMAGE,
        command: ['sh', '-c', 'echo hi > /data/f && cat /data/f'],
        mounts: [{ volume: named, target: '/data', readOnly: false }],
      });
      expect(r.exitCode).toBe(0);
      expect(r.output.trim()).toBe('hi');
      expect(anonymousVolumes().length).toBe(before);
    } finally {
      docker('volume', 'rm', '-f', named);
    }
  });
});
