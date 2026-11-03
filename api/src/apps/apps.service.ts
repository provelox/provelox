import bcrypt from 'bcryptjs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { CdnService } from '../cdn/cdn.service';
import { SsoService } from '../sso/sso.service';
import { CONFIG, type Config } from '../config/config';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import {
  certificateStatus,
  proxyProbe,
  type TlsProbe,
} from '../proxy/certificates';
import {
  DOCKER,
  type DockerPort,
  type ServiceStatus,
} from '../docker/docker.port';
import { GroupsService } from '../groups/groups.service';
import { CiKeysService } from '../ci/ci-keys.service';
import { RegistriesService } from '../registries/registries.service';
import { PlaceholderService } from '../system/placeholder.service';
import { SettingsService } from '../system/settings.service';
import { hostsOf } from '../proxy/traefik-labels';
import {
  appDefinition,
  appName,
  newAppName,
  networkAlias,
  domain,
  envVar,
  healthcheck,
  placement,
  PASSWORD_HASH,
  PLATFORM_HOST_PORTS,
  portMapping,
  resources,
  volumeMount,
  HOSTNAME_RE,
  cdnSetting,
  ssoSetting,
  type AppDefinition,
} from './app.model';
import { AppsRepo } from './apps.repo';
import { blueprintSpec, volumeNameFor } from './blueprint';
import {
  LABEL_APP,
  projectNetwork,
  serviceName,
  volumeName,
} from '../common/naming';
import { isSensitiveHostPath } from './sensitive-paths';
import { referencingKeys, rewriteEnv } from './references';
import {
  buildServiceSpec,
  mountSource,
  type SpecContext,
} from './service-spec';

// No `..` or `//`: the name ends up in a Docker API path, where it could otherwise point somewhere else
export const IMAGE_RE =
  /^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/;
const MAX_VERSIONS = 20;

