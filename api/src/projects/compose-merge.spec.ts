import { parse } from 'yaml';
import { ValidationError } from '../common/errors';
import { TEMPLATES, templateById } from '../templates/catalog';
import { makeStack } from '../test-utils';
import { addService, mergeTemplate } from './compose-merge';

const BASE = `# my shop
services:
  web:
    image: nginx:alpine
    environment:
      DB_HOST: postgres
      DB_PASSWORD: \${POSTGRES_PASSWORD}
volumes:
  pgdata:
`;

const js = (c: string) => parse(c) as Record<string, any>;

describe('mergeTemplate', () => {
  it('adds the template and keeps the file as it was, comments included', () => {
    const r = mergeTemplate(
      'services:\n  web:\n    image: nginx # the site\n',
      templateById('redis')!,
    );
    expect(r.services).toEqual(['redis']);
    expect(r.compose).toContain('# the site');
    expect(js(r.compose).services.web.image).toBe('nginx');
    expect(js(r.compose).services.redis.image).toMatch(/redis/);
    expect(r.renamed).toEqual([]);
  });

  it('generates secrets and takes defaults for the new variables', () => {
    const r = mergeTemplate('services: {}\n', templateById('postgres')!);
    expect(r.values.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(r.values.POSTGRES_USER).toBe('postgres');
  });

  it('renames a service, a volume and a variable that would clash, and says so', () => {
    const r = mergeTemplate(BASE, templateById('postgres')!);
    const c = js(r.compose);
    expect(Object.keys(c.services)).toEqual(['web', 'postgres']);
    // postgres is new here, but its volume and its variables are not
    expect(r.renamed.filter((x) => x.kind === 'volume')).toEqual([
      { kind: 'volume', from: 'pgdata', to: 'pgdata-2' },
    ]);
    expect(c.services.postgres.volumes[0]).toMatch(/^pgdata-2:/);
    expect(r.renamed).toContainEqual({
      kind: 'variable',
      from: 'POSTGRES_PASSWORD',
      to: 'POSTGRES_POSTGRES_PASSWORD',
    });
    // the project's own use of the variable is untouched, and the new one has its own value
    expect(c.services.web.environment.DB_PASSWORD).toBe('${POSTGRES_PASSWORD}');
    expect(c.services.postgres.environment.POSTGRES_PASSWORD).toBe(
      '${POSTGRES_POSTGRES_PASSWORD}',
    );
    expect(r.values.POSTGRES_POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('can be added twice: each time gets its own names', () => {
    let c = 'services: {}\n';
    for (let i = 0; i < 3; i++)
      c = mergeTemplate(c, templateById('postgres')!).compose;
    expect(Object.keys(js(c).services)).toEqual([
      'postgres',
      'postgres-2',
      'postgres-3',
    ]);
    expect(Object.keys(js(c).volumes)).toEqual([
      'pgdata',
      'pgdata-2',
      'pgdata-3',
    ]);
  });

  it('follows a renamed service in depends_on and in the hosts other services use', () => {
    const wp = templateById('wordpress')!;
    const base =
      'services:\n  db:\n    image: mariadb\n  site:\n    image: x\n';
    const c = js(mergeTemplate(base, wp).compose);
    const names = Object.keys(c.services);
    const db2 = names.find((n) => /^db-2$/.test(n));
    expect(db2).toBeDefined();
    const wpName = names.find(
      (n) => n !== 'db' && n !== 'site' && n !== 'db-2',
    )!;
    expect(JSON.stringify(c.services[wpName].environment)).toContain('db-2');
    if (c.services[wpName].depends_on)
      expect(JSON.stringify(c.services[wpName].depends_on)).toContain('db-2');
  });

  it('every built-in template merges into an empty project and stays valid YAML', () => {
    for (const t of TEMPLATES) {
      const r = mergeTemplate('services: {}\n', t);
      expect(Object.keys(js(r.compose).services).length).toBeGreaterThan(0);
    }
  });
});

describe('addService', () => {
  it('adds a service with a volume and a public port', () => {
    const r = addService(BASE, {
      name: 'api',
      image: 'ghcr.io/acme/api:1.2',
      port: 3000,
      expose: true,
      env: [{ key: 'LOG_LEVEL', value: 'debug' }],
      volumePath: '/data',
    });
    const s = js(r.compose).services.api;
    expect(s).toMatchObject({
      image: 'ghcr.io/acme/api:1.2',
      restart: 'unless-stopped',
      environment: { LOG_LEVEL: 'debug' },
      volumes: ['api-data:/data'],
      'x-provelox': { expose: true, port: 3000 },
    });
    expect(Object.keys(js(r.compose).volumes)).toEqual(['pgdata', 'api-data']);
    expect(r.compose).toContain('# my shop');
  });

  it('keeps secret-looking values out of the file, as variables', () => {
    const r = addService(BASE, {
      name: 'api',
      image: 'x',
      env: [
        { key: 'API_TOKEN', value: 'abc123' },
        { key: 'POSTGRES_PASSWORD', value: 'pw' },
        { key: 'PRICE', value: '$5' },
      ],
    });
    expect(r.compose).not.toContain('abc123');
    const env = js(r.compose).services.api.environment;
    expect(env.API_TOKEN).toBe('${API_TOKEN}');
    expect(env.POSTGRES_PASSWORD).toBe('${API_POSTGRES_PASSWORD}');
    expect(env.PRICE).toBe('$$5');
    expect(r.values).toEqual({
      API_TOKEN: 'abc123',
      API_POSTGRES_PASSWORD: 'pw',
    });
  });

  it('refuses a clashing name, a bad image, and an expose without a port', () => {
    expect(() => addService(BASE, { name: 'web', image: 'x' })).toThrow(
      /already/,
    );
    expect(() => addService(BASE, { name: 'a', image: 'x y' })).toThrow(
      ValidationError,
    );
    expect(() =>
      addService(BASE, { name: 'a', image: 'x', expose: true }),
    ).toThrow(/port/);
    expect(() =>
      addService(BASE, { name: 'a', image: 'x', volumePath: '/a/../b' }),
    ).toThrow(/\.\./);
  });
});

describe('adding to a deployed project', () => {
  const FILE = 'services:\n  web:\n    image: nginx:alpine\n';

  it('a merged template deploys as an update, leaving the existing service alone', async () => {
    const { projects, docker } = makeStack();
    await projects.deploy('shop', { compose: FILE, variables: {} });
    const m = projects.addTemplate('shop', 'redis');
    const res = await projects.deploy('shop', {
      compose: m.compose,
      variables: m.values,
    });
    expect(res.apps.map((a) => [a.name, a.action])).toEqual(
      expect.arrayContaining([['shop-redis', 'created']]),
    );
    expect(docker.services.has('pvx-shop-redis')).toBe(true);
    expect(docker.services.has('pvx-shop-web')).toBe(true);
  });

  it('an added service deploys the same way', async () => {
    const { projects, docker } = makeStack();
    await projects.deploy('shop', { compose: FILE, variables: {} });
    const m = projects.addService('shop', {
      name: 'cache',
      image: 'redis:7',
      volumePath: '/data',
    });
    await projects.deploy('shop', { compose: m.compose, variables: m.values });
    expect(docker.services.has('pvx-shop-cache')).toBe(true);
  });

  it('404s for unknown projects and templates', async () => {
    const { projects } = makeStack();
    expect(() => projects.addTemplate('nope', 'redis')).toThrow(/no project/);
    await projects.deploy('shop', { compose: FILE, variables: {} });
    expect(() => projects.addTemplate('shop', 'nope')).toThrow(
      /no such template/,
    );
  });
});
