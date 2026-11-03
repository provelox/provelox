/**
 * Moving data out of an image's unnamed volume, on a real Swarm (opt in with PVX_DOCKER_TESTS=1).
 * Builds a tiny image that declares VOLUME /data and appends a line to /data/runs.txt every time it starts, so the
 * file tells us exactly how many runs of the app a volume has seen. Everything is pvxtest-* and removed afterwards.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { AppsRepo } from '../src/apps/apps.repo';
import { AppsService } from '../src/apps/apps.service';
import { SsoService } from '../src/sso/sso.service';
import { CdnService } from '../src/cdn/cdn.service';
import { VolumeMigrationService } from '../src/apps/volume-migration.service';
import { CiKeysService } from '../src/ci/ci-keys.service';
import { loadConfig } from '../src/config/config';
import { Db } from '../src/db/db';
import { DockerodeAdapter } from '../src/docker/dockerode.adapter';
import { GroupsService } from '../src/groups/groups.service';
import { RegistriesService } from '../src/registries/registries.service';
import { StorageService } from '../src/storage/storage.service';
import { PlaceholderService } from '../src/system/placeholder.service';
import { SettingsService } from '../src/system/settings.service';

jest.setTimeout(420_000);

const IMAGE = 'pvxtest-vol:latest';
const docker = (...a: string[]) =>
  execFileSync('docker', a, { encoding: 'utf8' }).trim();
const tryDocker = (...a: string[]) => {
  try {
    return docker(...a);
  } catch {
    return '';
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = `pvxtest${randomBytes(3).toString('hex')}`;
const APP = `${P}-files`;
const SERVICE = `pvx-${APP}`;

async function until<T>(
  what: string,
  fn: () => Promise<T | false | undefined>,
  ms = 150_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last = '';
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > end)
      throw new Error(
        `Timed out waiting for ${what}${last ? ` (last error: ${last})` : ''}`,
      );
    await sleep(2000);
  }
}

/** Lines of runs.txt on a volume, read through a throwaway container (read-only) */
const runsOn = (volume: string) => {
  // `docker run -v name:...` silently creates a missing volume, which would hide a vanished original
  if (!tryDocker('volume', 'ls', '-q', '--filter', `name=^${volume}$`))
    throw new Error(`volume ${volume} does not exist`);
  return runsRaw(volume);
};
const runsRaw = (volume: string) =>
  docker(
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${volume}:/x:ro`,
    'busybox:latest',
    'sh',
    '-c',
    'cat /x/runs.txt 2>/dev/null | wc -l',
  ).trim();

describe('moving data into a named volume on a real Swarm', () => {
  const cfg = loadConfig({
    JWT_SECRET: 'x'.repeat(40),
    DATA_DIR: ':memory:',
    PLACEHOLDER_IMAGE: IMAGE,
    PROXY_ENABLED: 'false',
  });
  const db = new Db(':memory:');
  const adapter = new DockerodeAdapter(cfg);
  const repo = new AppsRepo(db);
  const settings = new SettingsService(db, cfg);
  const groups = new GroupsService(db, repo);
  const placeholder = new PlaceholderService(settings, adapter);
  const cdn = new CdnService(settings, repo, cfg);
  const apps = new AppsService(
    repo,
    adapter,
    settings,
    groups,
    placeholder,
    new RegistriesService(db, adapter, cfg),
    new CiKeysService(db),
    cfg,
    cdn,
    new SsoService(settings, repo, cfg),
  );
  const migration = new VolumeMigrationService(apps, adapter, cfg);
  const storage = new StorageService(repo, adapter, cfg);

  const hadBusybox = !!tryDocker('image', 'inspect', 'busybox:latest');
  const hadConfigs = new Set(
    tryDocker('config', 'ls', '--format', '{{.Name}}').split('\n'),
  );
  const hadNetwork = !!tryDocker(
    'network',
    'ls',
    '--filter',
    'name=^provelox-net$',
    '-q',
  );
  /** Every volume any container of our service has had: they are all ours to remove, and nothing else is */
  const seen = new Set<string>();
  const snapshot = () => {
    for (const id of tryDocker(
      'ps',
      '-a',
      '-q',
      '--filter',
      `label=com.docker.swarm.service.name=${SERVICE}`,
    )
      .split('\n')
      .filter(Boolean))
      for (const v of tryDocker(
        'inspect',
        '--format',
        '{{range .Mounts}}{{.Name}} {{end}}',
        id,
      ).split(' '))
        if (v.trim()) seen.add(v.trim());
  };
  const container = () =>
    tryDocker(
      'ps',
      '-q',
      '--filter',
      `label=com.docker.swarm.service.name=${SERVICE}`,
    ).split('\n')[0];
  const runningLines = () =>
    Number(
      tryDocker(
        'exec',
        container(),
        'sh',
        '-c',
        'wc -l < /data/runs.txt',
      ).trim(),
    );

  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-'], {
      input:
        'FROM busybox:latest\nVOLUME /data\nCMD ["sh", "-c", "echo run >> /data/runs.txt; sleep 3600"]\n',
    });
  });

  afterAll(async () => {
    snapshot();
    // pins first: a held volume cannot be removed
    for (const id of tryDocker(
      'ps',
      '-a',
      '-q',
      '--filter',
      'label=io.provelox.helper=pin',
      '--filter',
      `label=io.provelox.app=${APP}`,
    )
      .split('\n')
      .filter(Boolean))
      tryDocker('rm', '-f', id);
    tryDocker('service', 'rm', SERVICE);
    await sleep(8000);
    snapshot();
    for (let i = 0; i < 15; i++) {
      const mine = [...seen, `pvx-${APP}-data`];
      for (const v of mine) tryDocker('volume', 'rm', v);
      if (
        mine.every(
          (v) => !tryDocker('volume', 'ls', '-q', '--filter', `name=^${v}$`),
        )
      )
        break;
      await sleep(3000);
    }
    for (const c of tryDocker('config', 'ls', '--format', '{{.Name}}').split(
      '\n',
    ))
      // only configs this run created: a real installation on the same Docker has its own placeholder page
      if (c.startsWith('pvx-placeholder-') && !hadConfigs.has(c))
        tryDocker('config', 'rm', c);
    if (!hadNetwork) tryDocker('network', 'rm', 'provelox-net');
    tryDocker('image', 'rm', IMAGE);
    if (!hadBusybox)
      for (
        let i = 0;
        i < 6 && tryDocker('image', 'inspect', 'busybox:latest');
        i++
      ) {
        tryDocker('image', 'rm', 'busybox:latest');
        await sleep(3000);
      }
    db.close();
  });

  it('finds the unnamed volume the image created', async () => {
    await apps.create({ name: APP, persistent: true });
    await apps.deploy(APP, IMAGE);
    const found = await until('the unmanaged mount', async () => {
      const d = await migration.detect(APP);
      return d.length > 0 && d;
    });
    snapshot();
    expect(found).toEqual([
      {
        containerPath: '/data',
        volume: expect.stringMatching(/^[0-9a-f]{64}$/),
        anonymous: true,
      },
    ]);
    await until(
      'the app to write its first run',
      async () =>
        (await adapter.serviceStatus(SERVICE))?.state === 'running' &&
        runningLines() >= 1,
    );
  });

  it('an unnamed volume loses its data on a redeploy (the problem being solved)', async () => {
    const before = (await migration.detect(APP))[0].volume;
    await apps.update(APP, { env: [{ key: 'BUMP', value: '1' }] }); // changes the task, so Swarm replaces the container
    const after = await until(
      'a replacement container with its own volume',
      async () => {
        const d = await migration.detect(APP);
        return d.length > 0 && d[0].volume !== before && d[0].volume;
      },
    );
    snapshot();
    expect(after).not.toBe(before);
    await until('the new run', async () => runningLines() >= 1);
    expect(runningLines()).toBe(1); // only this run: the earlier data is stranded in the old volume
  });

  it('a failed move restores the app and keeps the original data safe even after Docker removes the old container', async () => {
    // Break only the copy step, so everything else (holding, stopping, rollback) is real
    const failing = Object.create(adapter) as DockerodeAdapter;
    failing.runHelper = async () => ({
      exitCode: 1,
      output: 'simulated copy failure',
    });
    const failingMigration = new VolumeMigrationService(apps, failing, cfg);
    const original = (await migration.detect(APP))[0].volume;
    const runsBefore = Number(runsOn(original));
    expect(runsBefore).toBeGreaterThanOrEqual(1);
    const oldContainers = tryDocker(
      'ps',
      '-q',
      '--filter',
      `label=com.docker.swarm.service.name=${SERVICE}`,
    )
      .split('\n')
      .filter(Boolean);

    await failingMigration.start(APP, '/data', 'data');
    const state = await until(
      'the failed move to finish',
      async () => {
        const s = failingMigration.get(APP);
        return s && s.status !== 'running' && s;
      },
      240_000,
    );
    snapshot();
    expect(state?.status).toBe('failed');
    expect(state?.error).toMatch(/simulated copy failure/);
    expect(state?.heldVolume).toBe(original);

    // the app is back, with its old definition, and the partly made volume is gone
    await until(
      'the restored app',
      async () => (await adapter.serviceStatus(SERVICE))?.state === 'running',
    );
    expect(apps.getDefinition(APP).volumes).toEqual([]);
    expect(
      tryDocker('volume', 'ls', '-q', '--filter', `name=^pvx-${APP}-data$`),
    ).toBe('');
    expect(
      tryDocker('ps', '-a', '-q', '--filter', 'label=io.provelox.helper=pin'),
    ).not.toBe('');

    // Swarm prunes the old stopped container: Docker deletes an unnamed volume with it, unless something holds it
    for (const c of oldContainers) tryDocker('rm', '-v', '-f', c);
    expect(runsOn(original)).toBe(String(runsBefore));

    // releasing the hold lets go of the helper (the data is then in Docker's hands again)
    expect(await failingMigration.releaseHold(APP)).toEqual({ released: 1 });
    expect(
      tryDocker('ps', '-a', '-q', '--filter', 'label=io.provelox.helper=pin'),
    ).toBe('');
    expect(
      tryDocker('volume', 'ls', '-q', '--filter', `name=^${original}$`),
    ).toBe(original);
    // the original is now just an unnamed volume nothing uses: Storage will not offer it without an acknowledgement
    const report = await storage.report(1);
    expect(report.volumes.find((v) => v.name === original)).toMatchObject({
      kind: 'unnamed-orphan',
      delete: 'acknowledge',
    });
  });

  it('moves the data into a named volume (verified copy) and leaves no helper behind', async () => {
    await until(
      'the app running again',
      async () =>
        (await adapter.serviceStatus(SERVICE))?.state === 'running' &&
        container(),
    );
    const original = (await migration.detect(APP))[0].volume;
    // the restored app starts a new run on a fresh volume
    await until(
      'a first run on the fresh volume',
      async () => runningLines() >= 1,
    );
    const runsBefore = runningLines();

    await migration.start(APP, '/data', 'data');
    const state = await until(
      'the move to finish',
      async () => {
        const s = migration.get(APP);
        return s && s.status !== 'running' && s;
      },
      240_000,
    );
    snapshot();
    expect(state?.error).toBeUndefined();
    expect(state?.status).toBe('done');
    expect(state?.from).toBe(original);

    // the data really is in the named volume, labelled as ours with its lineage
    expect(Number(runsOn(`pvx-${APP}-data`))).toBeGreaterThanOrEqual(
      runsBefore,
    );
    const labels = JSON.parse(
      docker(
        'volume',
        'inspect',
        `pvx-${APP}-data`,
        '--format',
        '{{json .Labels}}',
      ),
    );
    expect(labels).toMatchObject({
      'io.provelox.managed': 'true',
      'io.provelox.migrated-from': original,
    });
    // the app now mounts the named volume, and the hold on the original was released
    const mounts = JSON.parse(
      docker(
        'service',
        'inspect',
        SERVICE,
        '--format',
        '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}',
      ),
    );
    expect(mounts[0]).toMatchObject({
      Source: `pvx-${APP}-data`,
      Target: '/data',
    });
    expect(
      tryDocker('ps', '-a', '-q', '--filter', 'label=io.provelox.helper=pin'),
    ).toBe('');
  });

  it('now the data survives a redeploy', async () => {
    await until(
      'the app running on the named volume',
      async () =>
        (await adapter.serviceStatus(SERVICE))?.state === 'running' &&
        container() &&
        runningLines() >= 2,
    );
    const before = runningLines();
    await apps.update(APP, { env: [{ key: 'BUMP', value: '2' }] });
    await until('the replacement to add its run', async () => {
      const n = Number(
        tryDocker(
          'exec',
          container(),
          'sh',
          '-c',
          'wc -l < /data/runs.txt',
        ).trim(),
      );
      return Number.isFinite(n) && n > before && n;
    });
    snapshot();
    // earlier runs are still there: the count only went up
    expect(runningLines()).toBeGreaterThan(before);
  });

  it('never offers the new named volume for deletion', async () => {
    const report = await storage.report(1);
    const named = report.volumes.find((v) => v.name === `pvx-${APP}-data`);
    expect(named?.delete).toBe('no'); // in use and declared by the app
    const r = await storage.deleteVolumes([`pvx-${APP}-data`], true);
    expect(r.deleted).toEqual([]);
    expect(
      tryDocker('volume', 'ls', '-q', '--filter', `name=^pvx-${APP}-data$`),
    ).toBe(`pvx-${APP}-data`);
  });
});
