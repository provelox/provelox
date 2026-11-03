import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import type { ServiceUsage } from '../docker/usage';

/** The services Provelox itself runs on, as the status calls report them. */
export const PLATFORM_SERVICES = [
  { id: 'api', label: 'API', service: 'pvx-provelox' },
  { id: 'proxy', label: 'Proxy', service: 'pvx-traefik' },
  { id: 'console', label: 'Console', service: 'pvx-console' },
] as const;

/** Readings younger than this are used as they are; older ones are shown while a new one is taken. */
export const FRESH_MS = 10_000;
/** A service with no reading (not started yet, say) is looked at again after this, not served as empty for long. */
export const RETRY_EMPTY_MS = 1_000;
/** Beyond this a reading is not shown at all: the caller waits for a new one. */
export const TOO_OLD_MS = 5 * 60_000;

/**
 * What the platform's own services use. Docker measures a container over about a second, so three of them take
 * two seconds, and the status call (which the hub makes every half minute and the console's Infrastructure page makes
 * on every visit) used to wait for all of it. Now it answers from the last readings and refreshes them behind itself.
 */
@Injectable()
export class PlatformUsageService implements OnModuleInit {
  private value: {
    at: number;
    usage: Record<string, ServiceUsage | null>;
  } | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(@Inject(DOCKER) private readonly docker: DockerPort) {}

  /** Take the first reading before anyone asks for it. */
  onModuleInit() {
    void this.refresh();
  }

  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const entries = await Promise.all(
        PLATFORM_SERVICES.map(
          async (s) =>
            [
              s.service,
              await this.docker.serviceUsage(s.service).catch(() => null),
            ] as const,
        ),
      );
      this.value = { at: Date.now(), usage: Object.fromEntries(entries) };
    })()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** The usage of one service by its Docker name, or null when it is not running or has no reading yet. */
  async of(service: string, now = Date.now()): Promise<ServiceUsage | null> {
    const age = this.value ? now - this.value.at : Infinity;
    if (age >= TOO_OLD_MS) await this.refresh();
    // The caller found the service, so an empty reading is probably from before it started: look again, briefly
    else if (
      (this.value?.usage[service] ?? null) === null &&
      age >= RETRY_EMPTY_MS
    )
      await this.refresh();
    else if (age >= FRESH_MS) void this.refresh();
    return this.value?.usage[service] ?? null;
  }
}
