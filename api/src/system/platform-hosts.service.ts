import { lookup } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { ValidationError } from '../common/errors';
import { hostRoutingLabels } from '../self/routing';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { SELF_APP, SELF_SERVICE } from '../self/api-spec';
import { CONSOLE_APP, CONSOLE_SERVICE } from '../self/console-spec';
import { publicUrl } from '../self/bootstrap';
import { SettingsService } from './settings.service';

export interface PlatformMove {
  /** Where the console is served now, when it is served at the new root domain */
  consoleUrl?: string;
  /** True when a service was moved by this call */
  moved: boolean;
  /** Why nothing moved, when the move could not go ahead */
  reason?: string;
  /** Hosts that were set by hand at install time: never changed here */
  kept: string[];
}

const TARGETS = [
  {
    label: 'console',
    id: 'pvx_console',
    service: CONSOLE_SERVICE,
    app: CONSOLE_APP,
  },
  { label: 'api', id: 'pvx_api', service: SELF_SERVICE, app: SELF_APP },
] as const;

const hostOf = (labels: Record<string, string>, id: string) =>
  /^Host\(`(.+)`\)$/.exec(
    labels[`traefik.http.routers.${id}-web.rule`] ?? '',
  )?.[1];

/**
 * Keeps the platform's own addresses (console.<root>, api.<root>) in step with the root domain. Install gives them
 * their hosts; without this, changing the domain later would move the apps and leave the console behind. Only the
 * services' labels change, so the API can do it to itself without restarting.
 */