/** The only fields a client may change on an app. Everything else (name, persistent, project, versions...) is fixed. */
export const patchApp = z
  .object({
    instanceCount: z.number().int().min(0).max(50),
    containerPort: z.number().int().min(1).max(65535),
    exposed: z.boolean(),
    forceSsl: z.boolean(),
    defaultSubdomain: z.boolean(),
    defaultSubdomainSsl: z.boolean(),
    domains: z.array(domain).max(50),
    primaryDomain: z.string().trim().toLowerCase().max(253).nullable(),
    linkedDomain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(HOSTNAME_RE, 'Enter a valid domain, like dns.example.com')
      .nullable(),
    aliases: z.array(networkAlias).max(10),
    env: z
      .array(envVar)
      .max(200)
      .refine(
        (rows) => new Set(rows.map((r) => r.key)).size === rows.length,
        'Variable names must be unique',
      ),
    ports: z
      .array(portMapping)
      .max(50)
      .refine(
        (rows) => !rows.some((r) => PLATFORM_HOST_PORTS.includes(r.hostPort)),
        'Host ports 22, 80, 443, 2375, 2376, 2377, 4789 and 7946 are used by the server and the platform itself.',
      ),
    pendingPorts: z.array(portMapping).max(50),
    volumes: z.array(volumeMount).max(50),
    command: z.array(z.string()).nullable(),
    entrypoint: z.array(z.string()).nullable(),
    workingDir: z.string().nullable(),
    user: z.string().nullable(),
    healthcheck: healthcheck.nullable(),
    resources: resources.nullable(),
    restart: z.enum(['any', 'on-failure', 'none']),
    /** Where in a cluster it may run; null lets it run anywhere */
    placement: placement.nullable(),
    /**
     * Asks for a username and password before the app. A user is given with a password (which is hashed here and not
     * kept), a hash already made (an import), or `keep` to leave the saved one as it is. null removes the password.
     */
    basicAuth: z
      .object({
        users: z
          .array(
            z.union([
              z
                .object({
                  name: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
                  password: z.string().min(8).max(200),
                })
                .strict(),
              z
                .object({
                  name: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
                  hash: z.string().regex(PASSWORD_HASH),
                })
                .strict(),
              z
                .object({
                  name: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
                  keep: z.literal(true),
                })
                .strict(),
            ]),
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
      .strict()
      .nullable(),
    /** The CDN in front of the app, and whether only it may reach the app; null for none */
    cdn: cdnSetting.nullable(),
    /** Visitors sign in with an identity provider before the app; null for none */
    sso: ssoSetting.nullable(),
    /** Per status; an empty string removes that page */
    errorPages: z
      .object({
        '502': z.string().max(100 * 1024),
        '503': z.string().max(100 * 1024),
        '504': z.string().max(100 * 1024),
      })
      .partial()
      .strict(),
    groupId: z.string().nullable(),
    /** Needed to mount a server directory that exposes the host (/etc, the Docker socket...). Not stored. */
    acknowledgeSensitiveHostPaths: z.boolean(),
  })
  .partial()
  .strict();
export type AppPatch = z.input<typeof patchApp>;

export const createApp = z
  .object({
    name: newAppName,
    persistent: z.boolean().default(false),
    groupId: z.string().nullable().default(null),
    /** Serve <name>.<root domain>. Missing: the platform's default for new apps. */
    defaultSubdomain: z.boolean().optional(),
  })
  .strict();

/** A reading older than this is not worth showing instead of waiting for a new one. */
export const USAGE_STALE_MS = 5 * 60_000;

export interface AppView {
  app: AppDefinition;
  /** Null when Docker has no service for the app */
  status: ServiceStatus | null;
  /**
   * Names of secrets the app lists but Docker no longer holds (a rebuilt Swarm, say). The app cannot start until each
   * is set again: values are never kept here.
   */
  missingSecrets: string[];
  hosts: { host: string; ssl: boolean }[];
  /** The machine an app with local volumes is held to (its data is there). Null when it is free to move */
  pinnedTo: string | null;
}

@Injectable()
export class AppsService implements OnApplicationBootstrap {
  private readonly log = new Logger('Apps');
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: AppsRepo,
    @Inject(DOCKER) private readonly docker: DockerPort,
    private readonly settings: SettingsService,
    private readonly groups: GroupsService,
    private readonly placeholder: PlaceholderService,
    private readonly registries: RegistriesService,
    private readonly ciKeys: CiKeysService,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly cdn: CdnService,
    private readonly sso: SsoService,
  ) {}

  /** Apps whose data is being moved: nothing may change them until it is done */
  private readonly migrating = new Set<string>();

  block(name: string) {
    this.migrating.add(name);
  }

  unblock(name: string) {
    this.migrating.delete(name);
  }

  isBlocked(name: string) {
    return this.migrating.has(name);
  }

  /** Runs operations on one app one after another, so two requests cannot interleave their Docker calls. */
  private async serialize<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(name, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    }
  }

  /** Like serialize, but refuses while the app's data is being moved. */
  async locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.serialize(name, async () => {
      if (this.migrating.has(name))
        throw new ConflictError(
          `"${name}" is having its data moved right now. Wait for that to finish.`,
        );
      return fn();
    });
  }

  /** Applies a definition to Docker with the credentials its image needs, if a registry for it is stored. */
  private async apply(
    app: AppDefinition,
    opts: { forceRollout?: boolean } = {},
  ) {
    const missing = await this.missingSecrets(app);
    if (missing.length > 0)
      throw new ConflictError(
        `"${app.name}" cannot start: its ${missing.length === 1 ? 'secret' : 'secrets'} ${missing.join(', ')} no longer ${missing.length === 1 ? 'exists' : 'exist'} in Docker (a rebuilt Swarm loses them). Set ${missing.length === 1 ? 'it' : 'them'} again in the app's Secrets tab.`,
      );
    return this.docker.applyService(
      buildServiceSpec(app, {
        ...(await this.specContext()),
        pinnedNode: (await this.volumePin(app))?.id ?? null,
      }),
      app.name,
      this.registries.authFor(app.image),
      opts,
    );
  }

  private pinKey(app: AppDefinition) {
    return app.project ? `project:${app.project}` : `app:${app.name}`;
  }

  private readPins(): Record<string, { id: string; host: string }> {
    return (
      this.settings.get<Record<string, { id: string; host: string }>>(
        'volumePins',
      ) ?? {}
    );
  }

  /**
   * The machine an app with local volumes must stay on once the cluster has more than one: the one it was chosen to run
   * on, else the one its latest task ran on (that is where the volume is), else, for an app that has never run, the
   * leader. Remembered by the machine's id, so a machine that takes another's name cannot take the app. An app that
   * exists but has no task to learn from is not guessed at: the admin says where its data is. Null on a single machine
   * and for apps with no volumes. A Docker error stops the apply instead of letting the app go unconstrained.
   */
  private async volumePin(
    app: AppDefinition,
  ): Promise<{ id: string; host: string } | null> {
    if (!app.volumes.some((v) => v.volumeName)) return null;
    const key = this.pinKey(app);
    const have = this.readPins()[key];
    if (have) return have;
    if ((await this.docker.swarmState()) !== 'manager') return null;
    const nodes = await this.docker.listNodes(true);
    if (nodes.length < 2) return null;
    const svc = serviceName(app.name);
    let node: (typeof nodes)[number] | undefined;
    if (app.placement?.node) {
      const named = nodes.filter((n) => n.hostname === app.placement?.node);
      if (named.length !== 1)
        throw new ConflictError(
          `More than one machine is called "${app.placement.node}", so it is not clear which holds the data of "${app.name}". Rename one of them.`,
        );
      node = named[0];
    } else {
      const last = await this.docker.lastTaskNode(svc);
      if (last) {
        node = nodes.find((n) => n.id === last);
        if (!node)
          throw new ConflictError(
            `"${app.name}" last ran on a machine that is no longer in the cluster, so Provelox cannot tell where its data is. Choose its server under Configuration → Where it runs.`,
          );
      } else if ((await this.docker.serviceStatus(svc)) === null) {
        // never started: its volume does not exist yet, so anywhere will do; the leader is as good as any
        node = nodes.find((n) => n.role === 'leader') ?? nodes[0];
      } else {
        throw new ConflictError(
          `"${app.name}" keeps data on a local volume, but Provelox cannot tell which server holds it (it has no instance to learn that from). Choose its server under Configuration → Where it runs.`,
        );
      }
    }
    const pin = { id: node.id, host: node.hostname };
    // read again: another app may have been pinned while this one waited on Docker
    const latest = this.readPins();
    if (latest[key]) return latest[key];
    this.settings.set('volumePins', { ...latest, [key]: pin });
    return pin;
  }

  /**
   * Pins every app that keeps data on a local volume and has no pin yet. Run when the cluster grows, so an app is held to
   * its machine before anything can move it, not at its next deploy. Returns the apps that could not be pinned.
   */
  async pinVolumeApps(): Promise<{ app: string; reason: string }[]> {
    const unresolved: { app: string; reason: string }[] = [];
    for (const app of this.repo.list()) {
      if (!app.volumes.some((v) => v.volumeName)) continue;
      try {
        await this.volumePin(app);
      } catch (e) {
        unresolved.push({
          app: app.name,
          reason: e instanceof Error ? e.message : 'Unknown',
        });
      }
    }
    return unresolved;
  }

  /** The apps held to a machine because their data is on it. */
  pinnedApps(nodeId: string): string[] {
    const pins = this.readPins();
    return this.repo
      .list()
      .filter(
        (a) =>
          a.volumes.some((v) => v.volumeName) &&
          pins[this.pinKey(a)]?.id === nodeId,
      )
      .map((a) => a.name);
  }

  /**
   * Forgets where an app's data is. For when the machine it was on is gone or being replaced: the app is then not held
   * anywhere, and the next time it is applied the admin chooses its server again. Whatever data is on the old machine is
   * not moved.
   */
  releasePin(name: string): void {
    const app = this.getDefinition(name);
    const { [this.pinKey(app)]: _gone, ...rest } = this.readPins();
    this.settings.set('volumePins', rest);
  }

  /** The machine (its Swarm id and name) an app's data is held to, or null when it is not held to one. */
  heldTo(name: string): { id: string; host: string } | null {
    const app = this.getDefinition(name);
    if (!app.volumes.some((v) => v.volumeName)) return null;
    return this.readPins()[this.pinKey(app)] ?? null;
  }

  /** Where an app that keeps data on a local volume is held, for the pages that show it. Null when it is free to move. */
  async pinnedTo(name: string): Promise<string | null> {
    const app = this.getDefinition(name);
    if (!app.volumes.some((v) => v.volumeName)) return null;
    return this.readPins()[this.pinKey(app)]?.host ?? null;
  }

  /** Refuses a placement that names a machine that is not in the cluster, or that would leave an app's data behind. */
  private async checkPlacement(
    current: AppDefinition,
    next: z.infer<typeof placement> | null,
  ) {
    if (!next) return;
    const nodes = await this.docker.listNodes();
    if (next.node) {
      const named = nodes.filter((n) => n.hostname === next.node);
      if (named.length === 0)
        throw new ValidationError(
          nodes.length === 0
            ? 'This server is not part of a cluster, so there is nothing to choose between.'
            : `No machine named "${next.node}" is in the cluster. Machines: ${nodes.map((n) => n.hostname).join(', ')}.`,
        );
      if (named.length > 1)
        throw new ValidationError(
          `More than one machine is called "${next.node}", so the name does not say which. Rename one of them.`,
        );
    }
    // only a pin that exists holds the app: without one, a chosen machine becomes the pin when it is applied
    const pin = current.volumes.some((v) => v.volumeName)
      ? this.readPins()[this.pinKey(current)]
      : undefined;
    if (!pin) return;
    const home = nodes.find((n) => n.id === pin.id);
    const ok =
      (!next.node || next.node === pin.host) &&
      (!next.role ||
        (next.role === 'manager'
          ? home?.role !== 'worker'
          : home?.role === 'worker'));
    if (!ok)
      throw new ConflictError(
        `"${current.name}" keeps its data on ${pin.host}, so it has to run there. Moving it would leave the data behind.`,
      );
  }

  async specContext(): Promise<SpecContext> {
    return {
      rootDomain: this.settings.appsDomain(),
      certResolver: this.cfg.CERT_RESOLVER,
      errorPagesService: this.cfg.ERROR_PAGES_SERVICE ?? null,
      cdnRanges: this.cdn.rangesById(),
      sso: this.sso.available()
        ? {
            verifyUrl: this.sso.verifyUrl(),
            service: this.cfg.ERROR_PAGES_SERVICE as string,
          }
        : undefined,
      placeholderImage: this.cfg.PLACEHOLDER_IMAGE,
      placeholder: await this.placeholder.ensure(),
      placeholderConf: await this.placeholder.ensureConf(),
    };
  }

  private async view(
    app: AppDefinition,
    status: ServiceStatus | null,
    secretIds?: Set<string> | null,
  ): Promise<AppView> {
    return {
      app,
      status,
      missingSecrets: await this.missingSecrets(app, secretIds),
      hosts: hostsOf(app, this.settings.appsDomain()),
      pinnedTo: app.volumes.some((v) => v.volumeName)
        ? (this.readPins()[this.pinKey(app)]?.host ?? null)
        : null,
    };
  }

  /** Secrets the app lists that Docker does not hold. When Docker cannot say, nothing is reported (and nothing blocked). */
  async missingSecrets(
    app: AppDefinition,
    known?: Set<string> | null,
  ): Promise<string[]> {
    if (app.secrets.length === 0) return [];
    let ids = known;
    if (ids === undefined)
      ids = await this.docker.secretIds().catch(() => null);
    if (!ids) return [];
    return app.secrets.filter((s) => !ids.has(s.id)).map((s) => s.name);
  }

  private async statusOf(app: AppDefinition): Promise<ServiceStatus | null> {
    try {
      return await this.docker.serviceStatus(serviceName(app.name));
    } catch {
      return null; // a Docker hiccup must not take the whole list down
    }
  }

  async list(): Promise<AppView[]> {
    const apps = this.repo.list();
    // One look at Docker's secrets for the whole list, and only when some app has any
    const ids = apps.some((a) => a.secrets.length > 0)
      ? await this.docker.secretIds().catch(() => null)
      : null;
    return Promise.all(
      apps.map(async (a) => this.view(a, await this.statusOf(a), ids)),
    );
  }

  async get(name: string): Promise<AppView> {
    const app = this.repo.get(name);
    if (!app) throw new NotFoundError(`There is no app named "${name}".`);
    return this.view(app, await this.statusOf(app));
  }

  getDefinition(name: string): AppDefinition {
    const app = this.repo.get(name);
    if (!app) throw new NotFoundError(`There is no app named "${name}".`);
    return app;
  }

  async create(input: z.input<typeof createApp>): Promise<AppView> {
    const parsed = createApp.safeParse(input);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
        parsed.error.issues,
      );
    const { name, persistent, groupId, defaultSubdomain } = parsed.data;
    return this.locked(name, async () => {
      if (this.repo.get(name))
        throw new ConflictError(`An app named "${name}" already exists.`);
      if (groupId && !this.groups.exists(groupId))
        throw new ValidationError('That collection does not exist.');
      const app = appDefinition.parse({
        name,
        persistent,
        groupId,
        defaultSubdomain:
          defaultSubdomain ?? this.settings.defaultSubdomainForNewApps(),
        createdAt: new Date().toISOString(),
      });
      // Its default address would be the platform's own when apps share the root domain
      if (app.defaultSubdomain && this.settings.appsDomain()) {
        const host = `${name}.${this.settings.appsDomain()}`;
        if ((await this.platformHosts()).includes(host))
          throw new ConflictError(
            `${host} is where the platform's own console or API is served, so an app called "${name}" cannot have a default address there. Turn the default address off, pick another name, or give apps a domain of their own under Settings → General.`,
          );
      }
      await this.docker.ensureNetwork(SHARED, {});
      // Docker first: if it refuses, nothing was saved and there is no phantom app
      await this.apply(app);
      this.repo.save(app);
      return this.view(app, await this.statusOf(app));
    });
  }

  /**
   * Makes an app match a blueprint a hub sent: creates it when it is not there, sets what the blueprint governs, and
   * deploys the image when that differs. Everything else about the app is left as it is. Refuses an app that belongs to
   * a project, and one whose persistence differs (that is fixed when the app is created).
   */
  async applyBlueprint(
    raw: unknown,
  ): Promise<{ name: string; created: boolean; deployed: boolean }> {
    const parsed = blueprintSpec.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid blueprint',
        parsed.error.issues,
      );
    const s = parsed.data;
    const existing = this.repo.get(s.name);
    // An update token may apply blueprints, so it may only touch apps that came from one, and only while they hold
    // nothing a new image could read or serve: no secrets, no custom domains, no host directories.
    if (existing && !existing.blueprint)
      throw new ConflictError(
        `"${s.name}" was not created from a blueprint, so one cannot change it. Remove the app on this node first.`,
      );
    if (
      existing &&
      (existing.secrets.length > 0 ||
        existing.domains.length > 0 ||
        existing.volumes.some((v) => !v.volumeName))
    )
      throw new ConflictError(
        `"${s.name}" has secrets, custom domains or host directories, which a blueprint does not govern, so it cannot change it.`,
      );
    if (existing?.project)
      throw new ConflictError(
        `"${s.name}" belongs to the project "${existing.project}", so a blueprint cannot change it.`,
      );
    if (existing && existing.persistent !== s.persistent)
      throw new ConflictError(
        `"${s.name}" was created ${existing.persistent ? 'with' : 'without'} persistent data, which cannot be changed. Remove the app on this node first.`,
      );
    // A volume of the same name that something else owns would be mounted as it is: refuse it
    if (s.volumes.length > 0) {
      const owned = new Map(
        (await this.docker.volumeFacts(false)).map((v) => [v.name, v.labels]),
      );
      for (const v of s.volumes) {
        const name = volumeName(s.name, volumeNameFor(s.name, v.containerPath));
        const labels = owned.get(name);
        if (labels && labels[LABEL_APP] !== s.name)
          throw new ConflictError(
            `The volume ${name} already exists and belongs to something else, so ${s.name} cannot use it.`,
          );
      }
    }
    const created = !existing;
    if (created) {
      await this.create({
        name: s.name,
        persistent: s.persistent,
        defaultSubdomain: s.defaultSubdomain,
      });
      this.repo.save({ ...this.getDefinition(s.name), blueprint: true });
    }
    await this.update(s.name, {
      containerPort: s.containerPort,
      instanceCount: s.instanceCount,
      exposed: s.exposed,
      defaultSubdomain: s.defaultSubdomain,
      linkedDomain: s.linkedDomain,
      restart: s.restart,
      env: s.env,
      ports: s.ports,
      volumes: s.volumes.map((v) => ({
        containerPath: v.containerPath,
        volumeName: volumeNameFor(s.name, v.containerPath),
        readOnly: false,
      })),
    });
    const deployed = this.getDefinition(s.name).image !== s.image;
    if (deployed) await this.deploy(s.name, s.image);
    return { name: s.name, created, deployed };
  }

  /** A token may only deploy another version of the image the app already runs. */
  assertSameImageRepository(
    name: string,
    image: string,
    opts: { allowFirstDeploy?: boolean } = {},
  ) {
    const current = this.getDefinition(name).image;
    if (!current && opts.allowFirstDeploy) return;
    const repo = (i: string) =>
      i.replace(/@sha256:[a-f0-9]+$/i, '').replace(/:[^/:]+$/, '');
    if (!current || repo(current).toLowerCase() !== repo(image).toLowerCase())
      throw new ForbiddenError(
        'This key or token can deploy another version of the image the app runs, not a different image. Sign in as the admin to change the image.',
      );
  }

  /**
   * The addresses the console and the API answer at right now, read from their own routing: console.<root> and
   * api.<root> by default, but whatever an install was given with --console-host / --api-host. Without those services
   * (a development setup) the default names stand in.
   */
  private async platformHosts(): Promise<string[]> {
    const read = async (service: string, id: string, fallback: string) => {
      const labels = await this.docker.serviceLabels(service);
      if (!labels) return [fallback];
      const m = /^Host\(`(.+)`\)$/.exec(
        labels[`traefik.http.routers.${id}-web.rule`] ?? '',
      );
      return m ? [m[1]] : [];
    };
    const root = this.settings.rootDomain();
    return [
      ...(await read(
        'pvx-console',
        'pvx_console',
        root ? `console.${root}` : '',
      )),
      ...(await read('pvx-provelox', 'pvx_api', root ? `api.${root}` : '')),
    ].filter(Boolean);
  }

  /**
   * An app must not answer at the address the console or the API does: that is where sign-ins and tokens go. An app
   * that already had the address is left alone, so nothing that works is broken by this.
   */
  private async assertNotPlatformHost(
    current: AppDefinition,
    next: AppDefinition,
  ) {
    const root = this.settings.appsDomain();
    const had = new Set(hostsOf(current, root).map((h) => h.host));
    const taken = hostsOf(next, root).find((h) => !had.has(h.host));
    if (!taken) return;
    const platform = await this.platformHosts();
    if (platform.includes(taken.host))
      throw new ConflictError(
        `${taken.host} is the address the platform's own ${taken.host === platform[0] ? 'console' : 'API'} is served at, so an app cannot use it. Serve the platform elsewhere (--console-host and --api-host when installing), pick another domain for the app, or give apps a domain of their own under Settings → General.`,
      );
  }

  /** Applies a validated patch to the definition. Pure: checks the rules that span fields or other apps. */
  private applyPatch(
    current: AppDefinition,
    patch: z.infer<typeof patchApp>,
  ): AppDefinition {
    const { acknowledgeSensitiveHostPaths, errorPages, basicAuth, ...fields } =
      patch;
    const next: AppDefinition = { ...current };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      // null clears an optional field
      (next as Record<string, unknown>)[k] =
        v === null && k !== 'groupId' ? undefined : v;
    }
    if (basicAuth !== undefined) {
      if (basicAuth === null) next.basicAuth = undefined;
      else {
        const saved = new Map(
          (current.basicAuth?.users ?? []).map((u) => [u.name, u.hash]),
        );
        const names = basicAuth.users.map((u) => u.name);
        if (new Set(names).size !== names.length)
          throw new ValidationError('A user name can only be listed once.');
        next.basicAuth = {
          openPaths: basicAuth.openPaths,
          users: basicAuth.users.map((u) => {
            if ('password' in u)
              // cost 8: the proxy checks it on every request
              return { name: u.name, hash: bcrypt.hashSync(u.password, 8) };
            if ('hash' in u) return { name: u.name, hash: u.hash };
            const hash = saved.get(u.name);
            if (!hash)
              throw new ValidationError(
                `${u.name} has no saved password to keep: give one.`,
              );
            return { name: u.name, hash };
          }),
        };
      }
    }
    if (errorPages) {
      const pages: Record<string, string> = { ...current.errorPages };
      for (const [status, html] of Object.entries(errorPages)) {
        if (html) pages[status] = html;
        else delete pages[status];
      }
      if (Object.keys(pages).length > 0 && !this.cfg.ERROR_PAGES_SERVICE)
        throw new ValidationError(
          'Custom error pages need the proxy to reach this API: set ERROR_PAGES_SERVICE.',
        );
      next.errorPages = pages;
    }

    if (patch.sso) {
      if (!this.sso.available())
        throw new ValidationError(
          'Signing in with a provider needs the API at its own address (API_PUBLIC_URL) and ERROR_PAGES_SERVICE set.',
        );
      if (!this.sso.has(patch.sso.provider))
        throw new ValidationError('That sign-in provider does not exist.');
    }
    if (next.groupId && !this.groups.exists(next.groupId))
      throw new ValidationError('That collection does not exist.');
    if (next.volumes.length > 0 && !next.persistent)
      throw new ValidationError(
        'This app was not created with persistent data, so it cannot mount volumes or directories.',
      );
    if (next.persistent && next.instanceCount > 1)
      throw new ValidationError(
        'An app with persistent data runs a single instance.',
      );
    if (
      new Set(next.ports.map((p) => `${p.hostPort}/${p.protocol}`)).size !==
      next.ports.length
    )
      throw new ValidationError(
        'Each host port can only be used once per protocol.',
      );
    if (
      new Set(next.pendingPorts.map((p) => `${p.hostPort}/${p.protocol}`))
        .size !== next.pendingPorts.length
    )
      throw new ValidationError(
        'Each pending host port can only be used once per protocol.',
      );
    if (
      new Set(next.volumes.map((v) => v.containerPath.replace(/\/+$/, '')))
        .size !== next.volumes.length
    )
      throw new ValidationError(
        'Each path inside the container can only be mounted once.',
      );
    if (new Set(next.domains.map((d) => d.host)).size !== next.domains.length)
      throw new ValidationError('A domain can only be listed once.');

    if (patch.volumes) {
      // A client sends volumes as it knows them, without the Docker name a renamed app keeps its data under
      const named = new Map(
        current.volumes.flatMap((v) =>
          v.volumeName && v.dockerName ? [[v.volumeName, v.dockerName]] : [],
        ),
      );
      next.volumes = next.volumes.map((v) =>
        v.volumeName && !v.dockerName && named.has(v.volumeName)
          ? { ...v, dockerName: named.get(v.volumeName) }
          : v,
      );
      for (const v of next.volumes)
        if (
          v.hostPath &&
          isSensitiveHostPath(v.hostPath) &&
          !acknowledgeSensitiveHostPaths
        )
          throw new ValidationError(
            `${v.hostPath} gives this app control over the server. Set acknowledgeSensitiveHostPaths to mount it anyway.`,
          );
    }

    const root = this.settings.appsDomain();
    const hosts = hostsOf(next, root);
    if (
      next.primaryDomain &&
      !hosts.some((h) => h.host === next.primaryDomain)
    ) {
      if (patch.primaryDomain)
        throw new ValidationError(
          `${next.primaryDomain} is not one of this app's addresses. Add it first, or pick one from the list.`,
        );
      // the address it pointed at was removed or turned off: the others simply stop redirecting
      next.primaryDomain = undefined;
    }
    if (next.forceSsl && !hosts.some((h) => h.ssl))
      throw new ValidationError(
        'Turn on HTTPS for a domain before forcing HTTPS.',
      );
    if (hosts.some((h) => h.ssl) && !this.settings.acmeEmail())
      throw new ValidationError(
        "Set a Let's Encrypt email in the HTTPS settings before turning on HTTPS.",
      );
    if (next.defaultSubdomainSsl && !root)
      throw new ValidationError(
        'Set the root domain or an apps domain before turning on HTTPS for the default address.',
      );

    // Another app already answering for the same domain or host port would silently steal or break traffic
    for (const other of this.repo.list()) {
      if (other.name === next.name) continue;
      const taken = new Set(hostsOf(other, root).map((h) => h.host));
      const clash = hosts.find((h) => taken.has(h.host));
      if (clash)
        throw new ConflictError(
          `${clash.host} is already used by the app "${other.name}".`,
        );
      const portClash = next.ports.find((p) =>
        other.ports.some(
          (o) => o.hostPort === p.hostPort && o.protocol === p.protocol,
        ),
      );
      if (portClash)
        throw new ConflictError(
          `Host port ${portClash.hostPort}/${portClash.protocol} is already used by "${other.name}".`,
        );
    }
    return next;
  }

  async update(name: string, patch: unknown): Promise<AppView> {
    const parsed = patchApp.safeParse(patch);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
        parsed.error.issues,
      );
    // The ranges are needed to build the app's routing: fetch them first, and refuse the change if they cannot be had
    if (parsed.data.cdn) await this.cdn.ensureRanges(parsed.data.cdn.provider);
    const view = await this.locked(name, async () => {
      const current = this.getDefinition(name);
      if (parsed.data.placement !== undefined)
        await this.checkPlacement(current, parsed.data.placement);
      const next = this.applyPatch(current, parsed.data);
      await this.assertNotPlatformHost(current, next);
      // Moving between groups is bookkeeping only: Docker has nothing to change
      const groupOnly = Object.keys(parsed.data).every((k) => k === 'groupId');
      if (!groupOnly) await this.apply(next);
      this.repo.save(next);
      return this.view(next, await this.statusOf(next));
    });
    // Which CDNs apps sit behind decides what the proxy trusts: tell it once the app is saved and unlocked
    if (parsed.data.cdn !== undefined) await this.cdn.notify([]);
    return view;
  }

  /** Deploys an image: bumps the version, records it, and rolls the service onto it. */
  async deploy(name: string, image: string): Promise<AppView> {
    const img = image.trim();
    if (!IMAGE_RE.test(img))
      throw new ValidationError(
        'Enter a valid image name, e.g. ghcr.io/org/app:tag',
      );
    return this.locked(name, async () => {
      const current = this.getDefinition(name);
      const version = current.deployVersion + 1;
      const next: AppDefinition = {
        ...current,
        image: img,
        deployVersion: version,
        versions: [
          ...current.versions,
          { version, image: img, deployedAt: new Date().toISOString() },
        ].slice(-MAX_VERSIONS),
      };
      await this.apply(next);
      this.repo.save(next);
      return this.view(next, await this.statusOf(next));
    });
  }

  /**
   * Creates or replaces an app from a definition the platform itself produced (a Compose project). Skips the
   * rules for client edits, but still applies to Docker first and never touches a service it does not own.
   */
  async upsertManaged(app: AppDefinition): Promise<'created' | 'updated'> {
    return this.locked(app.name, async () => {
      await this.docker.ensureNetwork(SHARED, {});
      const action = await this.apply(app);
      this.repo.save(app);
      return action;
    });
  }

  /**
   * Deletes the app's Docker secrets once its service is gone. They are write-only and only this app could read
   * them, so leaving them behind would keep credentials around for nothing. Best effort: a failure here must not
   * undo a removal that already happened.
   */
  private async removeSecretsOf(app: AppDefinition | undefined) {
    for (const secret of app?.secrets ?? [])
      await this.docker
        .removeSecret(secret.dockerName, secret.owner ?? (app?.name as string))
        .catch(() => undefined);
  }

  /** Removes an app's service and record without the "belongs to a project" guard. For project removal only. */
  async removeManaged(name: string): Promise<void> {
    return this.locked(name, async () => {
      const app = this.repo.get(name);
      await this.docker.removeService(serviceName(name), name);
      this.repo.delete(name);
      this.ciKeys.removeForApp(name); // their app is gone
      await this.removeSecretsOf(app);
    });
  }

  /**
   * Changes an app under its lock: `change` gets the current definition and returns the next one, which is applied
   * to Docker and then saved. If anything throws, nothing is saved.
   */
  async mutate(
    name: string,
    change: (current: AppDefinition) => Promise<AppDefinition>,
    opts: { duringMigration?: boolean; allowMissingSecrets?: boolean } = {},
  ): Promise<AppView> {
    // Only the migration itself may change an app while it is blocked
    const run = opts.duringMigration
      ? this.serialize.bind(this)
      : this.locked.bind(this);
    return run(name, async () => {
      const next = await change(this.getDefinition(name));
      // Putting back the secrets that were lost has to work one at a time: the app waits, unapplied, until the last
      // one is set
      const waiting =
        opts.allowMissingSecrets &&
        (await this.missingSecrets(next)).length > 0;
      if (!waiting) await this.apply(next);
      this.repo.save(next);
      return this.view(next, await this.statusOf(next));
    });
  }

  /** Re-applies the stored definition to Docker (repairs a service someone removed or changed by hand). */
  async reconcile(name: string): Promise<AppView> {
    return this.locked(name, async () => {
      const app = this.getDefinition(name);
      // The networks may be gone (a rebuilt Swarm, say): an app cannot start without the ones it joins
      await this.docker.ensureNetwork(SHARED, {});
      if (app.project)
        await this.docker.ensureNetwork(projectNetwork(app.project), {
          project: app.project,
        });
      await this.apply(app);
      return this.view(app, await this.statusOf(app));
    });
  }

  /** Reads the certificate the proxy serves for a host. A test swaps it for a fake. Made on first use, once the config is known. */
  tlsProbe: TlsProbe = (host) =>
    proxyProbe(this.cfg.PROXY_TLS_HOST, this.cfg.PROXY_TLS_PORT)(host);

  /** For each address of the app: whether HTTPS is on, and the certificate actually being served (issuer, expiry). */
  async certificates(name: string) {
    const app = this.getDefinition(name);
    return certificateStatus(
      hostsOf(app, this.settings.appsDomain()),
      this.tlsProbe,
    );
  }

  private usageCache: {
    at: number;
    value: Record<
      string,
      { instances: number; cpuPercent: number; memoryBytes: number }
    >;
  } | null = null;
  /** How long a reading of every app is reused. Each reading takes Docker a moment per container. Public for tests. */
  usageCacheMs = 4000;

  /**
   * What every running app uses right now, for the apps list. Apps that are stopped are left out. Readings are shared
   * for a few seconds, so several people looking at the list cost Docker one round of stats, not several.
   */
  async usageAll(now?: number) {
    if (
      this.usageCache &&
      (now ?? Date.now()) - this.usageCache.at < this.usageCacheMs
    )
      return this.usageCache.value;
    const running = this.repo.list().filter((a) => a.instanceCount > 0);
    const value: Record<
      string,
      { instances: number; cpuPercent: number; memoryBytes: number }
    > = {};
    // several at a time: each is a few container samples, and a sample takes Docker about a second
    for (let i = 0; i < running.length; i += 12)
      await Promise.all(
        running.slice(i, i + 12).map(async (a) => {
          const u = await this.docker
            .serviceUsage(serviceName(a.name))
            .catch(() => null);
          if (u) value[a.name] = u;
        }),
      );
    // stamped when the readings are done, not when they were asked for: gathering them takes a few seconds
    this.usageCache = { at: now ?? Date.now(), value };
    return value;
  }

  /** The readings of every app that are being refreshed right now, if any */
  private refreshingUsage: Promise<unknown> | null = null;

  /**
   * Like usageAll, but never makes the caller wait for Docker when there is a reading to show: it answers with the last
   * one at once, and when that is older than usageCacheMs starts a fresh one in the background for the next caller.
   * Docker takes about a second per container to measure, so a status page that waited for it would take seconds. Only
   * the first call after a start, or after the readings are minutes old, waits. The history sampler keeps using usageAll.
   */
  async usageAllQuick(now = Date.now()) {
    const c = this.usageCache;
    if (c && now - c.at < USAGE_STALE_MS) {
      if (now - c.at >= this.usageCacheMs)
        this.refreshingUsage ??= this.usageAll(now)
          .catch(() => undefined)
          .finally(() => {
            this.refreshingUsage = null;
          });
      return c.value;
    }
    return this.usageAll(now);
  }

  /**
   * What the app's running instances use right now, beside the limits it was given (so a reading can be shown as a
   * share of them). Instances on other machines of a Swarm are not included: Docker reports per machine.
   */
  async usage(name: string) {
    const app = this.getDefinition(name);
    const u = await this.docker.serviceUsage(serviceName(app.name));
    return {
      instances: u?.instances ?? 0,
      cpuPercent: u?.cpuPercent ?? 0,
      memoryBytes: u?.memoryBytes ?? 0,
      cpuLimitPercent: app.resources?.cpus ? app.resources.cpus * 100 : null,
      memoryLimitBytes: app.resources?.memoryBytes ?? null,
    };
  }

  /**
   * Replaces the app's running instances with fresh ones, with the same image and settings. For an app that is stuck,
   * or one that reads its configuration only at start. Instances are replaced as a deploy replaces them: one at a time,
   * and an app that keeps data stops before its new instance starts.
   */
  async restart(name: string): Promise<AppView> {
    return this.locked(name, async () => {
      const app = this.getDefinition(name);
      if (app.instanceCount === 0)
        throw new ConflictError(
          `"${name}" is stopped. Start it instead of restarting it.`,
        );
      if (!app.image)
        throw new ConflictError(
          `"${name}" has nothing deployed yet, so there is nothing to restart.`,
        );
      await this.apply(app, { forceRollout: true });
      return this.view(app, await this.statusOf(app));
    });
  }

  /**
   * Re-applies every app when the API starts, so a platform upgrade (new error pages, routing, health checks)
   * reaches apps that already exist. Docker leaves a service alone when its spec did not change. Runs in the
   * background and never stops the API from starting.
   */
  onApplicationBootstrap(): void {
    // New ranges for a CDN reach the apps behind it: their routing carries the list
    this.cdn.onChange(async (changed) => {
      for (const a of this.repo.list())
        if (a.cdn?.enforce && changed.includes(a.cdn.provider))
          await this.reconcile(a.name);
    });
    // The first reading of what the apps use takes Docker a while: take it now, so the first status call is not the one waiting
    void this.usageAll().catch(() => undefined);
    void this.reconcileAll()
      .then((failed) => {
        for (const f of failed)
          this.log.warn(`Could not re-apply ${f.app} at startup: ${f.error}`);
      })
      .catch((e) =>
        this.log.error(
          `Re-applying apps at startup failed: ${e instanceof Error ? e.message : e}`,
        ),
      );
  }

  /**
   * Re-applies every app (after the root domain changed, say). `onlyUndeployed` limits it to apps still showing
   * the placeholder page. Returns the ones that failed, with why.
   */
  async reconcileAll(
    opts: { onlyUndeployed?: boolean } = {},
  ): Promise<{ app: string; error: string }[]> {
    const failed: { app: string; error: string }[] = [];
    for (const app of this.repo.list()) {
      if (opts.onlyUndeployed && app.image) continue;
      try {
        await this.reconcile(app.name);
      } catch (e) {
        failed.push({
          app: app.name,
          error: e instanceof Error ? e.message : 'unknown error',
        });
      }
    }
    return failed;
  }

  /** How long a rename waits for the old service's containers to be gone before it starts the new one on the same data */
  renameWaitMs = 60_000;
  renamePollMs = 500;

  /**
   * The other apps whose environment names this one by its local name on the network, and which variables: those would
   * point nowhere after a rename. Apps of a project cannot be rewritten here (their variables come from the project's
   * Compose file), so they are listed as such.
   */
  referencesTo(name: string) {
    this.getDefinition(name);
    return this.repo
      .list()
      .filter((a) => a.name !== name)
      .map((a) => ({
        app: a.name,
        keys: referencingKeys(a.env, name),
        editable: !a.project,
      }))
      .filter((r) => r.keys.length > 0);
  }

  /**
   * Gives an app another name. Docker cannot rename a service, so the service is replaced: stopped under the old name
   * and started under the new one with the same definition, which is a short outage. Named volumes keep their Docker
   * names (the data stays where it is), secrets stay as they are, and deploy keys, usage history and the machine the app
   * is held to move with it. Its default address follows the name; custom domains do not change.
   *
   * Other apps that reach it by its old name on the network can be rewritten (their variables change and they restart),
   * and/or the old name can stay as an alias so they keep working untouched.
   */
  async rename(
    from: string,
    rawTo: unknown,
    opts: { updateReferences?: boolean; keepOldName?: boolean } = {},
  ): Promise<{
    view: AppView;
    updated: string[];
    failed: { app: string; error: string }[];
  }> {
    const parsed = newAppName.safeParse(rawTo);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid name',
      );
    const to = parsed.data;
    if (to === from) throw new ValidationError('That is already its name.');
    // one order for every pair of names, so two renames crossing each other cannot wait on one another forever
    const [first, second] = [from, to].sort();
    const referrers = opts.updateReferences
      ? this.referencesTo(from).filter((r) => r.editable)
      : [];
    const view = await this.locked(first, () =>
      this.locked(second, () => this.renameLocked(from, to, opts)),
    );
    const updated: string[] = [];
    const failed: { app: string; error: string }[] = [];
    for (const ref of referrers)
      try {
        await this.mutate(ref.app, async (cur) => ({
          ...cur,
          env: rewriteEnv(cur.env, from, to),
        }));
        updated.push(ref.app);
      } catch (e) {
        failed.push({
          app: ref.app,
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    return { view, updated, failed };
  }

  private async renameLocked(
    from: string,
    to: string,
    opts: { updateReferences?: boolean; keepOldName?: boolean },
  ): Promise<AppView> {
    const app = this.getDefinition(from);
    if (app.project)
      throw new ConflictError(
        `"${from}" is part of the project "${app.project}", so its name comes from the project.`,
      );
    if (app.blueprint)
      throw new ConflictError(
        `"${from}" is managed by a hub that knows it by this name, so it cannot be renamed here.`,
      );
    if (this.repo.get(to))
      throw new ConflictError(`An app named "${to}" already exists.`);
    if (this.repo.list().some((a) => a.aliases.includes(to)))
      throw new ConflictError(
        `Another app already answers to "${to}" on the network.`,
      );
    if ((await this.docker.serviceStatus(serviceName(to))) !== null)
      throw new ConflictError(
        `A Docker service called "${serviceName(to)}" already exists.`,
      );
    const missing = await this.missingSecrets(app);
    if (missing.length > 0)
      throw new ConflictError(
        `"${from}" is missing its ${missing.length === 1 ? 'secret' : 'secrets'} ${missing.join(', ')} in Docker. Set ${missing.length === 1 ? 'it' : 'them'} again before renaming, or the app could not start under its new name.`,
      );

    const aliases = [
      ...new Set([...(opts.keepOldName ? [from] : []), ...app.aliases]),
    ].filter((a) => a !== to);
    if (aliases.length > 10)
      throw new ValidationError(
        'An app can have at most 10 names on the network, so the old one cannot be kept.',
      );
    const next: AppDefinition = {
      ...app,
      name: to,
      aliases,
      volumes: app.volumes.map((v) =>
        v.volumeName ? { ...v, dockerName: mountSource(app, v) } : v,
      ),
      secrets: app.secrets.map((s) => ({ ...s, owner: s.owner ?? from })),
    };
    await this.assertNotPlatformHost(app, next);

    // The machine a data-keeping app is held to is remembered by the app's name: carry it over
    const pins = this.readPins();
    const oldKey = this.pinKey(app);
    const hadPin = pins[oldKey];
    if (hadPin) {
      const { [oldKey]: _moved, ...rest } = pins;
      this.settings.set('volumePins', { ...rest, [this.pinKey(next)]: hadPin });
    }
    const undoPin = () => {
      if (!hadPin) return;
      const { [this.pinKey(next)]: _back, ...rest } = this.readPins();
      this.settings.set('volumePins', { ...rest, [oldKey]: hadPin });
    };

    await this.docker.removeService(serviceName(from), from);
    try {
      // Two services holding one volume, or one published port, at once is worse than a gap: wait for the old to be gone
      const deadline = Date.now() + this.renameWaitMs;
      while (
        (await this.docker.countContainers(serviceName(from))) > 0 &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, this.renamePollMs));
      await this.docker.ensureNetwork(SHARED, {});
      await this.apply(next);
    } catch (e) {
      // Put the app back under its old name so a failed rename costs nothing
      undoPin();
      await this.apply(app).catch((err) =>
        this.log.error(
          `Renaming ${from} failed and it could not be put back: ${err instanceof Error ? err.message : err}`,
        ),
      );
      throw e;
    }
    this.repo.rename(from, next);
    this.log.log(`Renamed ${from} to ${to}`);
    return this.view(next, await this.statusOf(next));
  }

  /** How long a move waits for the new service to run, and then for the proxy to learn about it. Public for tests. */
  adoptReadyMs = 120_000;
  adoptPollMs = 500;
  adoptSettleMs = 4_000;

  /**
   * Turns the standalone app `from` into `next`, a service of a project (see projects/adopt.ts). The data stays where it
   * is (`next` mounts the volumes under the names they have), and so do the history, deploy keys and the machine it is
   * held to.
   *
   * With `gap` false (no data, no published host port) the new service starts beside the old one, takes no traffic until
   * it runs, serves next to it for a moment, and only then does the old one go: no outage. With `gap` true, two
   * containers must not hold the same volume or port, so the old one stops first and the new one starts on its data. A
   * failure before the old one has gone costs nothing; a failure after puts the old one back.
   */
  async adoptIntoProject(
    from: string,
    next: AppDefinition,
    opts: { gap: boolean },
  ): Promise<void> {
    const [first, second] = [from, next.name].sort();
    await this.locked(first, () =>
      this.locked(second, () => this.adoptLocked(from, next, opts)),
    );
  }

  private async adoptLocked(
    from: string,
    wanted: AppDefinition,
    opts: { gap: boolean },
  ): Promise<void> {
    let next = wanted;
    const old = this.getDefinition(from);
    // A standalone app moving in, or a service of this same project renamed (it keeps the same project, and its
    // addresses, deploy keys and history carry on to the new name just the same)
    if (old.project && old.project !== wanted.project)
      throw new ConflictError(
        `"${from}" is already part of the project "${old.project}".`,
      );
    // The default address follows the app's name, which is about to change: keep the one people use, as an address of
    // its own (it is reached through both apps while they overlap)
    const root = this.settings.appsDomain();
    if (old.defaultSubdomain && root)
      next = {
        ...next,
        defaultSubdomain: false,
        defaultSubdomainSsl: false,
        domains: [
          { host: `${old.name}.${root}`, ssl: old.defaultSubdomainSsl },
          ...next.domains.filter((d) => d.host !== `${old.name}.${root}`),
        ],
      };
    if (old.blueprint)
      throw new ConflictError(`"${from}" is managed by a hub.`);
    if (this.repo.get(next.name))
      throw new ConflictError(`An app named "${next.name}" already exists.`);
    if ((await this.docker.serviceStatus(serviceName(next.name))) !== null)
      throw new ConflictError(
        `A Docker service called "${serviceName(next.name)}" already exists.`,
      );
    const missing = await this.missingSecrets(old);
    if (missing.length > 0)
      throw new ConflictError(
        `"${from}" is missing its secrets ${missing.join(', ')} in Docker.`,
      );

    // The machine an app with data is held to is remembered by its name or its project: carry it over
    const pins = this.readPins();
    const oldKey = this.pinKey(old);
    const hadPin = pins[oldKey];
    if (hadPin) {
      const { [oldKey]: _moved, ...rest } = pins;
      this.settings.set('volumePins', {
        ...rest,
        [this.pinKey(next)]: pins[this.pinKey(next)] ?? hadPin,
      });
    }
    const undoPin = () => {
      if (!hadPin) return;
      const { [this.pinKey(next)]: _back, ...rest } = this.readPins();
      this.settings.set('volumePins', { ...rest, [oldKey]: hadPin });
    };

    await this.docker.ensureNetwork(SHARED, {});
    if (!opts.gap) {
      // The new service first, not routed, so nothing is sent to it before it runs
      try {
        await this.apply({ ...next, exposed: false });
        await this.waitRunning(next.name);
        await this.apply(next);
        await new Promise((r) => setTimeout(r, this.adoptSettleMs));
      } catch (e) {
        undoPin();
        await this.docker
          .removeService(serviceName(next.name), next.name)
          .catch(() => undefined);
        throw e;
      }
      await this.docker.removeService(serviceName(from), from);
    } else {
      await this.docker.removeService(serviceName(from), from);
      try {
        const deadline = Date.now() + this.renameWaitMs;
        while (
          (await this.docker.countContainers(serviceName(from))) > 0 &&
          Date.now() < deadline
        )
          await new Promise((r) => setTimeout(r, this.renamePollMs));
        await this.apply(next);
      } catch (e) {
        undoPin();
        await this.apply(old).catch((err) =>
          this.log.error(
            `Moving ${from} failed and it could not be put back: ${err instanceof Error ? err.message : err}`,
          ),
        );
        throw e;
      }
    }
    this.repo.rename(from, next);
    this.log.log(
      old.project
        ? `Renamed the service ${from} to ${next.name} in the project ${next.project}`
        : `Moved ${from} into the project ${next.project} as ${next.name}`,
    );
  }

  private async waitRunning(name: string) {
    const deadline = Date.now() + this.adoptReadyMs;
    for (;;) {
      const st = await this.docker.serviceStatus(serviceName(name));
      if (st?.state === 'running' && st.health !== 'unhealthy') return;
      if (st?.state === 'failed')
        throw new ConflictError(
          `"${name}" did not start: ${st.message ?? 'its tasks keep failing'}.`,
        );
      if (Date.now() >= deadline)
        throw new ConflictError(`"${name}" was not running after a while.`);
      await new Promise((r) => setTimeout(r, this.adoptPollMs));
    }
  }

  /**
   * Removes the app and its service. Its Docker volumes are kept (they hold data): the names come back so they
   * can be removed deliberately from storage cleanup.
   */
  async remove(name: string): Promise<{ keptVolumes: string[] }> {
    return this.locked(name, async () => {
      const app = this.getDefinition(name);
      if (app.project)
        throw new ConflictError(
          `"${name}" is part of the project "${app.project}". Remove it by removing the project.`,
        );
      await this.docker.removeService(serviceName(name), name);
      this.repo.delete(name);
      this.ciKeys.removeForApp(name); // their app is gone
      await this.removeSecretsOf(app);
      return {
        keptVolumes: app.volumes
          .filter((v) => v.volumeName)
          .map((v) => v.volumeName as string),
      };
    });
  }
}

const SHARED = 'provelox-net';
