'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api, loadTemplate, loadTemplates } from '@/lib/backend';
import { toProjectPlan } from '@/lib/backend-map';
import type { BackendDeployResult, BackendPlan } from '@/lib/backend-types';
import type {
  KeptSettings,
  PlanIssue,
  ProjectPlan,
  Template,
} from '@/lib/types';
import { asUser, UserError, type ActionResult } from './guard';

const name = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,47}[a-z0-9])?$/,
    'Use lowercase letters, numbers and single dashes.',
  )
  .refine(
    (v) => !v.includes('--'),
    'Use lowercase letters, numbers and single dashes.',
  );
const compose = z
  .string()
  .min(1, 'Paste a compose file.')
  .max(256 * 1024, 'The file is too large (256 KB maximum).');
const variables = z
  .record(z.string().max(100), z.string().max(10_000))
  .default({});

/** Which service is an app that already runs, moved into the project: service name to app name. */
const adoptMap = z.record(z.string().max(100), z.string().max(100)).default({});

/** Which service is an existing service of the project under a new name: new name to old name. */
const renameMap = z
  .record(z.string().max(100), z.string().max(100))
  .default({});

const body = (
  n: string,
  c: string,
  v: Record<string, string>,
  adopt: Record<string, string> = {},
  renames: Record<string, string> = {},
) => ({
  name: name.parse(n),
  compose: compose.parse(c),
  variables: variables.parse(v),
  adopt: adoptMap.parse(adopt),
  renames: renameMap.parse(renames),
});

/** What deploying would do: nothing is changed. Problems come back in the plan, not as a failure. */
export async function previewProjectAction(
  projectName: string,
  composeText: string,
  vars: Record<string, string>,
  adopt: Record<string, string> = {},
  renames: Record<string, string> = {},
): Promise<ActionResult<ProjectPlan>> {
  return asUser(async (token) =>
    toProjectPlan(
      await api<BackendPlan>('projects/preview', {
        method: 'POST',
        token,
        body: body(projectName, composeText, vars, adopt, renames),
      }),
    ),
  );
}

export interface DeployedProject {
  services: string[];
  removed: string[];
  warnings: PlanIssue[];
}

/** Creates the project, or (update) brings an existing one in line with the file. */
export async function deployProjectAction(
  projectName: string,
  composeText: string,
  vars: Record<string, string>,
  update = false,
  adopt: Record<string, string> = {},
  renames: Record<string, string> = {},
): Promise<ActionResult<DeployedProject>> {
  const result = await asUser(async (token) => {
    const b = body(projectName, composeText, vars, adopt, renames);
    const r = await api<BackendDeployResult>(
      update ? `projects/${b.name}` : 'projects',
      {
        method: update ? 'PUT' : 'POST',
        token,
        body: b,
      },
    );
    return {
      services: r.apps.map((a) => a.name),
      removed: r.removed,
      warnings: r.warnings,
    };
  });
  if (result.ok) {
    revalidatePath('/apps');
    revalidatePath('/apps');
  }
  return result;
}

/** Removes the services and network. The data volumes are kept: they hold the project's data. */
/** Removes a project: its services and network. Data volumes are kept unless `deleteData` is set. */
export async function removeProjectAction(
  projectName: string,
  opts: { deleteData?: boolean } = {},
): Promise<ActionResult<{ keptVolumes: string[]; deletedVolumes: string[] }>> {
  const result = await asUser(async (token) => {
    const n = name.safeParse(projectName);
    if (!n.success) throw new UserError('Invalid project name');
    const r = await api<{
      keptVolumes: string[];
      deletedVolumes?: string[];
    }>(`projects/${n.data}${opts.deleteData ? '?deleteVolumes=true' : ''}`, {
      method: 'DELETE',
      token,
    });
    // An API older than the console never deletes volumes
    return {
      keptVolumes: r.keptVolumes,
      deletedVolumes: r.deletedVolumes ?? [],
    };
  });
  if (result.ok) {
    revalidatePath('/apps');
    revalidatePath('/apps');
  }
  return result;
}

