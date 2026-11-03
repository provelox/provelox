import { parseDocument } from 'yaml';
import { makeStack } from '../test-utils';
import { ValidationError } from '../common/errors';
import { planCompose } from './compose';

const fast = (s: ReturnType<typeof makeStack>) => {
  s.apps.adoptSettleMs = 0;
  s.apps.adoptPollMs = 1;
  s.apps.renamePollMs = 1;
};

const WEB = (name: string) =>
  `services:\n  ${name}:\n    image: acme/web:1\n    x-provelox:\n      expose: true\n      port: 80\n`;

/** A project with one exposed service whose owner has since set things the compose file cannot say */
async function deployed(s: ReturnType<typeof makeStack>, service = 'web') {
  await s.projects.deploy('shop', { compose: WEB(service), variables: {} });
  const name = `shop-${service}`;
  await s.apps.update(name, {
    domains: [
      { host: 'portal.one.example', ssl: true },
      { host: 'portal.two.example', ssl: false },
    ],
    primaryDomain: 'portal.one.example',
    forceSsl: true,
  });
  return name;
}

describe('what a later update of a project keeps', () => {
  it('keeps the password and the linked domain set in Networking, not only the addresses', async () => {
    const s = makeStack();
    const name = await deployed(s);
    const def = s.repo.get(name)!;
    s.repo.save({
      ...def,
      basicAuth: {
        users: [{ name: 'a', hash: `{SHA}${'A'.repeat(27)}=` }],
        openPaths: [],
      },
      linkedDomain: 'dns.example.com',
    });
    await s.projects.deploy('shop', { compose: WEB('web'), variables: {} });
    const after = s.repo.get(name)!;
    expect(after.basicAuth?.users).toHaveLength(1);
    expect(after.linkedDomain).toBe('dns.example.com');
    expect(after.domains.map((d) => d.host)).toEqual([
      'portal.one.example',
      'portal.two.example',
    ]);
  });
});

describe('renaming a service of a project', () => {
  it('without asking to keep it, the old app goes and the new one starts bare (the old behaviour)', async () => {
    const s = makeStack();
    fast(s);
    await deployed(s);
    await s.projects.deploy('shop', { compose: WEB('site'), variables: {} });
    expect(s.repo.get('shop-web')).toBeUndefined();
    expect(s.repo.get('shop-site')?.domains).toEqual([]);
  });

  it('with renames, the new service keeps the addresses, primary, HTTPS setting and the old name as an alias', async () => {
    const s = makeStack();
    fast(s);
    const old = await deployed(s);
    const res = await s.projects.deploy('shop', {
      compose: WEB('site'),
      variables: {},
      renames: { site: 'web' },
    });
    expect(res.renamed).toEqual([{ from: 'shop-web', to: 'shop-site' }]);
    expect(res.removed).toEqual([]);
    expect(s.repo.get(old)).toBeUndefined();
    const moved = s.repo.get('shop-site')!;
    expect(moved.project).toBe('shop');
    expect(moved.serviceAlias).toBe('site');
    // The default address followed the app's name, so the one people use is kept as an address of its own
    expect(moved.domains.map((d) => d.host)).toEqual([
      'shop-web.example.com',
      'portal.one.example',
      'portal.two.example',
    ]);
    expect(moved.primaryDomain).toBe('portal.one.example');
    expect(moved.forceSsl).toBe(true);
    expect(moved.aliases).toContain('shop-web');
    expect(s.docker.services.has('pvx-shop-site')).toBe(true);
    expect(s.docker.services.has('pvx-shop-web')).toBe(false);
  });

  it('carries deploy keys and usage history to the new name, and leaves the project pin alone', async () => {
    const s = makeStack();
    fast(s);
    await deployed(s);
    // the machine a project is held to is remembered by the project, so it needs no move
    s.settings.set('volumePins', {
      'project:shop': { id: 'n1', host: 'node-1' },
    });
    s.db.raw
      .prepare(
        "INSERT INTO ci_keys (id, name, app, secret_hash, created_at) VALUES ('k1','ci','shop-web','h','2026-01-01')",
      )
      .run();
    s.db.raw
      .prepare(
        "INSERT INTO usage_samples (app, at, cpu, mem) VALUES ('shop-web', 1, 1, 1)",
      )
      .run();
    await s.projects.deploy('shop', {
      compose: WEB('site'),
      variables: {},
      renames: { site: 'web' },
    });
    expect(
      s.db.raw.prepare("SELECT app FROM ci_keys WHERE id='k1'").get(),
    ).toEqual({ app: 'shop-site' });
    expect(
      s.db.raw.prepare('SELECT DISTINCT app FROM usage_samples').all(),
    ).toEqual([{ app: 'shop-site' }]);
    expect(s.settings.get('volumePins')).toEqual({
      'project:shop': { id: 'n1', host: 'node-1' },
    });
  });

  it('keeps the data of a service with a volume, even when the volume is renamed in the file', async () => {
    const s = makeStack();
    fast(s);
    const db = (svc: string, vol: string) =>
      `services:\n  ${svc}:\n    image: postgres:16\n    volumes:\n      - ${vol}:/var/lib/postgresql/data\nvolumes:\n  ${vol}:\n`;
    await s.projects.deploy('shop', {
      compose: db('db', 'pgdata'),
      variables: {},
    });
    await s.projects.deploy('shop', {
      compose: db('database', 'main'),
      variables: {},
      renames: { database: 'db' },
    });
    const moved = s.repo.get('shop-database')!;
    expect(moved.persistent).toBe(true);
    expect(moved.volumes[0].dockerName).toBe('pvx-shop-pgdata');
    const mount =
      s.docker.services.get('pvx-shop-database')?.TaskTemplate.ContainerSpec
        .Mounts[0];
    expect(mount.Source).toBe('pvx-shop-pgdata');
  });

  it('overlaps the new service with the old one when there is no data: the old one goes only after the new one is there', async () => {
    const s = makeStack();
    fast(s);
    const seen: boolean[] = [];
    const real = s.docker.removeService.bind(s.docker);
    s.docker.removeService = async (svc: string, app?: string) => {
      seen.push(s.docker.services.has('pvx-shop-site'));
      return real(svc, app as never);
    };
    await deployed(s);
    await s.projects.deploy('shop', {
      compose: WEB('site'),
      variables: {},
      renames: { site: 'web' },
    });
    expect(seen).toEqual([true]);
  });

  it('stops the old service first when it has data (a short gap)', async () => {
    const s = makeStack();
    fast(s);
    const db = (svc: string) =>
      `services:\n  ${svc}:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata:\n`;
    await s.projects.deploy('shop', { compose: db('db'), variables: {} });
    const seen: boolean[] = [];
    const real = s.docker.removeService.bind(s.docker);
    s.docker.removeService = async (svc: string, app?: string) => {
      seen.push(s.docker.services.has('pvx-shop-database'));
      return real(svc, app as never);
    };
    await s.projects.deploy('shop', {
      compose: db('database'),
      variables: {},
      renames: { database: 'db' },
    });
    expect(seen).toEqual([false]);
  });

  it('puts the old service back when the new one cannot start (data service)', async () => {
    const s = makeStack();
    fast(s);
    const db = (svc: string) =>
      `services:\n  ${svc}:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata:\n`;
    await s.projects.deploy('shop', { compose: db('db'), variables: {} });
    // the first thing a rename of a data service applies is the new service, once the old one is gone
    s.docker.failNextApply = new Error('no capacity');
    await expect(
      s.projects.deploy('shop', {
        compose: db('database'),
        variables: {},
        renames: { database: 'db' },
      }),
    ).rejects.toThrow();
    expect(s.repo.get('shop-db')).toBeDefined();
    expect(s.repo.get('shop-database')).toBeUndefined();
    expect(s.docker.services.has('pvx-shop-db')).toBe(true);
  });
});

