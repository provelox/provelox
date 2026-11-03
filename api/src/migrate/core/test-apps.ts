import type { SourceApp } from './source';

/** A plain app of an imaginary platform, for tests of the core: nothing here is specific to a source. */
export const app = (
  over: Partial<SourceApp> & { name: string },
): SourceApp => ({
  image: 'nginx:1',
  imageIsLocal: false,
  instanceCount: 1,
  containerPort: 80,
  exposed: true,
  forceSsl: false,
  domains: [],
  env: [],
  volumes: [],
  hostPorts: [],
  persistent: false,
  alias: `old-${over.name}`,
  attention: [],
  notes: [],
  warnings: [],
  ...over,
});

export const withData = (name: string) =>
  app({
    name,
    image: 'postgres:16',
    persistent: true,
    volumes: [
      {
        containerPath: '/data',
        volume: `old--${name}-data`,
        name: `${name}-data`,
      },
    ],
  });

export const withPorts = (name: string) =>
  app({
    name,
    image: 'a/b:1',
    hostPorts: [
      { hostPort: 53, containerPort: 53, protocol: 'tcp' },
      { hostPort: 53, containerPort: 53, protocol: 'udp' },
    ],
  });
