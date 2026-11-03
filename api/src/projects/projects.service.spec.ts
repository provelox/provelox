import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';

const FILE = `
services:
  web:
    image: acme/web:1
    ports: ["8080:3000"]
    depends_on: [db]
  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
`;
import { TEMPLATES } from '../templates/catalog';

const input = (compose = FILE, variables = {}) => ({ compose, variables });

describe('ProjectsService.deploy', () => {
  it('creates a network and one app per service, with no group of their own, dependencies first', async () => {
    const { projects, docker, repo, groups } = makeStack();
    const r = await projects.deploy('shop', input());
    expect(r.apps).toEqual([
      { name: 'shop-db', action: 'created' },
      { name: 'shop-web', action: 'created' },
    ]);
    expect(docker.calls.filter((c) => c.startsWith('apply:'))).toEqual([
      'apply:pvx-shop-db',
      'apply:pvx-shop-web',
    ]);
    expect(docker.networks.has('pvx-net-shop')).toBe(true);
    expect(groups.list()).toEqual([]);
    expect(repo.get('shop-db')).toMatchObject({
      project: 'shop',
      persistent: true,
      serviceAlias: 'db',
    });
  });

  it('puts every service on the project network under its compose name', async () => {
    const { projects, docker } = makeStack();
    await projects.deploy('shop', input());
    const nets = docker.services.get('pvx-shop-web')?.TaskTemplate.Networks;
    expect(nets).toContainEqual({ Target: 'pvx-net-shop', Aliases: ['web'] });
  });

  it('refuses a file with errors and changes nothing', async () => {
    const { projects, docker, repo } = makeStack();
    await expect(
      projects.deploy(
        'shop',
        input('services:\n  a:\n    image: x\n    privileged: true'),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(docker.services.size).toBe(0);
    expect(repo.list()).toEqual([]);
  });

  it('will not overwrite an unrelated app with the same name', async () => {
    const { projects, apps, docker } = makeStack();
    await apps.create({ name: 'shop-web' });
    await expect(projects.deploy('shop', input())).rejects.toBeInstanceOf(
      ValidationError,
    );
    // nothing of the project was created, and the other app is intact
    expect(docker.services.has('pvx-shop-db')).toBe(false);
    expect(apps.getDefinition('shop-web').project).toBeUndefined();
  });

  it('does not touch a Docker service it does not own', async () => {
    const { projects, docker } = makeStack();
    docker.addForeignService('pvx-shop-db', {});
    await expect(projects.deploy('shop', input())).rejects.toThrow(
      /is not app shop-db/,
    );
    expect(docker.services.get('pvx-shop-db')?.Labels).toEqual({});
  });

  it('warns when a dependency never starts, but still deploys', async () => {
    const { projects, docker } = makeStack();
    docker.statusOverride = (name) =>
      name === 'pvx-shop-db'
        ? { desired: 1, running: 0, state: 'starting' }
        : { desired: 1, running: 1, state: 'running' };
    const r = await projects.deploy('shop', input());
    expect(r.apps).toHaveLength(2);
    expect(r.warnings.map((w) => w.message).join()).toMatch(
      /"shop-db" was not running/,
    );
  });

  it('rejects an invalid project name', async () => {
    await expect(
      makeStack().projects.deploy('Bad_Name', input()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ProjectsService: redeploying', () => {
  it('updates changed services, adds new ones and removes dropped ones', async () => {
    const { projects, docker, repo } = makeStack();
    await projects.deploy('shop', input());
    const next = `
services:
  web:
    image: acme/web:2
  cache:
    image: redis:7
`;
    const r = await projects.deploy('shop', input(next));
    expect(r.apps.map((a) => `${a.name}:${a.action}`).sort()).toEqual([
      'shop-cache:created',
      'shop-web:updated',
    ]);
    expect(r.removed).toEqual(['shop-db']);
    expect(docker.services.has('pvx-shop-db')).toBe(false);
    expect(repo.get('shop-db')).toBeUndefined();
    expect(
      docker.services.get('pvx-shop-web')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('acme/web:2');
  });

  it('bumps the version only when the image changed', async () => {
    const { projects, repo } = makeStack();
    await projects.deploy('shop', input());
    await projects.deploy('shop', input());
    expect(repo.get('shop-web')?.deployVersion).toBe(0);
    await projects.deploy(
      'shop',
      input(FILE.replace('acme/web:1', 'acme/web:2')),
    );
    expect(repo.get('shop-web')).toMatchObject({
      deployVersion: 1,
      image: 'acme/web:2',
    });
  });

  it('keeps what the user configured on an app (domains, exposure)', async () => {
    const { projects, apps } = makeStack();
    await projects.deploy('shop', input());
    await apps.update('shop-web', {
      exposed: true,
      domains: [{ host: 'shop.org', ssl: false }],
    });
    await projects.deploy(
      'shop',
      input(FILE.replace('acme/web:1', 'acme/web:2')),
    );
    expect(apps.getDefinition('shop-web')).toMatchObject({
      exposed: true,
      domains: [{ host: 'shop.org', ssl: false }],
    });
  });

  it('refuses to change whether a service keeps data', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', input());
    const noVolume =
      'services:\n  web:\n    image: acme/web:1\n  db:\n    image: postgres:16';
    await expect(
      projects.deploy('shop', input(noVolume)),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('previews changes without touching anything', async () => {
    const { projects, docker } = makeStack();
    await projects.deploy('shop', input());
    const calls = docker.calls.length;
    const p = projects.preview(
      'shop',
      input(
        'services:\n  web:\n    image: acme/web:2\n  cache:\n    image: redis',
      ),
    );
    expect(p.changes).toEqual({
      create: ['shop-cache'],
      update: ['shop-web'],
      remove: ['shop-db'],
    });
    expect(p.errors).toEqual([]);
    expect(docker.calls.length).toBe(calls);
  });

  it('previews errors and conflicts', async () => {
    const { projects, apps } = makeStack();
    await apps.create({ name: 'shop-web' });
    const p = projects.preview('shop', input());
    expect(p.errors.map((e) => e.message).join()).toMatch(
      /already exists and is not part of this project/,
    );
    expect(
      projects.preview('shop', input('services:\n  a:\n    build: .')).errors
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('ProjectsService.get: connecting to a template', () => {
  const redis = TEMPLATES.find((t) => t.id === 'redis')!;

  it('says how to connect to a project that is a template, with the values it was given', async () => {
    const { projects } = makeStack();
    await projects.deploy(
      'cache',
      input(redis.compose, { REDIS_PASSWORD: 'p@w/ 1' }),
    );
    const t = (await projects.get('cache')).template!;
    expect(t.id).toBe('redis');
    expect(t.variables[0]).toMatchObject({
      key: 'REDIS_PASSWORD',
      value: 'p@w/ 1',
      where: 'its command',
    });
    expect(t.connection).toMatchObject({
      host: 'cache-redis',
      hostInProject: 'redis',
      port: 6379,
      url: 'redis://:p%40w%2F%201@cache-redis:6379',
    });
  });

  it('has no template for a project that is not one', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', input());
    expect((await projects.get('shop')).template).toBeNull();
  });
});

describe('ProjectsService.remove', () => {
  it('removes services and network, keeps volumes, and ', async () => {
    const { projects, docker, groups, repo } = makeStack();
    await projects.deploy('shop', input());
    const r = await projects.remove('shop');
    expect(r.removed.sort()).toEqual(['shop-db', 'shop-web']);
    expect(r.keptVolumes).toEqual(['pvx-shop-pgdata']);
    expect(docker.services.size).toBe(0);
    expect(docker.networks.has('pvx-net-shop')).toBe(false);
    expect(repo.list()).toEqual([]);
    expect(groups.list()).toEqual([]);
    await expect(projects.get('shop')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes the data volumes too when asked', async () => {
    const { projects, docker } = makeStack();
    projects.volumeRetryMs = 0;
    await projects.deploy('shop', input());
    expect(docker.volumes.has('pvx-shop-pgdata')).toBe(true);
    const r = await projects.remove('shop', { deleteVolumes: true });
    expect(r.deletedVolumes).toEqual(['pvx-shop-pgdata']);
    expect(r.keptVolumes).toEqual([]);
    expect(docker.volumes.has('pvx-shop-pgdata')).toBe(false);
  });

  it('keeps a volume Docker will not release, and says so', async () => {
    const { projects, docker } = makeStack();
    projects.volumeRetryMs = 0;
    projects.volumeRetries = 2;
    await projects.deploy('shop', input());
    docker.removeVolume = async () => {
      throw new Error('volume is in use');
    };
    const r = await projects.remove('shop', { deleteVolumes: true });
    expect(r.deletedVolumes).toEqual([]);
    expect(r.keptVolumes).toEqual(['pvx-shop-pgdata']);
  });

  it('404s for unknown projects', async () => {
    await expect(makeStack().projects.remove('nope')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('removes the services a failed deploy left behind, though the project was never saved', async () => {
    const { projects, docker, repo } = makeStack();
    const apply = docker.applyService.bind(docker);
    docker.applyService = async (spec, ...rest) => {
      if (spec.Name === 'pvx-shop-web') throw new Error('pull access denied');
      return apply(spec, ...rest);
    };
    await expect(projects.deploy('shop', input())).rejects.toThrow();
    expect(repo.byProject('shop').length).toBeGreaterThan(0);
    await projects.remove('shop');
    expect(repo.byProject('shop')).toEqual([]);
  });

  it("does not remove a network that is not the project's", async () => {
    const { projects, docker } = makeStack();
    await projects.deploy('shop', input());
    docker.networks.set('pvx-net-shop', {
      'io.provelox.managed': 'true',
      'io.provelox.project': 'other',
    });
    await expect(projects.remove('shop')).rejects.toThrow(/not/i);
  });
});

describe('ProjectsService.get/list', () => {
  it('lists projects with their apps and returns the stored file', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', input(FILE, { DB_PASS: 'p4ss-v4lue-xyz' }));
    expect(projects.list()).toMatchObject([
      { name: 'shop', apps: expect.arrayContaining(['shop-web', 'shop-db']) },
    ]);
    const g = await projects.get('shop');
    expect(g.compose).toBe(FILE);
    expect(g.variableNames).toEqual(['DB_PASS']);
    expect(g.apps).toHaveLength(2);
    // variable values are never stored
    expect(JSON.stringify(g)).not.toContain('p4ss-v4lue-xyz');
  });
});

describe('ProjectsService.dropProjectGroups', () => {
  it('removes the group an older version made for a project, and nothing else', async () => {
    const { projects, apps, groups, repo } = makeStack();
    await projects.deploy('shop', input());
    const old = groups.create('shop');
    for (const n of ['shop-db', 'shop-web'])
      repo.save({ ...repo.get(n)!, groupId: old.id });
    const mine = groups.create('Mine');
    await apps.create({ name: 'extra', groupId: mine.id });
    const shared = groups.create('Shared');
    await apps.create({ name: 'loose', groupId: shared.id });
    expect(projects.dropProjectGroups()).toEqual(['shop']);
    expect(groups.list().map((g) => g.name)).toEqual(['Mine', 'Shared']);
    expect(repo.get('shop-web')?.groupId).toBeNull();
  });

  it('keeps a project-named group that holds other apps', async () => {
    const { projects, apps, groups } = makeStack();
    await projects.deploy('shop', input());
    const g = groups.create('shop');
    await apps.create({ name: 'extra', groupId: g.id });
    expect(projects.dropProjectGroups()).toEqual([]);
  });
});

describe('ProjectsService.preview: what an update would do', () => {
  const FILE2 = `
services:
  web:
    image: acme/web:\${TAG:-1}
    environment:
      SECRET_KEY: \${SECRET_KEY}
    depends_on: [db]
  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
  extra:
    image: acme/extra:1
volumes:
  pgdata:
`;
  const run = (vars: Record<string, string>) => input(FILE2, vars);

  it('tells which services restart, which are new, and which stay as they are', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', run({ SECRET_KEY: 'k1' }));
    const v = projects.preview(
      'shop',
      input(FILE2.replace('acme/extra:1', 'acme/extra:2') + '', {
        SECRET_KEY: 'k1',
        TAG: '2',
      }),
    );
    const by = Object.fromEntries(v.diff.map((d) => [d.service, d]));
    expect(by.db.action).toBe('unchanged');
    expect(by.web).toMatchObject({
      action: 'restart',
      reasons: ['image acme/web:1 → acme/web:2'],
    });
    expect(by.extra).toMatchObject({ action: 'restart' });
  });

  it('flags a secret that differs from the running one, without showing either value', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', run({ SECRET_KEY: 'correct-value' }));
    const v = projects.preview('shop', run({ SECRET_KEY: 'mistyped-value' }));
    const web = v.diff.find((d) => d.service === 'web');
    expect(web?.secretsChanged).toEqual(['SECRET_KEY']);
    expect(JSON.stringify(v.diff)).not.toMatch(/correct-value|mistyped-value/);
  });

  it('reports a change that cannot be made (volumes appearing) in the preview, not only at deploy', async () => {
    const { projects } = makeStack();
    await projects.deploy('shop', input(FILE));
    const v = projects.preview(
      'shop',
      input(
        FILE.replace('    volumes: ["pgdata:/var/lib/postgresql/data"]\n', ''),
      ),
    );
    expect(v.errors.map((e) => e.message).join()).toMatch(/cannot change/);
  });
});

describe('ProjectsService.get: values read back from a pasted file', () => {
  const FILE3 = `
x-provelox:
  variables:
    JWT_SECRET: { secret: true, minLength: 8, label: Sign-in secret }
services:
  api:
    image: acme/api:1
    environment:
      JWT_SECRET: \${JWT_SECRET:?needed}
      URL: https://\${HOST}/app
      MODE: \${MODE:-live}
`;
  it('finds a value wherever the file gives the variable a whole entry to itself', async () => {
    const { projects } = makeStack();
    await projects.deploy(
      'shop',
      input(FILE3, { JWT_SECRET: 'abcdefghij', HOST: 'h.example' }),
    );
    const v = (await projects.get('shop')).variables;
    const by = Object.fromEntries(v.map((x) => [x.key, x]));
    expect(by.JWT_SECRET).toMatchObject({
      value: 'abcdefghij',
      kind: 'secret',
      label: 'Sign-in secret',
      where: 'the environment variable JWT_SECRET',
    });
    // MODE had a fallback and was left empty: the running service holds the fallback
    expect(by.MODE.value).toBe('live');
    // HOST sits inside a longer value, so it cannot be told apart from the rest
    expect(by.HOST.value).toBeNull();
  });
});

describe('ProjectsService.get: an image variable is read back from the running service', () => {
  it('reads `image: ${IMG}` from what the service runs', async () => {
    const { projects } = makeStack();
    await projects.deploy(
      'shop',
      input('services:\n  web:\n    image: ${WEB_IMAGE:?needed}\n', {
        WEB_IMAGE: 'acme/web:7',
      }),
    );
    const v = (await projects.get('shop')).variables.find(
      (x) => x.key === 'WEB_IMAGE',
    );
    expect(v).toMatchObject({ value: 'acme/web:7', where: 'its image' });
  });
});
