import { makeStack } from '../test-utils';
import { ValidationError } from '../common/errors';
import { groupingProblems } from './adopt';

/** An app that already runs: a web app, and a database with data */
async function standalone(stack: ReturnType<typeof makeStack>) {
  const { apps } = stack;
  await apps.create({ name: 'web' });
  await apps.update('web', {
    env: [
      { key: 'MODE', value: 'prod' },
      { key: 'API_KEY', value: 's3cret' },
    ],
    domains: [{ host: 'web.example.com', ssl: false }],
  });
  await apps.deploy('web', 'acme/web:1');
  await apps.create({ name: 'db', persistent: true });
  await apps.update('db', {
    volumes: [{ containerPath: '/var/lib/data', volumeName: 'data' }],
    exposed: false,
  });
  await apps.deploy('db', 'postgres:16');
}

const fast = (s: ReturnType<typeof makeStack>) => {
  s.apps.adoptSettleMs = 0;
  s.apps.adoptPollMs = 1;
  s.apps.renamePollMs = 1;
};

describe('moving apps into a project', () => {
  it('describes the apps as compose services: secrets become variables, the data keeps its mount', async () => {
    const s = makeStack();
    await standalone(s);
    const r = await s.projects.groupApps(null, ['web', 'db']);
    expect(r.adopt).toEqual({ web: 'web', db: 'db' });
    expect(r.compose).toContain('image: acme/web:1');
    expect(r.compose).toContain('API_KEY: ${API_KEY}');
    expect(r.compose).not.toContain('s3cret');
    expect(r.compose).toContain('data:/var/lib/data');
    expect(r.values).toEqual({ API_KEY: 's3cret' });
    expect(r.moves).toEqual([
      expect.objectContaining({ app: 'web', service: 'web', gap: false }),
      expect.objectContaining({ app: 'db', service: 'db', gap: true }),
    ]);
  });

  it('keeps the data: the new app mounts the volume the old one had', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    const r = await s.projects.groupApps(null, ['db']);
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(s.repo.get('db')).toBeUndefined();
    const moved = s.repo.get('shop-db');
    expect(moved).toMatchObject({ project: 'shop', persistent: true });
    expect(moved?.volumes[0].dockerName).toBe('pvx-db-data');
    expect(moved?.aliases).toContain('db');
    const mount =
      s.docker.services.get('pvx-shop-db')?.TaskTemplate.ContainerSpec
        .Mounts[0];
    expect(mount.Source).toBe('pvx-db-data');
    expect(s.docker.services.has('pvx-db')).toBe(false);
  });

  it('keeps the data through a later update of the project', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    const r = await s.projects.groupApps(null, ['db']);
    const body = { compose: r.compose, variables: r.values, adopt: r.adopt };
    await s.projects.deploy('shop', body);
    // the project is deployed again from its file, with nothing about moving in it
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
    });
    const mount =
      s.docker.services.get('pvx-shop-db')?.TaskTemplate.ContainerSpec
        .Mounts[0];
    expect(mount.Source).toBe('pvx-db-data');
    expect(s.repo.get('shop-db')?.aliases).toContain('db');
  });

  it('keeps the address and settings the compose file cannot say', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    const r = await s.projects.groupApps(null, ['web']);
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(s.repo.get('shop-web')).toMatchObject({
      exposed: true,
      domains: [{ host: 'web.example.com' }],
    });
  });

  it('keeps the default address, which would otherwise follow the new name', async () => {
    const s = makeStack();
    fast(s);
    s.settings.set('appsDomain', 'apps.example.com');
    await s.apps.create({ name: 'site', defaultSubdomain: true });
    await s.apps.deploy('site', 'nginx:1');
    const r = await s.projects.groupApps(null, ['site']);
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    const moved = s.repo.get('shop-site');
    expect(moved?.defaultSubdomain).toBe(false);
    expect(moved?.domains.map((d) => d.host)).toEqual([
      'site.apps.example.com',
    ]);
  });

  it('starts a web app beside the old one, unrouted, and only then removes the old', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    s.docker.calls.length = 0;
    const r = await s.projects.groupApps(null, ['web']);
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    const order = s.docker.calls.filter(
      (c) => c.startsWith('apply:pvx-shop-web') || c.includes('remove'),
    );
    expect(order[0]).toBe('apply:pvx-shop-web');
    expect(order.at(-1)).toMatch(/remove.*pvx-web/);
    expect(s.docker.services.has('pvx-web')).toBe(false);
  });

  it('moves an app with data last, after everything else is up', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    s.docker.calls.length = 0;
    const r = await s.projects.groupApps(null, ['db', 'web']);
    const res = await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(res.apps.map((a) => a.name)).toEqual(['shop-web', 'shop-db']);
  });

  it('adds apps to a project that exists, keeping what it has', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    await s.projects.deploy('shop', {
      compose: 'services:\n  cache:\n    image: redis:7\n',
      variables: {},
    });
    const r = await s.projects.groupApps('shop', ['web']);
    expect(r.compose).toContain('cache:');
    expect(r.compose).toContain('web:');
    await s.projects.deploy('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(
      s.repo
        .byProject('shop')
        .map((a) => a.name)
        .sort(),
    ).toEqual(['shop-cache', 'shop-web']);
  });

  it("reports what the project's own services run with, so adding apps does not blank them", async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    await s.projects.deploy('shop', {
      compose:
        'services:\n  cache:\n    image: redis:7\n    environment:\n      API_TOKEN: ${API_TOKEN}\n',
      variables: { API_TOKEN: 'keep-me-1234567890' },
    });
    const r = await s.projects.groupApps('shop', ['web']);
    expect(r.running.API_TOKEN).toBe('keep-me-1234567890');
    // A new project has nothing running yet
    expect((await s.projects.groupApps(null, ['web'])).running).toEqual({});
  });

  it('shows in the preview which apps move and which have a gap, and changes nothing', async () => {
    const s = makeStack();
    await standalone(s);
    const r = await s.projects.groupApps(null, ['web', 'db']);
    const view = s.projects.preview('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(view.errors).toEqual([]);
    expect(view.adopting).toEqual([
      expect.objectContaining({
        service: 'web',
        app: 'web',
        to: 'shop-web',
        gap: false,
      }),
      expect.objectContaining({
        service: 'db',
        app: 'db',
        to: 'shop-db',
        gap: true,
      }),
    ]);
    // the web app has an address of its own, which the move keeps
    expect(view.adopting[0].keeps.domains).toEqual([
      { host: 'web.example.com', ssl: false },
    ]);
    expect(s.repo.get('web')).toBeDefined();
    expect(s.repo.get('shop-web')).toBeUndefined();
  });

  it('refuses what a project cannot hold, naming the reason', async () => {
    const s = makeStack();
    await s.apps.create({ name: 'dirs', persistent: true });
    await s.apps.update('dirs', {
      volumes: [{ containerPath: '/in', hostPath: '/srv/in' }],
    });
    await s.apps.deploy('dirs', 'x/y:1');
    await expect(s.projects.groupApps(null, ['dirs'])).rejects.toThrow(
      ValidationError,
    );
    expect(groupingProblems(s.apps.getDefinition('dirs'))[0]).toMatch(
      /directory of the server/,
    );
  });

  it('puts the old app back when the data app cannot start in the project', async () => {
    const s = makeStack();
    fast(s);
    await standalone(s);
    const r = await s.projects.groupApps(null, ['db']);
    const real = s.docker.applyService.bind(s.docker);
    let n = 0;
    s.docker.applyService = (async (...a: Parameters<typeof real>) => {
      if (String(a[0].Name) === 'pvx-shop-db' && n++ === 0)
        throw new Error('boom');
      return real(...a);
    }) as typeof real;
    await expect(
      s.projects.deploy('shop', {
        compose: r.compose,
        variables: r.values,
        adopt: r.adopt,
      }),
    ).rejects.toThrow('boom');
    expect(s.repo.get('db')).toBeDefined();
    expect(s.docker.services.has('pvx-db')).toBe(true);
  });
});
