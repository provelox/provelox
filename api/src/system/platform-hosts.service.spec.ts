import { bootstrap } from '../self/bootstrap';
import { makeStack } from '../test-utils';
import { PlatformHostsService } from './platform-hosts.service';

async function setup(opts: { consoleHost?: string } = {}) {
  const stack = makeStack({ ROOT_DOMAIN: 'old.example.com' });
  await bootstrap(stack.docker, {
    image: 'provelox:t',
    consoleImage: 'provelox:t',
    rootDomain: 'old.example.com',
    apiHost: 'api.old.example.com',
    apiSsl: true,
    consoleSsl: true,
    acmeEmail: 'ops@example.com',
    consoleHost: opts.consoleHost,
  });
  const hosts = new PlatformHostsService(
    stack.settings,
    stack.docker,
    stack.cfg,
  );
  const dns = new Set<string>();
  jest
    .spyOn(hosts as any, 'resolves')
    .mockImplementation(async (h: any) => dns.has(h));
  const rule = (svc: string, id: string, kind = 'websecure') =>
    stack.docker.services.get(svc)?.Labels[
      `traefik.http.routers.${id}-${kind}.rule`
    ];
  return { ...stack, hosts, dns, rule };
}

describe('PlatformHostsService', () => {
  it('moves the console and the API once their new names resolve', async () => {
    const { hosts, dns, rule, docker } = await setup();
    dns.add('console.new.example.com').add('api.new.example.com');

    const res = await hosts.moveTo('new.example.com', 'old.example.com');

    expect(res).toMatchObject({
      moved: true,
      kept: [],
      consoleUrl: 'https://console.new.example.com',
    });
    expect(rule('pvx-console', 'pvx_console')).toBe(
      'Host(`console.new.example.com`)',
    );
    expect(rule('pvx-console', 'pvx_console', 'web')).toBe(
      'Host(`console.new.example.com`)',
    );
    expect(rule('pvx-provelox', 'pvx_api')).toBe('Host(`api.new.example.com`)');
    // the console first, the API (which is running this) last
    expect(docker.calls.filter((c) => c.startsWith('edit:'))).toEqual([
      'edit:pvx-console',
      'edit:pvx-provelox',
    ]);
  });

  it("points the console's idea of the API at the new address", async () => {
    const { hosts, dns, docker } = await setup();
    dns.add('console.new.example.com').add('api.new.example.com');
    await hosts.moveTo('new.example.com', 'old.example.com');
    const env = docker.services.get('pvx-console')?.TaskTemplate.ContainerSpec
      .Env as string[];
    expect(env.join('\n')).not.toContain('api.old.example.com');
  });

  it('leaves everything alone, and says why, while the new names do not resolve', async () => {
    const { hosts, rule, docker } = await setup();

    const res = await hosts.moveTo('new.example.com', 'old.example.com');

    expect(res.moved).toBe(false);
    expect(res.reason).toMatch(/console\.new\.example\.com/);
    expect(res.reason).toMatch(/DNS/);
    expect(rule('pvx-console', 'pvx_console')).toBe(
      'Host(`console.old.example.com`)',
    );
    expect(docker.calls.some((c) => c.startsWith('edit:'))).toBe(false);
  });

  it('moves on a second try once DNS is there, though the domain is already saved', async () => {
    const { hosts, dns, settings, rule } = await setup();
    await hosts.moveTo('new.example.com', 'old.example.com');
    settings.set('rootDomain', 'new.example.com');
    dns.add('console.new.example.com').add('api.new.example.com');

    const res = await hosts.moveTo('new.example.com', 'new.example.com');

    expect(res.moved).toBe(true);
    expect(rule('pvx-console', 'pvx_console')).toBe(
      'Host(`console.new.example.com`)',
    );
  });

  it('never touches an address that was given by hand at install', async () => {
    const { hosts, dns, rule } = await setup({
      consoleHost: 'admin.other.org',
    });
    dns.add('api.new.example.com');

    const res = await hosts.moveTo('new.example.com', 'old.example.com');

    expect(res).toMatchObject({ moved: true, kept: ['admin.other.org'] });
    expect(res.consoleUrl).toBeUndefined();
    expect(rule('pvx-console', 'pvx_console')).toBe('Host(`admin.other.org`)');
    expect(rule('pvx-provelox', 'pvx_api')).toBe('Host(`api.new.example.com`)');
  });

  it('does nothing when no console is installed', async () => {
    const stack = makeStack();
    const hosts = new PlatformHostsService(
      stack.settings,
      stack.docker,
      stack.cfg,
    );
    expect(await hosts.moveTo('new.example.com', 'old.example.com')).toEqual({
      moved: false,
      kept: [],
      consoleUrl: undefined,
    });
  });
});

