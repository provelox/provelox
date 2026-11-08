'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  APP_NAME_RE,
  explainAppName,
  isNewAppNameAllowed,
} from '@/lib/app-name';
import { api, loadAppMounts, loadVolumeMigration } from '@/lib/backend';
import { toBackendPatch } from '@/lib/backend-map';
import type { BackendAppView } from '@/lib/backend-types';
import type { AppMounts, VolumeMigration } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const appName = z
  .string()
  .refine((v) => APP_NAME_RE.test(v), 'Invalid app name');
// Creating an app follows the stricter naming rule
const newAppName = z.string().refine(isNewAppNameAllowed, {
  error: (issue) => explainAppName(String(issue.input)) ?? 'Invalid app name',
});

/** The only fields the console may change on an app. Anything else is rejected. */
const patchSchema = z
  .object({
    disableDefaultSubDomain: z.boolean(),
    notExposeAsWebApp: z.boolean(),
    linkedDomain: z.string().trim().toLowerCase().max(253).nullable(),
    instanceCount: z.number().int().min(0).max(50),
    containerHttpPort: z.number().int().min(1).max(65535),
    forceSsl: z.boolean(),
    primaryDomain: z.string().trim().toLowerCase().max(253).nullable(),
    websocketSupport: z.boolean(),
    ports: z
      .array(
        z.object({
          containerPort: z.number().int().min(1).max(65535),
          hostPort: z.number().int().min(1).max(65535),
          protocol: z.enum(['tcp', 'udp']).optional(),
          publishMode: z.enum(['ingress', 'host']).optional(),
        }),
      )
      .max(50)
      .refine(
        (rows) =>
          new Set(rows.map((r) => `${r.hostPort}/${r.protocol ?? 'tcp'}`))
            .size === rows.length,
        'Each host port can only be used once per protocol',
      ),
    volumes: z
      .array(
        z
          .object({
            containerPath: z
              .string()
              .regex(
                /^\/[^\0:]*$/,
                'The path inside the container must be absolute, like /var/lib/data',
              )
              .refine(
                (p) => !p.split('/').includes('..'),
                'The path cannot contain ..',
              ),
            volumeName: z
              .string()
              .regex(
                /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
                'Volume names use letters, numbers, dots, dashes and underscores',
              )
              .optional(),
            hostPath: z
              .string()
              .regex(
                /^\/[^\0:]*$/,
                'The directory on the server must be an absolute path',
              )
              .refine(
                (p) => !p.split('/').includes('..'),
                'The path cannot contain ..',
              )
              .optional(),
            mode: z.string().max(10).optional(),
          })
          .refine(
            (v) => !!v.volumeName !== !!v.hostPath,
            'Pick either a Docker volume or a directory on the server',
          ),
      )
      .max(50)
      .refine(
        (rows) =>
          new Set(rows.map((r) => r.containerPath.replace(/\/+$/, ''))).size ===
          rows.length,
        'Each path inside the container can only be mounted once',
      ),
    basicAuth: z
      .object({
        users: z
          .array(
            z.union([
              z.object({
                name: z
                  .string()
                  .regex(
                    /^[A-Za-z0-9._@-]{1,64}$/,
                    'A user name uses letters, numbers and . _ @ -',
                  ),
                password: z
                  .string()
                  .min(8, 'A password needs at least 8 characters')
                  .max(200),
              }),
              z.object({
                name: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
                keep: z.literal(true),
              }),
            ]),
          )
          .min(1)
          .max(20),
        openPaths: z
          .array(
            z
              .string()
              .regex(
                /^\/[A-Za-z0-9._~%/-]*$/,
                'A path starts with / and uses letters, numbers and . _ ~ % / -',
              )
              .max(200),
          )
          .max(20),
      })
      .nullable(),
    cdn: z
      .object({
        provider: z.string().min(1).max(32),
        enforce: z.boolean(),
      })
      .nullable(),
    sso: z
      .object({
        provider: z.string().min(1).max(32),
        emails: z.array(z.string().trim().toLowerCase().email()).max(200),
        domains: z
          .array(z.string().trim().toLowerCase().min(3).max(253))
          .max(50),
        openPaths: z
          .array(
            z
              .string()
              .regex(
                /^\/[A-Za-z0-9._~%/-]*$/,
                'A path starts with / and uses letters, numbers and . _ ~ % / -',
              )
              .max(200),
          )
          .max(20),
      })
      .nullable(),
    aliases: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
            'A name uses lowercase letters, numbers and dashes.',
          ),
      )
      .max(10, 'At most 10 extra names.')
      .refine((a) => new Set(a).size === a.length, 'Each name once.'),
    placement: z
      .object({
        node: z.string().trim().min(1).max(253).optional(),
        role: z.enum(['worker', 'manager']).optional(),
      })
      .nullable(),
    envVars: z
      .array(
        z.object({
          key: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid variable name'),
          value: z.string().max(10_000),
        }),
      )
      .max(200)
      .refine(
        (rows) => new Set(rows.map((r) => r.key)).size === rows.length,
        'Variable names must be unique',
      ),
    // null clears a setting back to the image's own
    command: z.array(z.string().max(2000)).min(1).max(100).nullable(),
    entrypoint: z.array(z.string().max(2000)).min(1).max(100).nullable(),
    workingDir: z
      .string()
      .max(300)
      .regex(/^\//, 'Use an absolute path, like /app')
      .nullable(),
    user: z.string().max(100).nullable(),
    restart: z.enum(['any', 'on-failure', 'none']),
    resources: z
      .object({
        cpus: z.number().positive().max(256).optional(),
        memoryBytes: z
          .number()
          .int()
          .min(6 * 1024 * 1024)
          .optional(),
      })
      .nullable(),
    healthcheck: z
      .object({
        test: z.array(z.string().max(2000)).min(1).max(100),
        intervalSeconds: z.number().min(1).max(3600).optional(),
        timeoutSeconds: z.number().min(1).max(3600).optional(),
        retries: z.number().int().min(1).max(100).optional(),
        startPeriodSeconds: z.number().min(0).max(3600).optional(),
      })
      .nullable(),
  })
  .partial()
  .strict();

