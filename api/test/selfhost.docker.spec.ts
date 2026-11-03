/**
 * The production topology on a real Swarm (opt in with PVX_DOCKER_TESTS=1): bootstrap installs the API as a Swarm
 * service, the API starts Traefik itself, and everything below goes through Traefik to the API in its container.
 *
 * Needs the image: `docker build -t provelox-api:pvxtest .`. Uses the platform's real service names
 * (pvx-provelox, pvx-traefik), so it refuses to run if either already exists. Spare ports keep it clear of other proxies.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { DockerodeAdapter } from '../src/docker/dockerode.adapter';
import { bootstrap } from '../src/self/bootstrap';
import type { Config } from '../src/config/config';

jest.setTimeout(600_000);

const IMAGE = 'provelox-api:pvxtest';
const HTTP_PORT = 18080;
const ROOT = 'pvxtest.localhost';
const API_HOST = `api.${ROOT}`;
const PASSWORD = 'selfhost-test-password';
const P = `pvxtest${randomBytes(3).toString('hex')}`;

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

function call(
  host: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        method,
        path,
        timeout: 8000,
        headers: {
          Host: host,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function until<T>(
  what: string,
  fn: () => Promise<T | false | undefined>,
  ms = 240_000,
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
    await sleep(2500);
  }
}

describe('Provelox running as a Swarm service', () => {
  const adapter = new DockerodeAdapter({
    DOCKER_SOCKET: '/var/run/docker.sock',
  } as Config);
  const images = [
    'traefik:v3.6',
    'traefik/whoami:latest',
    'nginx:alpine',
    'node:24-slim',
  ];
  const had = new Map(
    images.map((i) => [i, !!tryDocker('image', 'inspect', i)]),
  );
  const hadNetwork = !!tryDocker(
    'network',
    'ls',
    '--filter',
    'name=^provelox-net$',
    '-q',
  );
  const running = (name: string) => async () =>
    (await adapter.serviceStatus(name))?.state === 'running';
  let token = '';

  beforeAll(() => {
    if (!tryDocker('image', 'inspect', IMAGE))
      throw new Error(`Build the image first: docker build -t ${IMAGE} .`);
    for (const name of ['pvx-provelox', 'pvx-traefik'])
      if (tryDocker('service', 'ls', '--filter', `name=^${name}$`, '-q'))
        throw new Error(
          `${name} already exists on this Docker: refusing to run over a real installation`,
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
      if (
        s.startsWith(`pvx-${P}`) ||
        s === 'pvx-provelox' ||
        s === 'pvx-traefik'
      )
        tryDocker('service', 'rm', s);
    await sleep(8000);
    for (let i = 0; i < 15; i++) {
      for (const v of tryDocker('volume', 'ls', '--format', '{{.Name}}').split(
        '\n',
      ))
        if (
          v === 'pvx-provelox-data' ||
          v === 'pvx-traefik-certs' ||
          v.startsWith(`pvx-${P}`)
        )
          tryDocker('volume', 'rm', v);
      if (
        !tryDocker(
          'volume',
          'ls',
          '-q',
          '--filter',
          'name=pvx-provelox-data',
        ) &&
        !tryDocker('volume', 'ls', '-q', '--filter', 'name=pvx-traefik-certs')
      )
        break;
      await sleep(3000);
    }
    for (const s of ['pvx-provelox-jwt', 'pvx-provelox-admin-password'])
      tryDocker('secret', 'rm', s);
    for (const c of tryDocker('config', 'ls', '--format', '{{.Name}}').split(
      '\n',
    ))
      if (c.startsWith('pvx-placeholder-')) tryDocker('config', 'rm', c);
    if (!hadNetwork) tryDocker('network', 'rm', 'provelox-net');
    tryDocker('image', 'rm', IMAGE);
    for (const [image, existed] of had)
      if (!existed)
        for (let i = 0; i < 6 && tryDocker('image', 'inspect', image); i++) {
          tryDocker('image', 'rm', image);
          await sleep(3000);
        }
  });

  it('installs with the bootstrap command, and the API starts Traefik itself', async () => {
    const r = await bootstrap(adapter, {
      image: IMAGE,
      httpPort: HTTP_PORT,
      httpsPort: 18443,
      rootDomain: ROOT,
      apiHost: API_HOST,
      adminPassword: PASSWORD,
    });
    expect(r.action).toBe('created');
    await until('the API service', running('pvx-provelox'));
    // nobody told anyone to start Traefik: the API did, from inside its container
    await until('Traefik, started by the API', running('pvx-traefik'));
  });

  it('is reachable through Traefik at its own hostname, and requires sign-in', async () => {
    const health = await until('the API through Traefik', async () => {
      const r = await call(API_HOST, 'GET', '/health');
      return r.status === 200 && r;
    });
    expect(health.json).toEqual({ status: 'ok' });
    expect((await call(API_HOST, 'GET', '/v1/apps')).status).toBe(401);
    expect(
      (
        await call(API_HOST, 'POST', '/v1/auth/login', {
          body: { password: 'wrong' },
        })
      ).status,
    ).toBe(401);
    const login = await call(API_HOST, 'POST', '/v1/auth/login', {
      body: { password: PASSWORD },
    });
    expect(login.status).toBe(201);
    token = login.json.token;
  });

  it('deploys and routes an app, entirely through its own API', async () => {
    const name = `${P}-site`;
    expect(
      (await call(API_HOST, 'POST', '/v1/apps', { token, body: { name } }))
        .status,
    ).toBe(201);
    const first = await until('the placeholder page', async () => {
      const r = await call(`${name}.${ROOT}`, 'GET', '/');
      return r.status === 200 && r.body.includes('first deploy') && r;
    });
    expect(first.body).toContain('ready for its first deploy');
    expect(
      (
        await call(API_HOST, 'POST', `/v1/apps/${name}/deploy`, {
          token,
          body: { image: 'traefik/whoami:latest' },
        })
      ).status,
    ).toBe(202);
    await until('the app', async () => {
      const r = await call(`${name}.${ROOT}`, 'GET', '/');
      return r.status === 200 && r.body.includes('Hostname:') && r;
    });
    const dep = await until('the rollout to finish', async () => {
      const d = await call(API_HOST, 'GET', `/v1/apps/${name}/deployment`, {
        token,
      });
      return d.json && d.json.isBuilding === false && d;
    });
    expect(dep.json.isFailed).toBe(false);
  });

  it('serves custom error pages: Traefik fetches them from the API running in its container', async () => {
    const name = `${P}-site`;
    const patched = await call(API_HOST, 'PATCH', `/v1/apps/${name}`, {
      token,
      body: {
        errorPages: { '502': '<h1>Back soon</h1>' },
        containerPort: 9999,
      },
    });
    expect(patched.status).toBe(200);
    const r = await until('the custom 502 page', async () => {
      const res = await call(`${name}.${ROOT}`, 'GET', '/');
      return res.status === 502 && res.body.includes('Back soon') && res;
    });
    expect(r.body).toBe('<h1>Back soon</h1>');
  });

  it('deploys a Compose project through the API', async () => {
    const project = `${P}-shop`;
    const compose = 'services:\n  web:\n    image: traefik/whoami:latest\n';
    const preview = await call(API_HOST, 'POST', '/v1/projects/preview', {
      token,
      body: { name: project, compose },
    });
    expect(preview.json.errors).toEqual([]);
    expect(
      (
        await call(API_HOST, 'POST', '/v1/projects', {
          token,
          body: { name: project, compose },
        })
      ).status,
    ).toBe(201);
    await until('the project service', running(`pvx-${project}-web`));
    expect(
      (await call(API_HOST, 'DELETE', `/v1/projects/${project}`, { token }))
        .status,
    ).toBe(200);
  });

  it('upgrades in place: same signing key, same data, nobody signed out', async () => {
    const r = await bootstrap(adapter, {
      image: IMAGE,
      httpPort: HTTP_PORT,
      httpsPort: 18443,
      rootDomain: ROOT,
      apiHost: API_HOST,
    });
    expect(r).toEqual({ action: 'updated', existingInstall: true });
    // wait for the new instance: a request that works means it is up (the old one stops first)
    const me = await until('the upgraded API', async () => {
      const res = await call(API_HOST, 'GET', '/v1/auth/me', { token });
      return res.status === 200 && res;
    });
    expect(me.json).toEqual({ authenticated: true });
    // the database lives on the volume, so the app is still there
    const apps = await call(API_HOST, 'GET', '/v1/apps', { token });
    expect(
      apps.json.map((a: { app: { name: string } }) => a.app.name),
    ).toContain(`${P}-site`);
  });
});
