import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import { stamp, VolumeDownloadService } from './volume-download.service';

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'files', persistent: true });
  await s.apps.update('files', {
    volumes: [
      { containerPath: '/data', volumeName: 'data' },
      { containerPath: '/in', hostPath: '/srv/in', readOnly: true },
    ],
  });
  await s.apps.deploy('files', 'x/y:1');
  s.docker.volumes.set('pvx-files-data', {});
  const dl = new VolumeDownloadService(s.apps, s.docker, s.cfg);
  dl.pollMs = 1;
  dl.waitMs = 30;
  return { ...s, dl };
}

const read = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

describe('VolumeDownloadService: which volume may be asked for', () => {
  it('finds a named volume of the app by the name the app gives it', async () => {
    const s = await setup();
    expect(s.dl.resolve('files', 'data').dockerName).toBe('pvx-files-data');
  });

  it('refuses a volume the app does not have, including one that exists in Docker', async () => {
    const s = await setup();
    s.docker.volumes.set('pvx-other-data', {});
    expect(() => s.dl.resolve('files', 'nope')).toThrow(NotFoundError);
    // a Docker name is not a volume name of the app, and neither is another app's
    expect(() => s.dl.resolve('files', 'pvx-other-data')).toThrow(
      NotFoundError,
    );
    expect(() => s.dl.resolve('files', '../../etc')).toThrow(NotFoundError);
    expect(() => s.dl.resolve('ghost', 'data')).toThrow(NotFoundError);
  });

  it("never reaches another app's volume through this app", async () => {
    const s = await setup();
    await s.apps.create({ name: 'other', persistent: true });
    await s.apps.update('other', {
      volumes: [{ containerPath: '/d', volumeName: 'secret' }],
    });
    expect(() => s.dl.resolve('files', 'secret')).toThrow(NotFoundError);
  });

  it('says a directory of the server is not a volume, whichever way it is named', async () => {
    const s = await setup();
    for (const asked of ['/in', '/srv/in'])
      expect(() => s.dl.resolve('files', asked)).toThrow(ValidationError);
    expect(() => s.dl.resolve('files', '/in')).toThrow(
      /directory of the server/,
    );
  });

  it('uses the Docker name a volume keeps after a rename', async () => {
    const s = await setup();
    await s.apps.mutate('files', async (cur) => ({
      ...cur,
      volumes: cur.volumes.map((v) =>
        v.volumeName ? { ...v, dockerName: 'pvx-old-data' } : v,
      ),
    }));
    expect(s.dl.resolve('files', 'data').dockerName).toBe('pvx-old-data');
  });

  it('uses the project volume for a service of a project', async () => {
    const s = await setup();
    await s.projects.deploy('shop', {
      compose:
        'services:\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata:\n',
      variables: {},
    });
    const r = s.dl.resolve('shop-db', 'pgdata');
    expect(r.dockerName).toBe('pvx-shop-pgdata');
  });
});

