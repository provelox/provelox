import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { z } from 'zod';
import { AppsService } from '../apps/apps.service';
import { Public } from '../auth/public.decorator';
import { ValidationError } from '../common/errors';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { Inject } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import {
  MAX_PLACEHOLDER_BYTES,
  PlaceholderService,
} from './placeholder.service';
import { blueprintHash, specOfApp } from '../apps/blueprint';
import { fleetHash } from './fleet-hash';
import { NotificationsService } from '../notifications/notifications.service';
import { RegistriesService } from '../registries/registries.service';
import { TemplateSourcesService } from '../templates/template-sources.service';
import { ProxyService } from '../proxy/proxy.service';
import { PlatformHostsService } from './platform-hosts.service';
import { SettingsService } from './settings.service';
import { readHostStats } from './host-stats';
import { apiVersion } from './version';
import type { Request } from 'express';
import { Scope, type TokenScope } from '../auth/scope.decorator';
import { HostProcessesService } from './host-processes.service';
import { SecurityService } from '../security/security.service';
import { SelfUpdateService } from '../self/self-update';
import {
  PLATFORM_SERVICES,
  PlatformUsageService,
} from './platform-usage.service';

const domain = z.object({
  rootDomain: z
    .string()
    .toLowerCase()
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
      'Enter a valid domain, like apps.example.com',
    ),
});

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Controller('system')
export class SystemController {
  constructor(
    private readonly settings: SettingsService,
    private readonly apps: AppsService,
    private readonly proxy: ProxyService,
    private readonly placeholder: PlaceholderService,
    private readonly platformHosts: PlatformHostsService,
    private readonly selfUpdate: SelfUpdateService,
    private readonly platformUsage: PlatformUsageService,
    private readonly hostProcesses: HostProcessesService,
    private readonly security: SecurityService,
    private readonly registries: RegistriesService,
    private readonly notifications: NotificationsService,
    private readonly templateSources: TemplateSourcesService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  @Scope('read')
  @Get('info')
  async info() {
    const docker = await this.docker.ping().then(
      () => 'ok' as const,
      () => 'unreachable' as const,
    );
    return {
      version: apiVersion ?? null,
      rootDomain: this.settings.rootDomain(),
      // Where apps' default addresses are (<app>.<appsDomain>): the root domain unless one is set aside for apps
      appsDomain: this.settings.appsDomain(),
      appsDomainCustom: this.settings.appsDomainOverride() !== null,
      defaultSubdomainForNewApps: this.settings.defaultSubdomainForNewApps(),
      docker,
      // Where visitors reach apps: needed to build a working link when the proxy is not on 80/443
      httpPort: this.cfg.PROXY_HTTP_PORT,
      httpsPort: this.cfg.PROXY_HTTPS_PORT,
    };
  }

  /**
   * Everything a monitor needs to judge this instance in one call: version, machines, platform services and a
   * status line per app. Deliberately no settings, environment or secrets: access tokens may read this.
   */
  @Scope('read')
  @Get('summary')
  async summary(@Req() req: Request) {
    const [info, nodes, services, apps, usage] = await Promise.all([
      this.info(),
      this.nodes().catch(() => []),
      this.platformServices(),
      this.apps.list(),
      this.apps.usageAllQuick().catch(() => ({})),
    ]);
    return {
      version: apiVersion ?? null,
      // What the caller may do: a token's own scope, or 'admin' for a signed-in session. A hub reads this to know
      // whether its token can operate or update, instead of guessing.
      tokenScope:
        (req as Request & { tokenScope?: TokenScope }).tokenScope ?? 'admin',
      at: new Date().toISOString(),
      rootDomain: info.rootDomain,
      appsDomain: info.appsDomain,
      appsDomainCustom: info.appsDomainCustom,
      docker: info.docker,
      nodes,
      host: readHostStats(this.cfg.DATA_DIR),
      // From the last scan only: asking never starts one
      security: this.security.summary() ?? undefined,
      services,
      // What this node holds of the settings a hub can keep the same across a fleet, as fingerprints it can compare
      fleet: {
        errorPages: fleetHash(this.settings.errorPages()),
        placeholderPage: fleetHash(
          this.placeholder.isCustom() ? this.placeholder.html() : null,
        ),
        defaultSubdomain: this.settings.defaultSubdomainForNewApps(),
        // This node takes blueprints (PUT /system/blueprint) and fingerprints its apps against them
        blueprints: true,
        acmeEmail: this.settings.acmeEmail(),
        // The webhooks (names and hosts only, never the addresses) and which events it sends
        notifications: this.notifications.view(),
        // Which registries it can sign in to, and as whom: never the passwords
        registries: this.registries
          .list()
          .map((r) => ({ domain: r.domain, username: r.username })),
        // Which template registries it reads, by address: never the tokens
        templateRegistries: this.templateSources.list().map((r) => ({
          kind: r.kind,
          url: r.url,
          ref: r.ref,
          path: r.path,
          name: r.name,
        })),
      },
      apps: apps.map((v) => ({
        name: v.app.name,
        image: v.status?.image ?? v.app.image ?? null,
        project: v.app.project ?? null,
        deployVersion: v.app.deployVersion,
        desired: v.status?.desired ?? v.app.instanceCount,
        running: v.status?.running ?? 0,
        state: v.status?.state ?? 'stopped',
        health: v.status?.health ?? null,
        message: v.status?.message ?? null,
        hosts: v.hosts,
        // The address it has by default (<app>.<apps domain>), whether or not it is switched on
        defaultHost: info.appsDomain
          ? `${v.app.name}.${info.appsDomain}`
          : null,
        defaultAddress: v.app.exposed && v.app.defaultSubdomain,
        // A name pointed at the server for identification: never routed, so not one of the hosts
        linkedDomain: v.app.linkedDomain ?? null,
        // A fingerprint of what a blueprint governs, so a hub can tell whether the app matches its blueprint
        blueprint: blueprintHash(specOfApp(v.app)),
        usage: (usage as Record<string, unknown>)[v.app.name] ?? null,
      })),
    };
  }

  /** The machines the platform runs on: what they are and whether they are healthy. */
  /**
   * The busiest process names on the machine the API runs on, by processor and by memory, and which app or container
   * each runs in. Operate level: it shows what runs on the host, though never a command line.
   */
  @Scope('operate')
  @Get('processes')
  processes() {
    return this.hostProcesses.top();
  }

  @Scope('read')
  @Get('nodes')
  nodes() {
    return this.docker.listNodes();
  }

  /**
   * Apps are served at <app>.<rootDomain>; every app's routing is re-applied when it changes. So are the console and
   * the API (console.<rootDomain>, api.<rootDomain>), once their new addresses point here.
   */
  @Put('domain')
  async setDomain(@Body() body: unknown) {
    const parsed = domain.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid domain',
      );
    const previous = this.settings.rootDomain();
    this.settings.set('rootDomain', parsed.data.rootDomain);
    const failed = await this.apps.reconcileAll();
    const platform = await this.platformHosts
      .moveTo(parsed.data.rootDomain, previous)
      .catch((e) => ({
        moved: false,
        kept: [] as string[],
        reason: `The console and API could not be moved: ${e instanceof Error ? e.message : e}`,
      }));
    return { rootDomain: parsed.data.rootDomain, failed, platform };
  }

