import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import {
  EXPORT_SCRIPT,
  REPLACE_FROM_SCRIPT,
  RESTORE_FROM_SCRIPT,
} from '../imports/imports';
import { ImportsService } from '../imports/imports.service';
import { makeStack } from '../test-utils';
import { VolumeDownloadService } from './volume-download.service';
import { VolumeImportService } from './volume-import.service';
import { RESTORE_CAPABILITIES } from './volume-restore.service';

const F = (name: string, size = 100, gz = 1) =>
  `F\t${name}\t${size}\t1700000000\t${gz}`;
/** What the helpers print, in the order they run: prepare the folder, list it, look in the volume, then do the work */
const plan = (
  opts: {
    files?: string[];
    free?: number;
    volume?: string;
    work?: { bytes?: string; exit?: number; stderr?: string };
  },
  /** The folder is prepared once per service: only the first plan has that step */
  prepare = true,
) => [
  ...(prepare ? [{ bytes: '' }] : []),
  { bytes: `${(opts.files ?? []).join('\n')}\nD\t${opts.free ?? 1_000_000}\n` },
  { bytes: opts.volume ?? '' },
  opts.work ?? {},
];

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
  const imports = new ImportsService(s.docker, s.cfg);
  const vi = new VolumeImportService(dl, imports, s.apps, s.docker, s.cfg);
  vi.pollMs = 1;
  vi.waitMs = 30;
  return { ...s, vi };
}

describe('VolumeImportService.restoreFrom: what may be restored from where', () => {
  it('refuses a volume the app does not have, a server directory, and a bad file name, before any helper runs', async () => {
    const s = await setup();
    await expect(s.vi.restoreFrom('files', 'nope', 'a.tar.gz')).rejects.toThrow(
      NotFoundError,
    );
    await expect(s.vi.restoreFrom('ghost', 'data', 'a.tar.gz')).rejects.toThrow(
      NotFoundError,
    );
    await expect(s.vi.restoreFrom('files', '/in', 'a.tar.gz')).rejects.toThrow(
      /directory of the server/,
    );
    for (const bad of [
      '../etc/passwd',
      '/etc/passwd',
      'a/b.tar.gz',
      'a.zip',
      '..tar.gz',
      '',
      undefined,
      // a database dump is never unpacked into a volume, even when it is in the folder
      'db-1.dump',
      'export.sql',
      'export.sql.gz',
    ])
      await expect(s.vi.restoreFrom('files', 'data', bad)).rejects.toThrow(
        ValidationError,
      );
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('refuses a file the folder does not hold (404), one that is not gzip (400), and one that cannot fit (409), without stopping the app', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [] });
    await expect(
      s.vi.restoreFrom('files', 'data', 'missing.tar.gz'),
    ).rejects.toThrow(NotFoundError);

    s.docker.streamPlan = plan({ files: [F('plain.tar.gz', 10, 0)] }, false);
    await expect(
      s.vi.restoreFrom('files', 'data', 'plain.tar.gz'),
    ).rejects.toThrow(/not a gzip archive/);

    s.docker.streamPlan = plan(
      { files: [F('big.tar.gz', 5000)], free: 1 },
      false,
    );
    await expect(
      s.vi.restoreFrom('files', 'data', 'big.tar.gz'),
    ).rejects.toThrow(/less free space/);

    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
    // none of them reached a helper that writes
    expect(s.docker.streamRuns.every((r) => r.kind === 'import')).toBe(true);
    expect(
      s.docker.streamRuns.some((r) =>
        r.mounts.some((m) => !m.readOnly && m.target === '/data'),
      ),
    ).toBe(false);
  });

  it('refuses a volume that was never created, one on another machine, a hub-managed app and several instances', async () => {
    const s = await setup();
    s.docker.volumes.delete('pvx-files-data');
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      ConflictError,
    );
    s.docker.volumes.set('pvx-files-data', {});
    s.docker.nodes = [
      { id: 'n1', hostname: 'here' },
      { id: 'n2', hostname: 'elsewhere' },
    ] as never;
    s.docker.taskNodes.set('pvx-files', 'n2');
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /elsewhere/,
    );
    s.docker.taskNodes.set('pvx-files', 'n1');
    await s.apps.mutate('files', async (cur) => ({ ...cur, blueprint: true }));
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /hub/,
    );
    await s.apps.mutate('files', async (cur) => ({
      ...cur,
      blueprint: false,
      instanceCount: 3,
    }));
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /3 instances/,
    );
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('refuses replace without the app name, or with another, before touching anything', async () => {
    const s = await setup();
    for (const confirm of [undefined, '', 'other', 'FILES'])
      await expect(
        s.vi.restoreFrom('files', 'data', 'a.tar.gz', {
          replace: true,
          confirm,
        }),
      ).rejects.toThrow(ValidationError);
    expect(s.docker.streamRuns).toHaveLength(0);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });
});

