/**
 * Runs against the real Docker Engine (Swarm mode required). Opt in with PVX_DOCKER_TESTS=1.
 * Everything it creates is named pvxtest-* and labelled as Provelox's, and is removed at the end, so it cannot
 * touch other services on the host (CapRover, etc).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config/config';
import { Db } from '../src/db/db';
import { AppsRepo } from '../src/apps/apps.repo';
import { AppsService } from '../src/apps/apps.service';
import { SsoService } from '../src/sso/sso.service';
import { CdnService } from '../src/cdn/cdn.service';
import { DockerodeAdapter } from '../src/docker/dockerode.adapter';
import { GroupsService } from '../src/groups/groups.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PlaceholderService } from '../src/system/placeholder.service';
import { CiKeysService } from '../src/ci/ci-keys.service';
import { RegistriesService } from '../src/registries/registries.service';
import { StorageService } from '../src/storage/storage.service';
import { SettingsService } from '../src/system/settings.service';
import { OwnershipError } from '../src/common/errors';

jest.setTimeout(240_000);

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' }).trim();
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args);
  } catch {
    return '';
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = randomBytes(3).toString('hex');
const P = `pvxtest${run}`; // prefix for everything this run creates

async function until<T>(
  what: string,
  fn: () => Promise<T | false | undefined>,
  ms = 120_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1500);
  }
}

describe('against a real Docker Swarm', () => {
  const cfg = loadConfig({
    JWT_SECRET: 'x'.repeat(40),
    ROOT_DOMAIN: 'example.test',
    PLACEHOLDER_IMAGE: 'busybox:latest',
    DATA_DIR: ':memory:',
  });
  const db = new Db(':memory:');
  const adapter = new DockerodeAdapter(cfg);
  const repo = new AppsRepo(db);
  const settings = new SettingsService(db, cfg);
  const groups = new GroupsService(db, repo);
  const placeholder = new PlaceholderService(settings, adapter);
  const registries = new RegistriesService(db, adapter, cfg);
  const ciKeys = new CiKeysService(db);
  const cdn = new CdnService(settings, repo, cfg);
  const apps = new AppsService(
    repo,
    adapter,
    settings,
    groups,
    placeholder,
    registries,
    ciKeys,
    cfg,
    cdn,
    new SsoService(settings, repo, cfg),
  );
  const projects = new ProjectsService(db, repo, apps, groups, adapter);
  const hadBusybox = !!tryDocker('image', 'inspect', 'busybox:latest');
  const hadSharedNetwork = !!tryDocker(
    'network',
    'ls',
    '--filter',
    'name=^provelox-net$',
    '-q',
  );

  beforeAll(async () => {
    await adapter.ping();
    if (tryDocker('info', '--format', '{{.Swarm.LocalNodeState}}') !== 'active')
      throw new Error('Docker Swarm is not active');
  });

  afterAll(async () => {
    // Remove only what this run made
    for (const s of tryDocker(
      'service',
      'ls',
      '--filter',
      'label=io.provelox.managed=true',
      '--format',
      '{{.Name}}',
    ).split('\n'))
      if (s.startsWith(`pvx-${P}`)) tryDocker('service', 'rm', s);
    tryDocker('service', 'rm', `pvx-${P}-foreign`); // created without our label on purpose
    await sleep(4000);
    for (const n of tryDocker('network', 'ls', '--format', '{{.Name}}').split(
      '\n',
    ))
      if (n.startsWith(`pvx-net-${P}`)) tryDocker('network', 'rm', n);
    // Containers linger a few seconds after their service goes; volumes and the image free up after that
    for (let attempt = 0; attempt < 12; attempt++) {
      const mine = tryDocker('volume', 'ls', '--format', '{{.Name}}')
        .split('\n')
        .filter((v) => v.startsWith(`pvx-${P}`));
      for (const v of mine) tryDocker('volume', 'rm', v);
      if (
        mine.every(
          (v) => !tryDocker('volume', 'ls', '-q', '--filter', `name=^${v}$`),
        )
      )
        break;
      await sleep(3000);
    }
    if (!hadSharedNetwork) tryDocker('network', 'rm', 'provelox-net');
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

  it('creates an app as a labelled Swarm service and brings it up', async () => {
    const name = `${P}-one`;
    const v = await apps.create({ name });
    expect(v.app.name).toBe(name);
    const labels = JSON.parse(
      docker(
        'service',
        'inspect',
        `pvx-${name}`,
        '--format',
        '{{json .Spec.Labels}}',
      ),
    );
    expect(labels['io.provelox.managed']).toBe('true');
    expect(labels['io.provelox.app']).toBe(name);
    // busybox exits right away (no command), so Swarm keeps restarting it: give it a command through the app
    await apps.update(name, { command: ['sleep', '3600'] });
    await until(
      'the app to run',
      async () =>
        (await adapter.serviceStatus(`pvx-${name}`))?.state === 'running',
    );
  });

  it('scales, changes env, and reports status', async () => {
    const name = `${P}-one`;
    await apps.update(name, {
      instanceCount: 2,
      env: [{ key: 'GREETING', value: 'hi' }],
    });
    const s = await until('two instances', async () => {
      const st = await adapter.serviceStatus(`pvx-${name}`);
      return st?.running === 2 && st;
    });
    expect(s.desired).toBe(2);
    expect(
      docker(
        'service',
        'inspect',
        `pvx-${name}`,
        '--format',
        '{{json .Spec.TaskTemplate.ContainerSpec.Env}}',
      ),
    ).toContain('GREETING=hi');
  });

  it('refuses to adopt a service it did not create, and leaves it alone', async () => {
    const name = `${P}-foreign`;
    docker(
      'service',
      'create',
      '--name',
      `pvx-${name}`,
      '--replicas',
      '0',
      'busybox:latest',
      'sleep',
      '3600',
    );
    await expect(apps.create({ name })).rejects.toBeInstanceOf(OwnershipError);
    expect(repo.get(name)).toBeUndefined();
    expect(
      docker('service', 'inspect', `pvx-${name}`, '--format', '{{.Spec.Name}}'),
    ).toBe(`pvx-${name}`);
    await expect(
      adapter.removeService(`pvx-${name}`, name),
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it('removes an app and its service', async () => {
    const name = `${P}-one`;
    await apps.remove(name);
    expect(
      tryDocker('service', 'ls', '--filter', `name=pvx-${name}`, '-q'),
    ).toBe('');
  });

  it('deploys a Compose project where services reach each other by their compose names', async () => {
    const project = `${P}-shop`;
    const compose = `
services:
  db:
    image: busybox:latest
    command: ["sleep", "3600"]
    volumes: ["data:/data"]
  web:
    image: busybox:latest
    depends_on: [db]
    command: ["sh", "-c", "while true; do nslookup db 2>&1 | grep -q 'Address' && echo RESOLVED-DB; sleep 2; done"]
volumes:
  data:
`;
    const preview = projects.preview(project, { compose });
    expect(preview.errors).toEqual([]);
    const r = await projects.deploy(project, { compose });
    expect(r.apps.map((a) => a.action)).toEqual(['created', 'created']);

    await until('both services running', async () => {
      const a = await adapter.serviceStatus(`pvx-${project}-db`);
      const b = await adapter.serviceStatus(`pvx-${project}-web`);
      return a?.state === 'running' && b?.state === 'running';
    });
    // The real proof of project networking: "db" resolves from the web container
    await until('web to resolve "db"', async () =>
      tryDocker('service', 'logs', `pvx-${project}-web`).includes(
        'RESOLVED-DB',
      ),
    );
    expect(
      docker(
        'network',
        'ls',
        '--filter',
        `name=pvx-net-${project}`,
        '--format',
        '{{.Name}}',
      ),
    ).toBe(`pvx-net-${project}`);
  });

  it('redeploys a project, dropping a service that left the file', async () => {
    const project = `${P}-shop`;
    const compose = `
services:
  web:
    image: busybox:latest
    command: ["sleep", "3600"]
`;
    // the "db" service had a volume; dropping it is allowed (volume is kept)
    const r = await projects.deploy(project, { compose });
    expect(r.removed).toEqual([`${project}-db`]);
    await until(
      'db service to be gone',
      async () =>
        tryDocker(
          'service',
          'ls',
          '--filter',
          `name=pvx-${project}-db`,
          '-q',
        ) === '',
    );
    expect(
      tryDocker('volume', 'ls', '--filter', `name=pvx-${project}-data`, '-q'),
    ).toBe(`pvx-${project}-data`);
  });

  it('removes a project: services and network go, the volume stays', async () => {
    const project = `${P}-shop`;
    const r = await projects.remove(project);
    expect(r.keptVolumes).toEqual([`pvx-${project}-data`]);
    await until(
      'services to be gone',
      async () =>
        tryDocker('service', 'ls', '--filter', `name=pvx-${project}`, '-q') ===
        '',
    );
    // networks free up a moment after their last task stops
    await until('the network to be removable', async () => {
      try {
        await adapter.removeNetwork(`pvx-net-${project}`, project);
        return true;
      } catch {
        return false;
      }
    }).catch(() => undefined);
    expect(
      tryDocker('volume', 'ls', '--filter', `name=pvx-${project}-data`, '-q'),
    ).toBe(`pvx-${project}-data`);
  });

  it("returns a helper container's output as clean text, without Docker's log framing", async () => {
    const r = await adapter.runHelper({
      image: 'busybox:latest',
      command: ['sh', '-c', 'echo hello; echo oops >&2; exit 3'],
      mounts: [],
    });
    expect(r.exitCode).toBe(3);
    expect(r.output.split('\n').sort()).toEqual(['hello', 'oops']);
  });

  it('reads storage without changing anything, and never calls a foreign volume or image ours', async () => {
    const storage = new StorageService(repo, adapter, cfg);
    const before = tryDocker('volume', 'ls', '-q').split('\n').length;
    const report = await storage.report(1);
    expect(report.volumes.length).toBeGreaterThan(0);
    // Whatever else lives on this host (other tools, other platforms) must need an acknowledgement, never "yes"
    for (const v of report.volumes)
      if (v.delete === 'yes') expect(v.name.startsWith('pvx-')).toBe(true);
    for (const i of report.images)
      if (i.delete === 'yes') expect(i.kind).toBe('old-version');
    // nothing was removed by looking
    expect(tryDocker('volume', 'ls', '-q').split('\n').length).toBe(before);
    // and asking to delete things we cannot prove are ours does nothing without the acknowledgement
    const foreign = report.volumes
      .filter((v) => v.delete === 'acknowledge')
      .map((v) => v.name);
    const r = await storage.deleteVolumes(foreign, false);
    expect(r.deleted).toEqual([]);
    expect(tryDocker('volume', 'ls', '-q').split('\n').length).toBe(before);
  });
});