describe('PlatformHostsService.enableHttps', () => {
  async function plain() {
    // no Let's Encrypt email until a test sets one
    const stack = makeStack({ ROOT_DOMAIN: 'x.example.com', ACME_EMAIL: '' });
    await bootstrap(stack.docker, {
      image: 'provelox:t',
      consoleImage: 'provelox:t',
      rootDomain: 'x.example.com',
      apiHost: 'api.x.example.com',
      consoleHost: 'console.x.example.com',
    });
    const hosts = new PlatformHostsService(
      stack.settings,
      stack.docker,
      stack.cfg,
    );
    const dns = new Set<string>(['console.x.example.com', 'api.x.example.com']);
    jest
      .spyOn(hosts as any, 'resolves')
      .mockImplementation(async (h: any) => dns.has(h));
    const label = (svc: string, key: string) =>
      stack.docker.services.get(svc)?.Labels[key];
    return { ...stack, hosts, dns, label };
  }

  it('says where the console and API are and whether they use HTTPS', async () => {
    const { hosts } = await plain();
    const s = await hosts.status();
    expect(s.console).toMatchObject({
      host: 'console.x.example.com',
      ssl: false,
    });
    expect(s.console?.url).toBe('http://console.x.example.com');
    expect(s.api?.ssl).toBe(false);
  });

  it('adds the secure routers and the redirect to both, and points the console at the API over HTTPS', async () => {
    const { hosts, settings, label, docker } = await plain();
    settings.set('acmeEmail', 'ops@example.com');
    const r = await hosts.enableHttps();
    expect(r.changed).toEqual(['console', 'api']);
    expect(r.console).toMatchObject({
      ssl: true,
      url: 'https://console.x.example.com',
    });
    expect(r.api?.url).toBe('https://api.x.example.com');
    for (const [svc, id] of [
      ['pvx-console', 'pvx_console'],
      ['pvx-provelox', 'pvx_api'],
    ]) {
      expect(
        label(svc, `traefik.http.routers.${id}-websecure.tls.certresolver`),
      ).toBe('le');
      expect(label(svc, `traefik.http.routers.${id}-web.middlewares`)).toBe(
        `${id}-https`,
      );
    }
    const env = (
      docker.services.get('pvx-console')?.TaskTemplate.ContainerSpec as {
        Env: string[];
      }
    ).Env;
    expect(env.find((e) => e.startsWith('PROVELOX_PUBLIC_API_URL='))).toBe(
      'PROVELOX_PUBLIC_API_URL=https://api.x.example.com',
    );
    // again: nothing left to do
    expect((await hosts.enableHttps()).changed).toEqual([]);
  });

  it('asks for the email first, and for DNS that leads here, and changes nothing until both are there', async () => {
    const { hosts, settings, dns, label } = await plain();
    await expect(hosts.enableHttps()).rejects.toThrow(/email/);
    settings.set('acmeEmail', 'ops@example.com');
    dns.delete('api.x.example.com');
    await expect(hosts.enableHttps()).rejects.toThrow(
      /api\.x\.example\.com does not point/,
    );
    expect(
      label('pvx-console', 'traefik.http.routers.pvx_console-websecure.rule'),
    ).toBeUndefined();
  });
});
