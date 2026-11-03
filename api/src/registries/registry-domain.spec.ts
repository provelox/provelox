import { normalizeRegistryDomain, registryOf } from './registry-domain';

describe('registryOf', () => {
  it.each([
    ['nginx', 'docker.io'],
    ['nginx:1.27', 'docker.io'],
    ['acme/app:1', 'docker.io'],
    ['docker.io/acme/app', 'docker.io'],
    ['index.docker.io/acme/app', 'docker.io'],
    ['ghcr.io/acme/app:1', 'ghcr.io'],
    ['GHCR.io/acme/app', 'ghcr.io'],
    ['registry.example.com:5000/app', 'registry.example.com:5000'],
    ['localhost/app', 'localhost'],
    ['localhost:5000/app', 'localhost:5000'],
  ])('%s → %s', (image, host) => expect(registryOf(image)).toBe(host));
});

describe('normalizeRegistryDomain', () => {
  it('strips scheme and path, and unifies Docker Hub names', () => {
    expect(normalizeRegistryDomain('https://GHCR.io/')).toBe('ghcr.io');
    expect(normalizeRegistryDomain('index.docker.io')).toBe('docker.io');
    expect(normalizeRegistryDomain(' registry.acme.com:5000/x ')).toBe(
      'registry.acme.com:5000',
    );
  });
});