/** A template with its compose file, loaded when someone picks it. */
export async function getTemplateAction(
  id: string,
): Promise<ActionResult<{ compose: string }>> {
  return asUser(async (token) => {
    const t = await loadTemplate(
      token,
      z
        .string()
        .regex(/^(ts_[a-f0-9]{10}:)?[a-z0-9-]{1,50}$/)
        .parse(id),
    );
    return { compose: t.compose };
  });
}

/** A project's compose file with something added, for the Update dialog to review. Nothing is deployed. */
export interface MergedCompose {
  compose: string;
  /** What the variables the new file needs start at (generated secrets, defaults, what was typed) */
  values: Record<string, string>;
  services: string[];
  /** What was renamed to avoid a clash with something already in the project */
  renamed: {
    kind: 'service' | 'volume' | 'variable';
    from: string;
    to: string;
  }[];
}

const templateId = z.string().regex(/^(ts_[a-f0-9]{10}:)?[a-z0-9-]{1,50}$/);

export async function addTemplateToProjectAction(
  project: string,
  template: string,
): Promise<ActionResult<MergedCompose>> {
  return asUser((token) =>
    api<MergedCompose>(`projects/${name.parse(project)}/add-template`, {
      method: 'POST',
      token,
      body: { template: templateId.parse(template) },
    }),
  );
}

/** Apps that already run, turned into a compose file for the Update (or new project) dialog to review. */
export interface GroupedApps extends MergedCompose {
  /** Service name to the app it is */
  adopt: Record<string, string>;
  /** Values the project's own services run with now, to start the review from (empty for a new project) */
  running: Record<string, string>;
  /** Each app moving in, and whether it is briefly down while it moves */
  moves: {
    app: string;
    service: string;
    gap: boolean;
    keeps?: KeptSettings;
  }[];
}

const appNames = z.array(z.string().max(100)).min(1).max(50);

/** Moves apps into a project that exists (`project` set) or a new one (null). Nothing is changed until it is reviewed. */
export async function groupAppsAction(
  project: string | null,
  apps: string[],
): Promise<ActionResult<GroupedApps>> {
  return asUser((token) =>
    api<GroupedApps>(
      project === null
        ? 'projects/from-apps'
        : `projects/${name.parse(project)}/add-apps`,
      { method: 'POST', token, body: { apps: appNames.parse(apps) } },
    ),
  );
}

/** The projects that exist, for choosing where to move apps. */
export async function listProjectNamesAction(): Promise<
  ActionResult<string[]>
> {
  return asUser(async (token) => {
    const all = await api<{ app: { project?: string } }[]>('apps', { token });
    return [
      ...new Set(all.flatMap((v) => (v.app.project ? [v.app.project] : []))),
    ].sort();
  });
}

/** Apps that can be moved into a project: the ones that are not part of one yet. */
export async function listMovableAppsAction(): Promise<
  ActionResult<{ name: string; image: string }[]>
> {
  return asUser(async (token) => {
    const all = await api<
      { app: { name: string; image: string; project?: string } }[]
    >('apps', { token });
    return all
      .filter((v) => !v.app.project)
      .map((v) => ({ name: v.app.name, image: v.app.image }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

export interface NewServiceInput {
  name: string;
  image: string;
  port?: number;
  expose: boolean;
  env: { key: string; value: string }[];
  volumePath?: string;
}

export async function addServiceToProjectAction(
  project: string,
  service: NewServiceInput,
): Promise<ActionResult<MergedCompose>> {
  return asUser((token) =>
    api<MergedCompose>(`projects/${name.parse(project)}/add-service`, {
      method: 'POST',
      token,
      body: {
        name: service.name,
        image: service.image.trim(),
        expose: service.expose,
        env: service.env.filter((e) => e.key.trim()),
        ...(service.port ? { port: service.port } : {}),
        ...(service.volumePath?.trim()
          ? { volumePath: service.volumePath.trim() }
          : {}),
      },
    }),
  );
}

/** The templates on offer (built in and from registries), for the picker that adds one to a project. */
export async function listTemplatesAction(): Promise<ActionResult<Template[]>> {
  return asUser(async (token) => (await loadTemplates(token)) as Template[]);
}
