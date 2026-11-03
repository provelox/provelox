import { PassThrough, Readable } from 'node:stream';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import { VolumeDownloadService } from './volume-download.service';
import {
  EMPTY_THEN_EXTRACT,
  EXTRACT,
  RESTORE_CAPABILITIES,
  VolumeRestoreService,
} from './volume-restore.service';

/** gzip's first two bytes, then whatever follows */
const gz = (rest = 'archive-bytes') =>
  Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from(rest)]);
const upload = (b: Buffer, chunk = 4) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < b.length; i += chunk) yield b.subarray(i, i + chunk);
    })(),
  );

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
  // an empty volume: what `ls` prints is nothing
  s.docker.streamBytes = Buffer.alloc(0);
  const dl = new VolumeDownloadService(s.apps, s.docker, s.cfg);
  const rs = new VolumeRestoreService(dl, s.apps, s.docker, s.cfg);
  rs.pollMs = 1;
  rs.waitMs = 30;
  return { ...s, rs };
}

describe('VolumeRestoreService: what may be restored where', () => {
  it('refuses a volume the app does not have, and a directory of the server', async () => {
    const s = await setup();
    await expect(s.rs.restore('files', 'nope', upload(gz()))).rejects.toThrow(
      NotFoundError,
    );
    await expect(s.rs.restore('ghost', 'data', upload(gz()))).rejects.toThrow(
      NotFoundError,
    );
    await expect(s.rs.restore('files', '/in', upload(gz()))).rejects.toThrow(
      /directory of the server/,
    );
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('refuses a volume that was never created, and one on another machine', async () => {
    const s = await setup();
    s.docker.volumes.delete('pvx-files-data');
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      ConflictError,
    );
    s.docker.volumes.set('pvx-files-data', {});
    s.docker.nodes = [
      { id: 'n1', hostname: 'here' },
      { id: 'n2', hostname: 'elsewhere' },
    ] as never;
    s.docker.taskNodes.set('pvx-files', 'n2');
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /on elsewhere.*only write volumes on the machine it runs on/s,
    );
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('refuses an app a hub manages, and one that runs several instances', async () => {
    const s = await setup();
    await s.apps.mutate('files', async (cur) => ({ ...cur, blueprint: true }));
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /hub/,
    );
    await s.apps.mutate('files', async (cur) => ({
      ...cur,
      blueprint: false,
      instanceCount: 3,
    }));
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /3 instances/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(3);
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});

describe('VolumeRestoreService: replacing needs confirming', () => {
  it('refuses replace without the app name, or with another, before touching anything', async () => {
    const s = await setup();
    for (const confirm of [undefined, '', 'other', 'FILES'])
      await expect(
        s.rs.restore('files', 'data', upload(gz()), { replace: true, confirm }),
      ).rejects.toThrow(ValidationError);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('does not need the name when it is not replacing', async () => {
    const s = await setup();
    await expect(
      s.rs.restore('files', 'data', upload(gz())),
    ).resolves.toMatchObject({ restored: true, replaced: false });
  });
});

describe('VolumeRestoreService: what is uploaded', () => {
  it.each([
    ['plain text', Buffer.from('hello, not an archive')],
    ['a zip file', Buffer.from('PK\x03\x04rest')],
    ['nothing', Buffer.alloc(0)],
  ])(
    'rejects %s with 400 before anything is written or stopped',
    async (_n, body) => {
      const s = await setup();
      await expect(s.rs.restore('files', 'data', upload(body))).rejects.toThrow(
        /not a \.tar\.gz/,
      );
      expect(s.docker.streamRuns).toHaveLength(0);
      expect(s.repo.get('files')?.instanceCount).toBe(1);
      expect(s.apps.isBlocked('files')).toBe(false);
    },
  );

  it('rejects a replace of non-gzip too, so the volume is not emptied for nothing', async () => {
    const s = await setup();
    await expect(
      s.rs.restore('files', 'data', upload(Buffer.from('nope')), {
        replace: true,
        confirm: 'files',
      }),
    ).rejects.toThrow(ValidationError);
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});

describe('VolumeRestoreService: into an empty volume', () => {
  it('hands the whole archive to a helper that can write only that volume', async () => {
    const s = await setup();
    const body = gz('x'.repeat(1000));
    const r = await s.rs.restore('files', 'data', upload(body, 7));
    expect(r).toEqual({
      restored: true,
      bytes: body.length,
      replaced: false,
      stopped: true,
    });
    // first it looked (read-only), then it wrote
    expect(s.docker.streamRuns).toHaveLength(2);
    const [look, write] = s.docker.streamRuns;
    expect(look.entrypoint).toEqual(['ls']);
    expect(look.mounts).toEqual([
      { volume: 'pvx-files-data', target: '/data', readOnly: true },
    ]);
    expect(write).toMatchObject({
      kind: 'restore',
      entrypoint: ['tar'],
      command: EXTRACT.slice(1),
      capabilities: RESTORE_CAPABILITIES,
      mounts: [{ volume: 'pvx-files-data', target: '/data', readOnly: false }],
    });
    expect(Buffer.concat(s.docker.streamReceived).equals(body)).toBe(true);
  });

  it('refuses a volume that already has something in it, and says how to replace it, without stopping the app', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.from('old.txt\n');
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /not empty.*replace/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.docker.streamRuns).toHaveLength(1);
  });

  it('stops the app while data is written, and starts it again with the instances it had', async () => {
    const s = await setup();
    const seen: number[] = [];
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      if (spec.kind === 'restore') {
        seen.push(s.repo.get('files')?.instanceCount ?? -1);
        expect(s.apps.isBlocked('files')).toBe(true);
      }
      return real(spec);
    };
    await s.rs.restore('files', 'data', upload(gz()));
    expect(seen).toEqual([0]);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('leaves an app that was already stopped stopped', async () => {
    const s = await setup();
    await s.apps.update('files', { instanceCount: 0 });
    const r = await s.rs.restore('files', 'data', upload(gz()));
    expect(r.stopped).toBe(false);
    expect(s.repo.get('files')?.instanceCount).toBe(0);
  });
});

describe('VolumeRestoreService: replacing', () => {
  it('empties the volume and extracts in one helper, without looking first', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.from('old.txt\n');
    const r = await s.rs.restore('files', 'data', upload(gz()), {
      replace: true,
      confirm: 'files',
    });
    expect(r.replaced).toBe(true);
    expect(s.docker.streamRuns).toHaveLength(1);
    expect(s.docker.streamRuns[0]).toMatchObject({
      kind: 'restore',
      entrypoint: ['sh'],
      command: ['-c', EMPTY_THEN_EXTRACT],
    });
    // fixed text: nothing of the request is part of the command
    expect(EMPTY_THEN_EXTRACT).not.toMatch(/\$|`|;/);
  });
});

describe('VolumeRestoreService: when it goes wrong, the app is started again', () => {
  it('says what tar said, and that the volume may be partly written', async () => {
    const s = await setup();
    s.docker.streamExit = 2;
    s.docker.streamStderr = 'tar: invalid magic';
    // the helper that looks at the volume succeeds, the one that writes fails
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      s.docker.streamExit = spec.kind === 'restore' ? 2 : 0;
      return real(spec);
    };
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /exit code 2.*invalid magic.*partly written/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('says the volume was emptied first when a replace fails', async () => {
    const s = await setup();
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      s.docker.streamExit = 2;
      return real(spec);
    };
    await expect(
      s.rs.restore('files', 'data', upload(gz()), {
        replace: true,
        confirm: 'files',
      }),
    ).rejects.toThrow(/emptied first.*restore a copy of it again/s);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('starts the app again when the helper cannot be started', async () => {
    const s = await setup();
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      if (spec.kind === 'restore') throw new Error('no image');
      return real(spec);
    };
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /Could not start the restore: no image/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts the app again, and writes nothing, when it will not stop', async () => {
    const s = await setup();
    s.docker.containerCounts.set('pvx-files', 1);
    await expect(s.rs.restore('files', 'data', upload(gz()))).rejects.toThrow(
      /did not stop/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
    expect(s.docker.streamRuns.map((r) => r.kind)).not.toContain('restore');
  });

  it('stops tar and starts the app again when the sender goes away half way', async () => {
    const s = await setup();
    const body = new PassThrough();
    body.write(gz('first part'));
    const pending = s.rs.restore('files', 'data', body);
    // the connection drops before the end of the archive
    await new Promise((r) => setTimeout(r, 30));
    expect(s.repo.get('files')?.instanceCount).toBe(0);
    body.destroy();
    await expect(pending).rejects.toThrow(/stopped before the end/);
    expect(s.docker.streamAborts).toBe(1);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('says a replace that was cut short left the volume emptied and partly written', async () => {
    const s = await setup();
    const body = new PassThrough();
    body.write(gz('first part'));
    const pending = s.rs.restore('files', 'data', body, {
      replace: true,
      confirm: 'files',
    });
    await new Promise((r) => setTimeout(r, 30));
    body.destroy();
    await expect(pending).rejects.toThrow(/emptied first.*partly written/s);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });
});