describe('VolumeImportService.restoreFrom: into an empty volume', () => {
  it('extracts the named file with a fixed program that gets the name as an argument, and writes only that volume', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [F('shop.tar.gz', 1234)] });
    const r = await s.vi.restoreFrom('files', 'data', 'shop.tar.gz');
    expect(r).toEqual({
      restored: true,
      file: 'shop.tar.gz',
      bytes: 1234,
      replaced: false,
      stopped: true,
    });
    const write = s.docker.streamRuns[s.docker.streamRuns.length - 1];
    expect(write).toMatchObject({
      kind: 'import',
      entrypoint: ['sh'],
      command: ['-c', RESTORE_FROM_SCRIPT, 'sh', 'shop.tar.gz'],
      capabilities: RESTORE_CAPABILITIES,
      mounts: [
        { volume: 'pvx-files-data', target: '/data', readOnly: false },
        {
          volume: '/var/lib/provelox/imports',
          target: '/imports',
          readOnly: true,
        },
      ],
    });
    expect(RESTORE_FROM_SCRIPT).not.toContain('-delete');
  });

  it('refuses a volume with something in it, and says how to replace, without stopping the app', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [F('a.tar.gz')], volume: 'old.txt\n' });
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /not empty.*replace/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.docker.streamRuns).toHaveLength(3);
  });

  it('stops the app while data is written and starts it again with the instances it had', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [F('a.tar.gz')] });
    const seen: number[] = [];
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      if (spec.mounts.some((m) => !m.readOnly && m.target === '/data')) {
        seen.push(s.repo.get('files')?.instanceCount ?? -1);
        expect(s.apps.isBlocked('files')).toBe(true);
      }
      return real(spec);
    };
    await s.vi.restoreFrom('files', 'data', 'a.tar.gz');
    expect(seen).toEqual([0]);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('leaves an app that was already stopped stopped', async () => {
    const s = await setup();
    await s.apps.update('files', { instanceCount: 0 });
    s.docker.streamPlan = plan({ files: [F('a.tar.gz')] });
    const r = await s.vi.restoreFrom('files', 'data', 'a.tar.gz');
    expect(r.stopped).toBe(false);
    expect(s.repo.get('files')?.instanceCount).toBe(0);
  });
});

