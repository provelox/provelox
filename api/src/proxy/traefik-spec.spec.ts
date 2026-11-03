import { buildTraefikSpec } from './traefik-spec';

const base = {
  image: 'traefik:v3.6',
  httpPort: 80,
  httpsPort: 443,
  certResolver: 'le',
  acmeEmail: null as string | null,
  acmeStaging: false,
};

describe('buildTraefikSpec', () => {
  it('is a labelled, Provelox-owned system service', () => {
    const s = buildTraefikSpec(base);
    expect(s.Name).toBe('pvx-traefik');
    expect(s.Labels['io.provelox.managed']).toBe('true');
    expect(s.Labels['io.provelox.app']).toBe('traefik');
    // it must not route itself
    expect(s.Labels['traefik.enable']).toBe('false');
  });
  it('discovers apps from Swarm service labels on the shared network only', () => {
    const args = buildTraefikSpec(base).TaskTemplate.ContainerSpec
      .Args as string[];
    expect(args).toContain('--providers.swarm=true');
    expect(args).toContain('--providers.swarm.exposedbydefault=false');
    expect(args).toContain('--providers.swarm.network=provelox-net');
    // a deploy must not leave the proxy sending requests to the old task for the default 15 seconds
    expect(args).toContain('--providers.swarm.refreshSeconds=2');
  });
  it('overwrites X-Forwarded-For unless upstream proxies are trusted', () => {
    const args = (o: Parameters<typeof buildTraefikSpec>[0] = base) =>
      buildTraefikSpec(o).TaskTemplate.ContainerSpec.Args as string[];
    expect(args().some((a) => a.includes('forwardedHeaders'))).toBe(false);
    const trusted = args({ ...base, trustedIPs: ['1.2.3.0/24', '5.6.0.0/16'] });
    for (const ep of ['web', 'websecure'])
      expect(trusted).toContain(
        `--entrypoints.${ep}.forwardedHeaders.trustedIPs=1.2.3.0/24,5.6.0.0/16`,
      );
  });
  it('has no certificate resolver without an ACME email', () => {
    const args = buildTraefikSpec(base).TaskTemplate.ContainerSpec
      .Args as string[];
    expect(args.some((a) => a.includes('certificatesresolvers'))).toBe(false);
  });
  it("configures Let's Encrypt when an email is set, with persistent storage", () => {
    const s = buildTraefikSpec({ ...base, acmeEmail: 'ops@example.com' });
    const args = s.TaskTemplate.ContainerSpec.Args as string[];
    expect(args).toContain(
      '--certificatesresolvers.le.acme.email=ops@example.com',
    );
    expect(args).toContain(
      '--certificatesresolvers.le.acme.httpchallenge.entrypoint=web',
    );
    expect(args.some((a) => a.includes('caserver'))).toBe(false);
    expect(
      s.TaskTemplate.ContainerSpec.Mounts.some(
        (m: { Source: string }) => m.Source === 'pvx-traefik-certs',
      ),
    ).toBe(true);
  });
  it('can use the staging CA', () => {
    const args = buildTraefikSpec({
      ...base,
      acmeEmail: 'a@b.co',
      acmeStaging: true,
    }).TaskTemplate.ContainerSpec.Args as string[];
    expect(args.some((a) => a.includes('acme-staging'))).toBe(true);
  });
  it('publishes the configured host ports in host mode', () => {
    const ports = buildTraefikSpec({
      ...base,
      httpPort: 18080,
      httpsPort: 18443,
    }).EndpointSpec?.Ports;
    expect(ports).toEqual([
      {
        Protocol: 'tcp',
        TargetPort: 80,
        PublishedPort: 18080,
        PublishMode: 'host',
      },
      {
        Protocol: 'tcp',
        TargetPort: 443,
        PublishedPort: 18443,
        PublishMode: 'host',
      },
    ]);
  });
  it('runs on a manager and replaces itself stop-first', () => {
    const s = buildTraefikSpec(base);
    expect(s.TaskTemplate.Placement.Constraints).toEqual([
      'node.role==manager',
    ]);
    expect(s.UpdateConfig.Order).toBe('stop-first');
  });
});