const imageName = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/,
    'Enter a valid image name, e.g. ghcr.io/org/app:tag',
  );

export async function registerAppAction(
  name: string,
  hasPersistentData: boolean,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api('apps', {
      method: 'POST',
      token,
      body: { name: newAppName.parse(name), persistent: hasPersistentData },
    });
  });
  if (result.ok) revalidatePath('/apps');
  return result;
}

/**
 * Changes the editable fields of an app. `acknowledgeSensitive` is the user's explicit confirmation to mount a
 * server directory that exposes the host (/etc, the Docker socket...): without it the API refuses.
 */
export async function updateAppAction(
  name: string,
  patch: z.input<typeof patchSchema>,
  acknowledgeSensitive = false,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}`, {
      method: 'PATCH',
      token,
      body: {
        ...toBackendPatch(patchSchema.parse(patch)),
        ...(acknowledgeSensitive
          ? { acknowledgeSensitiveHostPaths: true }
          : {}),
      },
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

/**
 * For an app that keeps its data on one server: forgets which. For when that server is gone or being replaced; the data
 * is not moved.
 */
export async function releasePinAction(name: string): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}/release-pin`, {
      method: 'POST',
      token,
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

/** Replaces the app's running instances with fresh ones, same image and settings. */
export async function restartAppAction(name: string): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}/restart`, {
      method: 'POST',
      token,
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

export async function deleteAppAction(name: string): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}`, { method: 'DELETE', token });
  });
  if (result.ok) revalidatePath('/apps');
  return result;
}

export interface AppReference {
  app: string;
  keys: string[];
  editable: boolean;
}

