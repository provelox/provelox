import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';

const ANON = 'c'.repeat(64);

/** A persistent app whose image created an unnamed volume at /data */
async function setup(over: { instanceCount?: number } = {}) {
  const s = makeStack();
  await s.apps.create({ name: 'files', persistent: true });
  await s.apps.deploy('files', 'acme/files:1');
  if (over.instanceCount !== undefined)
    await s.apps.update('files', { instanceCount: over.instanceCount });
  s.docker.mounts.set('pvx-files', [
    { type: 'volume', name: ANON, destination: '/data', readOnly: false },
  ]);
  return s;
}

/** Waits for the background move to finish */
async function finished(s: Awaited<ReturnType<typeof setup>>, app = 'files') {
  for (let i = 0; i < 200; i++) {
    const st = s.migration.get(app);
    if (st && st.status !== 'running') return st;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('migration did not finish');
}

describe('VolumeMigrationService.detect', () => {
  it('finds mounts the image created, and says which are unnamed', async () => {
    const s = await setup();
    expect(await s.migration.detect('files')).toEqual([
      { containerPath: '/data', volume: ANON, anonymous: true },
    ]);
  });
  it('ignores mounts the app already declares and non-volume mounts', async () => {
    const s = await setup();
    await s.apps.update('files', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    s.docker.mounts.set('pvx-files', [
      {
        type: 'volume',
        name: 'pvx-files-data',
        destination: '/data',
        readOnly: false,
      },
      { type: 'bind', destination: '/etc/x', readOnly: true },
    ]);
    expect(await s.migration.detect('files')).toEqual([]);
  });
});

describe('VolumeMigrationService.start: refusals', () => {
  it('needs an app that keeps persistent data', async () => {
    const s = makeStack();
    await s.apps.create({ name: 'site' });
    s.docker.mounts.set('pvx-site', [
      { type: 'volume', name: ANON, destination: '/data', readOnly: false },
    ]);
    await expect(
      s.migration.start('site', '/data', 'data'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('needs an unmanaged volume to be mounted at that path right now', async () => {
    const s = await setup();
    await expect(
      s.migration.start('files', '/nope', 'data'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it('validates the volume name and refuses names already in use', async () => {
    const s = await setup();
    await expect(
      s.migration.start('files', '/data', 'bad name'),
    ).rejects.toBeInstanceOf(ValidationError);
    s.docker.volumes.set('pvx-files-data', {});
    await expect(
      s.migration.start('files', '/data', 'data'),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it('refuses unknown apps', async () => {
    await expect(
      makeStack().migration.start('ghost', '/d', 'x'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it('changes nothing when it refuses', async () => {
    const s = await setup();
    const calls = s.docker.calls.length;
    await s.migration.start('files', '/nope', 'data').catch(() => undefined);
    expect(s.docker.calls.length).toBe(calls);
    expect(s.apps.isBlocked('files')).toBe(false);
  });
});

describe('VolumeMigrationService: the move', () => {
  it('stops the app, copies and verifies read-only from the original, then switches and restarts', async () => {
    const s = await setup({ instanceCount: 1 });
    s.docker.containerCounts.set('pvx-files', 0);
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('done');

    const run = s.docker.helperRuns[0];
    expect(run.command.join(' ')).toContain(
      'cp -a /from/. /to/ && diff -r /from /to',
    );
    // the original is mounted read-only: it can only be read
    expect(run.mounts).toEqual([
      { volume: ANON, target: '/from', readOnly: true },
      { volume: 'pvx-files-data', target: '/to', readOnly: false },
    ]);
    const app = s.apps.getDefinition('files');
    expect(app.volumes).toEqual([
      { containerPath: '/data', volumeName: 'data', readOnly: false },
    ]);
    expect(app.instanceCount).toBe(1);
    // the new volume is labelled as ours and points back at where the data came from
    expect(s.docker.volumes.get('pvx-files-data')).toMatchObject({
      'io.provelox.managed': 'true',
      'io.provelox.app': 'files',
      'io.provelox.migrated-from': ANON,
    });
    // the original was never deleted
    expect(s.docker.removed).toEqual([]);
  });

  it('is blocked from edits, deploys and removal while it runs, and unblocked after', async () => {
    const s = await setup();
    // the app "keeps containers" until we let it stop
    s.docker.containerCounts.set('pvx-files', 1);
    await s.migration.start('files', '/data', 'data');
    await expect(s.apps.update('files', { env: [] })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(s.apps.deploy('files', 'acme/files:2')).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(s.apps.remove('files')).rejects.toBeInstanceOf(ConflictError);
    await expect(
      s.migration.start('files', '/data', 'other'),
    ).rejects.toBeInstanceOf(ConflictError);
    s.docker.containerCounts.set('pvx-files', 0);
    await finished(s);
    expect(s.apps.isBlocked('files')).toBe(false);
    await expect(s.apps.update('files', { env: [] })).resolves.toBeDefined();
  });
});

describe('VolumeMigrationService: failures restore everything', () => {
  it('a copy that does not verify puts the app back and removes the half-made volume', async () => {
    const s = await setup();
    s.docker.helperResult = { exitCode: 1, output: 'Only in /from: file.db' };
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    expect(st.error).toMatch(/did not verify/);
    expect(st.error).toMatch(/file\.db/);

    const app = s.apps.getDefinition('files');
    expect(app.volumes).toEqual([]);
    expect(app.instanceCount).toBe(1);
    expect(s.docker.volumes.has('pvx-files-data')).toBe(false);
    // the original is intact, and only the new volume was ever removed
    expect(s.docker.removed).toEqual(['volume:pvx-files-data']);
    expect(s.docker.removed).not.toContain(`volume:${ANON}`);
    expect(st.log.join('\n')).toMatch(/restored/);
    expect(s.apps.isBlocked('files')).toBe(false);
  });

  it('creating the volume failing leaves the app running as before', async () => {
    const s = await setup();
    const before = s.apps.getDefinition('files');
    const create = s.docker.createVolume.bind(s.docker);
    s.docker.createVolume = async () => {
      throw new Error('docker said no');
    };
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    expect(s.apps.getDefinition('files').instanceCount).toBe(
      before.instanceCount,
    );
    s.docker.createVolume = create;
  });

  it('a timeout waiting for the app to stop is a failure that restores it', async () => {
    const s = await setup();
    s.docker.containerCounts.set('pvx-files', 1); // never stops
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    expect(st.error).toMatch(/Timed out waiting for the app to stop/);
    expect(s.apps.getDefinition('files').instanceCount).toBe(1);
    expect(s.docker.helperRuns).toEqual([]);
    expect(s.docker.volumes.has('pvx-files-data')).toBe(false);
  });

  it('a new volume that cannot be started on is rolled back too', async () => {
    const s = await setup();
    s.docker.statusOverride = (name) =>
      s.docker.services
        .get(name)
        ?.TaskTemplate.ContainerSpec.Mounts.some(
          (m: { Source: string }) => m.Source === 'pvx-files-data',
        )
        ? { desired: 1, running: 0, state: 'starting' }
        : { desired: 1, running: 1, state: 'running' };
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    expect(s.apps.getDefinition('files').volumes).toEqual([]);
    expect(s.docker.volumes.has('pvx-files-data')).toBe(false);
  });
});

describe('VolumeMigrationService: holding the original volume', () => {
  it('holds the original before the app is stopped, and lets go once the copy is verified', async () => {
    const s = await setup();
    const order: string[] = [];
    const apply = s.docker.applyService.bind(s.docker);
    s.docker.applyService = async (spec, app, auth) => {
      order.push(`apply:${spec.Mode.Replicated.Replicas}`);
      return apply(spec, app, auth);
    };
    const pin = s.docker.pinVolume.bind(s.docker);
    s.docker.pinVolume = async (v, i, a) => {
      order.push('pin');
      return pin(v, i, a);
    };
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('done');
    // held first, then the app was scaled to 0, then switched back up
    expect(order.indexOf('pin')).toBeLessThan(order.indexOf('apply:0'));
    expect(s.docker.pins.size).toBe(0);
    expect(st.heldVolume).toBeUndefined();
  });

  it('KEEPS holding the original when the move fails after the app was stopped', async () => {
    const s = await setup();
    s.docker.helperResult = { exitCode: 1, output: 'nope' };
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    // the app is back on a fresh volume, so the original may hold the only copy: it stays held
    expect([...s.docker.pins.values()]).toEqual([
      { volume: ANON, app: 'files' },
    ]);
    expect(st.heldVolume).toBe(ANON);
    expect(st.log.join('\n')).toMatch(/safe in the volume/);
    expect(s.apps.getDefinition('files').volumes).toEqual([]);
  });

  it('releases a held volume on request, and only when no move is running', async () => {
    const s = await setup();
    s.docker.helperResult = { exitCode: 1, output: 'nope' };
    await s.migration.start('files', '/data', 'data');
    await finished(s);
    expect(await s.migration.releaseHold('files')).toEqual({ released: 1 });
    expect(s.docker.pins.size).toBe(0);
    expect(s.migration.get('files')?.heldVolume).toBeUndefined();
    expect(await s.migration.releaseHold('files')).toEqual({ released: 0 });
    await expect(s.migration.releaseHold('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses to release while a move is running', async () => {
    const s = await setup();
    s.docker.containerCounts.set('pvx-files', 1);
    await s.migration.start('files', '/data', 'data');
    await expect(s.migration.releaseHold('files')).rejects.toBeInstanceOf(
      ConflictError,
    );
    s.docker.containerCounts.set('pvx-files', 0);
    await finished(s);
  });

  it('does not touch the app when the original cannot be held', async () => {
    const s = await setup();
    s.docker.failPin = new Error('no helper image');
    const before = s.docker.calls.length;
    await s.migration.start('files', '/data', 'data');
    const st = await finished(s);
    expect(st.status).toBe('failed');
    expect(st.error).toMatch(/no helper image/);
    // the app was never stopped: nothing was applied to Docker
    expect(
      s.docker.calls.slice(before).filter((c) => c.startsWith('apply:')),
    ).toEqual([]);
    expect(s.apps.getDefinition('files').instanceCount).toBe(1);
    expect(s.docker.helperRuns).toEqual([]);
    expect(st.heldVolume).toBeUndefined();
  });
});