@Injectable()
export class PlatformHostsService {
  constructor(
    private readonly settings: SettingsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Whether a name points anywhere yet. Moving to one that does not would lock the owner out of the console. */
  protected async resolves(host: string): Promise<boolean> {
    return lookup(host).then(
      () => true,
      () => false,
    );
  }

  /**
   * `previousRoot` is the root domain before this change. The hosts count as derived from it only when they are
   * exactly console.<it> / api.<it>; ones given by hand (--console-host) stay as they are.
   */
  async moveTo(
    newRoot: string,
    previousRoot: string | null,
  ): Promise<PlatformMove> {
    // Where the hosts were last derived from: differs from previousRoot when an earlier move had to wait for DNS
    const from = this.settings.get<string>('platformRoot') ?? previousRoot;
    // Remembered now, so a try that has to wait for DNS can be repeated after the saved root has moved on
    if (from) this.settings.set('platformRoot', from);
    const kept: string[] = [];
    const plan: { t: (typeof TARGETS)[number]; old: string; next: string }[] =
      [];
    for (const t of TARGETS) {
      const labels = await this.docker.serviceLabels(t.service);
      const host = labels && hostOf(labels, t.id);
      if (!host) continue;
      const next = `${t.label}.${newRoot}`;
      if (host === next) continue;
      if (from && host === `${t.label}.${from}`)
        plan.push({ t, old: host, next });
      else kept.push(host);
    }

    if (plan.length) {
      const missing: string[] = [];
      for (const p of plan)
        if (!(await this.resolves(p.next))) missing.push(p.next);
      if (missing.length)
        return {
          moved: false,
          kept,
          reason: `${missing.join(' and ')} ${missing.length > 1 ? 'do' : 'does'} not point anywhere yet, so the console stays at its current address. Add DNS records for ${missing.length > 1 ? 'them' : 'it'}, then save the domain again.`,
        };

      const apiMove = plan.find((p) => p.t.label === 'api');
      // The console first, the API last: the API is the one running this
      for (const p of [...plan].sort((a) =>
        a.t.label === 'console' ? -1 : 1,
      )) {
        await this.docker.editService(p.t.service, p.t.app, (spec) => {
          const swap = (v: string) =>
            v.split(`\`${p.old}\``).join(`\`${p.next}\``);
          spec.Labels = Object.fromEntries(
            Object.entries(spec.Labels).map(([k, v]) => [k, swap(v)]),
          );
          // The console shows the API's address in its CI snippet
          if (p.t.label === 'console' && apiMove) {
            const cs = spec.TaskTemplate.ContainerSpec as { Env?: string[] };
            cs.Env = cs.Env?.map((e) =>
              e.startsWith('PROVELOX_PUBLIC_API_URL=')
                ? e.split(`//${apiMove.old}`).join(`//${apiMove.next}`)
                : e,
            );
          }
          return spec;
        });
      }
    }
    this.settings.set('platformRoot', newRoot);
    return {
      moved: plan.length > 0,
      kept,
      consoleUrl: await this.consoleUrl(newRoot),
    };
  }

  /** Where the console and the API are served, and whether over HTTPS. Null for one that is not installed. */
  async status(): Promise<{
    console: { host: string; ssl: boolean; url: string } | null;
    api: { host: string; ssl: boolean; url: string } | null;
  }> {
    const read = async (t: (typeof TARGETS)[number]) => {
      const labels = await this.docker.serviceLabels(t.service);
      const host = labels && hostOf(labels, t.id);
      if (!labels || !host) return null;
      const ssl = `traefik.http.routers.${t.id}-websecure.rule` in labels;
      return {
        host,
        ssl,
        url: publicUrl(
          host,
          ssl,
          this.cfg.PROXY_HTTP_PORT,
          this.cfg.PROXY_HTTPS_PORT,
        ),
      };
    };
    return { console: await read(TARGETS[0]), api: await read(TARGETS[1]) };
  }

  /**
   * Serves the console and the API over HTTPS, for an install that was made without a Let's Encrypt email (or migrated
   * from another platform) and so answers on plain HTTP. Adds the secure routers to their own routing, redirects plain
   * HTTP to them, and points the console at the API's HTTPS address. Needs the email (the proxy asks for the
   * certificates with it) and DNS that already leads here, since a certificate cannot be issued otherwise; the
   * certificate itself can take up to a minute to appear.
   */
  async enableHttps(): Promise<
    { changed: string[] } & Awaited<ReturnType<PlatformHostsService['status']>>
  > {
    if (!this.settings.acmeEmail())
      throw new ValidationError(
        "Save a Let's Encrypt email first: certificates are requested with it.",
      );
    const before = await this.status();
    const todo = TARGETS.filter(
      (t) => before[t.label] && !before[t.label]!.ssl,
    );
    const missing: string[] = [];
    for (const t of todo)
      if (!(await this.resolves(before[t.label]!.host)))
        missing.push(before[t.label]!.host);
    if (missing.length)
      throw new ValidationError(
        `${missing.join(' and ')} ${missing.length > 1 ? 'do' : 'does'} not point to this server yet, so a certificate cannot be issued. Add DNS records for ${missing.length > 1 ? 'them' : 'it'}, make sure ports 80 and 443 reach this server, then try again.`,
      );
    const apiHost = before.api?.host;
    const changed: string[] = [];
    // The console first, the API last: the API is the one running this
    for (const t of [...todo].sort((a) => (a.label === 'console' ? -1 : 1))) {
      const host = before[t.label]!.host;
      await this.docker.editService(t.service, t.app, (spec) => {
        const port = Number(
          spec.Labels[`traefik.http.services.${t.id}.loadbalancer.server.port`],
        );
        spec.Labels = {
          ...spec.Labels,
          ...hostRoutingLabels(
            t.id,
            { host, ssl: true },
            port,
            this.cfg.CERT_RESOLVER,
          ),
        };
        // The console shows the API's address in its CI snippet
        if (t.label === 'console' && apiHost && !before.api?.ssl) {
          const cs = spec.TaskTemplate.ContainerSpec as { Env?: string[] };
          cs.Env = cs.Env?.map((e) =>
            e.startsWith('PROVELOX_PUBLIC_API_URL=')
              ? `PROVELOX_PUBLIC_API_URL=${publicUrl(apiHost, true, this.cfg.PROXY_HTTP_PORT, this.cfg.PROXY_HTTPS_PORT)}`
              : e,
          );
        }
        return spec;
      });
      changed.push(t.label);
    }
    return { changed, ...(await this.status()) };
  }

  /** The console's address, only when it is at the new root domain */
  private async consoleUrl(newRoot: string) {
    const labels = await this.docker.serviceLabels(CONSOLE_SERVICE);
    const host = labels && hostOf(labels, 'pvx_console');
    if (!labels || host !== `console.${newRoot}`) return undefined;
    const ssl = 'traefik.http.routers.pvx_console-websecure.rule' in labels;
    return publicUrl(
      host,
      ssl,
      this.cfg.PROXY_HTTP_PORT,
      this.cfg.PROXY_HTTPS_PORT,
    );
  }
}
