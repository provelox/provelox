import { ValidationError } from '../common/errors';
import { FakeDocker } from '../docker/fake-docker';
import { install, withNetworkLag } from './install';

const base = { rootDomain: 'apps.example.com' };
const docker = (over: Partial<FakeDocker> = {}) =>
  Object.assign(
    new FakeDocker(),
    { self: 'ghcr.io/acme/provelox:1.0.0' },
    over,
  );

describe('install', () => {
  it('installs the API, proxy settings and console from its own image', async () => {
    const d = docker();
    const r = await install(d, base);
    expect(r.image).toBe('ghcr.io/acme/provelox:1.0.0');
    expect(
      d.services.get('pvx-provelox')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('ghcr.io/acme/provelox:1.0.0');
    expect(
      d.services.get('pvx-console')?.TaskTemplate.ContainerSpec.Image,
    ).toBe('ghcr.io/acme/provelox:1.0.0');
    expect(r.consoleUrl).toBe('http://console.apps.example.com');
    expect(r.apiUrl).toBe('http://api.apps.example.com');
  });

  describe('a private registry', () => {
    const sign = { registryUser: 'octocat', registryPassword: 'ghp_token' };

    it('signs Swarm in to pull the API and the console, on first install and on upgrade', async () => {
      const d = docker();
      await install(d, { ...base, ...sign });
      const expected = {
        username: 'octocat',
        password: 'ghp_token',
        serveraddress: 'ghcr.io',
      };
      expect(d.appliedAuth.get('pvx-provelox')).toEqual(expected);
      expect(d.appliedAuth.get('pvx-console')).toEqual(expected);
      d.appliedAuth.clear();
      await install(d, { ...base, ...sign });
      expect(d.appliedAuth.get('pvx-provelox')).toEqual(expected);
    });

    it('changes nothing when the registry rejects the sign-in', async () => {
      const d = docker();
      d.rejectRegistry.add('ghcr.io');
      await expect(install(d, { ...base, ...sign })).rejects.toThrow(
        /ghcr.io rejected that sign-in/,
      );
      expect(d.services.size).toBe(0);
      expect(d.calls).not.toContain('swarm-init:undefined');
    });

    it('needs the user and the password together', async () => {
      await expect(
        install(docker(), { ...base, registryUser: 'octocat' }),
      ).rejects.toThrow(/both --registry-user and the password/);
      await expect(
        install(docker(), { ...base, registryPassword: 'x' }),
      ).rejects.toThrow(/both --registry-user/);
    });

    it('sends no credentials for a public image', async () => {
      const d = docker();
      await install(d, base);
      expect(d.appliedAuth.get('pvx-provelox')).toBeUndefined();
    });
  });

  it('needs a root domain', async () => {
    await expect(install(docker(), { rootDomain: '' })).rejects.toThrow(
      /--root-domain is required/,
    );
  });

  describe('the Swarm', () => {
    it('starts one when the host has none, and says so', async () => {
      const d = docker({ swarm: 'none' });
      const r = await install(d, { ...base, advertiseAddr: '10.0.0.5' });
      expect(r.swarmCreated).toBe(true);
      expect(d.calls).toContain('swarm-init:10.0.0.5');
    });
    it('uses the existing one without touching it', async () => {
      const d = docker();
      expect((await install(d, base)).swarmCreated).toBe(false);
      expect(d.calls.some((c) => c.startsWith('swarm-init'))).toBe(false);
    });
    it('refuses to run on a worker node', async () => {
      await expect(install(docker({ swarm: 'worker' }), base)).rejects.toThrow(
        /manager node/,
      );
    });
    it('explains how to proceed when Docker cannot pick an address', async () => {
      const d = docker({
        swarm: 'none',
        swarmInitError: new Error('could not choose an IP address'),
      });
      await expect(install(d, base)).rejects.toThrow(/--advertise-addr/);
    });
  });

  describe('which image it installs', () => {
    it('takes --image over what it detects', async () => {
      const r = await install(docker(), { ...base, image: 'other/provelox:2' });
      expect(r.image).toBe('other/provelox:2');
    });
    it('asks for --image when it cannot tell', async () => {
      await expect(install(docker({ self: null }), base)).rejects.toThrow(
        /Pass --image/,
      );
    });
    it('rejects a bare image id, which services could not be updated from', async () => {
      await expect(
        install(docker({ self: 'sha256:' + 'a'.repeat(64) }), base),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        install(docker({ self: 'a'.repeat(12) }), base),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('HTTPS', () => {
    it('is off without an email, and warns', async () => {
      const r = await install(docker(), base);
      expect(r.insecure).toBe(true);
      expect(r.apiUrl.startsWith('http://')).toBe(true);
    });
    it('turns on for the API and the console with an email', async () => {
      const d = docker();
      const r = await install(d, { ...base, acmeEmail: 'ops@example.com' });
      expect(r.insecure).toBe(false);
      expect(r.consoleUrl).toBe('https://console.apps.example.com');
      expect(
        d.services.get('pvx-console')?.Labels[
          'traefik.http.routers.pvx_console-websecure.tls'
        ],
      ).toBe('true');
      expect(
        d.services.get('pvx-provelox')?.Labels[
          'traefik.http.routers.pvx_api-websecure.tls'
        ],
      ).toBe('true');
    });
    it('shows the proxy port in the addresses when it is not standard', async () => {
      const r = await install(docker(), { ...base, httpPort: 8080 });
      expect(r.consoleUrl).toBe('http://console.apps.example.com:8080');
    });
  });

  describe('data from an earlier install', () => {
    it('keeps it and does not make a password that would never be used', async () => {
      const d = docker();
      d.volumes.set('pvx-provelox-data', {});
      const r = await install(d, { ...base, adminPassword: 'ignored-anyway' });
      expect(r.existingData).toBe(true);
      expect(r.generatedPassword).toBeUndefined();
      expect(d.secrets.has('pvx-provelox-admin-password')).toBe(false);
    });
    it('is not reported on a clean host, or when the platform is already running', async () => {
      expect((await install(docker(), base)).existingData).toBe(false);
      const d = docker();
      await install(d, base);
      d.volumes.set('pvx-provelox-data', {});
      expect((await install(d, base)).existingData).toBe(false);
    });
  });

  describe('the admin password', () => {
    it('is generated on a first install and handed back once, as a Docker secret', async () => {
      const d = docker();
      const r = await install(d, base);
      expect(r.generatedPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(d.secrets.get('pvx-provelox-admin-password')?.value).toBe(
        r.generatedPassword,
      );
    });
    it('uses the one given and does not echo it back', async () => {
      const d = docker();
      const r = await install(d, {
        ...base,
        adminPassword: 'my-chosen-password',
      });
      expect(r.generatedPassword).toBeUndefined();
      expect(d.secrets.get('pvx-provelox-admin-password')?.value).toBe(
        'my-chosen-password',
      );
    });
    it('is not generated again on an upgrade, so the existing one stays', async () => {
      const d = docker();
      await install(d, base);
      d.secrets.delete('pvx-provelox-admin-password');
      const r = await install(d, {
        ...base,
        image: 'ghcr.io/acme/provelox:1.1.0',
      });
      expect(r.action).toBe('updated');
      expect(r.generatedPassword).toBeUndefined();
      expect(d.secrets.has('pvx-provelox-admin-password')).toBe(false);
      expect(
        d.services.get('pvx-provelox')?.TaskTemplate.ContainerSpec.Image,
      ).toBe('ghcr.io/acme/provelox:1.1.0');
    });
  });
});

describe('withNetworkLag', () => {
  it('tries again when Docker has not finished removing a network, and gives up after a few tries', async () => {
    let n = 0;
    const waits: number[] = [];
    const r = await withNetworkLag(
      async () => {
        if (++n < 3)
          throw new Error(
            '(HTTP code 500) server error - network provelox-net not found',
          );
        return 'ok';
      },
      async (ms) => void waits.push(ms),
    );
    expect(r).toBe('ok');
    expect(waits).toEqual([5000, 5000]);
    await expect(
      withNetworkLag(
        async () => {
          throw new Error('network x not found');
        },
        async () => {},
        3,
      ),
    ).rejects.toThrow(/not found/);
  });
  it('does not hide any other error', async () => {
    let n = 0;
    await expect(
      withNetworkLag(
        async () => {
          n++;
          throw new Error('port is already allocated');
        },
        async () => {},
      ),
    ).rejects.toThrow(/port/);
    expect(n).toBe(1);
  });
});