  /**
   * Sets a separate domain for apps' default addresses (app-1.<appsDomain>), or null to use the root domain again. The
   * console and API stay on the root domain. Certificates are requested per address, as for any other domain.
   */
  @Put('apps-domain')
  async setAppsDomain(@Body() body: unknown) {
    const parsed = z
      .object({ appsDomain: domain.shape.rootDomain.nullable() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid domain',
      );
    if (parsed.data.appsDomain === null) this.settings.delete('appsDomain');
    else this.settings.set('appsDomain', parsed.data.appsDomain);
    const failed = await this.apps.reconcileAll();
    return {
      appsDomain: this.settings.appsDomain(),
      appsDomainCustom: this.settings.appsDomainOverride() !== null,
      failed,
    };
  }

  /** Where the console and the API are served, and whether over HTTPS. */
  @Get('platform-hosts')
  platformHostsStatus() {
    return this.platformHosts.status();
  }

  /**
   * Serves the console and the API over HTTPS (for an install made without a Let's Encrypt email, or migrated from
   * another platform). Admin only: it changes how the platform itself is reached.
   */
  @Put('platform-https')
  enablePlatformHttps() {
    return this.platformHosts.enableHttps();
  }

  /** Defaults for apps created from now on. Existing apps keep what they have. */
  @Scope('update')
  @Put('app-defaults')
  setAppDefaults(@Body() body: unknown) {
    const parsed = z
      .object({ defaultSubdomain: z.boolean() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new ValidationError('defaultSubdomain must be true or false.');
    this.settings.set(
      'defaultSubdomainForNewApps',
      parsed.data.defaultSubdomain,
    );
    return { defaultSubdomainForNewApps: parsed.data.defaultSubdomain };
  }

  /**
   * The platform's own services (this API, the proxy, the console): their state and the image each runs. They are not
   * apps, so they are not in the app list and cannot be stopped or deleted from the console.
   */
  @Scope('read')
  @Get('services')
  async platformServices() {
    return Promise.all(
      PLATFORM_SERVICES.map(async (n) => {
        const s = await this.docker.serviceStatus(n.service).catch(() => null);
        // What it uses right now. Missing when it is not installed or Docker would not say.
        const usage = s ? await this.platformUsage.of(n.service) : null;
        return {
          id: n.id,
          label: n.label,
          installed: !!s,
          state: s?.state ?? null,
          image: s?.image ?? null,
          // Docker's own word for an upgrade in flight or undone: updating, completed, rollback_completed...
          updateState: s?.updateState ?? null,
          // Why it is not running or was rolled back, in Docker's words
          message: s?.message ?? null,
          usage,
        };
      }),
    );
  }

  /**
   * Moves the platform's own services (the API and the console) to another release of the same image. Apps are not
   * touched. The API restarts as part of this, so the answer may not arrive; Docker puts the old release back if the
   * new one does not become healthy.
   */
  @Scope('update')
  @Post('update')
  @HttpCode(202)
  update(@Body() body: unknown) {
    const parsed = z
      .object({ version: z.string().max(40) })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new ValidationError('Send { "version": "0.2.7" }.');
    return this.selfUpdate.update(parsed.data.version);
  }

  @Scope('read')
  @Get('proxy')
  proxyStatus() {
    return this.proxy.status();
  }

  /** The Let's Encrypt account email. Needed before any app can use HTTPS. */
  @Scope('update')
  @Put('acme-email')
  async setAcmeEmail(@Body() body: unknown) {
    const parsed = z.object({ email: z.string().max(254) }).safeParse(body);
    if (!parsed.success) throw new ValidationError('Enter an email address.');
    await this.proxy.setAcmeEmail(parsed.data.email);
    return { email: this.settings.acmeEmail() };
  }

  @Scope('read')
  @Get('placeholder-page')
  placeholderPage() {
    return {
      html: this.placeholder.html(),
      custom: this.placeholder.isCustom(),
    };
  }

  /** The page apps show before their first deploy. Empty restores the default. Apps on it are updated. */
  @Scope('update')
  @Put('placeholder-page')
  async setPlaceholderPage(@Body() body: unknown) {
    const parsed = z.object({ html: z.string() }).safeParse(body);
    if (!parsed.success)
      throw new ValidationError('Send the page as { "html": "..." }.');
    await this.placeholder.set(parsed.data.html);
    const failed = await this.apps.reconcileAll({ onlyUndeployed: true });
    await this.placeholder.prune();
    return { custom: this.placeholder.isCustom(), failed };
  }

  /**
   * Makes one app match a blueprint a hub keeps the same on every node (see apps/blueprint.ts for what it may govern).
   * Needs the update scope.
   */
  @Scope('update')
  @Put('blueprint')
  applyBlueprint(@Body() body: unknown) {
    return this.apps.applyBlueprint(body);
  }

  /** The pages the proxy shows when an app has none of its own (and for an address nothing answers to). */
  @Scope('read')
  @Get('error-pages')
  errorPages() {
    const pages = this.settings.errorPages();
    return { pages, custom: Object.keys(pages).length > 0 };
  }

  /** Replaces the platform's pages with those given; a status left out or empty goes back to the built-in page. */
  @Scope('update')
  @Put('error-pages')
  setErrorPages(@Body() body: unknown) {
    const page = z.string().max(MAX_PLACEHOLDER_BYTES);
    const parsed = z
      .object({
        pages: z
          .object({
            '404': page.optional(),
            '502': page.optional(),
            '503': page.optional(),
            '504': page.optional(),
          })
          .strict(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "pages": { "404"?, "502"?, "503"?, "504"? } }, each up to 100 KB of HTML.',
      );
    const kept = Object.fromEntries(
      Object.entries(parsed.data.pages).filter(([, html]) => html?.trim()),
    );
    this.settings.setErrorPages(kept);
    return { pages: kept, custom: Object.keys(kept).length > 0 };
  }
}
