import {
  buildApiSpec,
  ERROR_PAGES_SERVICE_REF,
  type ApiSpecOptions,
} from './api-spec';

const base: ApiSpecOptions = {
  image: 'provelox/api:1',
  port: 4000,
  httpPort: 80,
  httpsPort: 443,
  certResolver: 'le',
  jwtSecret: { id: 's1', name: 'pvx-provelox-jwt' },
};
const env = (s: ReturnType<typeof buildApiSpec>) =>
  Object.fromEntries(
    (s.TaskTemplate.ContainerSpec.Env as string[]).map((e) => [
      e.slice(0, e.indexOf('=')),
      e.slice(e.indexOf('=') + 1),
    ]),
  );

describe('buildApiSpec', () => {
  it('is owned by the reserved "provelox" identity', () => {
    const s = buildApiSpec(base);
    expect(s.Name).toBe('pvx-provelox');
    expect(s.Labels['io.provelox.app']).toBe('provelox');
    expect(s.Labels['io.provelox.managed']).toBe('true');
  });
  it('runs a single instance that stops before its replacement starts (SQLite has one writer)', () => {
    const s = buildApiSpec(base);
    expect(s.Mode.Replicated.Replicas).toBe(1);
    expect(s.UpdateConfig.Order).toBe('stop-first');
  });
  it('reads its signing key from a Docker secret file, not from the environment', () => {
    const s = buildApiSpec(base);
    expect(env(s).JWT_SECRET_FILE).toBe('/run/secrets/pvx-provelox-jwt');
    expect(env(s).JWT_SECRET).toBeUndefined();
    expect(s.TaskTemplate.ContainerSpec.Secrets).toEqual([
      {
        SecretID: 's1',
        SecretName: 'pvx-provelox-jwt',
        File: { Name: 'pvx-provelox-jwt', UID: '0', GID: '0', Mode: 0o444 },
      },
    ]);
  });
  it('persists its database on a volume and can reach Docker', () => {
    const mounts = buildApiSpec(base).TaskTemplate.ContainerSpec.Mounts;
    expect(mounts).toContainEqual(
      expect.objectContaining({
        Type: 'volume',
        Source: 'pvx-provelox-data',
        Target: '/data',
      }),
    );
    expect(mounts).toContainEqual(
      expect.objectContaining({ Type: 'bind', Source: '/var/run/docker.sock' }),
    );
  });
  it('runs on a manager and joins the shared network', () => {
    const t = buildApiSpec(base).TaskTemplate;
    expect(t.Placement.Constraints).toEqual(['node.role==manager']);
    expect(t.Networks).toEqual([
      { Target: 'provelox-net', Aliases: ['provelox'] },
    ]);
  });
  it('tells itself where the proxy should fetch error pages, and defines that service for Traefik', () => {
    const s = buildApiSpec(base);
    expect(env(s).ERROR_PAGES_SERVICE).toBe(ERROR_PAGES_SERVICE_REF);
    expect(
      s.Labels[
        'traefik.http.services.pvx_error_pages.loadbalancer.server.port'
      ],
    ).toBe('4000');
    // not exposed on any host unless asked: the only routers are the catch-all for unknown addresses
    expect(
      Object.keys(s.Labels).filter(
        (k) => k.includes('routers') && !k.includes('pvx_not_found'),
      ),
    ).toEqual([]);
  });
  it('answers unknown addresses with the branded 404, below every real router', () => {
    const l = buildApiSpec(base).Labels;
    for (const kind of ['web', 'websecure']) {
      const r = `traefik.http.routers.pvx_not_found-${kind}`;
      expect(l[`${r}.rule`]).toBe('PathPrefix(`/`)');
      expect(l[`${r}.priority`]).toBe('1');
      expect(l[`${r}.service`]).toBe('pvx_error_pages');
      expect(l[`${r}.middlewares`]).toBe('pvx_not_found-path');
    }
    expect(l['traefik.http.routers.pvx_not_found-websecure.tls']).toBe('true');
    expect(l['traefik.http.routers.pvx_not_found-web.tls']).toBeUndefined();
    expect(
      l['traefik.http.middlewares.pvx_not_found-path.replacepath.path'],
    ).toBe('/internal/error-pages/not-found');
  });
  it('passes through domain, email and proxy ports', () => {
    const e = env(
      buildApiSpec({
        ...base,
        rootDomain: 'apps.example.com',
        acmeEmail: 'a@b.co',
        httpPort: 18080,
        httpsPort: 18443,
        acmeStaging: true,
        traefikImage: 'traefik:v3.7',
      }),
    );
    expect(e).toMatchObject({
      ROOT_DOMAIN: 'apps.example.com',
      ACME_EMAIL: 'a@b.co',
      PROXY_HTTP_PORT: '18080',
      PROXY_HTTPS_PORT: '18443',
      ACME_STAGING: 'true',
      TRAEFIK_IMAGE: 'traefik:v3.7',
    });
  });
  it('mounts an admin password secret only when one is given', () => {
    expect(env(buildApiSpec(base)).ADMIN_PASSWORD_FILE).toBeUndefined();
    const s = buildApiSpec({
      ...base,
      adminPassword: { id: 'a1', name: 'pvx-provelox-admin-password' },
    });
    expect(env(s).ADMIN_PASSWORD_FILE).toBe(
      '/run/secrets/pvx-provelox-admin-password',
    );
    expect(s.TaskTemplate.ContainerSpec.Secrets).toHaveLength(2);
  });
  describe('serving the API on a host', () => {
    it('routes plain HTTP when SSL is off', () => {
      const l = buildApiSpec({
        ...base,
        apiHost: { host: 'api.example.com', ssl: false },
      }).Labels;
      expect(l['traefik.http.routers.pvx_api-web.rule']).toBe(
        'Host(`api.example.com`)',
      );
      expect(
        Object.keys(l).some(
          (k) => k.includes('websecure') && !k.includes('pvx_not_found'),
        ),
      ).toBe(false);
    });
    it('redirects to HTTPS and gets a certificate when SSL is on', () => {
      const l = buildApiSpec({
        ...base,
        apiHost: { host: 'api.example.com', ssl: true },
      }).Labels;
      expect(l['traefik.http.routers.pvx_api-web.middlewares']).toBe(
        'pvx_api-https',
      );
      expect(l['traefik.http.routers.pvx_api-websecure.tls.certresolver']).toBe(
        'le',
      );
    });
  });
  it('tells the API its own address, for sign-in providers to return to', () => {
    const env = (apiHost?: { host: string; ssl: boolean }) =>
      buildApiSpec({ ...base, apiHost }).TaskTemplate.ContainerSpec.Env;
    expect(env({ host: 'api.example.com', ssl: true })).toContain(
      'API_PUBLIC_URL=https://api.example.com',
    );
    expect(env({ host: 'api.example.com', ssl: false })).toContain(
      'API_PUBLIC_URL=http://api.example.com',
    );
    expect(env().some((e: string) => e.startsWith('API_PUBLIC_URL'))).toBe(
      false,
    );
  });
  it('puts a proxy port other than 80 or 443 in the API’s address', () => {
    const url = (o: object) =>
      buildApiSpec({ ...base, ...o }).TaskTemplate.ContainerSpec.Env.find(
        (e: string) => e.startsWith('API_PUBLIC_URL'),
      );
    expect(
      url({ apiHost: { host: 'a.example.com', ssl: true }, httpsPort: 8443 }),
    ).toBe('API_PUBLIC_URL=https://a.example.com:8443');
    expect(
      url({ apiHost: { host: 'a.example.com', ssl: false }, httpPort: 8080 }),
    ).toBe('API_PUBLIC_URL=http://a.example.com:8080');
    // the other scheme's port does not matter
    expect(
      url({ apiHost: { host: 'a.example.com', ssl: true }, httpPort: 8080 }),
    ).toBe('API_PUBLIC_URL=https://a.example.com');
  });
  it('has a health check', () => {
    const h = buildApiSpec(base).TaskTemplate.ContainerSpec.Healthcheck;
    expect(h.Test.join(' ')).toContain('/health');
  });
});