describe('VolumeDownloadService: the copy', () => {
  it('streams what the helper writes, from a read-only mount with a name for the file', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.from('0123456789abcdef');
    const d = await s.dl.open(
      'files',
      'data',
      {},
      new Date('2026-01-02T03:04:05Z'),
    );
    expect(d.filename).toBe('files-data-20260102-030405.tar.gz');
    expect((await read(d.stream)).toString()).toBe('0123456789abcdef');
    expect(await d.finished).toEqual({ ok: true, detail: '' });
    const run = s.docker.streamRuns[0];
    expect(run.mounts).toEqual([
      { volume: 'pvx-files-data', target: '/data', readOnly: true },
    ]);
    expect(run.entrypoint).toEqual(['tar']);
    expect(d.stopped).toBe(false);
  });

  it('leaves a running app alone by default', async () => {
    const s = await setup();
    const d = await s.dl.open('files', 'data');
    await read(d.stream);
    await d.finished;
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('says why when the copy fails before any data, instead of an empty download', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.alloc(0);
    s.docker.streamExit = 2;
    s.docker.streamStderr = 'tar: /data: Cannot open';
    await expect(s.dl.open('files', 'data')).rejects.toThrow(
      /Nothing could be read.*Cannot open/s,
    );
  });

  it('reports a copy that died half way as incomplete, and one that only skipped files as complete', async () => {
    const s = await setup();
    s.docker.streamExit = 137;
    const dead = await s.dl.open('files', 'data');
    await read(dead.stream);
    expect((await dead.finished).ok).toBe(false);

    s.docker.streamExit = 1;
    s.docker.streamStderr = 'tar: x: file changed as we read it';
    const skipped = await s.dl.open('files', 'data');
    await read(skipped.stream);
    const r = await skipped.finished;
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/left out/);
  });

  it('stops the helper when the reader goes away', async () => {
    const s = await setup();
    s.docker.streamHold = true;
    const d = await s.dl.open('files', 'data');
    await d.abort();
    await d.abort();
    expect(s.docker.streamAborts).toBe(1);
    expect((await d.finished).ok).toBe(false);
  });

  it('refuses a volume that was never created', async () => {
    const s = await setup();
    s.docker.volumes.delete('pvx-files-data');
    await expect(s.dl.open('files', 'data')).rejects.toThrow(ConflictError);
  });

  it('says which machine holds the data when it is not this one', async () => {
    const s = await setup();
    s.docker.nodes = [
      { id: 'n1', hostname: 'here' },
      { id: 'n2', hostname: 'elsewhere' },
    ] as never;
    s.docker.taskNodes.set('pvx-files', 'n2');
    await expect(s.dl.open('files', 'data')).rejects.toThrow(
      /on elsewhere.*only read volumes on the machine it runs on/s,
    );
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});

describe('VolumeDownloadService: stopping the app for a consistent copy', () => {
  it('stops the app, copies, and starts it again with the instances it had', async () => {
    const s = await setup();
    const seen: number[] = [];
    const d = await s.dl.open('files', 'data', { stop: true });
    seen.push(s.repo.get('files')?.instanceCount ?? -1);
    expect(d.stopped).toBe(true);
    // the app is stopped while the archive is read
    expect(s.docker.streamRuns).toHaveLength(1);
    await read(d.stream);
    await d.finished;
    expect(seen).toEqual([0]);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts the app again when the client leaves half way', async () => {
    const s = await setup();
    s.docker.streamHold = true;
    const d = await s.dl.open('files', 'data', { stop: true });
    expect(s.repo.get('files')?.instanceCount).toBe(0);
    await d.abort();
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts the app again when the helper cannot be started', async () => {
    const s = await setup();
    s.docker.streamStartError = new Error('no image');
    await expect(s.dl.open('files', 'data', { stop: true })).rejects.toThrow(
      /Could not start the copy: no image/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts the app again, and copies nothing, when it will not stop', async () => {
    const s = await setup();
    s.docker.containerCounts.set('pvx-files', 1);
    await expect(s.dl.open('files', 'data', { stop: true })).rejects.toThrow(
      /did not stop/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('starts the app again when the copy itself fails', async () => {
    const s = await setup();
    s.docker.streamExit = 2;
    const d = await s.dl.open('files', 'data', { stop: true });
    await read(d.stream);
    expect((await d.finished).ok).toBe(false);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('does not touch an app that is already stopped, and leaves it stopped', async () => {
    const s = await setup();
    await s.apps.update('files', { instanceCount: 0 });
    const d = await s.dl.open('files', 'data', { stop: true });
    expect(d.stopped).toBe(false);
    await read(d.stream);
    await d.finished;
    expect(s.repo.get('files')?.instanceCount).toBe(0);
  });

  it('refuses to stop an app a hub manages', async () => {
    const s = await setup();
    await s.apps.mutate('files', async (cur) => ({ ...cur, blueprint: true }));
    await expect(s.dl.open('files', 'data', { stop: true })).rejects.toThrow(
      /hub/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    // without stopping it is fine
    const d = await s.dl.open('files', 'data');
    await read(d.stream);
    await d.finished;
  });
});

describe('stamp', () => {
  it('is UTC, sortable and safe in a file name', () => {
    expect(stamp(new Date('2026-11-02T21:05:09.123Z'))).toBe('20261102-210509');
  });
});
