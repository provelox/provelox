/**
 * Real Traefik on a real Swarm (opt in with PVX_DOCKER_TESTS=1). Traefik listens on spare ports so it cannot clash
 * with another proxy on the host; every resource is pvxtest-* and removed afterwards.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { AppsRepo } from '../src/apps/apps.repo';
import { AppsService } from '../src/apps/apps.service';
import { SsoService } from '../src/sso/sso.service';
import { CdnService } from '../src/cdn/cdn.service';
import { loadConfig } from '../src/config/config';
import { Db } from '../src/db/db';
import { DockerodeAdapter } from '../src/docker/dockerode.adapter';
import { GroupsService } from '../src/groups/groups.service';
import { ProxyService } from '../src/proxy/proxy.service';
import { PlaceholderService } from '../src/system/placeholder.service';
import { CiKeysService } from '../src/ci/ci-keys.service';
import { RegistriesService } from '../src/registries/registries.service';
import { SettingsService } from '../src/system/settings.service';

jest.setTimeout(420_000);

const HTTP_PORT = 18080;
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
const ROOT = 'pvxtest.localhost';

/** GET through Traefik with a chosen Host header */
function get(
  host: string,
  path = '/',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        path,
        headers: { Host: host },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

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

describe('Traefik routing on a real Swarm', () => {
  const cfg = loadConfig({
    JWT_SECRET: 'x'.repeat(40),
    DATA_DIR: ':memory:',
    ROOT_DOMAIN: ROOT,
    PLACEHOLDER_IMAGE: 'nginx:alpine',
    PROXY_HTTP_PORT: String(HTTP_PORT),
    PROXY_HTTPS_PORT: '18443',
    ERROR_PAGES_SERVICE: `${P}-errs@swarm`,
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
  const proxy = new ProxyService(settings, adapter, cfg, cdn);

  const images = ['traefik:v3.6', 'traefik/whoami:latest', 'nginx:alpine'];
  const had = new Map(
    images.map((i) => [i, !!tryDocker('image', 'inspect', i)]),
  );
  const hadSharedNetwork = !!tryDocker(
    'network',
    'ls',
    '--filter',
    'name=^provelox-net$',
    '-q',
  );
  const hadTraefik = !!tryDocker(
    'service',
    'ls',
    '--filter',
    'name=^pvx-traefik$',
    '-q',
  );
  const running = (name: string) => async () =>
    (await adapter.serviceStatus(name))?.state === 'running';

  beforeAll(() => {
    if (hadTraefik)
      throw new Error(
        'A pvx-traefik service already exists on this Docker: refusing to run this test over it',
      );
  });

  afterAll(async () => {
    for (const s of tryDocker(
      'service',
      'ls',
      '--filter',
      'label=io.provelox.managed=true',
      '--format',
      '{{.Name}}',
    ).split('\n'))
      if (s.startsWith(`pvx-${P}`) || s === 'pvx-traefik')
        tryDocker('service', 'rm', s);
    await sleep(6000);
    for (let i = 0; i < 12; i++) {
      for (const v of tryDocker('volume', 'ls', '--format', '{{.Name}}').split(
        '\n',
      ))
        if (v === 'pvx-traefik-certs' || v.startsWith(`pvx-${P}`))
          tryDocker('volume', 'rm', v);
      if (
        !tryDocker('volume', 'ls', '-q', '--filter', 'name=pvx-traefik-certs')
      )
        break;
      await sleep(3000);
    }
    for (const c of tryDocker('config', 'ls', '--format', '{{.Name}}').split(
      '\n',
    ))
      if (c.startsWith('pvx-placeholder-')) tryDocker('config', 'rm', c);
    if (!hadSharedNetwork) tryDocker('network', 'rm', 'provelox-net');
    for (const [image, existed] of had)
      if (!existed)
        for (let i = 0; i < 6 && tryDocker('image', 'inspect', image); i++) {
          tryDocker('image', 'rm', image);
          await sleep(3000);
        }
    db.close();
  });

  it('starts Traefik as a managed service', async () => {
    await proxy.ensure();
    await until('traefik to run', running('pvx-traefik'));
    const labels = JSON.parse(
      docker(
        'service',
        'inspect',
        'pvx-traefik',
        '--format',
        '{{json .Spec.Labels}}',
      ),
    );
    expect(labels['io.provelox.app']).toBe('traefik');
    // a second ensure() updates in place
    expect(await proxy.ensure()).toBe('updated');
  });

  it('routes an app by its hostname, showing the placeholder page until it is deployed', async () => {
    // the error-pages stand-in is an ordinary app; whoami echoes the request path it is asked for
    await apps.create({ name: `${P}-errs` });
    await apps.deploy(`${P}-errs`, 'traefik/whoami:latest');
    await apps.create({ name: `${P}-site` });
    await until(
      'both apps to run',
      async () =>
        (await running(`pvx-${P}-site`)()) &&
        (await running(`pvx-${P}-errs`)()),
    );
    const r = await until('the placeholder page through Traefik', async () => {
      const res = await get(`${P}-site.${ROOT}`);
      return (
        res.status === 200 &&
        res.body.includes('ready for its first deploy') &&
        res
      );
    });
    expect(r.body).toContain('first deploy');
  });

  it('serves the real app after a deploy', async () => {
    await apps.deploy(`${P}-site`, 'traefik/whoami:latest');
    const r = await until('whoami through Traefik', async () => {
      const res = await get(`${P}-site.${ROOT}`);
      return res.status === 200 && res.body.includes('Hostname:') && res;
    });
    expect(r.body).toContain('Host: ');
  });

  it('answers 404 for hostnames no app owns', async () => {
    expect((await get('nobody.pvxtest.localhost')).status).toBe(404);
  });

  it('shows a custom error page when the app cannot answer', async () => {
    // The app runs, but nothing listens on the port Traefik is told to use: a real 502
    await apps.update(`${P}-site`, {
      errorPages: { '502': '<h1>Back soon</h1>' },
      containerPort: 9999,
    });
    const r = await until('the error page', async () => {
      const res = await get(`${P}-site.${ROOT}`);
      // Traefik keeps the 502 and replaces the body with what the error-pages service returns for that path
      // (the stand-in service is whoami, which echoes the path it was asked for)
      return (
        res.status === 502 &&
        res.body.includes(`/internal/error-pages/${P}-site/502`) &&
        res
      );
    });
    expect(r.status).toBe(502);
  });

  it('applies a custom placeholder page to apps that have not been deployed', async () => {
    await apps.create({ name: `${P}-fresh` });
    await until('the fresh app', running(`pvx-${P}-fresh`));
    await placeholder.set('<h1>Custom placeholder</h1>');
    expect(await apps.reconcileAll({ onlyUndeployed: true })).toEqual([]);
    await until('the custom placeholder', async () => {
      const res = await get(`${P}-fresh.${ROOT}`);
      return res.status === 200 && res.body.includes('Custom placeholder');
    });
    await placeholder.prune();
  });
});
