/** The parts of Docker's one-shot container stats this reads. Everything is optional: platforms differ. */
export interface RawStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
}

export interface InstanceUsage {
  /** Percent of one core, the way `docker stats` shows it: two busy cores read 200 */
  cpuPercent: number;
  /** What the container holds in memory, without the file cache Docker counts but reclaims on demand */
  memoryBytes: number;
}

/** CPU and memory of one container, from one stats sample. Never negative, never NaN. */
export function instanceUsage(raw: RawStats): InstanceUsage {
  const cpu = raw.cpu_stats;
  const pre = raw.precpu_stats;
  const cpuDelta =
    (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const cores = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpuPercent =
    cpuDelta > 0 && systemDelta > 0
      ? (cpuDelta / systemDelta) * cores * 100
      : 0;

  const mem = raw.memory_stats;
  // cgroup v2 reports inactive_file, v1 reports cache: either is memory the kernel gives back when asked
  const cache = mem?.stats?.inactive_file ?? mem?.stats?.cache ?? 0;
  const memoryBytes = Math.max(0, (mem?.usage ?? 0) - cache);
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryBytes,
  };
}

export interface ServiceUsage {
  instances: number;
  cpuPercent: number;
  memoryBytes: number;
}

/** The sum over a service's running instances. */
export function totalUsage(parts: InstanceUsage[]): ServiceUsage {
  return {
    instances: parts.length,
    cpuPercent:
      Math.round(parts.reduce((s, p) => s + p.cpuPercent, 0) * 10) / 10,
    memoryBytes: parts.reduce((s, p) => s + p.memoryBytes, 0),
  };
}
