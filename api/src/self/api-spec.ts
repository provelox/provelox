import type { SwarmServiceSpec } from '../apps/service-spec';
import { hostRoutingLabels } from './routing';
import { LABEL_APP, LABEL_MANAGED, SHARED_NETWORK } from '../common/naming';

/** The API's own identity. "provelox" is a reserved app name, so no user app can collide with it. */
export const SELF_APP = 'provelox';
export const SELF_SERVICE = 'pvx-provelox';
export const SELF_DATA_VOLUME = 'pvx-provelox-data';
export const SELF_JWT_SECRET = 'pvx-provelox-jwt';
export const SELF_ADMIN_SECRET = 'pvx-provelox-admin-password';
/**
 * The Traefik service that serves custom error pages (this API's /internal/error-pages). The underscores keep it
 * clear of any app: app names cannot contain them.
 */
export const ERROR_PAGES_TRAEFIK_SERVICE = 'pvx_error_pages';
export const ERROR_PAGES_SERVICE_REF = `${ERROR_PAGES_TRAEFIK_SERVICE}@swarm`;

export interface ApiSpecOptions {
  image: string;
  port: number;
  httpPort: number;
  httpsPort: number;
  certResolver: string;
  traefikImage?: string;
  rootDomain?: string;
  acmeEmail?: string;
  acmeStaging?: boolean;
  /** Serve the API itself at this host (the console talks to it there) */
  apiHost?: { host: string; ssl: boolean };
  jwtSecret: { id: string; name: string };
  adminPassword?: { id: string; name: string };
  /** The sign-in the install was given for a private image, for the API to register on start (see RegistriesService) */
  registrySeed?: { id: string; name: string };
}

/** The API as a Swarm service: one instance (SQLite has a single writer), on a manager (it drives Docker). */
export function buildApiSpec(o: ApiSpecOptions): SwarmServiceSpec {
  const env: Record<string, string> = {
    PORT: String(o.port),
    DATA_DIR: '/data',
    DOCKER_SOCKET: '/var/run/docker.sock',
    JWT_SECRET_FILE: `/run/secrets/${o.jwtSecret.name}`,
    PROXY_HTTP_PORT: String(o.httpPort),
    PROXY_HTTPS_PORT: String(o.httpsPort),
    CERT_RESOLVER: o.certResolver,
    ERROR_PAGES_SERVICE: ERROR_PAGES_SERVICE_REF,
  };
  if (o.adminPassword)
    env.ADMIN_PASSWORD_FILE = `/run/secrets/${o.adminPassword.name}`;
  if (o.registrySeed)
    env.REGISTRY_SEED_FILE = `/run/secrets/${o.registrySeed.name}`;
  // Sign-in providers send people back to the API at its own address
  if (o.apiHost) {
    const [scheme, port, usual] = o.apiHost.ssl
      ? ['https', o.httpsPort, 443]
      : ['http', o.httpPort, 80];
    env.API_PUBLIC_URL = `${scheme}://${o.apiHost.host}${port === usual ? '' : `:${port}`}`;
  }
  if (o.rootDomain) env.ROOT_DOMAIN = o.rootDomain;
  if (o.acmeEmail) env.ACME_EMAIL = o.acmeEmail;
  if (o.acmeStaging) env.ACME_STAGING = 'true';
  if (o.traefikImage) env.TRAEFIK_IMAGE = o.traefikImage;

  const labels: Record<string, string> = {
    [LABEL_MANAGED]: 'true',
    [LABEL_APP]: SELF_APP,
    'io.provelox.system': 'api',
    'traefik.enable': 'true',
    'traefik.swarm.network': SHARED_NETWORK,
    // Traefik asks this service for custom error pages (see ERROR_PAGES_SERVICE)
    [`traefik.http.services.${ERROR_PAGES_TRAEFIK_SERVICE}.loadbalancer.server.port`]:
      String(o.port),
  };
  // Anything no app answers to (an unknown address) gets the branded 404 instead of the proxy's bare one. Priority 1
  // keeps it below every real router.
  const nf = 'traefik.http.routers.pvx_not_found';
  const nfMiddleware =
    'traefik.http.middlewares.pvx_not_found-path.replacepath.path';
  labels[nfMiddleware] = '/internal/error-pages/not-found';
  for (const [suffix, entry] of [
    ['web', 'web'],
    ['websecure', 'websecure'],
  ] as const) {
    labels[`${nf}-${suffix}.rule`] = 'PathPrefix(`/`)';
    labels[`${nf}-${suffix}.priority`] = '1';
    labels[`${nf}-${suffix}.entrypoints`] = entry;
    labels[`${nf}-${suffix}.service`] = ERROR_PAGES_TRAEFIK_SERVICE;
    labels[`${nf}-${suffix}.middlewares`] = 'pvx_not_found-path';
    if (suffix === 'websecure') labels[`${nf}-${suffix}.tls`] = 'true';
  }
  if (o.apiHost)
    Object.assign(
      labels,
      hostRoutingLabels('pvx_api', o.apiHost, o.port, o.certResolver),
    );

  const secrets = [
    o.jwtSecret,
    ...(o.adminPassword ? [o.adminPassword] : []),
    ...(o.registrySeed ? [o.registrySeed] : []),
  ].map((s) => ({
    SecretID: s.id,
    SecretName: s.name,
    File: { Name: s.name, UID: '0', GID: '0', Mode: 0o444 },
  }));

  return {
    Name: SELF_SERVICE,
    Labels: labels,
    TaskTemplate: {
      ContainerSpec: {
        Image: o.image,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: SELF_APP },
        Mounts: [
          {
            Type: 'bind',
            Source: '/var/run/docker.sock',
            Target: '/var/run/docker.sock',
          },
          {
            Type: 'volume',
            Source: SELF_DATA_VOLUME,
            Target: '/data',
            VolumeOptions: {
              Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: SELF_APP },
            },
          },
        ],
        Secrets: secrets,
        Healthcheck: {
          Test: [
            'CMD',
            'node',
            '-e',
            `fetch('http://127.0.0.1:${o.port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
          ],
          Interval: 15_000_000_000,
          Timeout: 5_000_000_000,
          Retries: 3,
          StartPeriod: 20_000_000_000,
        },
      },
      Networks: [{ Target: SHARED_NETWORK, Aliases: [SELF_APP] }],
      RestartPolicy: { Condition: 'any' },
      Placement: { Constraints: ['node.role==manager'] },
    },
    Mode: { Replicated: { Replicas: 1 } },
    // one writer at a time: the old instance stops before the new one opens the database
    UpdateConfig: {
      Parallelism: 1,
      Order: 'stop-first',
      FailureAction: 'rollback',
    },
    RollbackConfig: { Parallelism: 1, Order: 'stop-first' },
  };
}