describe('VolumeImportService.restoreFrom: replacing', () => {
  it('empties the volume inside the same helper that extracts, without looking first', async () => {
    const s = await setup();
    // prepare the folder, list it, then the work: no look into the volume
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('a.tar.gz')}\nD\t1000000\n` },
      {},
    ];
    const r = await s.vi.restoreFrom('files', 'data', 'a.tar.gz', {
      replace: true,
      confirm: 'files',
    });
    expect(r.replaced).toBe(true);
    expect(s.docker.streamRuns).toHaveLength(3);
    const write = s.docker.streamRuns[2];
    expect(write.command).toEqual([
      '-c',
      REPLACE_FROM_SCRIPT,
      'sh',
      'a.tar.gz',
    ]);
    expect(REPLACE_FROM_SCRIPT).toContain('find /data -mindepth 1 -delete');
  });
});

describe('VolumeImportService.restoreFrom: when it goes wrong, the app is started again', () => {
  it('says what tar said, and that the volume may be partly written', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({
      files: [F('a.tar.gz')],
      work: { exit: 2, stderr: 'tar: invalid magic' },
    });
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /exit code 2.*invalid magic.*partly written/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('says the volume was emptied first when a replace fails', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('a.tar.gz')}\nD\t1000000\n` },
      { exit: 2, stderr: 'boom' },
    ];
    await expect(
      s.vi.restoreFrom('files', 'data', 'a.tar.gz', {
        replace: true,
        confirm: 'files',
      }),
    ).rejects.toThrow(/emptied first/);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('reports a file that was swapped after it was listed (exit 3) as nothing written', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({
      files: [F('a.tar.gz')],
      work: { exit: 3, stderr: 'that file is not a gzip archive' },
    });
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /changed since it was listed.*nothing was written/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('starts it again when Docker cannot start the helper', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [F('a.tar.gz')] });
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      if (spec.mounts.some((m) => !m.readOnly && m.target === '/data'))
        throw new Error('no such image');
      return real(spec);
    };
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /no such image/,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts it again, and writes nothing, when the app does not stop in time', async () => {
    const s = await setup();
    s.docker.streamPlan = plan({ files: [F('a.tar.gz')] });
    s.docker.containerCounts.set('pvx-files', 1);
    await expect(s.vi.restoreFrom('files', 'data', 'a.tar.gz')).rejects.toThrow(
      /did not stop.*nothing was written/s,
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });
});

describe('VolumeImportService.exportVolume', () => {
  const now = new Date('2026-11-02T21:05:09Z');

  it('saves a copy named for the app, volume and time, read-only on the volume, and returns where it is', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=777\n' }];
    const r = await s.vi.exportVolume('files', 'data', {}, now);
    expect(r).toEqual({
      file: 'files-data-20261102-210509.tar.gz',
      sizeBytes: 777,
      dir: '/var/lib/provelox/imports',
      stopped: false,
      note: '',
    });
    const run = s.docker.streamRuns[1];
    expect(run.command).toEqual([
      '-c',
      EXPORT_SCRIPT,
      'sh',
      'files-data-20261102-210509.tar.gz',
    ]);
    expect(run.mounts[0]).toEqual({
      volume: 'pvx-files-data',
      target: '/data',
      readOnly: true,
    });
    // the app was not touched
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('with stop, stops the app for the copy and starts it again', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=5\n' }];
    const seen: number[] = [];
    const real = s.docker.streamHelper.bind(s.docker);
    s.docker.streamHelper = async (spec) => {
      if (spec.mounts.some((m) => m.target === '/data'))
        seen.push(s.repo.get('files')?.instanceCount ?? -1);
      return real(spec);
    };
    const r = await s.vi.exportVolume('files', 'data', { stop: true }, now);
    expect(r.stopped).toBe(true);
    expect(seen).toEqual([0]);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('starts the app again when the copy fails, and the failure says why', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { exit: 2, stderr: 'No space left on device' },
    ];
    await expect(
      s.vi.exportVolume('files', 'data', { stop: true }, now),
    ).rejects.toThrow(/No space left on device/);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('refuses what a download refuses: an unknown volume, a server directory, another machine, and stopping a hub-managed or multi-instance app', async () => {
    const s = await setup();
    await expect(s.vi.exportVolume('files', 'nope')).rejects.toThrow(
      NotFoundError,
    );
    await expect(s.vi.exportVolume('files', '/in')).rejects.toThrow(
      /directory of the server/,
    );
    await s.apps.mutate('files', async (cur) => ({ ...cur, blueprint: true }));
    await expect(
      s.vi.exportVolume('files', 'data', { stop: true }),
    ).rejects.toThrow(/hub/);
    // a hub-managed app can still be copied live
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=1\n' }];
    await expect(s.vi.exportVolume('files', 'data')).resolves.toMatchObject({
      sizeBytes: 1,
    });
    await s.apps.mutate('files', async (cur) => ({
      ...cur,
      blueprint: false,
      instanceCount: 2,
    }));
    await expect(
      s.vi.exportVolume('files', 'data', { stop: true }),
    ).rejects.toThrow(/2 instances/);
  });
});
