import { readFileSync, statfsSync } from 'node:fs';
import * as os from 'node:os';

/** What the machine the API runs on is doing right now. Only that machine: other Swarm nodes are not asked. */
export interface HostStats {
  cpus: number;
  /** Run queue length averaged over 1, 5 and 15 minutes: compare with `cpus` */
  load: [number, number, number];
  memoryTotalBytes: number;
  /** Not counting what the kernel can give back (caches) */
  memoryUsedBytes: number;
  /** The filesystem the platform's data lives on */
  diskPath: string;
  diskTotalBytes: number;
  diskFreeBytes: number;
  uptimeSeconds: number;
  /**
   * How much of the processor was actually working since the last reading, 0 to 100 of all the cores. Not the load
   * average: a machine waiting on its disk, or paused by its host, has a high load and a processor that does nothing.
   * Null until there are two readings, or where /proc/stat is not available.
   */
  cpuBusyPercent: number | null;
  /**
   * The share of the last minute in which something had to wait (the kernel's pressure figures): for a processor, and
   * for the disk. High while the processor is idle means the machine is stalling. Null where the kernel has none.
   */
  stalledPercent: { cpu: number; io: number } | null;
}

export interface HostProbe {
  cpus(): number;
  loadavg(): number[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  meminfo(): string | null;
  statfs(path: string): { blocks: number; bavail: number; bsize: number };
  /** The share of processor time spent working since the previous call, 0 to 100; null when unknown */
  cpuBusy?(): number | null;
  /** Contents of /proc/pressure/<name>, null when the kernel has none */
  pressure?(name: 'cpu' | 'io'): string | null;
}

/** Busy and total jiffies from the first line of /proc/stat. Waiting for the disk counts as idle: nothing is running. */
export function cpuTimes(
  stat: string | null,
): { busy: number; total: number } | null {
  const line = stat?.match(/^cpu\s+(.*)$/m)?.[1];
  if (!line) return null;
  const n = line.trim().split(/\s+/).map(Number);
  if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  return { busy: total - idle, total };
}

/** The "some" average over 60 seconds from a /proc/pressure file, as a percent. */
export function pressureSome60(text: string | null): number | null {
  const m = text?.match(/^some .*avg60=([0-9.]+)/m);
  return m ? Number(m[1]) : null;
}

let lastCpu: { busy: number; total: number; value: number | null } | null =
  null;

const real: HostProbe = {
  cpus: () => os.cpus().length,
  loadavg: () => os.loadavg(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  uptime: () => os.uptime(),
  meminfo: () => {
    try {
      return readFileSync('/proc/meminfo', 'utf8');
    } catch {
      return null;
    }
  },
  statfs: (p) => statfsSync(p),
  cpuBusy: () => {
    let now: ReturnType<typeof cpuTimes> = null;
    try {
      now = cpuTimes(readFileSync('/proc/stat', 'utf8'));
    } catch {
      return null;
    }
    if (!now) return null;
    const before = lastCpu;
    // Readings a moment apart would be noise: keep the last figure until enough time has passed
    if (before && now.total - before.total < 400) return before.value;
    const value =
      before && now.total > before.total
        ? Math.min(
            100,
            ((now.busy - before.busy) / (now.total - before.total)) * 100,
          )
        : null;
    lastCpu = { ...now, value };
    return value;
  },
  pressure: (name) => {
    try {
      return readFileSync(`/proc/pressure/${name}`, 'utf8');
    } catch {
      return null;
    }
  },
};

/** MemAvailable from /proc/meminfo in bytes: the honest "free", unlike os.freemem() which counts caches as used. */
export function memAvailable(meminfo: string | null): number | null {
  const m = meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  return m ? Number(m[1]) * 1024 : null;
}

export function readHostStats(
  diskPath: string,
  probe: HostProbe = real,
): HostStats {
  const total = probe.totalmem();
  const available = memAvailable(probe.meminfo()) ?? probe.freemem();
  let disk = { total: 0, free: 0 };
  try {
    const s = probe.statfs(diskPath);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    // a missing path is a reading of zero, not a failed summary
  }
  const [a = 0, b = 0, c = 0] = probe.loadavg();
  const busy = probe.cpuBusy?.() ?? null;
  const stallCpu = pressureSome60(probe.pressure?.('cpu') ?? null);
  const stallIo = pressureSome60(probe.pressure?.('io') ?? null);
  return {
    cpus: probe.cpus(),
    load: [a, b, c],
    memoryTotalBytes: total,
    memoryUsedBytes: Math.max(0, total - available),
    diskPath,
    diskTotalBytes: disk.total,
    diskFreeBytes: disk.free,
    uptimeSeconds: Math.floor(probe.uptime()),
    cpuBusyPercent: busy === null ? null : Math.round(busy * 10) / 10,
    stalledPercent:
      stallCpu === null && stallIo === null
        ? null
        : { cpu: stallCpu ?? 0, io: stallIo ?? 0 },
  };
}
