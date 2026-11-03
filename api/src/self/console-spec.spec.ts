import { buildConsoleSpec, type ConsoleSpecOptions } from './console-spec';

const base: ConsoleSpecOptions = {
  image: 'provelox-console:1',
  host: { host: 'console.example.com', ssl: false },
  certResolver: 'le',
  apiUrl: 'http://provelox:4000',
  sessionSecret: { id: 's1', name: 'pvx-console-session' },
};
const env = (s: ReturnType<typeof buildConsoleSpec>) =>
  Object.fromEntries(
    (s.TaskTemplate.ContainerSpec.Env as string[]).map((e) => [
      e.slice(0, e.indexOf('=')),
      e.slice(e.indexOf('=') + 1),
    ]),
  );

describe('buildConsoleSpec', () => {
  it('is a labelled platform service owned by the reserved "console" identity', () => {
    const s = buildConsoleSpec(base);
    expect(s.Name).toBe('pvx-console');
    expect(s.Labels['io.provelox.app']).toBe('console');
    expect(s.Labels['io.provelox.system']).toBe('console');
    expect(s.Labels['io.provelox.managed']).toBe('true');
  });
  it('reads its session key from a Docker secret file, never from a plain variable', () => {
    const s = buildConsoleSpec(base);
    expect(env(s).SESSION_SECRET_FILE).toBe('/run/secrets/pvx-console-session');
    expect(env(s).SESSION_SECRET).toBeUndefined();
    expect(s.TaskTemplate.ContainerSpec.Secrets[0]).toMatchObject({
      SecretID: 's1',
      SecretName: 'pvx-console-session',
    });
  });
  it('reaches the API by its name on the shared network', () => {
    expect(env(buildConsoleSpec(base)).PROVELOX_API_URL).toBe(
      'http://provelox:4000',
    );
    expect(buildConsoleSpec(base).TaskTemplate.Networks).toEqual([
      { Target: 'provelox-net', Aliases: ['console'] },
    ]);
  });
  it('routes its hostname to port 3000', () => {
    const l = buildConsoleSpec(base).Labels;
    expect(l['traefik.http.routers.pvx_console-web.rule']).toBe(
      'Host(`console.example.com`)',
    );
    expect(
      l['traefik.http.services.pvx_console.loadbalancer.server.port'],
    ).toBe('3000');
    expect(Object.keys(l).some((k) => k.includes('websecure'))).toBe(false);
  });
  it('redirects to HTTPS with a certificate when SSL is on', () => {
    const l = buildConsoleSpec({
      ...base,
      host: { host: 'console.example.com', ssl: true },
    }).Labels;
    expect(l['traefik.http.routers.pvx_console-web.middlewares']).toBe(
      'pvx_console-https',
    );
    expect(
      l['traefik.http.routers.pvx_console-websecure.tls.certresolver'],
    ).toBe('le');
  });
  it('starts the new instance before stopping the old one (it keeps no data)', () => {
    const s = buildConsoleSpec(base);
    expect(s.UpdateConfig.Order).toBe('start-first');
    expect(s.Mode.Replicated.Replicas).toBe(1);
  });
  it('passes the public API address and session length when given', () => {
    const e = env(
      buildConsoleSpec({
        ...base,
        publicApiUrl: 'https://api.example.com',
        sessionHours: 12,
      }),
    );
    expect(e.PROVELOX_PUBLIC_API_URL).toBe('https://api.example.com');
    expect(e.SESSION_HOURS).toBe('12');
  });
  it('starts the console role of the shared image, without root', () => {
    const c = buildConsoleSpec(base).TaskTemplate.ContainerSpec;
    expect(c.Args).toEqual(['console']);
    expect(c.User).toBe('node');
  });
  it('has a health check', () => {
    expect(
      buildConsoleSpec(base).TaskTemplate.ContainerSpec.Healthcheck.Test.join(
        ' ',
      ),
    ).toContain('/login');
  });
});
