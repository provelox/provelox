import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { CdnService } from '../cdn/cdn.service';
import { CONFIG, type Config } from '../config/config';
import {
  DOCKER,
  type DockerPort,
  type ServiceStatus,
} from '../docker/docker.port';
import { SettingsService } from '../system/settings.service';
import { SHARED_NETWORK } from '../common/naming';
import { buildTraefikSpec, TRAEFIK_APP, TRAEFIK_SERVICE } from './traefik-spec';

const email = z.string().trim().email('Enter a valid email address.').max(254);

@Injectable()
export class ProxyService implements OnApplicationBootstrap {
  private readonly log = new Logger('Proxy');

  constructor(
    private readonly settings: SettingsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly cdn: CdnService,
  ) {}

  /** Starts the proxy with the API, without ever stopping the API from starting if Docker is unhappy. */
  async onApplicationBootstrap() {
    if (!this.cfg.PROXY_ENABLED) return;
    // Docker leaves the proxy alone when its settings did not change, so this restarts it only for a real change
    this.cdn.onChange(() => this.ensure().then(() => undefined));
    try {
      await this.ensure();
    } catch (e) {
      this.log.error(
        `Could not start the proxy: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Creates or updates the Traefik service to match the current settings. Idempotent. */
  async ensure(): Promise<'created' | 'updated'> {
    await this.docker.ensureNetwork(SHARED_NETWORK, {});
    return this.docker.applyService(
      buildTraefikSpec({
        image: this.cfg.TRAEFIK_IMAGE,
        httpPort: this.cfg.PROXY_HTTP_PORT,
        httpsPort: this.cfg.PROXY_HTTPS_PORT,
        certResolver: this.cfg.CERT_RESOLVER,
        acmeEmail: this.settings.acmeEmail(),
        acmeStaging: this.cfg.ACME_STAGING,
        trustedIPs: this.cdn.trustedIPs(),
      }),
      TRAEFIK_APP,
    );
  }

  /** The Let's Encrypt account email. Changing it restarts the proxy (briefly) so it can register. */
  async setAcmeEmail(raw: string): Promise<void> {
    const parsed = email.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid email',
      );
    this.settings.set('acmeEmail', parsed.data);
    if (this.cfg.PROXY_ENABLED) await this.ensure();
  }

  async status(): Promise<{
    enabled: boolean;
    httpPort: number;
    httpsPort: number;
    acmeEmail: string | null;
    service: ServiceStatus | null;
  }> {
    return {
      enabled: this.cfg.PROXY_ENABLED,
      httpPort: this.cfg.PROXY_HTTP_PORT,
      httpsPort: this.cfg.PROXY_HTTPS_PORT,
      acmeEmail: this.settings.acmeEmail(),
      service: await this.docker
        .serviceStatus(TRAEFIK_SERVICE)
        .catch(() => null),
    };
  }
}
