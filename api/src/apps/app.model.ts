import { z } from 'zod';
import { isValidName, RESERVED_NAMES } from '../common/naming';

/** The shape of a name. Used when reading stored apps, so it must never reject a name that was valid when created. */
export const appName = z
  .string()
  .refine(
    isValidName,
    'Use lowercase letters, numbers and single dashes (at most 49 characters).',
  );

/** A name for a NEW app: also not one the platform's own services use. */
export const newAppName = appName.refine(
  (n) => !RESERVED_NAMES.includes(n),
  'That name is reserved.',
);

const containerPath = z
  .string()
  .regex(
    /^\/[^\0:]*$/,
    'The path inside the container must be absolute, like /data',
  )
  .refine((p) => !p.split('/').includes('..'), 'The path cannot contain ..');

export const envVar = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid variable name'),
  value: z.string().max(10_000),
});

export const portMapping = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
});

export const volumeMount = z
  .object({
    containerPath,
    /** A Docker volume this service manages (named per app); data survives redeploys */
    volumeName: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
        'Volume names use letters, numbers, dots, dashes and underscores',
      )
      .optional(),
    /**
     * What Docker calls the volume, when that is not `pvx-<app>-<volumeName>`: an app that was renamed keeps its volumes
     * under the names they were created with, because Docker cannot rename a volume and the data is in it.
     */
    dockerName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
    /** A directory that already exists on the server */
    hostPath: z
      .string()
      .regex(/^\/[^\0:]*$/)
      .refine((p) => !p.split('/').includes('..'))
      .optional(),
    readOnly: z.boolean().default(false),
  })
  .refine(
    (v) => !!v.volumeName !== !!v.hostPath,
    'Pick either a Docker volume or a directory on the server',
  );

export const healthcheck = z.object({
  test: z.array(z.string()).min(1),
  intervalSeconds: z.number().min(1).max(3600).optional(),
  timeoutSeconds: z.number().min(1).max(3600).optional(),
  retries: z.number().int().min(1).max(100).optional(),
  startPeriodSeconds: z.number().min(0).max(3600).optional(),
});

export const resources = z.object({
  /** CPU cores, e.g. 0.5 */
  cpus: z.number().positive().max(256).optional(),
  memoryBytes: z.number().int().positive().optional(),
});

/** A fully qualified domain name, like app.example.com */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export const domain = z.object({
  host: z
    .string()
    .toLowerCase()
    .regex(HOSTNAME_RE, 'Enter a valid domain, like app.example.com'),
  /** Serve this domain over HTTPS (certificate issued automatically) */
  ssl: z.boolean().default(false),
});

/** A DNS-style name on the shared network. Looser than an app name: CapRover's own names contain two dashes. */
export const networkAlias = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    'Use lowercase letters, numbers and dashes.',
  );

/** Password hashes Traefik's basic auth reads: bcrypt, Apache MD5 (apr1) or SHA1. Never a plain password. */
export const PASSWORD_HASH =
  /^(\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}|\$apr1\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{22}|\{SHA\}[A-Za-z0-9+/]{27}=)$/;

/**
 * A username and password the proxy asks for before it lets anyone reach the app (HTTP basic auth). Only hashes are kept.
 * `openPaths` stay reachable without a password (a webhook, a health check), as prefixes of the path.
 */
export const basicAuth = z
  .object({
    users: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
            hash: z.string().regex(PASSWORD_HASH),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    openPaths: z
      .array(
        z
          .string()
          .regex(/^\/[A-Za-z0-9._~%/-]*$/)
          .max(200),
      )
      .max(20)
      .default([]),
  })
  .strict();

/**
 * Which machines of a cluster may run the app: one by its hostname, or any worker, or any manager. Unset: anywhere.
 * An app that keeps data on a local volume is held to the machine that has the volume, whatever is set here.
 */
export const placement = z
  .object({
    role: z.enum(['worker', 'manager']).optional(),
    node: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use the machine’s hostname.')
      .optional(),
  })
  .strict()
  .refine((p) => !(p.role && p.node), 'Choose a machine or a role, not both.');

/**
 * Host ports no app may publish by choice: the web proxy, SSH, Docker's own, and Swarm's traffic between machines. Swarm
 * publishes through its ingress, which takes the port over from whatever listens on it, so publishing one would cut the
 * server off. (Imported apps may still list them as pending: they are recorded, never published.)
 */
export const PLATFORM_HOST_PORTS = [22, 80, 443, 2375, 2376, 2377, 4789, 7946];

/**
 * The CDN the app sits behind (an id from the CDN registry). With `enforce`, the proxy answers only requests that
 * come from that CDN's address ranges, so the app cannot be reached around it.
 */