/** The other apps whose variables name this one, so a rename can say what it would break. Variable names only. */
export async function appReferencesAction(
  name: string,
): Promise<ActionResult<AppReference[]>> {
  return asUser((token) =>
    api<AppReference[]>(`apps/${appName.parse(name)}/references`, { token }),
  );
}

export interface RenameOutcome {
  updated: string[];
  failed: { app: string; error: string }[];
}

/**
 * Gives an app a new name. The app restarts under it (a short outage). `updateReferences` rewrites the other apps that
 * name it in their variables; `keepOldName` leaves the old name working on the network as an alias.
 */
export async function renameAppAction(
  name: string,
  to: string,
  opts: { updateReferences: boolean; keepOldName: boolean },
): Promise<ActionResult<RenameOutcome>> {
  const result = await asUser(async (token) => {
    const done = await api<RenameOutcome>(
      `apps/${appName.parse(name)}/rename`,
      {
        method: 'POST',
        token,
        body: {
          name: newAppName.parse(to),
          updateReferences: opts.updateReferences,
          keepOldName: opts.keepOldName,
        },
      },
    );
    return { updated: done.updated, failed: done.failed };
  });
  if (result.ok) revalidatePath('/apps', 'layout');
  return result;
}

/** Starts a deploy; the UI polls its progress afterwards. */
export async function deployImageAction(
  name: string,
  image: string,
): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`apps/${appName.parse(name)}/deploy`, {
      method: 'POST',
      token,
      body: { image: imageName.parse(image) },
    });
  });
}

const errorPages = z
  .object({
    '502': z.string().max(100 * 1024),
    '503': z.string().max(100 * 1024),
    '504': z.string().max(100 * 1024),
  })
  .partial()
  .strict();

