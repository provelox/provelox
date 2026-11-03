import { Inject, Injectable } from '@nestjs/common';
import { AppsService } from '../apps/apps.service';
import {
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from '../common/errors';
import { serviceName } from '../common/naming';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { SettingsService } from '../system/settings.service';
import {
  acmeErrorFor,
  checkDns,
  diagnose,
  systemResolver,
  type Diagnosis,
  type DnsResult,
  type Resolver,
} from './certificate-diagnosis';
import { TRAEFIK_SERVICE } from './traefik-spec';
import { hostsOf } from './traefik-labels';

/** A second attempt too soon after the last one only spends Let's Encrypt's limit */
export const RETRY_COOLDOWN_SECONDS = 60;
/** Let's Encrypt allows five failed validations per name per hour; stay under it */
export const RETRIES_PER_HOUR = 3;
const HOUR = 3_600_000;

export interface CertificateDiagnosis extends Diagnosis {
  host: string;
  dns: DnsResult | null;
  /** The certificate state the proxy showed when this was worked out */
  state: string;
  /** Seconds until a retry is allowed; 0 when it is allowed now */
  retryAfterSeconds: number;
  /** A retry makes sense here: HTTPS is on and there is no working certificate */
  canRetry: boolean;
}

/**
 * The label a retry changes. Traefik asks Let's Encrypt for a certificate whenever its routing changes and a name has
 * none, and a name that failed is not asked again until then, so a retry has to change something Traefik reads. A
 * response flush interval 1 to 20 milliseconds away from its default of 100 ms changes nothing a visitor can see and
 * is picked up on Traefik's next look at the Swarm (every 15 seconds). Re-applying the app puts the default back.
 */
export const retryLabel = (app: string) =>
  `traefik.http.services.${app}.loadbalancer.responseforwarding.flushinterval`;

const nextFlush = (current: string | undefined) => {
  const n = Number(/^(\d+)ms$/.exec(current ?? '')?.[1] ?? 100);
  return `${100 + ((Math.max(100, n) - 100 + 1) % 20)}ms`;
};

@Injectable()
export class CertificatesService {
  /** Swapped by tests: how names are looked up in DNS */
  resolver: Resolver = systemResolver;

  private readonly pendingSince = new Map<string, number>();
  private readonly retries = new Map<string, number[]>();

  constructor(
    private readonly apps: AppsService,
    private readonly settings: SettingsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  private key = (app: string, host: string) => `${app}\0${host}`;

  /** The address must be one the app serves: a made-up host is a 404 and nothing is looked up for it */
  private hostOf(app: string, host: string) {
    const def = this.apps.getDefinition(app);
    const found = hostsOf(def, this.settings.appsDomain()).find(
      (h) => h.host === host.toLowerCase(),
    );
    if (!found) throw new NotFoundError(`${app} does not serve ${host}.`);
    return { def, host: found };
  }

  private retryAfter(app: string, host: string, now: number): number {
    const done = (this.retries.get(this.key(app, host)) ?? []).filter(
      (t) => now - t < HOUR,
    );
    if (done.length === 0) return 0;
    const cooldown =
      done[done.length - 1] + RETRY_COOLDOWN_SECONDS * 1000 - now;
    const hourly = done.length >= RETRIES_PER_HOUR ? done[0] + HOUR - now : 0;
    return Math.max(0, Math.ceil(Math.max(cooldown, hourly) / 1000));
  }

  /** The proxy's own account of a failed attempt for this host, when its log has one. Never invented. */
  private async acmeError(host: string): Promise<string | null> {
    const lines: string[] = [];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    try {
      await this.docker.followLogs(
        TRAEFIK_SERVICE,
        { tail: 400, follow: false },
        (l) => lines.push(l.text),
        abort.signal,
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    return acmeErrorFor(host, lines);
  }

  async diagnosis(
    app: string,
    host: string,
    now = Date.now(),
  ): Promise<CertificateDiagnosis> {
    const { host: h, def } = this.hostOf(app, host);
    const certs = await this.apps.certificates(app);
    const state = certs.find((c) => c.host === h.host)?.state ?? 'unreachable';
    const k = this.key(app, h.host);
    if (state === 'pending') {
      if (!this.pendingSince.has(k)) this.pendingSince.set(k, now);
    } else this.pendingSince.delete(k);

    const rootDomain = this.settings.appsDomain();
    const target = rootDomain ? `${def.name}.${rootDomain}` : null;
    const pending = state === 'pending' && h.ssl;
    const [dns, acmeError] = await Promise.all([
      h.ssl && state !== 'valid'
        ? checkDns(h.host, h.host === target ? null : target, this.resolver)
        : Promise.resolve(null),
      pending ? this.acmeError(h.host) : Promise.resolve(null),
    ]);
    const since = this.pendingSince.get(k);
    const verdict = diagnose({
      host: h.host,
      ssl: h.ssl,
      state,
      proxyEnabled: this.cfg.PROXY_ENABLED,
      acmeEmailSet: !!this.settings.acmeEmail(),
      dns,
      pendingSeconds: since === undefined ? null : (now - since) / 1000,
      acmeError,
    });
    const retryAfterSeconds = this.retryAfter(app, h.host, now);
    return {
      ...verdict,
      host: h.host,
      dns,
      state,
      retryAfterSeconds,
      canRetry:
        h.ssl &&
        this.cfg.PROXY_ENABLED &&
        !!this.settings.acmeEmail() &&
        verdict.verdict !== 'issued',
    };
  }

  /**
   * Asks the proxy to try for a certificate again. Refuses when HTTPS is off, no Let's Encrypt email is set, or an
   * attempt was made a moment ago (a minute) or too often this hour (three), because each failed attempt counts
   * against a limit at Let's Encrypt that would block this name for an hour.
   */
  async retry(app: string, host: string, now = Date.now()) {
    const { host: h } = this.hostOf(app, host);
    if (!h.ssl)
      throw new ValidationError(
        `HTTPS is not turned on for ${h.host}. Turn it on first.`,
      );
    if (!this.cfg.PROXY_ENABLED)
      throw new ValidationError(
        'This install does not run the proxy that issues certificates.',
      );
    if (!this.settings.acmeEmail())
      throw new ValidationError(
        'Set the Let’s Encrypt email under Settings, Domain & HTTPS first.',
      );
    const wait = this.retryAfter(app, h.host, now);
    if (wait > 0)
      throw new TooManyRequestsError(
        wait > RETRY_COOLDOWN_SECONDS
          ? `Let’s Encrypt allows only a few failed attempts per hour for one name. Try again in ${Math.ceil(wait / 60)} minutes.`
          : `Wait ${wait} seconds before trying again.`,
      );

    const service = serviceName(app);
    const label = retryLabel(app);
    const changed = await this.docker.editService(service, app, (spec) => ({
      ...spec,
      Labels: { ...spec.Labels, [label]: nextFlush(spec.Labels[label]) },
    }));
    if (!changed)
      throw new NotFoundError(
        `${app} has no running service yet. Deploy it first.`,
      );
    const k = this.key(app, h.host);
    this.retries.set(k, [
      ...(this.retries.get(k) ?? []).filter((t) => now - t < HOUR),
      now,
    ]);
    // The wait for a new certificate starts again from here
    this.pendingSince.set(k, now);
    return {
      host: h.host,
      retried: true,
      retryAfterSeconds: RETRY_COOLDOWN_SECONDS,
      // Traefik looks at the Swarm every 15 seconds, then asks Let's Encrypt, which takes a few seconds more
      expectedWithinSeconds: 45,
    };
  }
}
