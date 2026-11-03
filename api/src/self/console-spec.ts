import type { SwarmServiceSpec } from '../apps/service-spec';
import { LABEL_APP, LABEL_MANAGED, SHARED_NETWORK } from '../common/naming';
import { hostRoutingLabels } from './routing';

/** The console's identity. "console" is a reserved app name, so no user app can take it. */
export const CONSOLE_APP = 'console';
export const CONSOLE_SERVICE = 'pvx-console';
export const CONSOLE_SESSION_SECRET = 'pvx-console-session';
const CONSOLE_PORT = 3000;

export interface ConsoleSpecOptions {
  image: string;
  host: { host: string; ssl: boolean };
  certResolver: string;
  /** How the console's server reaches the API: the API's name on the shared network */
  apiUrl: string;
  /** How CI reaches the API, shown in the workflow snippet */
  publicApiUrl?: string;
  sessionHours?: number;
  sessionSecret: { id: string; name: string };
}

/**
 * The web console as a platform service, like the API: installed and upgraded by `bootstrap`, it never appears in
 * the apps list, and nobody can stop or delete it from the console it is serving. It keeps no data of its own
 * (sessions live in encrypted cookies), so it starts the new instance before stopping the old one.
 */
export function buildConsoleSpec(o: ConsoleSpecOptions): SwarmServiceSpec {
  const env: Record<string, string> = {
    PROVELOX_API_URL: o.apiUrl,
    // The signing key is a Docker secret file, never a plain environment variable
    SESSION_SECRET_FILE: `/run/secrets/${o.sessionSecret.name}`,
  };
  if (o.publicApiUrl) env.PROVELOX_PUBLIC_API_URL = o.publicApiUrl;
  if (o.sessionHours) env.SESSION_HOURS = String(o.sessionHours);

  return {
    Name: CONSOLE_SERVICE,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_APP]: CONSOLE_APP,
      'io.provelox.system': 'console',
      'traefik.enable': 'true',
      'traefik.swarm.network': SHARED_NETWORK,
      ...hostRoutingLabels('pvx_console', o.host, CONSOLE_PORT, o.certResolver),
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: o.image,
        // The same image as the API, started in its console role. Not root: it needs no Docker socket.
        Args: ['console'],
        User: 'node',
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: CONSOLE_APP },
        Secrets: [
          {
            SecretID: o.sessionSecret.id,
            SecretName: o.sessionSecret.name,
            File: {
              Name: o.sessionSecret.name,
              UID: '0',
              GID: '0',
              Mode: 0o444,
            },
          },
        ],
        Healthcheck: {
          Test: [
            'CMD',
            'node',
            '-e',
            `fetch('http://127.0.0.1:${CONSOLE_PORT}/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`,
          ],
          Interval: 15_000_000_000,
          Timeout: 5_000_000_000,
          Retries: 3,
          StartPeriod: 15_000_000_000,
        },
      },
      Networks: [{ Target: SHARED_NETWORK, Aliases: [CONSOLE_APP] }],
      RestartPolicy: { Condition: 'any' },
    },
    Mode: { Replicated: { Replicas: 1 } },
    UpdateConfig: {
      Parallelism: 1,
      Order: 'start-first',
      FailureAction: 'rollback',
    },
    RollbackConfig: { Parallelism: 1, Order: 'start-first' },
  };
}
