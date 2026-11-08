import { USAGE_STALE_MS } from './apps.service';
import {
  ConflictError,
  NotFoundError,
  OwnershipError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import {
  blueprintHash,
  blueprintSpec,
  specOfApp,
  specOfBlueprint,
} from './blueprint';

const setup = () => makeStack();

describe('AppsService.create', () => {
  it('creates the service in Docker, then saves the app', async () => {
    const { apps, docker, repo } = setup();
    const v = await apps.create({ name: 'site' });
    expect(v.app.name).toBe('site');
    expect(docker.services.has('pvx-site')).toBe(true);
    expect(docker.networks.has('provelox-net')).toBe(true);
    expect(repo.get('site')).toBeDefined();
    expect(v.status?.state).toBe('running');
    expect(v.hosts).toEqual([{ host: 'site.example.com', ssl: false }]);
  });

  describe('default subdomain', () => {
    it('is off on a new platform, so apps are not exposed until you decide', async () => {
      const { apps } = makeStack({}, { freshSettings: true });
      const v = await apps.create({ name: 'site' });
      expect(v.app.defaultSubdomain).toBe(false);
      expect(v.hosts).toEqual([]);
    });

    it('is on when the platform setting is turned on', async () => {
      const { apps } = setup();
      const v = await apps.create({ name: 'site' });
      expect(v.app.defaultSubdomain).toBe(true);
      expect(v.hosts).toEqual([{ host: 'site.example.com', ssl: false }]);
    });

    it('follows the platform setting for new apps only', async () => {
      const { apps, settings } = setup();
      const before = await apps.create({ name: 'before' });
      settings.set('defaultSubdomainForNewApps', false);
      const after = await apps.create({ name: 'after' });
      expect(after.app.defaultSubdomain).toBe(false);
      expect(after.hosts).toEqual([]);
      expect(apps.getDefinition('before').defaultSubdomain).toBe(true);
      expect(before.app.defaultSubdomain).toBe(true);
    });

    it('lets each app override the platform setting', async () => {
      const { apps, settings } = setup();
      settings.set('defaultSubdomainForNewApps', false);
      const on = await apps.create({ name: 'on', defaultSubdomain: true });
      expect(on.app.defaultSubdomain).toBe(true);
      settings.set('defaultSubdomainForNewApps', true);
      const off = await apps.create({ name: 'off', defaultSubdomain: false });
      expect(off.app.defaultSubdomain).toBe(false);
    });
  });

  it('saves nothing when Docker refuses', async () => {
    const { apps, docker, repo } = setup();
    docker.failNextApply = new Error('boom');
    await expect(apps.create({ name: 'site' })).rejects.toThrow('boom');
    expect(repo.get('site')).toBeUndefined();
  });

  it('rejects duplicates, bad and reserved names', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await expect(apps.create({ name: 'site' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(apps.create({ name: 'Bad Name' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(apps.create({ name: 'traefik' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses to adopt a Docker service it did not create', async () => {
    const { apps, docker, repo } = setup();
    docker.addForeignService('pvx-site', { 'something.else': '1' });
    await expect(apps.create({ name: 'site' })).rejects.toBeInstanceOf(
      OwnershipError,
    );
    expect(repo.get('site')).toBeUndefined();
    // and the foreign service is untouched
    expect(docker.services.get('pvx-site')?.Labels).toEqual({
      'something.else': '1',
    });
  });

  it('serialises concurrent creates of the same name', async () => {
    const { apps } = setup();
    const results = await Promise.allSettled([
      apps.create({ name: 'dup' }),
      apps.create({ name: 'dup' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('AppsService.update', () => {
  it('changes only allowed fields and re-applies the service', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    const v = await apps.update('site', {
      instanceCount: 3,
      env: [{ key: 'A', value: '1' }],
      containerPort: 3000,
    });
    expect(v.app.instanceCount).toBe(3);
    expect(docker.services.get('pvx-site')?.Mode.Replicated.Replicas).toBe(3);
    expect(
      docker.services.get('pvx-site')?.TaskTemplate.ContainerSpec.Env,
    ).toEqual(['A=1']);
  });

  it('records pending host ports without publishing them', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'dns' });
    const v = await apps.update('dns', {
      pendingPorts: [{ containerPort: 53, hostPort: 53, protocol: 'udp' }],
    });
    expect(v.app.pendingPorts).toEqual([
      { containerPort: 53, hostPort: 53, protocol: 'udp' },
    ]);
    expect(docker.services.get('pvx-dns')?.EndpointSpec).toBeUndefined();
    await expect(
      apps.update('dns', {
        pendingPorts: [
          { containerPort: 1, hostPort: 9000 },
          { containerPort: 2, hostPort: 9000 },
        ],
      }),
    ).rejects.toThrow(/pending host port/i);
  });

  it.each([
    ['name'],
    ['persistent'],
    ['project'],
    ['deployVersion'],
    ['createdAt'],
    ['versions'],
  ])('refuses to change %s', async (field) => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await expect(apps.update('site', { [field]: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('lets null clear optional fields', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', { command: ['a'] });
    const v = await apps.update('site', { command: null });
    expect(v.app.command).toBeUndefined();
  });

  it('keeps the old state when Docker rejects the change', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    docker.failNextApply = new Error('nope');
    await expect(apps.update('site', { instanceCount: 5 })).rejects.toThrow(
      'nope',
    );
    expect(apps.getDefinition('site').instanceCount).toBe(1);
  });

  it('404s for unknown apps', async () => {
    await expect(setup().apps.update('ghost', {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  describe('data rules', () => {
    it('needs persistent data to mount anything', async () => {
      const { apps } = setup();
      await apps.create({ name: 'site' });
      await expect(
        apps.update('site', {
          volumes: [{ containerPath: '/data', volumeName: 'd' }],
        }),
      ).rejects.toThrow(/persistent data/);
    });
    it('keeps persistent apps at one instance', async () => {
      const { apps } = setup();
      await apps.create({ name: 'db', persistent: true });
      await expect(apps.update('db', { instanceCount: 2 })).rejects.toThrow(
        /single instance/,
      );
    });
    it('refuses sensitive server directories unless acknowledged', async () => {
      const { apps } = setup();
      await apps.create({ name: 'db', persistent: true });
      const volumes = [{ containerPath: '/h', hostPath: '/etc' }];
      await expect(apps.update('db', { volumes })).rejects.toThrow(
        /control over the server/,
      );
      await expect(
        apps.update('db', { volumes, acknowledgeSensitiveHostPaths: true }),
      ).resolves.toBeDefined();
    });
    it('allows ordinary server directories', async () => {
      const { apps } = setup();
      await apps.create({ name: 'db', persistent: true });
      await expect(
        apps.update('db', {
          volumes: [{ containerPath: '/in', hostPath: '/srv/in' }],
        }),
      ).resolves.toBeDefined();
    });
    it('rejects duplicate mount paths and host ports', async () => {
      const { apps } = setup();
      await apps.create({ name: 'db', persistent: true });
      await expect(
        apps.update('db', {
          volumes: [
            { containerPath: '/d', volumeName: 'a' },
            { containerPath: '/d/', volumeName: 'b' },
          ],
        }),
      ).rejects.toThrow(/only be mounted once/);
      await expect(
        apps.update('db', {
          ports: [
            { containerPort: 1, hostPort: 9000 },
            { containerPort: 2, hostPort: 9000 },
          ],
        }),
      ).rejects.toThrow(/host port/i);
    });
  });

  describe('domains and HTTPS', () => {
    it('forbids forcing HTTPS before any host has HTTPS', async () => {
      const { apps } = setup();
      await apps.create({ name: 'site' });
      await expect(apps.update('site', { forceSsl: true })).rejects.toThrow(
        /Turn on HTTPS/,
      );
      await expect(
        apps.update('site', { defaultSubdomainSsl: true, forceSsl: true }),
      ).resolves.toBeDefined();
    });
    it('does not let two apps claim the same domain or host port', async () => {
      const { apps } = setup();
      await apps.create({ name: 'a' });
      await apps.create({ name: 'b' });
      await apps.update('a', {
        domains: [{ host: 'x.org', ssl: false }],
        ports: [{ containerPort: 1, hostPort: 9000 }],
      });
      await expect(
        apps.update('b', { domains: [{ host: 'x.org', ssl: false }] }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        apps.update('b', { ports: [{ containerPort: 1, hostPort: 9000 }] }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
    it('rejects malformed domains', async () => {
      const { apps } = setup();
      await apps.create({ name: 'site' });
      await expect(
        apps.update('site', {
          domains: [{ host: 'not a domain', ssl: false }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe('AppsService: health', () => {
  it('passes what the health check says through the app’s status', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    expect((await apps.get('site')).status?.health).toBe('none');
    docker.health.set('pvx-site', 'unhealthy');
    expect((await apps.get('site')).status?.health).toBe('unhealthy');
    expect((await apps.list())[0].status?.health).toBe('unhealthy');
  });
});

describe('AppsService: primary address', () => {
  it('redirects the other addresses to the one picked', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      domains: [{ host: 'www.shop.org', ssl: false }],
      primaryDomain: 'www.shop.org',
    });
    expect(apps.getDefinition('site').primaryDomain).toBe('www.shop.org');
    const labels = docker.services.get('pvx-site')?.Labels ?? {};
    expect(labels['traefik.http.routers.site-moved.rule']).toBe(
      'Host(`site.example.com`)',
    );
  });
  it('refuses an address the app does not have', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await expect(
      apps.update('site', { primaryDomain: 'other.org' }),
    ).rejects.toThrow(ValidationError);
  });
  it('stops redirecting once that address is removed, and can be cleared', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      domains: [{ host: 'www.shop.org', ssl: false }],
      primaryDomain: 'www.shop.org',
    });
    await apps.update('site', { domains: [] });
    expect(apps.getDefinition('site').primaryDomain).toBeUndefined();
    await apps.update('site', { primaryDomain: 'site.example.com' });
    expect(apps.getDefinition('site').primaryDomain).toBe('site.example.com');
    await apps.update('site', { primaryDomain: null });
    expect(apps.getDefinition('site').primaryDomain).toBeUndefined();
  });
});

describe('AppsService.certificates', () => {
  it('asks the proxy about each address that serves HTTPS', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      domains: [{ host: 'shop.example.org', ssl: false }],
    });
    const asked: string[] = [];
    apps.tlsProbe = async (h) => {
      asked.push(h);
      return null;
    };
    const r = await apps.certificates('site');
    // the default address has no HTTPS and the custom one has none either: nothing to ask
    expect(asked).toEqual([]);
    expect(r.map((x) => [x.host, x.state])).toEqual([
      ['site.example.com', 'off'],
      ['shop.example.org', 'off'],
    ]);
  });

  it('404s for unknown apps', async () => {
    await expect(setup().apps.certificates('nope')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('AppsService.usageAll', () => {
  it('reports running apps only, and reuses a reading for a few seconds', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'up' });
    await apps.create({ name: 'down' });
    await apps.update('down', { instanceCount: 0 });
    docker.usage.set('pvx-up', {
      instances: 1,
      cpuPercent: 5,
      memoryBytes: 10,
    });
    const first = await apps.usageAll(1000);
    expect(Object.keys(first)).toEqual(['up']);
    docker.usage.set('pvx-up', {
      instances: 1,
      cpuPercent: 99,
      memoryBytes: 10,
    });
    expect((await apps.usageAll(1500)).up.cpuPercent).toBe(5);
    expect(
      (await apps.usageAll(1000 + apps.usageCacheMs + 1)).up.cpuPercent,
    ).toBe(99);
  });
});

describe('AppsService.usageAllQuick', () => {
  const reading = (cpuPercent: number) => ({
    instances: 1,
    cpuPercent,
    memoryBytes: 10,
  });

  it('waits for the first reading, then answers at once with the last one while a new one is taken', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'up' });
    docker.usage.set('pvx-up', reading(5));
    const t0 = 1_000_000;
    expect((await apps.usageAllQuick(t0)).up.cpuPercent).toBe(5);

    // Docker now takes a long time to measure: a gate we open by hand
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const real = docker.serviceUsage.bind(docker);
    docker.serviceUsage = async (n) => {
      await gate;
      return real(n);
    };
    docker.usage.set('pvx-up', reading(99));

    // stale (older than the cache window), so a refresh starts, but the answer is the old one and does not wait
    const late = t0 + apps.usageCacheMs + 1;
    const answer = await Promise.race([
      apps.usageAllQuick(late),
      new Promise((r) => setTimeout(() => r('waited'), 200)),
    ]);
    expect(answer).not.toBe('waited');
    expect(
      (answer as Record<string, { cpuPercent: number }>).up.cpuPercent,
    ).toBe(5);

    open();
    await new Promise((r) => setTimeout(r, 20));
    // the refresh finished behind the call: the next one sees it
    expect(
      Object.values(await apps.usageAllQuick(late + 1))[0].cpuPercent,
    ).toBe(99);
  });

  it('starts one refresh however many callers arrive meanwhile', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'up' });
    docker.usage.set('pvx-up', reading(5));
    await apps.usageAllQuick(1_000_000);
    let calls = 0;
    const real = docker.serviceUsage.bind(docker);
    docker.serviceUsage = async (n) => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return real(n);
    };
    const late = 1_000_000 + apps.usageCacheMs + 1;
    await Promise.all([1, 2, 3, 4].map(() => apps.usageAllQuick(late)));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  it('waits for a new reading when the last one is minutes old', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'up' });
    docker.usage.set('pvx-up', reading(5));
    await apps.usageAllQuick(1_000_000);
    docker.usage.set('pvx-up', reading(77));
    expect(
      (await apps.usageAllQuick(1_000_000 + USAGE_STALE_MS + 1)).up.cpuPercent,
    ).toBe(77);
  });
});

describe('AppsService.usage', () => {
  it('reports what the instances use beside the limits they were given', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      resources: { cpus: 0.5, memoryBytes: 256 * 1024 * 1024 },
    });
    docker.usage.set('pvx-site', {
      instances: 2,
      cpuPercent: 12.5,
      memoryBytes: 1000,
    });
    expect(await apps.usage('site')).toEqual({
      instances: 2,
      cpuPercent: 12.5,
      memoryBytes: 1000,
      cpuLimitPercent: 50,
      memoryLimitBytes: 256 * 1024 * 1024,
    });
  });

  it('has no limits to show for an app that has none, and 404s for unknown apps', async () => {
    const { apps } = setup();
    await apps.create({ name: 'free' });
    const u = await apps.usage('free');
    expect(u.cpuLimitPercent).toBeNull();
    expect(u.memoryLimitBytes).toBeNull();
    await expect(apps.usage('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AppsService.restart', () => {
  it('replaces the instances even though nothing changed', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    await apps.deploy('site', 'acme/site:1');
    docker.forcedRollouts.clear();
    await apps.restart('site');
    expect(docker.forcedRollouts.has('pvx-site')).toBe(true);
  });

  it('refuses an app that is stopped or was never deployed', async () => {
    const { apps } = setup();
    await apps.create({ name: 'fresh' });
    await expect(apps.restart('fresh')).rejects.toThrow(/nothing deployed/);
    await apps.deploy('fresh', 'acme/site:1');
    await apps.update('fresh', { instanceCount: 0 });
    await expect(apps.restart('fresh')).rejects.toThrow(/stopped/);
    await expect(apps.restart('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AppsService.deploy', () => {
  it('records versions, swaps the image and caps history', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    for (let i = 1; i <= 22; i++) await apps.deploy('site', `acme/site:${i}`);
    const app = apps.getDefinition('site');
    expect(app.deployVersion).toBe(22);
    expect(app.versions).toHaveLength(20);
    expect(app.versions[19]).toMatchObject({
      version: 22,
      image: 'acme/site:22',
    });
    expect(
      docker.services.get('pvx-site')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('acme/site:22');
  });
  it('rejects invalid image names', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await expect(apps.deploy('site', 'bad image!')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('AppsService.remove', () => {
  it('removes the service and the app, and reports volumes it kept', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'db', persistent: true });
    await apps.update('db', {
      volumes: [{ containerPath: '/d', volumeName: 'data' }],
    });
    const r = await apps.remove('db');
    expect(r.keptVolumes).toEqual(['data']);
    expect(docker.services.has('pvx-db')).toBe(false);
    await expect(apps.get('db')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('will not delete an app that belongs to a project', async () => {
    const { apps, repo } = setup();
    await apps.create({ name: 'shop-db' });
    repo.save({ ...apps.getDefinition('shop-db'), project: 'shop' });
    await expect(apps.remove('shop-db')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('AppsService.list', () => {
  it('survives Docker status failures', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    docker.statusOverride = () => {
      throw new Error('docker down');
    };
    const list = await apps.list();
    expect(list[0].status).toBeNull();
  });
});

describe('AppsService: placeholder and error pages', () => {
  it('creates new apps on the placeholder page config', async () => {
    const { apps, docker } = makeStack();
    await apps.create({ name: 'fresh' });
    const spec = docker.services.get('pvx-fresh');
    expect(spec?.TaskTemplate.ContainerSpec.Configs?.[0].ConfigName).toMatch(
      /^pvx-placeholder-[0-9a-f]{12}$/,
    );
    // the page, and the server settings that send it with a no-script policy
    expect(docker.configs.size).toBe(2);
  });

  it('drops the placeholder mount on the first real deploy', async () => {
    const { apps, docker } = makeStack();
    await apps.create({ name: 'fresh' });
    await apps.deploy('fresh', 'acme/site:1');
    expect(
      docker.services.get('pvx-fresh')?.TaskTemplate.ContainerSpec.Configs,
    ).toBeUndefined();
  });

  describe('error pages', () => {
    const ps = () => makeStack({ ERROR_PAGES_SERVICE: 'pvx-api-errors@swarm' });
    it('stores, merges and removes pages per status', async () => {
      const { apps, docker } = ps();
      await apps.create({ name: 'site' });
      await apps.update('site', { errorPages: { '502': '<p>a</p>' } });
      await apps.update('site', { errorPages: { '503': '<p>b</p>' } });
      expect(apps.getDefinition('site').errorPages).toEqual({
        '502': '<p>a</p>',
        '503': '<p>b</p>',
      });
      expect(
        docker.services.get('pvx-site')?.Labels[
          'traefik.http.middlewares.site-errors.errors.status'
        ],
      ).toBe('502-504');
      await apps.update('site', { errorPages: { '502': '' } });
      expect(apps.getDefinition('site').errorPages).toEqual({
        '503': '<p>b</p>',
      });
    });
    it('refuses unknown statuses', async () => {
      const { apps } = ps();
      await apps.create({ name: 'site' });
      await expect(
        apps.update('site', { errorPages: { '500': 'x' } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
    it('needs the proxy to be able to reach the page endpoint', async () => {
      const { apps } = makeStack();
      await apps.create({ name: 'site' });
      await expect(
        apps.update('site', { errorPages: { '502': 'x' } }),
      ).rejects.toThrow(/ERROR_PAGES_SERVICE/);
    });
  });

  describe('HTTPS', () => {
    it("needs a Let's Encrypt email", async () => {
      const { apps } = makeStack({ ACME_EMAIL: '' });
      await apps.create({ name: 'site' });
      await expect(
        apps.update('site', { defaultSubdomainSsl: true }),
      ).rejects.toThrow(/Let's Encrypt email/);
    });
  });
});

describe('AppsService: names the platform keeps for itself', () => {
  it.each(['provelox', 'traefik', 'console', 'registry'])(
    'refuses to create an app named %s',
    async (name) => {
      const { apps, docker } = makeStack();
      await expect(apps.create({ name })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(docker.services.size).toBe(0);
    },
  );

  it('still reads and removes an app that already has such a name, so an older install keeps working', async () => {
    const { apps, repo, docker } = makeStack();
    // created back when the name was free (a console deployed as an ordinary app)
    await apps.create({ name: 'legacy' });
    const legacy = apps.getDefinition('legacy');
    repo.delete('legacy');
    docker.services.delete('pvx-legacy');
    docker.services.set('pvx-console', {
      Name: 'pvx-console',
      Labels: { 'io.provelox.managed': 'true', 'io.provelox.app': 'console' },
    } as never);
    repo.save({ ...legacy, name: 'console' });
    expect((await apps.list()).map((v) => v.app.name)).toEqual(['console']);
    await expect(apps.remove('console')).resolves.toBeDefined();
    expect(docker.services.has('pvx-console')).toBe(false);
  });
});

describe('AppsService: re-applying after the networks are gone', () => {
  it('recreates the shared network before applying an app', async () => {
    const { apps, docker } = makeStack();
    await apps.create({ name: 'one' });
    docker.networks.clear();
    await apps.reconcile('one');
    expect(docker.networks.has('provelox-net')).toBe(true);
  });
});

describe('AppsService: startup', () => {
  it('re-applies every existing app so platform upgrades reach them', async () => {
    const { apps, docker } = makeStack();
    await apps.create({ name: 'one' });
    await apps.create({ name: 'two' });
    docker.calls.length = 0;
    apps.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 20));
    expect(docker.calls.filter((c) => c.startsWith('apply:'))).toEqual([
      'apply:pvx-one',
      'apply:pvx-two',
    ]);
  });

  it('does not stop the API from starting when Docker is unhappy', async () => {
    const { apps, docker } = makeStack();
    await apps.create({ name: 'one' });
    docker.failNextApply = new Error('docker is down');
    expect(() => apps.onApplicationBootstrap()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('AppsService: HTTP off and a linked domain', () => {
  it('stops the proxy answering for the app while keeping its domains on record', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'dns' });
    await apps.update('dns', {
      domains: [{ host: 'ns1.example.org', ssl: false }],
    });
    expect(docker.services.get('pvx-dns')?.Labels['traefik.enable']).toBe(
      'true',
    );
    const v = await apps.update('dns', { exposed: false });
    expect(v.hosts).toEqual([]);
    expect(docker.services.get('pvx-dns')?.Labels['traefik.enable']).toBe(
      'false',
    );
    expect(apps.getDefinition('dns').domains).toHaveLength(1);
    // turning it back on restores the routes
    const again = await apps.update('dns', { exposed: true });
    expect(again.hosts.map((h) => h.host)).toContain('ns1.example.org');
  });

  it('keeps a linked domain that is never routed, and can clear it', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'dns' });
    const v = await apps.update('dns', {
      exposed: false,
      linkedDomain: ' NS1.Example.org ',
    });
    expect(v.app.linkedDomain).toBe('ns1.example.org');
    expect(v.hosts).toEqual([]);
    const labels = docker.services.get('pvx-dns')?.Labels ?? {};
    expect(JSON.stringify(labels)).not.toContain('ns1.example.org');
    const cleared = await apps.update('dns', { linkedDomain: null });
    expect(cleared.app.linkedDomain).toBeUndefined();
  });

  it('refuses a linked domain that is not a domain name', async () => {
    const { apps } = setup();
    await apps.create({ name: 'dns' });
    for (const bad of ['not a domain', 'localhost', 'http://x.com', '-a.com'])
      await expect(
        apps.update('dns', { linkedDomain: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('AppsService.applyBlueprint', () => {
  const dns = {
    name: 'dns-server',
    image: 'ghcr.io/acme/dns:1.0.0',
    persistent: true,
    containerPort: 8053,
    instanceCount: 1,
    exposed: false,
    linkedDomain: 'ns1.example.org',
    env: [
      { key: 'ZONE', value: 'example.org' },
      { key: 'A', value: '1' },
    ],
    ports: [
      { containerPort: 53, hostPort: 53, protocol: 'udp' as const },
      { containerPort: 53, hostPort: 53, protocol: 'tcp' as const },
    ],
    volumes: [{ containerPath: '/var/lib/dns' }],
  };
  const hashOf = (s: object) =>
    blueprintHash(specOfBlueprint(blueprintSpec.parse(s)));

  it('creates the app, sets what the blueprint governs, deploys the image, and matches its own fingerprint', async () => {
    const { apps, docker } = setup();
    const r = await apps.applyBlueprint(dns);
    expect(r).toEqual({ name: 'dns-server', created: true, deployed: true });
    const app = apps.getDefinition('dns-server');
    expect(app).toMatchObject({
      image: dns.image,
      persistent: true,
      exposed: false,
      containerPort: 8053,
      linkedDomain: 'ns1.example.org',
    });
    expect(app.volumes[0].volumeName).toBe('dns-server-var-lib-dns');
    expect(docker.services.get('pvx-dns-server')).toBeDefined();
    // the contract the hub relies on: the app and the blueprint make the same fingerprint
    expect(blueprintHash(specOfApp(app))).toBe(hashOf(dns));
    // and a client makes this very value from the same blueprint
    expect(hashOf(dns)).toBe('b1f0734f72b88ebc');
  });

  it('does nothing a second time, and only deploys when the image differs', async () => {
    const { apps } = setup();
    await apps.applyBlueprint(dns);
    const v = apps.getDefinition('dns-server').deployVersion;
    expect(await apps.applyBlueprint(dns)).toEqual({
      name: 'dns-server',
      created: false,
      deployed: false,
    });
    expect(apps.getDefinition('dns-server').deployVersion).toBe(v);
    await apps.applyBlueprint({
      ...dns,
      env: [{ key: 'ZONE', value: 'other.org' }],
    });
    expect(apps.getDefinition('dns-server').deployVersion).toBe(v);
    expect(apps.getDefinition('dns-server').env).toEqual([
      { key: 'ZONE', value: 'other.org' },
    ]);
    const r = await apps.applyBlueprint({
      ...dns,
      image: 'ghcr.io/acme/dns:1.1.0',
    });
    expect(r.deployed).toBe(true);
    expect(apps.getDefinition('dns-server').deployVersion).toBe(v + 1);
    expect(blueprintHash(specOfApp(apps.getDefinition('dns-server')))).toBe(
      hashOf({ ...dns, image: 'ghcr.io/acme/dns:1.1.0' }),
    );
  });

  it('refuses an app in a project, a change of persistence, and anything that reaches outside the blueprint', async () => {
    const { apps } = setup();
    await apps.applyBlueprint(dns);
    await expect(
      apps.applyBlueprint({ ...dns, persistent: false, volumes: [] }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      apps.applyBlueprint({ ...dns, name: 'x', hostPath: '/etc' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps.applyBlueprint({
        ...dns,
        name: 'x',
        volumes: [{ containerPath: '/a', hostPath: '/etc' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps.applyBlueprint({ ...dns, name: 'y', persistent: false }),
    ).rejects.toBeInstanceOf(ValidationError); // volumes without persistent data
    await expect(
      apps.applyBlueprint({ ...dns, name: 'Bad Name' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps.applyBlueprint({ ...dns, name: 'z', image: 'not an image' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('only changes apps that came from a blueprint, so a token cannot take over the others', async () => {
    const { apps } = setup();
    await apps.create({ name: 'victim' });
    await expect(
      apps.applyBlueprint({
        ...dns,
        name: 'victim',
        persistent: false,
        volumes: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(apps.getDefinition('victim').image).toBe('');
    // one made from a blueprint is fine
    await apps.applyBlueprint(dns);
    expect(apps.getDefinition('dns-server').blueprint).toBe(true);
    await apps.applyBlueprint({ ...dns, image: 'ghcr.io/acme/dns:2.0.0' });
  });

  it('stops changing a blueprint app once it holds secrets, custom domains or host directories', async () => {
    const { apps, repo } = setup();
    await apps.applyBlueprint(dns);
    const def = apps.getDefinition('dns-server');
    for (const extra of [
      {
        secrets: [
          { name: 'KEY', dockerName: 'k1', id: 'sec1', createdAt: 'x' },
        ],
      },
      { domains: [{ host: 'ns.example.org', ssl: false }] },
      {
        volumes: [
          ...def.volumes,
          { containerPath: '/h', hostPath: '/srv/h', readOnly: false },
        ],
      },
    ]) {
      repo.save({ ...def, ...extra } as never);
      await expect(
        apps.applyBlueprint({ ...dns, image: 'evil/image:1' }),
      ).rejects.toBeInstanceOf(ConflictError);
    }
    repo.save(def);
    await apps.applyBlueprint({ ...dns, image: 'ghcr.io/acme/dns:3.0.0' });
  });

  it('refuses ports the platform uses, and a volume that something else already owns', async () => {
    const { apps, docker } = setup();
    for (const hostPort of [80, 443, 2377, 22])
      await expect(
        apps.applyBlueprint({
          ...dns,
          ports: [{ containerPort: 80, hostPort, protocol: 'tcp' }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    docker.host.volumes.push({
      name: 'pvx-dns-server-dns-server-var-lib-dns',
      labels: {
        'io.provelox.managed': 'true',
        'io.provelox.project': 'dns-server',
      },
    } as never);
    await expect(apps.applyBlueprint(dns)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('AppsService platform addresses follow where the platform really is', () => {
  const platformAt = (
    docker: { services: Map<string, unknown> },
    api: string,
    console: string,
  ) => {
    for (const [name, id, host] of [
      ['pvx-provelox', 'pvx_api', api],
      ['pvx-console', 'pvx_console', console],
    ])
      docker.services.set(name, {
        Name: name,
        Labels: {
          [`traefik.http.routers.${id}-web.rule`]: `Host(\`${host}\`)`,
        },
        Mode: { Replicated: { Replicas: 1 } },
        TaskTemplate: { ContainerSpec: { Image: 'x:1' } },
      });
  };

  it('lets an app keep api.<root> when the platform is served somewhere else, and still protects where it is', async () => {
    const { apps, docker } = setup();
    platformAt(docker, 'ctl.example.com', 'admin-ui.example.com');
    await apps.create({ name: 'web' });
    await apps.update('web', {
      domains: [{ host: 'api.example.com', ssl: false }],
    });
    await apps.create({ name: 'web2' });
    for (const host of ['ctl.example.com', 'admin-ui.example.com'])
      await expect(
        apps.update('web2', { domains: [{ host, ssl: false }] }),
      ).rejects.toThrow(/platform's own/);
  });
});

describe('AppsService platform addresses and image names', () => {
  it('refuses to give an app the address the console or the API answers at', async () => {
    const { apps } = setup();
    await apps.create({ name: 'web' });
    for (const host of ['api.example.com', 'console.example.com'])
      await expect(
        apps.update('web', { domains: [{ host, ssl: false }] }),
      ).rejects.toBeInstanceOf(ConflictError);
    await apps.update('web', {
      domains: [{ host: 'shop.example.com', ssl: false }],
    });
  });

  it('turns away an image name that could point at another Docker path', async () => {
    const { apps } = setup();
    await apps.create({ name: 'web' });
    for (const image of ['a/../../images', 'a//b', '../etc'])
      await expect(apps.deploy('web', image)).rejects.toBeInstanceOf(
        ValidationError,
      );
  });
});

describe('AppsService placement in a cluster', () => {
  const node = (id: string, hostname: string, role: 'leader' | 'worker') =>
    ({
      id,
      hostname,
      role,
      state: 'ready',
      availability: 'active',
      address: '10.0.0.1',
      cpus: 2,
      memoryBytes: 1,
      os: 'linux',
      architecture: 'x86_64',
      dockerVersion: '27',
    }) as never;
  const cluster = () => {
    const s = setup();
    s.docker.nodes = [
      node('a', 'atl-1', 'leader'),
      node('b', 'dfw-1', 'worker'),
    ];
    return s;
  };
  const constraints = (docker: { services: Map<string, any> }, app: string) =>
    docker.services.get(`pvx-${app}`)?.TaskTemplate.Placement?.Constraints;

  it('puts an app on the machine or role chosen, and lets it go back to anywhere', async () => {
    const { apps, docker } = cluster();
    await apps.create({ name: 'web' });
    await apps.update('web', { placement: { node: 'dfw-1' } });
    expect(constraints(docker, 'web')).toEqual(['node.hostname==dfw-1']);
    await apps.update('web', { placement: { role: 'worker' } });
    expect(constraints(docker, 'web')).toEqual(['node.role==worker']);
    await apps.update('web', { placement: null });
    expect(constraints(docker, 'web')).toBeUndefined();
  });

  it('refuses a machine that is not in the cluster, and a machine and a role together', async () => {
    const { apps } = cluster();
    await apps.create({ name: 'web' });
    await expect(
      apps.update('web', { placement: { node: 'nowhere' } }),
    ).rejects.toThrow(/atl-1, dfw-1/);
    await expect(
      apps.update('web', { placement: { node: 'dfw-1', role: 'worker' } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('holds an app with local volumes to the machine it runs on once there are two, and refuses to move it', async () => {
    const { apps, docker } = cluster();
    await apps.create({ name: 'db', persistent: true });
    // it runs on dfw-1 (b): that is where its volume is
    docker.taskNodes.set('pvx-db', 'b');
    await apps.update('db', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    expect(constraints(docker, 'db')).toEqual(['node.id==b']);
    expect(await apps.pinnedTo('db')).toBe('dfw-1');
    await expect(
      apps.update('db', { placement: { node: 'atl-1' } }),
    ).rejects.toThrow(/keeps its data on dfw-1/);
    await expect(
      apps.update('db', { placement: { role: 'manager' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await apps.update('db', { placement: { node: 'dfw-1' } });
  });

  it('does not pin on a single machine', async () => {
    const { apps, docker } = setup();
    docker.nodes = [node('a', 'atl-1', 'leader')];
    await apps.create({ name: 'db', persistent: true });
    await apps.update('db', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    expect(constraints(docker, 'db')).toBeUndefined();
    expect(await apps.pinnedTo('db')).toBeNull();
  });
});

describe('AppsService platform addresses at creation', () => {
  it('refuses a default address that would be console.<root> or api.<root>, and allows it with an apps domain', async () => {
    const { apps, settings } = setup() as unknown as {
      apps: import('./apps.service').AppsService;
      settings: { set(k: string, v: unknown): void };
    };
    await expect(
      apps.create({ name: 'api', defaultSubdomain: true }),
    ).rejects.toThrow(/platform's own console or API is served/);
    // with the default address off it is only a name
    await apps.create({ name: 'api', defaultSubdomain: false });
    await apps.remove('api');
    // and apps with their own domain never meet the platform's
    settings.set('appsDomain', 'apps.example.com');
    await apps.create({ name: 'api', defaultSubdomain: true });
  });

  it('lets a key deploy the repository it was made for, from the first deploy on', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    // an app with no image yet: only a key that names one may deploy it
    apps.assertSameImageRepository('site', 'ghcr.io/acme/site:1', {
      keyRepository: 'ghcr.io/acme/site',
    });
    await apps.deploy('site', 'ghcr.io/acme/site:1');
    apps.assertSameImageRepository('site', 'ghcr.io/acme/site:2', {
      keyRepository: 'ghcr.io/acme/site',
    });
    expect(() =>
      apps.assertSameImageRepository('site', 'evil/miner:1', {
        keyRepository: 'ghcr.io/acme/site',
      }),
    ).toThrow(/different image/);
  });

  it('refuses a first deploy by a key that names no repository, or by a token', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    expect(() =>
      apps.assertSameImageRepository('site', 'ghcr.io/acme/site:1', {
        keyRepository: null,
      }),
    ).toThrow(/no image yet/);
    expect(() =>
      apps.assertSameImageRepository('site', 'ghcr.io/acme/site:1'),
    ).toThrow(/no image yet/);
  });

  it('refuses a key whose repository is not the app’s current one', async () => {
    const { apps } = setup();
    await apps.create({ name: 'site' });
    await apps.deploy('site', 'ghcr.io/acme/site:1');
    // the admin moved the app to another repository: the key was made for the old one
    expect(() =>
      apps.assertSameImageRepository('site', 'ghcr.io/acme/site:2', {
        keyRepository: 'ghcr.io/acme/old',
      }),
    ).toThrow(/different image/);
    // a key made before repositories were recorded still only rolls the current image forward
    apps.assertSameImageRepository('site', 'ghcr.io/acme/site:2', {
      keyRepository: null,
    });
  });
});

describe('AppsService HTTP basic auth', () => {
  const label = (docker: { services: Map<string, any> }, k: string) =>
    docker.services.get('pvx-web')?.Labels[k];

  it('hashes a password, keeps only the hash, and puts the middleware on the app', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'web' });
    const v = await apps.update('web', {
      basicAuth: {
        users: [{ name: 'secure', password: 'a long password' }],
        openPaths: ['/hook'],
      },
    });
    const saved = v.app.basicAuth!;
    expect(saved.users[0].name).toBe('secure');
    expect(saved.users[0].hash).toMatch(/^\$2[aby]\$08\$/);
    expect(JSON.stringify(v.app)).not.toContain('a long password');
    expect(
      label(docker, 'traefik.http.middlewares.web-auth.basicauth.users'),
    ).toBe(`secure:${saved.users[0].hash}`);
    expect(saved.openPaths).toEqual(['/hook']);
  });

  it('keeps a saved password when only the list changes, and refuses to keep one that was never there', async () => {
    const { apps } = setup();
    await apps.create({ name: 'web' });
    const first = await apps.update('web', {
      basicAuth: { users: [{ name: 'a', password: 'password one' }] },
    });
    const hashA = first.app.basicAuth!.users[0].hash;
    const next = await apps.update('web', {
      basicAuth: {
        users: [
          { name: 'a', keep: true },
          { name: 'b', password: 'password two' },
        ],
      },
    });
    expect(next.app.basicAuth!.users.map((u) => u.name)).toEqual(['a', 'b']);
    expect(next.app.basicAuth!.users[0].hash).toBe(hashA);
    await expect(
      apps.update('web', {
        basicAuth: { users: [{ name: 'ghost', keep: true }] },
      }),
    ).rejects.toThrow(/no saved password/);
  });

  it('takes a hash that was already made (an import), and refuses a short password, a bad hash or a repeated user', async () => {
    const { apps } = setup();
    await apps.create({ name: 'web' });
    const hash = '$2a$10$' + 'b'.repeat(53);
    const v = await apps.update('web', {
      basicAuth: { users: [{ name: 'x', hash }] },
    });
    expect(v.app.basicAuth!.users[0].hash).toBe(hash);
    await expect(
      apps.update('web', {
        basicAuth: { users: [{ name: 'x', password: 'short' }] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps.update('web', {
        basicAuth: { users: [{ name: 'x', hash: 'plaintext' }] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps.update('web', {
        basicAuth: {
          users: [
            { name: 'x', password: 'password one' },
            { name: 'x', password: 'password two' },
          ],
        },
      }),
    ).rejects.toThrow(/only be listed once/);
    await expect(
      apps.update('web', {
        basicAuth: {
          users: [{ name: 'x', hash }],
          openPaths: ['/a`) || Host(`evil'],
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('takes the password off with null', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'web' });
    await apps.update('web', {
      basicAuth: { users: [{ name: 'a', password: 'password one' }] },
    });
    const v = await apps.update('web', { basicAuth: null });
    expect(v.app.basicAuth).toBeUndefined();
    expect(
      label(docker, 'traefik.http.middlewares.web-auth.basicauth.users'),
    ).toBeUndefined();
  });
});