describe('what renames refuses', () => {
  const fails = async (
    s: ReturnType<typeof makeStack>,
    compose: string,
    renames: Record<string, string>,
    message: RegExp,
  ) => {
    const run = () =>
      s.projects.deploy('shop', { compose, variables: {}, renames });
    await expect(run()).rejects.toThrow(ValidationError);
    await expect(run()).rejects.toThrow(message);
  };

  it('an old service that is not in the project', async () => {
    const s = makeStack();
    await deployed(s);
    await fails(s, WEB('site'), { site: 'ghost' }, /no service "ghost"/);
  });
  it('an old service the file still has', async () => {
    const s = makeStack();
    await deployed(s);
    const both = `${WEB('web')}  site:\n    image: acme/web:1\n`;
    await fails(s, both, { site: 'web' }, /still in the file/);
  });
  it('a new service that already exists', async () => {
    const s = makeStack();
    await s.projects.deploy('shop', {
      compose: `${WEB('web')}  site:\n    image: acme/web:1\n`,
      variables: {},
    });
    await fails(
      s,
      `services:\n  site:\n    image: acme/web:1\n`,
      { site: 'web' },
      /already exists/,
    );
  });
  it('two services renamed from the same old one', async () => {
    const s = makeStack();
    await deployed(s);
    await fails(
      s,
      `services:\n  a:\n    image: acme/web:1\n  b:\n    image: acme/web:1\n`,
      { a: 'web', b: 'web' },
      /more than one/,
    );
  });
  it('a service that is not in the file', async () => {
    const s = makeStack();
    await deployed(s);
    await fails(s, WEB('site'), { other: 'web' }, /no service "other"/);
  });
  it('a change between data and no data, which a service cannot make', async () => {
    const s = makeStack();
    await deployed(s);
    await fails(
      s,
      `services:\n  site:\n    image: pg:1\n    volumes:\n      - d:/data\nvolumes:\n  d:\n`,
      { site: 'web' },
      /persistent data/,
    );
  });
});