/** Pages shown when the proxy can't reach the app. An empty string restores the default page. */
export async function setErrorPagesAction(
  name: string,
  pages: z.input<typeof errorPages>,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}`, {
      method: 'PATCH',
      token,
      body: { errorPages: errorPages.parse(pages) },
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

const placeholderHtml = z
  .string()
  .max(100 * 1024, 'The page can be at most 100 KB');

/** Platform-wide page for apps that have not been deployed yet. Empty restores the default page. */
export async function setPlaceholderPageAction(
  html: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api('system/placeholder-page', {
      method: 'PUT',
      token,
      body: { html: placeholderHtml.parse(html) },
    });
  });
  if (result.ok) revalidatePath('/settings/general');
  return result;
}

/** Re-reads mounts with their sizes. Sizes make Docker walk every volume, so this is on demand only. */
export async function loadMountSizesAction(
  name: string,
): Promise<ActionResult<AppMounts>> {
  return asUser(async (token) =>
    loadAppMounts(token, appName.parse(name), true),
  );
}

const volumeName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    'Volume names use letters, numbers, dots, dashes and underscores',
  );
const mountPath = z
  .string()
  .regex(
    /^\/[^\0:]*$/,
    'The path inside the container must be absolute, like /data',
  )
  .refine((p) => !p.split('/').includes('..'), 'The path cannot contain ..');

/**
 * Moves an unnamed volume of the app into a named one so its data survives redeploys. The API holds the original
 * while the app stops, copies and verifies the data, switches the app over, and restarts it, in the background.
 */
export async function startVolumeMigrationAction(
  name: string,
  containerPath: string,
  toVolume: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}/volumes/migrate`, {
      method: 'POST',
      token,
      body: {
        containerPath: mountPath.parse(containerPath),
        volumeName: volumeName.parse(toVolume),
      },
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

export async function getVolumeMigrationAction(
  name: string,
): Promise<ActionResult<VolumeMigration | null>> {
  return asUser(async (token) =>
    loadVolumeMigration(token, appName.parse(name)),
  );
}

/** After a failed move the original data is kept safe by a helper. Lets go of it. */
export async function releaseVolumeHoldAction(
  name: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(`apps/${appName.parse(name)}/volumes/migration/release`, {
      method: 'POST',
      token,
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

const wizardInput = z.object({
  name: newAppName,
  hasPersistentData: z.boolean(),
  groupId: z
    .string()
    .regex(/^g_[a-f0-9]{10}$/, 'Invalid collection')
    .nullable(),
  containerHttpPort: z.number().int().min(1).max(65535),
  /** Empty: create the app without deploying anything yet */
  image: z.union([imageName, z.literal('')]),
  /** Set: also create a CI deploy key with this name */
  ciKeyName: z.string().trim().min(1).max(60).nullable(),
  /** Serve <name>.<root domain>: the creator's choice, which wins over the platform's default */
  defaultSubdomain: z.boolean(),
  /** Set: also attach this domain to the app (HTTPS is turned on later, once its DNS points here) */
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(80)
    .regex(
      /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/,
      'Enter a domain such as api.example.com',
    )
    .or(z.literal(''))
    .default(''),
});

export interface WizardStep {
  id: 'register' | 'group' | 'port' | 'domain' | 'ci-key' | 'deploy';
  status: 'done' | 'failed' | 'skipped';
  error?: string;
}

export interface WizardResult {
  steps: WizardStep[];
  /** The CI key, shown to the user once */
  ciKey?: string;
}

const DEFAULT_CONTAINER_PORT = 80;

/**
 * Creates an app and applies the choices made in the wizard. Creating the app (with its group) is the only step
 * that can fail the whole call; once it exists, a failing later step is reported and the app is left as it is.
 */
export async function createAppWizardAction(
  input: z.input<typeof wizardInput>,
): Promise<ActionResult<WizardResult>> {
  const result = await asUser(async (token) => {
    const v = wizardInput.parse(input);
    await api<BackendAppView>('apps', {
      method: 'POST',
      token,
      body: {
        name: v.name,
        persistent: v.hasPersistentData,
        groupId: v.groupId,
        defaultSubdomain: v.defaultSubdomain,
      },
    });

    const steps: WizardStep[] = [
      { id: 'register', status: 'done' },
      { id: 'group', status: v.groupId ? 'done' : 'skipped' },
    ];
    let ciKey: string | undefined;
    const attempt = async (
      id: WizardStep['id'],
      wanted: boolean,
      fn: () => Promise<void>,
    ) => {
      if (!wanted) return void steps.push({ id, status: 'skipped' });
      try {
        await fn();
        steps.push({ id, status: 'done' });
      } catch (e) {
        steps.push({
          id,
          status: 'failed',
          error:
            e instanceof Error && e.message
              ? e.message
              : 'Something went wrong',
        });
      }
    };

    await attempt('port', v.containerHttpPort !== DEFAULT_CONTAINER_PORT, () =>
      api(`apps/${v.name}`, {
        method: 'PATCH',
        token,
        body: { containerPort: v.containerHttpPort },
      }).then(() => undefined),
    );
    await attempt('domain', !!v.domain, async () => {
      const base = `apps/${v.name}`;
      const view = await api<BackendAppView>(base, { token });
      await api(base, {
        method: 'PATCH',
        token,
        body: {
          domains: [...view.app.domains, { host: v.domain, ssl: false }],
        },
      });
    });
    await attempt('ci-key', !!v.ciKeyName, async () => {
      const created = await api<{ key: string }>('ci-keys', {
        method: 'POST',
        token,
        body: { app: v.name, name: v.ciKeyName },
      });
      ciKey = created.key;
    });
    await attempt('deploy', !!v.image, () =>
      api(`apps/${v.name}/deploy`, {
        method: 'POST',
        token,
        body: { image: v.image },
      }).then(() => undefined),
    );
    return { steps, ciKey } satisfies WizardResult;
  });
  if (result.ok) {
    revalidatePath('/apps');
    revalidatePath('/settings/access');
  }
  return result;
}
