import { ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';

describe('ProxyService', () => {
  it('creates the Traefik service on the shared network, labelled as ours', async () => {
    const { proxy, docker } = makeStack();
    expect(await proxy.ensure()).toBe('created');
    expect(docker.networks.has('provelox-net')).toBe(true);
    expect(docker.services.get('pvx-traefik')?.Labels['io.provelox.app']).toBe(
      'traefik',
    );
  });

  it('is idempotent', async () => {
    const { proxy } = makeStack();
    await proxy.ensure();
    expect(await proxy.ensure()).toBe('updated');
  });

  it("adds Let's Encrypt when an email is set at runtime, and applies it", async () => {
    const { proxy, docker } = makeStack({ ACME_EMAIL: '' });
    await proxy.ensure();
    const args = () =>
      docker.services.get('pvx-traefik')?.TaskTemplate.ContainerSpec
        .Args as string[];
    expect(args().some((a) => a.includes('acme.email'))).toBe(false);
    await proxy.setAcmeEmail('  me@example.com ');
    expect(args()).toContain(
      '--certificatesresolvers.le.acme.email=me@example.com',
    );
  });

  it('rejects an invalid email', async () => {
    await expect(makeStack().proxy.setAcmeEmail('nope')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('does not run the proxy when disabled, but still stores the email', async () => {
    const { proxy, docker } = makeStack({ PROXY_ENABLED: 'false' });
    await proxy.onApplicationBootstrap();
    await proxy.setAcmeEmail('me@example.com');
    expect(docker.services.has('pvx-traefik')).toBe(false);
  });

  it('refuses to take over a Traefik service it did not create', async () => {
    const { proxy, docker } = makeStack();
    docker.addForeignService('pvx-traefik', {});
    await expect(proxy.ensure()).rejects.toThrow(/not app traefik/);
  });

  it('reports its status', async () => {
    const { proxy } = makeStack();
    await proxy.ensure();
    expect(await proxy.status()).toMatchObject({
      enabled: true,
      httpPort: 80,
      httpsPort: 443,
      acmeEmail: 'ops@example.com',
    });
  });
});
