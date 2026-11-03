import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import type { AppDefinition } from '../apps/app.model';
import { AppsRepo } from '../apps/apps.repo';
import { AppsService } from '../apps/apps.service';
import { mountSource } from '../apps/service-spec';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import {
  explainName,
  projectNetwork,
  serviceName,
  volumeName,
} from '../common/naming';
import { Db } from '../db/db';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { GroupsService } from '../groups/groups.service';
import { TemplateSourcesService } from '../templates/template-sources.service';
import { templateById } from '../templates/catalog';
import { addService, mergeTemplate } from './compose-merge';
import {
  connectionOf,
  readBack,
  resolveVariables,
  templateOfProject,
} from '../templates/connection';
import { composeVariables } from './compose-variables';
import {
  adoptDefinition,
  groupCompose,
  groupingProblems,
  keptSettings,
  needsGap,
  type KeptSettings,
} from './adopt';
import { diffPlan, type ServiceDiff } from './plan-diff';
import { planCompose, type ComposePlan, type PlanIssue } from './compose';

export const projectInput = z.object({
  /** The compose file text */
  compose: z.string().min(1, 'Paste a compose file.'),
  /** Values for ${VAR} references. Used to build the apps, not stored */
  variables: z.record(z.string(), z.string()).default({}),
  /**
   * Services that are apps already running, moved into the project: service name to the app's name. Not part of the
   * compose file, which stays plain compose; the apps keep their data and address (see adopt.ts).
   */
  adopt: z.record(z.string(), z.string()).default({}),
  /**
   * Services that are an existing service of this project under a new name: the new service's name to the old one's.
   * Without this a renamed service looks like one removed and one new, and everything the compose file cannot say (its
   * addresses, deploy keys, history) goes with the old one. With it, the old app becomes the new one (see `renamings`).
   */
  renames: z.record(z.string(), z.string()).default({}),
});

/** A removed service and an added one that look like the same service under a new name. Only ever a suggestion. */
export interface RenameCandidate {
  /** The service's name now (in the project) */
  from: string;
  /** Its name in the new file */
  to: string;
  /** Why they look alike, in a sentence */
  reason: string;
}

export interface ProjectPlanView {
  project: string;
  /** What deploying this would do to apps that already exist */
  changes: { create: string[]; update: string[]; remove: string[] };
  /** What the update does to each service, so a person can see what restarts and why (see plan-diff.ts) */
  diff: ServiceDiff[];
  apps: AppDefinition[];
  /** Apps that are moved in, and whether each is briefly down while it moves (it keeps data or a host port) */
  adopting: {
    service: string;
    app: string;
    to: string;
    gap: boolean;
    /** What it keeps that the compose file cannot say (addresses, password, sign-in ...) */
    keeps: KeptSettings;
  }[];
  /** Services renamed in this update, keeping what the old app had; `gap` is whether it is briefly down meanwhile */
  renaming: {
    from: string;
    to: string;
    app: string;
    gap: boolean;
    keeps: KeptSettings;
  }[];
  /** Removed and added services that look like a rename, for the person to confirm (never applied on their own) */
  renameCandidates: RenameCandidate[];
  volumes: string[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export interface DeployResult {
  project: string;
  apps: { name: string; action: 'created' | 'updated' }[];
  /** Services renamed keeping their settings, by app name */
  renamed: { from: string; to: string }[];
  removed: string[];
  warnings: PlanIssue[];
}

interface ProjectRow {
  name: string;
  compose: string;
  variable_names: string;
  updated_at: string;
}

/** Fields the user sets on an app after the project created it; a redeploy must not undo them. */
const KEEP_FROM_EXISTING = [
  'exposed',
  'domains',
  'primaryDomain',
  'forceSsl',
  'defaultSubdomain',
  'defaultSubdomainSsl',
  'groupId',
  'createdAt',
  // other names the app answers to on the network, such as the name an app had before it joined
  'aliases',
  // Set in Networking and Settings, never in the compose file: password, CDN, sign-in, error pages, the address the app
  // is linked to and the machine it is held to
  'linkedDomain',
  'basicAuth',
  'cdn',
  'sso',
  'errorPages',
  'placement',
] as const;

@Injectable()
export class ProjectsService implements OnApplicationBootstrap {
  /** How many times, and how far apart, a volume is retried while its containers wind down. Public for tests. */
  volumeRetries = 15;
  volumeRetryMs = 1000;

  private readonly locks = new Map<string, Promise<unknown>>();
  /** How long a service waits for what it depends on before starting anyway (with a warning) */
  dependencyTimeoutMs = 120_000;
  dependencyPollMs = 1000;

  constructor(
    private readonly db: Db,
    private readonly repo: AppsRepo,
    private readonly apps: AppsService,
    private readonly groups: GroupsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Optional() private readonly templateSources?: TemplateSourcesService,
  ) {}

  onApplicationBootstrap() {
    this.dropProjectGroups();
  }

  /**
   * Deploying a project used to make a group with its name, which only repeated the project. Those groups are removed
   * (their apps stay, ungrouped). A group someone added other apps to, or that is named differently, is theirs and stays.
   */
  dropProjectGroups(): string[] {
    const projects = new Set(
      (
        this.db.raw.prepare('SELECT name FROM projects').all() as {
          name: string;
        }[]
      ).map((r) => r.name.toLowerCase()),
    );
    const dropped: string[] = [];
    for (const g of this.groups.list()) {
      if (!projects.has(g.name.toLowerCase())) continue;
      const members = g.apps.map((n) => this.repo.get(n));
      if (
        members.every((a) => a?.project?.toLowerCase() === g.name.toLowerCase())
      ) {
        this.groups.remove(g.id);
        dropped.push(g.name);
      }
    }
    return dropped;
  }

  private async locked<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(project) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(project, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(project) === tail) this.locks.delete(project);
    }
  }