describe('suggestions for a rename in the preview', () => {
  it('one service removed and one added is suggested', async () => {
    const s = makeStack();
    await deployed(s);
    const p = s.projects.preview('shop', {
      compose: WEB('site'),
      variables: {},
    });
    expect(p.renameCandidates).toEqual([
      expect.objectContaining({ from: 'web', to: 'site' }),
    ]);
  });
  it('is applied only when asked: the diff shows a rename with its reason, and nothing is removed', async () => {
    const s = makeStack();
    await deployed(s);
    const p = s.projects.preview('shop', {
      compose: WEB('site'),
      variables: {},
      renames: { site: 'web' },
    });
    expect(p.renaming).toEqual([
      expect.objectContaining({
        from: 'web',
        to: 'site',
        app: 'shop-web',
        gap: false,
      }),
    ]);
    // what it keeps is listed for the review
    expect(p.renaming[0].keeps.domains.map((d) => d.host)).toEqual([
      'portal.one.example',
      'portal.two.example',
    ]);
    expect(p.changes.remove).toEqual([]);
    const d = p.diff.find((x) => x.service === 'site')!;
    expect(d.reasons[0]).toMatch(/renamed from web/);
    expect(p.diff.some((x) => x.action === 'remove')).toBe(false);
  });
  it('without the rename, the preview says the old service goes', async () => {
    const s = makeStack();
    await deployed(s);
    const p = s.projects.preview('shop', {
      compose: WEB('site'),
      variables: {},
    });
    expect(p.changes.remove).toEqual(['shop-web']);
    expect(p.diff.find((x) => x.action === 'remove')?.app).toBe('shop-web');
  });
  it('several removed and several added: paired by image, only when that is unambiguous', async () => {
    const s = makeStack();
    await s.projects.deploy('shop', {
      compose: `services:\n  a:\n    image: acme/api:1\n  b:\n    image: acme/worker:1\n`,
      variables: {},
    });
    const p = s.projects.preview('shop', {
      compose: `services:\n  api:\n    image: acme/api:2\n  jobs:\n    image: acme/worker:2\n`,
      variables: {},
    });
    expect(p.renameCandidates.map((c) => `${c.from}>${c.to}`).sort()).toEqual([
      'a>api',
      'b>jobs',
    ]);
    const ambiguous = s.projects.preview('shop', {
      compose: `services:\n  x:\n    image: acme/other:1\n  y:\n    image: acme/other:2\n`,
      variables: {},
    });
    expect(ambiguous.renameCandidates).toEqual([]);
  });
  it('nothing is suggested for a new project', () => {
    const s = makeStack();
    const p = s.projects.preview('fresh', {
      compose: WEB('web'),
      variables: {},
    });
    expect(p.renameCandidates).toEqual([]);
  });
});

describe('what the file made from running apps says about what is kept', () => {
  it('lists the addresses and settings the app keeps as a comment, which changes nothing in the file', async () => {
    const s = makeStack();
    await s.apps.create({ name: 'web' });
    await s.apps.update('web', {
      domains: [
        { host: 'portal.one.example', ssl: true },
        { host: 'portal.two.example', ssl: false },
      ],
      primaryDomain: 'portal.one.example',
      forceSsl: true,
    });
    await s.apps.deploy('web', 'acme/web:1');
    const r = await s.projects.groupApps(null, ['web']);
    expect(r.compose).toContain(
      '# Kept from the running app. These are set in Networking and Settings, not in this file:',
    );
    expect(r.compose).toContain(
      '# domains: portal.one.example (HTTPS, primary), portal.two.example',
    );
    expect(r.compose).toContain('# also: redirect to HTTPS');
    // it is only a comment: the file means what it meant
    const plan = planCompose(r.compose, 'shop', r.values);
    expect(plan.errors).toEqual([]);
    expect(plan.apps.map((a) => a.serviceAlias)).toEqual(['web']);
    // and the editor's Format button (the yaml library round trip) keeps it
    const formatted = parseDocument(r.compose).toString({
      indent: 2,
      lineWidth: 0,
    });
    expect(formatted).toContain(
      '# domains: portal.one.example (HTTPS, primary)',
    );
    expect(planCompose(formatted, 'shop', r.values).errors).toEqual([]);
  });

  it('says nothing for an app with nothing to keep, and reports what the moves keep', async () => {
    const s = makeStack();
    await s.apps.create({ name: 'plain' });
    await s.apps.deploy('plain', 'acme/web:1');
    const r = await s.projects.groupApps(null, ['plain']);
    expect(r.compose).not.toContain('Kept from the running app');
    expect(r.moves[0].keeps).toEqual({
      domains: [],
      primaryDomain: null,
      features: [],
    });
  });

  it('the review lists what each moving app keeps', async () => {
    const s = makeStack();
    fast(s);
    await s.apps.create({ name: 'web' });
    await s.apps.update('web', {
      domains: [{ host: 'portal.one.example', ssl: true }],
      primaryDomain: 'portal.one.example',
    });
    await s.apps.deploy('web', 'acme/web:1');
    const r = await s.projects.groupApps(null, ['web']);
    const p = s.projects.preview('shop', {
      compose: r.compose,
      variables: r.values,
      adopt: r.adopt,
    });
    expect(p.adopting[0].keeps.domains).toEqual([
      { host: 'portal.one.example', ssl: true },
    ]);
    expect(p.adopting[0].keeps.primaryDomain).toBe('portal.one.example');
  });
});
