import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Where the SQLite file lives. Back this directory up. */
  DATA_DIR: z.string().min(1).default('./data'),
  /** Signs login tokens. Changing it signs everyone out. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Docker Engine socket */
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /**
   * Password for the first start. When it is not set a random one is generated and printed once to the log.
   * There is deliberately no default password.
   */
  ADMIN_PASSWORD: z.string().optional(),
  /** Apps are served at <app>.<ROOT_DOMAIN>. Can also be set at runtime. */
  ROOT_DOMAIN: z.string().optional(),
  /** Runs until an app's first real deploy */
  PLACEHOLDER_IMAGE: z.string().default('nginx:alpine'),
  /** Short-lived container used to copy data between volumes. Needs cp and diff (busybox has both). */
  HELPER_IMAGE: z.string().default('busybox:latest'),
  /**
   * The folder on the SERVER (a path on the machine Docker runs on, not inside the API's container) where archives of
   * volumes are saved and where large ones are put with rsync or scp to be restored. Only this folder is ever read
   * or written, by short-lived helper containers, and only files in it by name: no other path is accepted anywhere.
   */
  IMPORTS_DIR: z
    .string()
    .regex(
      /^\/[A-Za-z0-9._/-]+$/,
      'IMPORTS_DIR must be an absolute path of letters, digits and . _ - /',
    )
    .refine(
      (v) => !v.split('/').includes('..'),
      'IMPORTS_DIR must not contain ..',
    )
    .default('/var/lib/provelox/imports'),
  /** How often every running app's CPU and memory is sampled for the history. 0 turns the history off. */
  USAGE_SAMPLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** How often apps are checked for something to tell people about. 0 turns notifications off. */
  NOTIFY_CHECK_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** How long samples are kept */
  /** How long the activity log keeps what people changed, and the most it keeps */
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  ACTIVITY_MAX_EVENTS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(1000000)
    .default(50000),
  USAGE_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Traefik certificate resolver used for HTTPS hosts */
  CERT_RESOLVER: z.string().default('le'),
  /**
   * Now and then ask where the project publishes releases whether a newer one exists, and say so in the console. Off:
   * this API never contacts that server (it can also be turned off under Settings, but never turned on here).
   */
  UPDATE_CHECK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Where the newest release is read from: GitHub's answer for the project's latest (stable) release */
  RELEASES_URL: z
    .string()
    .url()
    .default('https://api.github.com/repos/provelox/provelox/releases/latest'),
  /** Run and manage the Traefik proxy service. Turn off to bring your own reverse proxy. */
  PROXY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Host ports Traefik is published on */
  PROXY_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(80),
  PROXY_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  /** How often the address ranges of the CDNs apps sit behind are refreshed. 0 turns the refresh off. */
  CDN_REFRESH_HOURS: z.coerce.number().min(0).max(720).default(6),
  TRAEFIK_IMAGE: z.string().default('traefik:v3.6'),
  /**
   * Comma-separated CIDRs of proxies in front of Traefik (e.g. CloudFront's ranges) whose X-Forwarded-For it should
   * keep. Unset: Traefik replaces the header with the peer address. Changing it restarts the proxy (briefly).
   */
  PROXY_TRUSTED_IPS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  /** Where the API asks the proxy which certificate it serves for a host: its name on the shared network, and its HTTPS port inside */
  PROXY_TLS_HOST: z.string().default('traefik'),
  PROXY_TLS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  /** Let's Encrypt account email. HTTPS needs one. Can also be set at runtime. */
  ACME_EMAIL: z.string().email().optional(),
  /** Use Let's Encrypt's staging CA (certificates are not trusted, but there are no rate limits) */
  ACME_STAGING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Traefik service that serves GET /internal/error-pages/<app>/<status> (the API, deployed as a Swarm service with
   * that service defined in its labels), e.g. pvx-api-errors@swarm. Unset: apps cannot have custom error pages.
   */
  ERROR_PAGES_SERVICE: z.string().optional(),
  /** The address the API answers at from outside (https://api.example.com). Sign-in providers send people back to it. */
  API_PUBLIC_URL: z.string().url().optional(),
  /** Where the proxy reaches the API to ask whether a visitor has signed in. Default: the API's own Swarm service. */
  SSO_VERIFY_URL: z.string().url().optional(),
  /** How long a sign-in to an app lasts */
  SSO_SESSION_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(12),
  SESSION_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(8),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (FOO=) means "not set"
  const cleaned: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== ''),
  );
  // Docker secrets arrive as files: FOO_FILE=/run/secrets/foo supplies FOO (a plain FOO wins if both are set)
  for (const [key, file] of Object.entries(cleaned)) {
    if (!key.endsWith('_FILE') || !file) continue;
    const target = key.slice(0, -'_FILE'.length);
    if (cleaned[target] !== undefined) continue;
    try {
      cleaned[target] = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(
        `Invalid configuration: ${key} points to ${file}, which cannot be read.`,
      );
    }
  }
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
