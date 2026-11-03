import { ValidationError } from '../common/errors';
import { FakeDocker } from '../docker/fake-docker';
import { bootstrap } from './bootstrap';

const opts = { image: 'provelox/api:1' };

describe('bootstrap', () => {
  it('installs: network, signing secret, then the API service', async () => {
    const d = new FakeDocker();
    const r = await bootstrap(d, opts);
    expect(r).toEqual({ action: 'created', existingInstall: false });
    expect(d.networks.has('provelox-net')).toBe(true);
    expect([...d.secrets.keys()]).toEqual(['pvx-provelox-jwt']);
    expect(
      d.services.get('pvx-provelox')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('provelox/api:1');
    // the signing key is a real random value held only by Docker
    expect(
      d.secrets.get('pvx-provelox-jwt')?.value.length,
    ).toBeGreaterThanOrEqual(48);
  });

  it('upgrading keeps the signing secret, so nobody is signed out', async () => {
    const d = new FakeDocker();
    await bootstrap(d, opts);
    const key = d.secrets.get('pvx-provelox-jwt')?.value;
    // the fake replaces secrets on ensure, like a fresh value; the real adapter keeps the existing one
    const keepExisting = d.ensureSecret.bind(d);
    d.ensureSecret = async (name, value, labels) =>
      d.secrets.has(name)
        ? { id: `sec-${name}`, name }
        : keepExisting(name, value, labels);
    const r = await bootstrap(d, { image: 'provelox/api:2' });
    expect(r).toEqual({ action: 'updated', existingInstall: true });
    expect(d.secrets.get('pvx-provelox-jwt')?.value).toBe(key);
    expect(
      d.services.get('pvx-provelox')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('provelox/api:2');
  });

  it('stores a given admin password as a Docker secret', async () => {
    const d = new FakeDocker();
    await bootstrap(d, { ...opts, adminPassword: 'first-password' });
    expect(d.secrets.get('pvx-provelox-admin-password')?.value).toBe(
      'first-password',
    );
  });

  it('validates input before touching Docker', async () => {
    const d = new FakeDocker();
    await expect(bootstrap(d, { image: 'bad image!' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      bootstrap(d, { ...opts, rootDomain: 'not a domain' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      bootstrap(d, { ...opts, apiHost: 'api.example.com', apiSsl: true }),
    ).rejects.toThrow(/Let's Encrypt email/);
    expect(d.calls).toEqual([]);
  });

  it('refuses to take over a pvx-provelox service it did not create', async () => {
    const d = new FakeDocker();
    d.addForeignService('pvx-provelox', {});
    await expect(bootstrap(d, opts)).rejects.toThrow(/not app provelox/);
  });

  it('rolls the API and console even when the image reference did not change (a moving tag)', async () => {
    const d = new FakeDocker();
    await bootstrap(d, {
      ...opts,
      consoleImage: 'x/provelox:latest',
      rootDomain: 'a.example.com',
    });
    expect([...d.forcedRollouts].sort()).toEqual([
      'pvx-console',
      'pvx-provelox',
    ]);
  });

  describe('with the console', () => {
    const withConsole = {
      ...opts,
      rootDomain: 'apps.example.com',
      consoleImage: 'provelox-console:1',
    };

    it('installs it as a platform service on its own host, with its own secret', async () => {
      const d = new FakeDocker();
      const r = await bootstrap(d, withConsole);
      expect(r.console).toBe('created');
      const s = d.services.get('pvx-console');
      expect(s?.TaskTemplate.ContainerSpec.Image).toBe('provelox-console:1');
      expect(s?.Labels['traefik.http.routers.pvx_console-web.rule']).toBe(
        'Host(`console.apps.example.com`)',
      );
      expect([...d.secrets.keys()].sort()).toEqual([
        'pvx-console-session',
        'pvx-provelox-jwt',
      ]);
      // the session key is a Docker secret, not a variable in the service
      expect(JSON.stringify(s?.TaskTemplate.ContainerSpec.Env)).not.toMatch(
        /SESSION_SECRET=/,
      );
    });

    it('points the console at the API by name, and tells it the address CI should use', async () => {
      const d = new FakeDocker();
      await bootstrap(d, {
        ...withConsole,
        apiHost: 'api.apps.example.com',
        httpPort: 8080,
      });
      const env = d.services.get('pvx-console')?.TaskTemplate.ContainerSpec
        .Env as string[];
      expect(env).toContain('PROVELOX_API_URL=http://provelox:4000');
      expect(env).toContain(
        'PROVELOX_PUBLIC_API_URL=http://api.apps.example.com:8080',
      );
    });

    it('uses an explicit console host over the derived one', async () => {
      const d = new FakeDocker();
      await bootstrap(d, { ...withConsole, consoleHost: 'ui.example.com' });
      expect(
        d.services.get('pvx-console')?.Labels[
          'traefik.http.routers.pvx_console-web.rule'
        ],
      ).toContain('ui.example.com');
    });

    it('does not install the console unless asked', async () => {
      const d = new FakeDocker();
      expect((await bootstrap(d, opts)).console).toBeUndefined();
      expect(d.services.has('pvx-console')).toBe(false);
    });

    it('upgrading the console keeps its session secret', async () => {
      const d = new FakeDocker();
      await bootstrap(d, withConsole);
      const key = d.secrets.get('pvx-console-session')?.value;
      const keepExisting = d.ensureSecret.bind(d);
      d.ensureSecret = async (name, value, labels) =>
        d.secrets.has(name)
          ? { id: `sec-${name}`, name }
          : keepExisting(name, value, labels);
      const r = await bootstrap(d, {
        ...withConsole,
        consoleImage: 'provelox-console:2',
      });
      expect(r.console).toBe('updated');
      expect(d.secrets.get('pvx-console-session')?.value).toBe(key);
      expect(
        d.services.get('pvx-console')?.TaskTemplate.ContainerSpec.Image,
      ).toBe('provelox-console:2');
    });

    it('needs somewhere to serve the console from, and a valid host and email for HTTPS', async () => {
      const d = new FakeDocker();
      await expect(
        bootstrap(d, { ...opts, consoleImage: 'x:1' }),
      ).rejects.toThrow(/Say where the console/);
      await expect(
        bootstrap(d, {
          ...opts,
          consoleImage: 'x:1',
          consoleHost: 'not a host',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        bootstrap(d, { ...withConsole, consoleSsl: true }),
      ).rejects.toThrow(/Let's Encrypt email/);
      await expect(
        bootstrap(d, { ...withConsole, consoleImage: 'bad image!' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(d.calls).toEqual([]);
    });

    it('refuses to take over a pvx-console service it did not create', async () => {
      const d = new FakeDocker();
      d.addForeignService('pvx-console', {});
      await expect(bootstrap(d, withConsole)).rejects.toThrow(
        /not app console/,
      );
    });
  });

  describe('with a sign-in for a private image', () => {
    const auth = { username: 'me', password: 'tok', serveraddress: 'ghcr.io' };

    it('hands it to the API as a secret to register, and keeps it for pulling', async () => {
      const d = new FakeDocker();
      await bootstrap(d, {
        image: 'ghcr.io/provelox/provelox:1',
        registryAuth: auth,
      });
      const name = [...d.secrets.keys()].find((k) =>
        k.startsWith('pvx-registry-'),
      )!;
      expect(JSON.parse(d.secrets.get(name)!.value)).toEqual({
        domain: 'ghcr.io',
        username: 'me',
        password: 'tok',
      });
      const spec = d.services.get('pvx-provelox')!;
      expect(spec.TaskTemplate.ContainerSpec.Env).toContain(
        `REGISTRY_SEED_FILE=/run/secrets/${name}`,
      );
      expect(
        spec.TaskTemplate.ContainerSpec.Secrets?.map(
          (x: { SecretName: string }) => x.SecretName,
        ),
      ).toContain(name);
    });

    it('adds nothing for a public image', async () => {
      const d = new FakeDocker();
      await bootstrap(d, opts);
      expect(
        [...d.secrets.keys()].some((k) => k.startsWith('pvx-registry-')),
      ).toBe(false);
      expect(
        d.services.get('pvx-provelox')!.TaskTemplate.ContainerSpec.Env?.join(),
      ).not.toContain('REGISTRY_SEED_FILE');
    });
  });
});
