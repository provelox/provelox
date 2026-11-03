import { z } from 'zod';
import { fleetHash } from '../system/fleet-hash';
import {
  envVar,
  PLATFORM_HOST_PORTS,
  HOSTNAME_RE,
  portMapping,
  type AppDefinition,
} from './app.model';

const IMAGE = /^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/;

/**
 * What a hub may define about an app and keep the same on every node: the image, how it listens, its published ports,
 * environment, whether it keeps data in named volumes, and how many run. Nothing that could reach into a server (no
 * host directories, no secrets, no domains): an update token is allowed to apply this, so it stays narrow.
 */
export const blueprintSpec = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/,
        'Use lowercase letters, numbers and dashes for the app name.',
      ),
    image: z.string().regex(IMAGE, 'Enter an image like ghcr.io/org/app:1.2.3'),
    /** Fixed when the app is created: only such apps keep data */
    persistent: z.boolean().default(false),
    containerPort: z.number().int().min(1).max(65535).default(80),
    instanceCount: z.number().int().min(0).max(50).default(1),
    exposed: z.boolean().default(true),
    defaultSubdomain: z.boolean().default(false),
    /** A name for identification; never routed */
    linkedDomain: z
      .string()
      .toLowerCase()
      .regex(HOSTNAME_RE)
      .nullable()
      .default(null),
    restart: z.enum(['any', 'on-failure', 'none']).default('any'),
    env: z.array(envVar).max(100).default([]),
    ports: z.array(portMapping).max(20).default([]),
    /** Docker volumes, named after the app and the path: data survives redeploys */
    volumes: z
      .array(
        z
          .object({
            containerPath: z
              .string()
              .regex(/^\/[^\0:]*$/)
              .refine((p) => !p.split('/').includes('..')),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (new Set(s.env.map((e) => e.key)).size !== s.env.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Variable names must be unique.',
      });
    if (
      new Set(s.ports.map((p) => `${p.hostPort}/${p.protocol}`)).size !==
      s.ports.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Each host port can only be used once per protocol.',
      });
    // Ports the platform itself listens on, or needs between its machines: an app must never publish these
    for (const p of s.ports)
      if (PLATFORM_HOST_PORTS.includes(p.hostPort))
        ctx.addIssue({
          code: 'custom',
          message: `Host port ${p.hostPort} is used by the platform itself.`,
        });
    if (s.volumes.length > 0 && !s.persistent)
      ctx.addIssue({
        code: 'custom',
        message: 'Only an app with persistent data can have volumes.',
      });
    if (s.persistent && s.instanceCount > 1)
      ctx.addIssue({
        code: 'custom',
        message: 'An app with persistent data runs a single instance.',
      });
  });

export type BlueprintSpec = z.infer<typeof blueprintSpec>;

/** The volume a blueprint path is kept in: the same on every node, and per app. */
export const volumeNameFor = (app: string, containerPath: string) =>
  `${app}-${containerPath.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'data'}`.slice(
    0,
    64,
  );

/** The parts of an app a blueprint governs, in the order and shape the hub makes its own copy: compared by fingerprint. */
export function specOfApp(a: AppDefinition) {
  return {
    image: a.image,
    persistent: a.persistent,
    containerPort: a.containerPort,
    instanceCount: a.instanceCount,
    exposed: a.exposed,
    defaultSubdomain: a.defaultSubdomain,
    linkedDomain: a.linkedDomain ?? null,
    restart: a.restart,
    env: [...a.env].sort((x, y) =>
      x.key < y.key ? -1 : x.key > y.key ? 1 : 0,
    ),
    ports: [...a.ports]
      .map((p) => ({
        containerPort: p.containerPort,
        hostPort: p.hostPort,
        protocol: p.protocol,
      }))
      .sort(
        (x, y) => x.hostPort - y.hostPort || (x.protocol < y.protocol ? -1 : 1),
      ),
    volumes: a.volumes
      .map((v) => v.containerPath)
      .sort()
      .map((containerPath) => ({ containerPath })),
  };
}

/** The same shape from a blueprint, so the two can be fingerprinted alike. */
export function specOfBlueprint(s: BlueprintSpec) {
  return {
    image: s.image,
    persistent: s.persistent,
    containerPort: s.containerPort,
    instanceCount: s.instanceCount,
    exposed: s.exposed,
    defaultSubdomain: s.defaultSubdomain,
    linkedDomain: s.linkedDomain,
    restart: s.restart,
    env: [...s.env].sort((x, y) =>
      x.key < y.key ? -1 : x.key > y.key ? 1 : 0,
    ),
    ports: [...s.ports]
      .map((p) => ({
        containerPort: p.containerPort,
        hostPort: p.hostPort,
        protocol: p.protocol,
      }))
      .sort(
        (x, y) => x.hostPort - y.hostPort || (x.protocol < y.protocol ? -1 : 1),
      ),
    volumes: s.volumes
      .map((v) => v.containerPath)
      .sort()
      .map((containerPath) => ({ containerPath })),
  };
}

export const blueprintHash = (spec: ReturnType<typeof specOfApp>) =>
  fleetHash(spec);
