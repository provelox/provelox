import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppsRepo } from '../apps/apps.repo';
import { AppsService } from '../apps/apps.service';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { readHostStats } from '../system/host-stats';
import {
  PLATFORM_SERVICES,
  PlatformUsageService,
} from '../system/platform-usage.service';
import {
  bySeverity,
  countFindings,
  exposedPortFindings,
  hostFindings,
  parseHostReport,
  unaccountedCpuFinding,
  type Finding,
  type SecurityScan,
} from './findings';
import { HOST_SCAN_SCRIPT } from './host-scan.script';

/** A scan younger than this is served again as it is: taking one starts a helper container and samples for a second. */
export const SCAN_FRESH_MS = 60_000;

/** The first scan after a start, and then one this often, so the summary and the console have something to show. */
export const FIRST_SCAN_MS = 90_000;
export const SCAN_EVERY_MS = 30 * 60_000;

/**
 * Looks for the usual signs of a machine someone else controls: databases open to the internet, work the processor does
 * that nothing accounts for, and (through a read-only helper container that sees the host's files) the traces malware
 * leaves. It changes nothing. It detects common signs, so a clean result is not proof that a machine is clean.
 */
@Injectable()
export class SecurityService implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private last: { at: number; scan: SecurityScan } | null = null;
  private running: Promise<SecurityScan> | null = null;

  constructor(
    @Inject(DOCKER) private readonly docker: DockerPort,
    private readonly repo: AppsRepo,
    private readonly apps: AppsService,
    private readonly platformUsage: PlatformUsageService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** A scan soon after the start and then regularly. Not in tests, which build the service without starting it. */
  onModuleInit() {
    const run = () => void this.scan(true).catch(() => undefined);
    const first = setTimeout(run, FIRST_SCAN_MS);
    const every = setInterval(run, SCAN_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** The last scan, as it was; null before the first. Never starts one. */
  latest(): SecurityScan | null {
    return this.last?.scan ?? null;
  }

  /** The counts other systems read from the summary, from the last scan only. */
  summary(): {
    critical: number;
    warning: number;
    at: string;
    /** What was found, by name only (never the detail: that is for people who can sign in to this machine's console) */
    findings: { id: string; severity: 'critical' | 'warning'; title: string }[];
  } | null {
    const s = this.latest();
    if (!s) return null;
    return {
      ...countFindings(s.findings),
      at: s.at,
      findings: [...s.findings]
        .filter((f) => f.severity !== 'info')
        .sort(bySeverity)
        .slice(0, 12)
        .map((f) => ({
          id: f.id,
          severity: f.severity as 'critical' | 'warning',
          title: f.title,
        })),
    };
  }

  async scan(fresh = false, now = Date.now()): Promise<SecurityScan> {
    if (!fresh && this.last && now - this.last.at < SCAN_FRESH_MS)
      return this.last.scan;
    this.running ??= this.take().finally(() => {
      this.running = null;
    });
    const scan = await this.running;
    this.last = { at: Date.now(), scan };
    return scan;
  }

  private async take(): Promise<SecurityScan> {
    const findings: Finding[] = [];

    // Checks that need only what Provelox already knows
    findings.push(
      ...exposedPortFindings(
        this.repo.list().map((a) => ({
          name: a.name,
          image: a.image,
          ports: a.ports,
        })),
      ),
    );
    const host = readHostStats(this.cfg.DATA_DIR);
    const [appUsage, platform] = await Promise.all([
      this.apps.usageAllQuick().catch(() => ({})),
      Promise.all(
        PLATFORM_SERVICES.map((s) =>
          this.platformUsage.of(s.service).catch(() => null),
        ),
      ),
    ]);
    const known =
      Object.values(appUsage as Record<string, { cpuPercent: number }>).reduce(
        (n, u) => n + (u?.cpuPercent ?? 0),
        0,
      ) + platform.reduce((n, u) => n + (u?.cpuPercent ?? 0), 0);
    const cpu = unaccountedCpuFinding({
      hostBusyPercent: host.cpuBusyPercent,
      cpus: host.cpus,
      knownPercentOfCores: known,
    });
    if (cpu) findings.push(cpu);

    // The host itself, through a helper that does not trust the host's own libraries
    let hostChecked = false;
    let hostError: string | undefined;
    try {
      findings.push(...(await this.lookAtHost()));
      hostChecked = true;
    } catch (e) {
      hostError = e instanceof Error ? e.message : 'unknown error';
    }

    return {
      at: new Date().toISOString(),
      findings: findings.sort(bySeverity),
      hostChecked,
      ...(hostError ? { hostError } : {}),
    };
  }

  private async lookAtHost(): Promise<Finding[]> {
    const image = await this.docker.selfImage();
    if (!image)
      throw new ServiceUnavailableException(
        'The API cannot tell which image it runs, so it cannot start the helper that reads the host.',
      );
    const run = await this.docker.runHelper({
      image,
      entrypoint: ['node'],
      command: ['-e', HOST_SCAN_SCRIPT],
      mounts: [],
      hostPid: true,
      hostRoot: true,
      maxOutput: 16_000,
    });
    if (run.exitCode !== 0)
      throw new Error(`The helper exited with ${run.exitCode}.`);
    // Names for the containers the report mentions, so a finding says which app, not a hex id
    const owners = await this.docker.containerOwners().catch(() => ({}));
    return hostFindings(parseHostReport(run.output), owners);
  }
}