  private row(project: string): ProjectRow | undefined {
    return this.db.raw
      .prepare('SELECT * FROM projects WHERE name = ?')
      .get(project) as ProjectRow | undefined;
  }

  list() {
    const rows = this.db.raw
      .prepare('SELECT name, updated_at FROM projects ORDER BY name')
      .all() as {
      name: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      name: r.name,
      updatedAt: r.updated_at,
      apps: this.repo.byProject(r.name).map((a) => a.name),
    }));
  }

  /**
   * The project's compose file with a template's services added, for the person to review and apply as an update. Changes
   * nothing itself.
   */
  addTemplate(project: string, templateId: unknown) {
    const row = this.row(project);
    if (!row)
      throw new NotFoundError(`There is no project named "${project}".`);
    if (typeof templateId !== 'string')
      throw new ValidationError('Choose a template.');
    const t =
      templateById(templateId) ?? this.templateSources?.byId(templateId);
    if (!t) throw new NotFoundError('There is no such template.');
    return mergeTemplate(row.compose, t);
  }

  /** The project's compose file with one more service, for review. Changes nothing itself. */
  addService(project: string, raw: unknown) {
    const row = this.row(project);
    if (!row)
      throw new NotFoundError(`There is no project named "${project}".`);
    return addService(row.compose, raw);
  }

  /**
   * The compose file for moving apps that already run into a project: a new one (`project` null) or the compose file of
   * one that exists. Changes nothing: it goes through the same review as any edit, with `adopt` saying which services
   * are those apps.
   */
  async groupApps(project: string | null, rawApps: unknown) {
    const names = z
      .array(z.string())
      .min(1, 'Choose at least one app.')
      .max(50)
      .safeParse(rawApps);
    if (!names.success)
      throw new ValidationError(
        names.error.issues[0]?.message ?? 'Choose the apps to move.',
      );
    let existing: string | null = null;
    if (project !== null) {
      const row = this.row(project);
      if (!row)
        throw new NotFoundError(`There is no project named "${project}".`);
      existing = row.compose;
    }
    const apps = [...new Set(names.data)].map((n) => {
      const a = this.repo.get(n);
      if (!a) throw new NotFoundError(`There is no app named "${n}".`);
      return a;
    });
    const blocked = apps
      .map((a) => ({ app: a.name, problems: groupingProblems(a) }))
      .filter((b) => b.problems.length > 0);
    if (blocked.length > 0)
      throw new ValidationError(
        blocked
          .map((b) => `"${b.app}" cannot be moved: ${b.problems.join('; ')}.`)
          .join(' '),
        blocked,
      );
    const grouped = groupCompose(existing, apps);
    // What the project's own services are running with, so the review starts from it and nothing is blanked
    const running: Record<string, string> = {};
    if (project !== null)
      for (const v of (await this.get(project)).variables)
        if (v.value !== null && v.value !== undefined) running[v.key] = v.value;
    return {
      ...grouped,
      running,
      moves: apps.map((a) => ({
        app: a.name,
        service: Object.keys(grouped.adopt).find(
          (k) => grouped.adopt[k] === a.name,
        ) as string,
        gap: needsGap(a),
        keeps: keptSettings(a),
      })),
    };
  }

  async get(project: string) {
    const row = this.row(project);
    if (!row)
      throw new NotFoundError(`There is no project named "${project}".`);
    const apps = await Promise.all(
      this.repo.byProject(project).map((a) => this.apps.get(a.name)),
    );
    // A project that is still exactly a template can say how to connect to it, with the values it was given
    const t = templateOfProject(row.compose, this.templateSources?.all() ?? []);
    const deployed = apps.map((v) => ({
      name: v.app.name,
      image: v.app.image,
      env: v.app.env,
      command: v.app.command,
    }));
    // A template says what its variables mean. Any other file is read the same way, by the variables it asks for.
    const variables = t
      ? resolveVariables(t, project, deployed)
      : readBack(row.compose, composeVariables(row.compose), project, deployed);
    return {
      name: project,
      compose: row.compose,
      variableNames: JSON.parse(row.variable_names) as string[],
      updatedAt: row.updated_at,
      apps,
      /** Every variable the file asks for, with the value read back from the running services where that is possible */
      variables,
      template: t
        ? {
            id: t.id,
            name: t.name,
            publicWeb: t.publicWeb,
            variables,
            connection: connectionOf(t, project, variables),
          }
        : null,
    };
  }

  private plan(
    project: string,
    input: unknown,
  ): {
    plan: ComposePlan;
    compose: string;
    variables: Record<string, string>;
    adopt: Record<string, string>;
    renames: Record<string, string>;
  } {
    const parsed = projectInput.safeParse(input);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
        parsed.error.issues,
      );
    return {
      plan: planCompose(parsed.data.compose, project, parsed.data.variables),
      compose: parsed.data.compose,
      variables: parsed.data.variables,
      adopt: parsed.data.adopt,
      renames: parsed.data.renames,
    };
  }

  /**
   * The services renamed in this update, by their new name, and what is wrong with renaming them (nothing is changed
   * here). The old service must be one of this project's, gone from the file; the new one must not exist yet; and a
   * service cannot change between having data and not having it (it was made one way and stays so).
   */
  private renamings(
    project: string,
    plan: ComposePlan,
    renames: Record<string, string>,
    adopt: Record<string, string>,
  ) {
    const old = new Map<string, AppDefinition>();
    const errors: PlanIssue[] = [];
    const taken = new Set<string>();
    const members = this.repo.byProject(project);
    for (const [service, from] of Object.entries(renames)) {
      const fail = (message: string) => errors.push({ service, message });
      const planned = plan.apps.find((a) => a.serviceAlias === service);
      if (!planned) {
        fail(`The file has no service "${service}" to rename "${from}" to.`);
        continue;
      }
      const was = members.find((a) => a.serviceAlias === from);
      if (!was) {
        fail(`There is no service "${from}" in this project to rename.`);
        continue;
      }
      if (from === service) {
        fail(`"${from}" is not renamed: the new name is the same.`);
        continue;
      }
      if (service in adopt) {
        fail(
          `"${service}" is already an app moving in, so it cannot be a rename too.`,
        );
        continue;
      }
      if (taken.has(from)) {
        fail(`"${from}" is renamed to more than one service.`);
        continue;
      }
      taken.add(from);
      if (plan.apps.some((a) => a.serviceAlias === from)) {
        fail(
          `"${from}" is still in the file, so it cannot be renamed to "${service}".`,
        );
        continue;
      }
      if (this.repo.get(planned.name)) {
        fail(
          `"${service}" already exists in this project, so "${from}" cannot be renamed to it.`,
        );
        continue;
      }
      if (was.blueprint) {
        fail(`"${from}" is managed by a hub, so it cannot be renamed here.`);
        continue;
      }
      if (was.persistent !== planned.persistent) {
        fail(
          `Renaming "${from}" to "${service}" would change whether it keeps persistent data, which cannot change after a service is made. Deploy without the rename to replace it instead.`,
        );
        continue;
      }
      old.set(service, was);
    }
    return { old, errors };
  }

  /**
   * Removed and added services that look like one service under a new name. Only when it is unambiguous: the only one
   * removed and the only one added, else a pair that share an image repository (or the same data mounts) and nothing
   * else does. A suggestion for the person to confirm, never applied on its own.
   */
  private renameCandidates(
    project: string,
    plan: ComposePlan,
    adopt: Record<string, string>,
  ): RenameCandidate[] {
    if (plan.errors.length > 0) return [];
    const members = this.repo.byProject(project);
    const wanted = new Set(plan.apps.map((a) => a.name));
    const removed = members.filter((a) => !wanted.has(a.name) && !a.blueprint);
    const added = plan.apps.filter(
      (p) =>
        !members.some((m) => m.name === p.name) &&
        !((p.serviceAlias ?? '') in adopt),
    );
    if (removed.length === 0 || added.length === 0) return [];
    const compatible = (o: AppDefinition, p: AppDefinition) =>
      o.persistent === p.persistent;
    const alias = (a: AppDefinition) => a.serviceAlias ?? a.name;
    if (removed.length === 1 && added.length === 1)
      return compatible(removed[0], added[0])
        ? [
            {
              from: alias(removed[0]),
              to: alias(added[0]),
              reason:
                'It is the only service that went and the only one added.',
            },
          ]
        : [];

    const out: RenameCandidate[] = [];
    const left = new Set(removed.map((r) => r.name));
    const free = new Set(added.map((a) => a.name));
    // Pairs that share something, where each side has exactly one match
    const pair = (
      key: (a: AppDefinition) => string | null,
      reason: (k: string) => string,
    ) => {
      for (const r of removed) {
        if (!left.has(r.name)) continue;
        const k = key(r);
        if (!k) continue;
        const matches = added.filter(
          (p) => free.has(p.name) && key(p) === k && compatible(r, p),
        );
        if (matches.length !== 1) continue;
        const rivals = removed.filter(
          (o) => left.has(o.name) && key(o) === k && compatible(o, matches[0]),
        );
        if (rivals.length !== 1) continue;
        out.push({ from: alias(r), to: alias(matches[0]), reason: reason(k) });
        left.delete(r.name);
        free.delete(matches[0].name);
      }
    };
    const repoOf = (a: AppDefinition) =>
      a.image ? a.image.split('@')[0].replace(/:[^/:]*$/, '') : null;
    const mountsOf = (a: AppDefinition) => {
      const paths = a.volumes
        .filter((v) => v.volumeName)
        .map((v) => v.containerPath)
        .sort();
      return paths.length > 0 ? paths.join(',') : null;
    };
    pair(repoOf, (k) => `The same image (${k}).`);
    pair(mountsOf, (k) => `The same data mounts (${k}).`);
    return out;
  }

  /** The apps moving in, by service, and what is wrong with moving them (nothing is changed here). */
  private adoptions(plan: ComposePlan, adopt: Record<string, string>) {
    const old = new Map<string, AppDefinition>();
    const errors: PlanIssue[] = [];
    const taken = new Set<string>();
    for (const [service, appName] of Object.entries(adopt)) {
      const planned = plan.apps.find((a) => a.serviceAlias === service);
      const app = this.repo.get(appName);
      const fail = (message: string) => errors.push({ service, message });
      if (!planned) {
        fail(`The file has no service "${service}" to move "${appName}" into.`);
        continue;
      }
      if (!app) {
        fail(`There is no app named "${appName}" to move.`);
        continue;
      }
      if (taken.has(appName)) {
        fail(`"${appName}" is moved into more than one service.`);
        continue;
      }
      taken.add(appName);
      const problems = groupingProblems(app);
      if (problems.length > 0) {
        fail(
          `"${appName}" cannot be moved into a project: ${problems.join('; ')}.`,
        );
        continue;
      }
      if (this.repo.get(planned.name)) {
        fail(
          `"${planned.name}" already exists, so "${appName}" cannot take its place.`,
        );
        continue;
      }
      old.set(service, app);
    }
    return { old, errors };
  }

  /** Names taken by apps that are not part of this project: deploying would overwrite someone else's app. */
  private conflicts(plan: ComposePlan): PlanIssue[] {
    return plan.apps
      .filter((a) => {
        const existing = this.repo.get(a.name);
        return existing && existing.project !== plan.project;
      })
      .map((a) => ({
        service: a.serviceAlias,
        message: `An app named "${a.name}" already exists and is not part of this project.`,
      }));
  }

  /** Shows what a compose file would do, without changing anything. */
  preview(project: string, input: unknown): ProjectPlanView {
    const { plan, adopt, renames } = this.plan(project, input);
    const moving = this.adoptions(plan, adopt);
    const renaming = this.renamings(project, plan, renames, adopt);
    const current = this.repo.byProject(project);
    const existing = current.map((a) => a.name);
    const planned = plan.apps.map((a) => a.name);
    const errors = [
      ...plan.errors,
      ...this.conflicts(plan),
      ...moving.errors,
      ...renaming.errors,
    ];
    // The definitions as a deploy would leave them: what is kept from the running service is kept here too
    const merged: AppDefinition[] = [];
    // The app each renamed service comes from, by the new app's name
    const renamedFrom = new Map<string, AppDefinition>();
    for (const p of plan.apps) {
      const was = moving.old.get(p.serviceAlias ?? '');
      if (was) {
        merged.push(adoptDefinition(p, was));
        continue;
      }
      const renamed = renaming.old.get(p.serviceAlias ?? '');
      if (renamed) {
        renamedFrom.set(p.name, renamed);
        merged.push(adoptDefinition(p, renamed));
        continue;
      }
      try {
        merged.push(this.merge(p, this.repo.get(p.name), null));
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        errors.push({ service: p.serviceAlias, message: e.message });
        merged.push(p);
      }
    }
    const renamedOld = new Set([...renamedFrom.values()].map((a) => a.name));
    return {
      project,
      changes: {
        // A renamed service is the old one carried on, not a new one and not one removed
        create: planned.filter(
          (n) => !existing.includes(n) && !renamedFrom.has(n),
        ),
        update: planned.filter(
          (n) => existing.includes(n) || renamedFrom.has(n),
        ),
        remove: plan.errors.length
          ? []
          : existing.filter((n) => !planned.includes(n) && !renamedOld.has(n)),
      },
      diff: diffPlan(current, merged, plan.errors.length === 0, renamedFrom),
      apps: plan.apps,
      adopting: [...moving.old].map(([service, app]) => ({
        service,
        app: app.name,
        to: `${project}-${service}`,
        gap: needsGap(app),
        keeps: keptSettings(app),
      })),
      renaming: [...renaming.old].map(([service, app]) => ({
        from: app.serviceAlias ?? app.name,
        to: service,
        app: app.name,
        gap: needsGap(app),
        keeps: keptSettings(app),
      })),
      renameCandidates: this.renameCandidates(project, plan, adopt),
      volumes: plan.volumes,
      errors,
      warnings: plan.warnings,
    };
  }

  private merge(
    planned: AppDefinition,
    existing: AppDefinition | undefined,
    groupId: string | null,
  ): AppDefinition {
    if (!existing) return { ...planned, groupId };
    if (existing.persistent !== planned.persistent)
      throw new ConflictError(
        `"${planned.serviceAlias}" ${planned.persistent ? 'now has volumes but was created without' : 'had volumes and now has none; it was created with'} persistent data, which cannot change. Remove the project and deploy it again.`,
      );
    const kept = Object.fromEntries(
      KEEP_FROM_EXISTING.map((k) => [k, existing[k]]),
    );
    const imageChanged = existing.image !== planned.image;
    const version = imageChanged
      ? existing.deployVersion + 1
      : existing.deployVersion;
    return {
      ...planned,
      ...kept,
      // A volume an app brought with it stays under the Docker name it has: the data is there
      volumes: planned.volumes.map((v) => {
        const was = existing.volumes.find(
          (o) => o.volumeName && o.volumeName === v.volumeName,
        );
        return was?.dockerName ? { ...v, dockerName: was.dockerName } : v;
      }),
      deployVersion: version,
      versions: imageChanged
        ? [
            ...existing.versions,
            {
              version,
              image: planned.image,
              deployedAt: new Date().toISOString(),
            },
          ].slice(-20)
        : existing.versions,
    };
  }

  private async waitFor(dependencies: string[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const dep of dependencies) {
      const deadline = Date.now() + this.dependencyTimeoutMs;
      let ok = false;
      for (;;) {
        const s = await this.docker
          .serviceStatus(serviceName(dep))
          .catch(() => null);
        if (s?.state === 'running') {
          ok = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, this.dependencyPollMs));
      }
      if (!ok) warnings.push(dep);
    }
    return warnings;
  }

  /** Creates the project, or brings an existing one in line with the file (apps added, changed and removed). */
  async deploy(project: string, input: unknown): Promise<DeployResult> {
    const nameProblem = explainName(project, 'Project');
    if (nameProblem) throw new ValidationError(nameProblem);
    return this.locked(project, async () => {
      const { plan, compose, variables, adopt, renames } = this.plan(
        project,
        input,
      );
      const moving = this.adoptions(plan, adopt);
      const renaming = this.renamings(project, plan, renames, adopt);
      const errors = [
        ...plan.errors,
        ...this.conflicts(plan),
        ...moving.errors,
        ...renaming.errors,
      ];
      if (errors.length > 0)
        throw new ValidationError(
          `The compose file cannot be deployed: ${errors[0].message}`,
          errors,
        );

      // Saved before the services start: a deploy that fails part-way, or takes a while pulling images, is still a project
      // that can be watched, fixed and redeployed, or removed
      this.db.raw
        .prepare(
          `INSERT INTO projects (name, compose, variable_names, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET compose = excluded.compose, variable_names = excluded.variable_names, updated_at = excluded.updated_at`,
        )
        .run(
          project,
          compose,
          JSON.stringify(Object.keys(variables)),
          new Date().toISOString(),
        );
      await this.docker.ensureNetwork(projectNetwork(project), { project });
      const result: DeployResult = {
        project,
        apps: [],
        renamed: [],
        removed: [],
        warnings: [...plan.warnings],
      };

      // Renamed services first, before anything is created or removed: each old app becomes the new one, keeping its
      // addresses, deploy keys, history and data (see apps.adoptIntoProject), so the pass below finds it already there
      // and the removal pass at the end does not see it as one the file dropped. Services without data overlap with the
      // old one (no outage); those with data stop the old one first, so they go after. The services the renamed one
      // depends on are not waited for here: the platform does not order services, and they retry until it is up.
      const toRename = plan.apps
        .map((planned) => ({
          planned,
          was: renaming.old.get(planned.serviceAlias ?? ''),
        }))
        .filter(
          (r): r is { planned: AppDefinition; was: AppDefinition } => !!r.was,
        )
        .sort((a, b) => Number(needsGap(a.was)) - Number(needsGap(b.was)));
      for (const { planned, was } of toRename) {
        const moved = adoptDefinition(planned, was);
        await this.apps.adoptIntoProject(was.name, moved, {
          gap: needsGap(was),
        });
        result.renamed.push({ from: was.name, to: moved.name });
        result.apps.push({ name: moved.name, action: 'updated' });
      }

      // Apps that keep data stop before their replacement starts, so they go last: everything else is up by then
      const later: { app: AppDefinition; old: AppDefinition }[] = [];
      for (const planned of plan.apps) {
        if (renaming.old.has(planned.serviceAlias ?? '')) continue;
        const late = await this.waitFor(planned.dependsOn);
        for (const dep of late)
          result.warnings.push({
            service: planned.serviceAlias,
            message: `"${dep}" was not running after ${Math.round(this.dependencyTimeoutMs / 1000)} seconds, so "${planned.serviceAlias}" was started anyway.`,
          });
        const was = moving.old.get(planned.serviceAlias ?? '');
        if (was) {
          const moved = adoptDefinition(planned, was);
          if (needsGap(was)) later.push({ app: moved, old: was });
          else {
            await this.apps.adoptIntoProject(was.name, moved, { gap: false });
            result.apps.push({ name: moved.name, action: 'created' });
          }
          continue;
        }
        const app = this.merge(planned, this.repo.get(planned.name), null);
        const action = await this.apps.upsertManaged(app);
        result.apps.push({ name: app.name, action });
      }
      for (const { app, old } of later) {
        await this.apps.adoptIntoProject(old.name, app, { gap: true });
        result.apps.push({ name: app.name, action: 'created' });
      }

      // Services the file no longer mentions go away (their volumes are kept)
      const planned = new Set(plan.apps.map((a) => a.name));
      for (const old of this.repo.byProject(project))
        if (!planned.has(old.name)) {
          await this.apps.removeManaged(old.name);
          result.removed.push(old.name);
        }

      return result;
    });
  }

  /** Removes every service of the project and its network. Volumes are kept and reported: they hold data. */
  async remove(
    project: string,
    opts: { deleteVolumes?: boolean } = {},
  ): Promise<{
    removed: string[];
    keptVolumes: string[];
    deletedVolumes: string[];
  }> {
    return this.locked(project, async () => {
      const apps = this.repo.byProject(project);
      // A deploy that failed part-way leaves its apps behind without a project record, and they must still be removable
      if (!this.row(project) && apps.length === 0)
        throw new NotFoundError(`There is no project named "${project}".`);
      for (const a of [...apps].reverse())
        await this.apps.removeManaged(a.name);
      await this.docker.removeNetwork(projectNetwork(project), project);
      this.db.raw.prepare('DELETE FROM projects WHERE name = ?').run(project);
      // Ask Docker, not only the current definitions: a volume of a service that was dropped earlier is still there
      const volumes = new Set([
        ...(await this.docker.listProjectVolumes(project)),
        ...apps.flatMap((a) =>
          a.volumes.filter((v) => v.volumeName).map((v) => mountSource(a, v)),
        ),
      ]);
      const all = [...volumes].sort();
      if (!opts.deleteVolumes)
        return {
          removed: apps.map((a) => a.name),
          keptVolumes: all,
          deletedVolumes: [],
        };
      // Only volumes Docker labels as this project's: a name alone is not proof. Docker refuses a volume a container
      // still holds, and the project's containers stop a moment after their services go, so each gets a few tries.
      const ours = new Set(await this.docker.listProjectVolumes(project));
      const deleted: string[] = [];
      const kept: string[] = [];
      for (const v of all) {
        if (!ours.has(v)) {
          kept.push(v);
          continue;
        }
        let gone = false;
        for (let i = 0; i < this.volumeRetries && !gone; i++) {
          try {
            await this.docker.removeVolume(v);
            gone = true;
          } catch {
            await new Promise((r) => setTimeout(r, this.volumeRetryMs));
          }
        }
        (gone ? deleted : kept).push(v);
      }
      return {
        removed: apps.map((a) => a.name),
        keptVolumes: kept,
        deletedVolumes: deleted,
      };
    });
  }
}
