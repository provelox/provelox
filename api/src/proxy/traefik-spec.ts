import { LABEL_APP, LABEL_MANAGED, SHARED_NETWORK } from '../common/naming';
import type { SwarmServiceSpec } from '../apps/service-spec';

export const TRAEFIK_APP = 'traefik';
export const TRAEFIK_SERVICE = 'pvx-traefik';
export const TRAEFIK_CERT_VOLUME = 'pvx-traefik-certs';
export const ACME_STAGING_CA =
  'https://acme-staging-v02.api.letsencrypt.org/directory';

export interface TraefikOptions {
  image: string;
  httpPort: number;
  httpsPort: number;
  certResolver: string;
  /** Without an email there is no certificate resolver, so HTTPS hosts cannot work */
  acmeEmail: string | null;
  acmeStaging: boolean;
  /** Upstream proxies (CIDRs) whose X-Forwarded-For is kept, e.g. a CDN. Empty: the header is overwritten. */
  trustedIPs?: string[];
}

/**
 * The reverse proxy as a Swarm service. It reads every app's routing from the labels on its service
 * (see traefik-labels.ts), so this spec never has to change when apps do.
 */
export function buildTraefikSpec(o: TraefikOptions): SwarmServiceSpec {
  const args = [
    '--providers.swarm=true',
    '--providers.swarm.endpoint=unix:///var/run/docker.sock',
    '--providers.swarm.exposedbydefault=false',
    `--providers.swarm.network=${SHARED_NETWORK}`,
    // The Swarm provider polls Docker (it has no events) every 15 seconds by default. For that long after a deploy the
    // proxy still sent requests to the task that had just stopped, and a few failed or hung. At 2 seconds none did
    // in a redeploy-under-load test (2,400 requests over six redeploys).
    '--providers.swarm.refreshSeconds=2',
    '--entrypoints.web.address=:80',
    '--entrypoints.websecure.address=:443',
    '--ping=true',
    '--log.level=INFO',
    '--accesslog=false',
  ];
  if (o.trustedIPs?.length) {
    for (const ep of ['web', 'websecure'])
      args.push(
        `--entrypoints.${ep}.forwardedHeaders.trustedIPs=${o.trustedIPs.join(',')}`,
      );
  }
  if (o.acmeEmail) {
    args.push(
      `--certificatesresolvers.${o.certResolver}.acme.email=${o.acmeEmail}`,
      `--certificatesresolvers.${o.certResolver}.acme.storage=/letsencrypt/acme.json`,
      `--certificatesresolvers.${o.certResolver}.acme.httpchallenge.entrypoint=web`,
    );
    if (o.acmeStaging)
      args.push(
        `--certificatesresolvers.${o.certResolver}.acme.caserver=${ACME_STAGING_CA}`,
      );
  }

  return {
    Name: TRAEFIK_SERVICE,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_APP]: TRAEFIK_APP,
      'io.provelox.system': 'traefik',
      'traefik.enable': 'false',
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: o.image,
        Args: args,
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: TRAEFIK_APP },
        Mounts: [
          // Traefik discovers services through the Docker API
          {
            Type: 'bind',
            Source: '/var/run/docker.sock',
            Target: '/var/run/docker.sock',
            ReadOnly: true,
          },
          {
            Type: 'volume',
            Source: TRAEFIK_CERT_VOLUME,
            Target: '/letsencrypt',
            VolumeOptions: {
              Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: TRAEFIK_APP },
            },
          },
        ],
      },
      Networks: [{ Target: SHARED_NETWORK, Aliases: [TRAEFIK_APP] }],
      RestartPolicy: { Condition: 'any' },
      // the Swarm provider needs a manager's Docker API
      Placement: { Constraints: ['node.role==manager'] },
    },
    Mode: { Replicated: { Replicas: 1 } },
    // Two proxies cannot hold the same host ports, so the old one stops first
    UpdateConfig: {
      Parallelism: 1,
      Order: 'stop-first',
      FailureAction: 'rollback',
    },
    RollbackConfig: { Parallelism: 1, Order: 'stop-first' },
    EndpointSpec: {
      Ports: [
        // host mode keeps the visitor's real IP address
        {
          Protocol: 'tcp',
          TargetPort: 80,
          PublishedPort: o.httpPort,
          PublishMode: 'host',
        },
        {
          Protocol: 'tcp',
          TargetPort: 443,
          PublishedPort: o.httpsPort,
          PublishMode: 'host',
        },
      ],
    },
  };
}