export const cdnSetting = z
  .object({
    provider: z.string().min(1).max(32),
    enforce: z.boolean().default(false),
  })
  .strict();

/**
 * Asks visitors to sign in with an identity provider (an id from the SSO registry) before the app. Only the listed
 * addresses, or anyone on a listed email domain, get through. `openPaths` stay reachable without signing in.
 */
export const ssoSetting = z
  .object({
    provider: z.string().min(1).max(32),
    emails: z
      .array(z.string().trim().toLowerCase().email().max(254))
      .max(200)
      .default([]),
    domains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/,
            'Use a domain like example.com',
          ),
      )
      .max(50)
      .default([]),
    openPaths: z
      .array(
        z
          .string()
          .regex(/^\/[A-Za-z0-9._~%/-]*$/)
          .max(200),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .refine((s) => s.emails.length + s.domains.length > 0, {
    message: 'Say who may sign in: at least one email address or domain.',
  });

export const appDefinition = z.object({
  name: appName,
  /** Fixed at creation: only such apps may mount data, and they run one instance */
  persistent: z.boolean().default(false),
  /** Image currently deployed. Empty until the first deploy (the placeholder page is shown) */
  image: z.string().default(''),
  instanceCount: z.number().int().min(0).max(50).default(1),
  /** Reachable from the internet through the proxy. Otherwise only other apps can call it */
  exposed: z.boolean().default(true),
  containerPort: z.number().int().min(1).max(65535).default(80),
  forceSsl: z.boolean().default(false),
  /** Serve https://<name>.<root domain> */
  defaultSubdomain: z.boolean().default(true),
  defaultSubdomainSsl: z.boolean().default(false),
  domains: z.array(domain).max(50).default([]),
  /** One of the app's addresses. Every other address redirects to it, keeping the path and query. */
  primaryDomain: z.string().max(253).optional(),
  /**
   * A name that points at this server, for identification (a DNS server's own name, say). It is never routed: the proxy
   * does not answer for it, whether or not the app is exposed.
   */
  linkedDomain: z.string().max(253).optional(),
  /** Extra names other apps can reach it by on the shared network (an imported app keeps its old CapRover name) */
  aliases: z.array(networkAlias).max(10).default([]),
  env: z.array(envVar).max(200).default([]),
  ports: z.array(portMapping).max(50).default([]),
  /**
   * Host ports this app is meant to publish but cannot yet, because another platform still holds them (an imported
   * CapRover app). Kept as a record only: Swarm refuses a duplicate published port even at zero instances, so nothing
   * here reaches the service until it is moved into `ports`.
   */
  pendingPorts: z.array(portMapping).max(50).default([]),
  volumes: z.array(volumeMount).max(50).default([]),
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  healthcheck: healthcheck.optional(),
  resources: resources.optional(),
  restart: z.enum(['any', 'on-failure', 'none']).default('any'),
  /** Compose projects: which project it belongs to and the name other services use for it */
  project: z.string().optional(),
  serviceAlias: z.string().optional(),
  /** Created from a blueprint a hub sent. Only such an app can be changed by one, so a token cannot take over the others */
  blueprint: z.boolean().optional(),
  /** Where in a cluster it may run. Unset: anywhere */
  placement: placement.optional(),
  /** Asks everyone for a username and password before the app, except on `openPaths`. Unset: no password */
  basicAuth: basicAuth.optional(),
  /** The CDN in front of it, if any */
  cdn: cdnSetting.optional(),
  /** Visitors sign in with an identity provider before the app */
  sso: ssoSetting.optional(),
  dependsOn: z.array(z.string()).default([]),
  /** Swarm secrets mounted as files under /run/secrets. Only names are kept here, never values */
  secrets: z
    .array(
      z.object({
        name: z.string(),
        /** The Docker secret currently holding the value (immutable, so a new value is a new secret) */
        dockerName: z.string(),
        id: z.string(),
        createdAt: z.string(),
        /** The app name the Docker secret is labelled with, when the app has been renamed since it was made */
        owner: z.string().optional(),
      }),
    )
    .default([]),
  /** Pages nginx-style proxies show when the app cannot answer. Missing: the platform's default page */
  errorPages: z
    .object({
      '502': z.string().max(100 * 1024),
      '503': z.string().max(100 * 1024),
      '504': z.string().max(100 * 1024),
    })
    .partial()
    .default({}),
  groupId: z.string().nullable().default(null),
  deployVersion: z.number().int().min(0).default(0),
  /** Newest last, capped. Lets you see (and later roll back to) what was deployed before */
  versions: z
    .array(
      z.object({
        version: z.number().int(),
        image: z.string(),
        deployedAt: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string(),
});

export type AppDefinition = z.infer<typeof appDefinition>;
export type AppDefinitionInput = z.input<typeof appDefinition>;
