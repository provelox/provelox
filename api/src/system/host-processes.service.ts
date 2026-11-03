import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { HOST_PROCESSES_SCRIPT } from './host-processes.script';

/** One process name on the host, summed over its processes, with where it runs. */
export interface HostProcess {
  name: string;
  /** The app, platform service or container it runs in, or null for a process on the host itself */
  owner: string | null;
  /** How many processes of this name (in that container) there are */
  count: number;
  /** Percent of one core over the sampling time */
  cpuPercent: number;
  memoryBytes: number;
}

export interface HostProcesses {
  at: string;
  /** How long the processor was sampled over, in seconds */
  sampledSeconds: number;
  byCpu: HostProcess[];
  byMemory: HostProcess[];
}

/** A reading younger than this is served again as it is: taking one starts a container and samples for a second. */
export const FRESH_MS = 10_000;
const SHOWN = 10;

/** The name of the app or service behind a Docker service name: "pvx-shop" is the app "shop". */
export function ownerName(service: string): string {
  return service.startsWith('pvx-') ? service.slice(4) : service;
}

/** Reads what the helper printed (its last line of JSON) and attaches the owner of each container. */
export function parseProcesses(
  output: string,
  owners: Record<string, string>,
  now = new Date(),
): HostProcesses {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'));
  if (!line) throw new Error('The helper printed no reading.');
  const raw = JSON.parse(line) as {
    dt: number;
    top: { n: string; c: string; k: number; u: number; m: number }[];
  };
  const rows: HostProcess[] = raw.top.map((e) => ({
    name: String(e.n).slice(0, 64),
    owner: e.c && owners[e.c] ? ownerName(owners[e.c]) : null,
    count: e.k,
    cpuPercent: e.u,
    memoryBytes: e.m,
  }));
  return {
    at: now.toISOString(),
    sampledSeconds: raw.dt,
    byCpu: [...rows]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, SHOWN),
    byMemory: [...rows]
      .sort((a, b) => b.memoryBytes - a.memoryBytes)
      .slice(0, SHOWN),
  };
}

/**
 * The busiest processes on the machine the API runs on, from a helper container that shares the host's process
 * view (the API's own container sees only itself). Process names only; never command lines. One reading is taken at
 * a time and kept for a few seconds, so many viewers cost one container.
 */
@Injectable()
export class HostProcessesService {
  private value: { at: number; data: HostProcesses } | null = null;
  private running: Promise<HostProcesses> | null = null;

  constructor(@Inject(DOCKER) private readonly docker: DockerPort) {}

  async top(now = Date.now()): Promise<HostProcesses> {
    if (this.value && now - this.value.at < FRESH_MS) return this.value.data;
    this.running ??= this.read().finally(() => {
      this.running = null;
    });
    const data = await this.running;
    this.value = { at: Date.now(), data };
    return data;
  }

  private async read(): Promise<HostProcesses> {
    const image = await this.docker.selfImage();
    if (!image)
      throw new ServiceUnavailableException(
        'The API cannot tell which image it runs, so it cannot start the helper that reads the host.',
      );
    try {
      const [run, owners] = await Promise.all([
        this.docker.runHelper({
          image,
          entrypoint: ['node'],
          command: ['-e', HOST_PROCESSES_SCRIPT],
          mounts: [],
          hostPid: true,
        }),
        this.docker.containerOwners().catch(() => ({})),
      ]);
      if (run.exitCode !== 0)
        throw new Error(`The helper exited with ${run.exitCode}.`);
      return parseProcesses(run.output, owners);
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not read the host's processes: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }
}
